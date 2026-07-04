// Bridge 1(a) live PoB file-watch — unit tests for the watcher logic. jsdom has no File System
// Access API, so we inject a mock FileSystemFileHandle and drive time with fake timers. The OS
// picker + the real updateContents() wiring are covered by the manual accept (see the design doc).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFileWatcher, isFileWatchSupported, type WatchableFileHandle } from '../src/watch/fileWatch'

interface MockState {
  name: string
  lastModified: number
  text: string
  fail: boolean // getFile() rejects
  textFail: boolean // file.text() rejects once then clears — simulates a read caught mid-write
}

/** A FileSystemFileHandle stub whose backing file we mutate between polls. */
function mockHandle(init: { text: string; name?: string; lastModified?: number }) {
  const state: MockState = {
    name: init.name ?? 'build.xml',
    lastModified: init.lastModified ?? 1,
    text: init.text,
    fail: false,
    textFail: false,
  }
  const handle: WatchableFileHandle = {
    getFile: async () => {
      if (state.fail) throw new Error('NotFoundError: file is gone')
      return {
        name: state.name,
        lastModified: state.lastModified,
        text: async () => {
          if (state.textFail) {
            state.textFail = false
            throw new Error('NotReadableError: file changed during read')
          }
          return state.text
        },
      } as unknown as File
    },
  }
  return { state, handle }
}

