// Bridge 1(a) — live PoB file-watch.
//
// Point the app at a PoB2 build `.xml` once; saving it in Path of Building (Ctrl+S) re-reads the
// file and re-imports the build. Read-only — the file is never written and never leaves the
// browser. Design + rationale: _workbench/Docs/bridge1-live-pob-file-watch.md.
//
// Chromium-desktop only (File System Access API). Callers MUST gate UI on isFileWatchSupported()
// and fall back to paste/upload on Firefox/Safari/mobile.
//
// v1 watches by POLLING — it compares File.lastModified every ~700 ms. The FileSystemObserver path
// (design decision D4) is deferred until that experimental API is stable enough to depend on;
// polling keeps sub-second latency with zero browser-version risk.

/** The only method we use from a FileSystemFileHandle. Declared locally so we don't depend on
 *  lib.dom typings that vary by TS/DOM version; the unit test supplies a matching stub. */
export interface WatchableFileHandle {
  getFile(): Promise<File>
}

type OpenFilePicker = (opts?: {
  multiple?: boolean
  types?: Array<{ description?: string; accept: Record<string, string[]> }>
}) => Promise<WatchableFileHandle[]>

const getPicker = (): OpenFilePicker | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker

/** True only where the OS file picker + handle re-reads actually WORK: a Chromium-desktop engine AND
 *  a top-level browsing context. Feature-detecting `showOpenFilePicker` alone isn't enough — it also
 *  exists inside a cross-origin iframe (e.g. the VS Code Simple Browser) where the call is blocked and
 *  silently no-ops, so we rule out framed contexts too rather than reveal a dead Watch tab there. */
export function isFileWatchSupported(): boolean {
  if (getPicker() === undefined) return false
  try {
    // Blocked inside an embedded frame (e.g. the VS Code Simple Browser iframes the page): the API
    // object exists but the call silently no-ops. Rule out framing via BOTH available signals.
    if (window.self !== window.top) return false // top-level only
    const ancestors = window.location.ancestorOrigins // Chromium-only: non-empty ⇒ we're in a frame
    if (ancestors && ancestors.length > 0) return false
  } catch {
    return false // reading window.top threw → sandboxed/cross-origin frame
  }
  return true
}

export interface WatchedFile {
  name: string
  text: string
}

export interface FileWatcher {
  /** Open the OS picker, read once, and begin watching. Resolves with the initial read, or null
   *  if the user cancels the picker. */
  pick(): Promise<WatchedFile | null>
  /** Begin watching an already-resolved handle (used by the tests + future session-restore).
   *  Stops any prior watch first. Resolves with the initial read. */
  watchHandle(handle: WatchableFileHandle): Promise<WatchedFile>
  /** Stop watching and release the handle. Idempotent. */
  stop(): void
  readonly watching: boolean
  readonly fileName: string | null
}

export interface FileWatcherOptions {
  /** Fired on every save observed AFTER the initial read (the initial read is returned by
   *  pick()/watchHandle()). Never fired for an unchanged file. */
  onChange: (text: string, fileName: string) => void
  /** Fired ONCE at the start of an error streak (file moved/deleted, permission revoked). The
   *  loop keeps polling and self-heals — onChange fires again if the file returns. */
  onError?: (err: unknown) => void
  /** Poll cadence in ms (default 700). */
  intervalMs?: number
}

export function createFileWatcher(opts: FileWatcherOptions): FileWatcher {
  const intervalMs = opts.intervalMs ?? 700
  let handle: WatchableFileHandle | null = null
  let lastModified = -1
  let running = false
  let errored = false // one onError per error streak — no spam while a file stays gone
  let busy = false // re-entry guard so an immediate poll can't overlap a scheduled one
  let currentName: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const onVisible = (): void => {
    // returning from PoB to the tab → poll immediately so the refresh feels instant
    if (running && typeof document !== 'undefined' && !document.hidden) void poll()
  }

  async function poll(): Promise<void> {
    if (!running || !handle || busy) return
    busy = true
    clearTimer()
    const myHandle = handle // a re-pick/stop mid-await must not let this poll touch the new watch's state
    let pending: { text: string; name: string } | null = null // a change to dispatch AFTER the I/O try
    try {
      const file = await myHandle.getFile()
      if (handle !== myHandle || !running) return // re-picked or stopped while awaiting → abandon
      if (file.lastModified !== lastModified) {
        // Read the bytes BEFORE committing anything. If text() throws (PoB caught mid-write), we must
        // leave lastModified at the previous good value so the next poll retries — otherwise the save
        // would be silently skipped forever (the mtime would already match).
        const text = await file.text()
        if (handle !== myHandle || !running) return
        lastModified = file.lastModified
        currentName = file.name
        pending = { text, name: file.name } // fire onChange outside the I/O catch (see below)
      }
      errored = false
    } catch (err) {
      if (!errored) {
        errored = true
        opts.onError?.(err)
      }
    } finally {
      busy = false
      if (running && handle === myHandle) timer = setTimeout(() => void poll(), intervalMs)
    }
    // Dispatch onChange OUTSIDE the try above so a throwing consumer callback isn't caught and
    // misreported as a file-read error (which would also mute the next real I/O error via `errored`).
    // The mtime is already committed, so a throw here won't re-fire this same save next poll.
    if (pending) opts.onChange(pending.text, pending.name)
  }

  async function watchHandle(next: WatchableFileHandle): Promise<WatchedFile> {
    stop()
    handle = next
    running = true
    errored = false
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    const file = await next.getFile()
    lastModified = file.lastModified
    currentName = file.name
    const initial: WatchedFile = { name: file.name, text: await file.text() }
    timer = setTimeout(() => void poll(), intervalMs)
    return initial
  }

  async function pick(): Promise<WatchedFile | null> {
    const picker = getPicker()
    if (!picker) return null
    let handles: WatchableFileHandle[]
    try {
      handles = await picker({
        multiple: false,
        types: [
          {
            description: 'Path of Building 2 build',
            accept: { 'application/xml': ['.xml'], 'text/plain': ['.txt', '.build'] },
          },
        ],
      })
    } catch {
      return null // user dismissed the picker (AbortError) — not an error worth surfacing
    }
    const first = handles[0]
    if (!first) return null
    return watchHandle(first)
  }

  function stop(): void {
    running = false
    busy = false
    clearTimer()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    handle = null
  }

  return {
    pick,
    watchHandle,
    stop,
    get watching(): boolean {
      return running
    },
    get fileName(): string | null {
      return currentName
    },
  }
}