describe('fileWatch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** Shared arrange: a '<A/>'@mtime-1 mock handle watched at 100 ms with both callbacks mocked. */
  async function watchedFixture() {
    const onChange = vi.fn()
    const onError = vi.fn()
    const { state, handle } = mockHandle({ text: '<A/>', lastModified: 1 })
    const w = createFileWatcher({ onChange, onError, intervalMs: 100 })
    await w.watchHandle(handle)
    return { onChange, onError, state, w }
  }

  it('returns the initial read and fires onChange once per real save, never on unchanged polls', async () => {
    const onChange = vi.fn()
    const { state, handle } = mockHandle({ text: '<A/>', lastModified: 1 })
    const w = createFileWatcher({ onChange, intervalMs: 100 })

    const initial = await w.watchHandle(handle)
    expect(initial).toEqual({ name: 'build.xml', text: '<A/>' })
    expect(w.watching).toBe(true)
    expect(w.fileName).toBe('build.xml')
    expect(onChange).not.toHaveBeenCalled() // the initial read is the return value, not an onChange

    // unchanged file → several polls do nothing
    await vi.advanceTimersByTimeAsync(350)
    expect(onChange).not.toHaveBeenCalled()

    // save in PoB → lastModified advances → exactly one onChange with the new text
    state.text = '<B/>'
    state.lastModified = 2
    await vi.advanceTimersByTimeAsync(150)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('<B/>', 'build.xml')

    // idle polls don't re-fire for the same content
    await vi.advanceTimersByTimeAsync(300)
    expect(onChange).toHaveBeenCalledTimes(1)

    // another save → a second onChange
    state.text = '<C/>'
    state.lastModified = 3
    await vi.advanceTimersByTimeAsync(150)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith('<C/>', 'build.xml')

    w.stop()
  })

  it('stop() halts polling', async () => {
    const onChange = vi.fn()
    const { state, handle } = mockHandle({ text: '<A/>', lastModified: 1 })
    const w = createFileWatcher({ onChange, intervalMs: 100 })

    await w.watchHandle(handle)
    w.stop()
    expect(w.watching).toBe(false)

    state.text = '<B/>'
    state.lastModified = 2
    await vi.advanceTimersByTimeAsync(500)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('fires onError once per failure streak and self-heals when the file returns', async () => {
    const { onChange, onError, state, w } = await watchedFixture()

    // file becomes unreadable → onError fires once, and stays once across further failing polls
    state.fail = true
    await vi.advanceTimersByTimeAsync(100)
    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(w.watching).toBe(true) // the loop survives — it did not stop itself

    // file returns with a new save → onChange fires, error streak resets
    state.fail = false
    state.text = '<B/>'
    state.lastModified = 2
    await vi.advanceTimersByTimeAsync(150)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('<B/>', 'build.xml')

    // a later failure fires onError again (new streak)
    state.fail = true
    await vi.advanceTimersByTimeAsync(150)
    expect(onError).toHaveBeenCalledTimes(2)

    w.stop()
  })

  it('a mid-write text() failure does not skip the save — lastModified holds and the next poll re-delivers it', async () => {
    // Regression for the inverted partial-write guard: lastModified must be committed only AFTER a
    // successful text() read, else a read caught mid-save advances the mtime and the save is lost.
    const { onChange, onError, state, w } = await watchedFixture()

    // a save lands (mtime bumps to 2) but the first read of it throws (PoB still flushing the file)
    state.text = '<B/>'
    state.lastModified = 2
    state.textFail = true
    await vi.advanceTimersByTimeAsync(120)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled() // not delivered yet — lastModified must NOT have advanced

    // the next poll re-reads the now-readable file and delivers the save (proves lastModified stayed at 1)
    await vi.advanceTimersByTimeAsync(120)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('<B/>', 'build.xml')

    w.stop()
  })

  it('a re-pick during an in-flight poll does not deliver the previous file’s content', async () => {
    // Regression for the re-pick race: a poll suspended at getFile() must bail (not fire onChange /
    // not clobber state / not re-arm) once watchHandle has switched to a new handle.
    const onChange = vi.fn()
    let getCalls = 0
    let releasePoll: (() => void) | null = null
    const fileA = (lm: number, text: string) =>
      ({ name: 'A.xml', lastModified: lm, text: async () => text }) as unknown as File
    const handleA: WatchableFileHandle = {
      getFile: () => {
        getCalls += 1
        if (getCalls === 1) return Promise.resolve(fileA(1, '<A/>')) // initial read resolves at once
        return new Promise<File>((resolve) => {
          releasePoll = () => resolve(fileA(2, '<A-CHANGED/>')) // the poll stays pending until released
        })
      },
    }
    const { handle: handleB } = mockHandle({ text: '<B/>', lastModified: 9, name: 'B.xml' })

    const w = createFileWatcher({ onChange, intervalMs: 100 })
    await w.watchHandle(handleA)
    await vi.advanceTimersByTimeAsync(100) // fire the poll → its getFile is now suspended
    expect(releasePoll).not.toBeNull()

    const initialB = await w.watchHandle(handleB) // re-pick B while A's poll is mid-await
    expect(initialB).toEqual({ name: 'B.xml', text: '<B/>' })

    releasePoll!() // resolve A's stale poll AFTER the re-pick
    await vi.advanceTimersByTimeAsync(0) // flush the resumed poll's microtasks

    expect(onChange).not.toHaveBeenCalledWith('<A-CHANGED/>', 'A.xml')
    expect(w.fileName).toBe('B.xml')
    w.stop()
  })

  it('isFileWatchSupported reflects showOpenFilePicker presence (at the top level)', () => {
    expect(isFileWatchSupported()).toBe(false) // jsdom has no File System Access API
    ;(window as unknown as { showOpenFilePicker?: () => void }).showOpenFilePicker = () => {}
    expect(isFileWatchSupported()).toBe(true) // jsdom is a top-level context
    delete (window as unknown as { showOpenFilePicker?: () => void }).showOpenFilePicker
    expect(isFileWatchSupported()).toBe(false)
  })

  it('isFileWatchSupported is false in a (cross-origin) iframe even when showOpenFilePicker exists', () => {
    ;(window as unknown as { showOpenFilePicker?: () => void }).showOpenFilePicker = () => {}
    const realTop = Object.getOwnPropertyDescriptor(window, 'top')
    try {
      Object.defineProperty(window, 'top', { value: {} as Window, configurable: true }) // simulate framing
      expect(window.self !== window.top).toBe(true)
      expect(isFileWatchSupported()).toBe(false) // framed → blocked, must not reveal the Watch tab
    } finally {
      if (realTop) Object.defineProperty(window, 'top', realTop)
      delete (window as unknown as { showOpenFilePicker?: () => void }).showOpenFilePicker
    }
  })
})
