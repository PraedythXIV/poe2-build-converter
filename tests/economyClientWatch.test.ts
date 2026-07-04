// Coverage top-up for two opt-in surfaces whose error/edge branches the primary suites
// (economyClient.test.ts, fileWatch.test.ts) leave unexercised:
//   • src/economy/client.ts — the typed fetchers that don't appear elsewhere (categories /
//     exchange / exchange-history / pairs / reference-currencies), the malformed-200-body
//     path, the real 12 s abort-timeout, and the privacy-mode localStorage throw.
//   • src/watch/fileWatch.ts — the OS file picker (pick) success / cancel / empty / unsupported
//     branches, the visibility re-poll + its re-entry guard, a stop() during the text() read,
//     and the two framed-context detections in isFileWatchSupported.
// Same jsdom + vi.stubGlobal('fetch', …) plumbing as economyClient.test.ts; separate file so it
// never collides with the sibling suites.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  BffError,
  fetchCategories,
  fetchExchangeSnapshot,
  fetchExchangeHistory,
  fetchPairs,
  fetchReferenceCurrencies,
  fetchLeagues,
  fetchUniques,
  getBffBase,
} from '../src/economy/client'
import { createFileWatcher, isFileWatchSupported, type WatchableFileHandle } from '../src/watch/fileWatch'
import { jsonOk, stubFetch } from './helpers/economyStub'

// ─────────────────────────────────────────────────────────────────────────────
// BFF client — the typed fetchers not covered by economyClient.test.ts
// ─────────────────────────────────────────────────────────────────────────────
describe('BFF client — remaining economy routes', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('fetchCategories maps ApiId/Label/Icon, falls back Name→ApiId and Icon→IconUrl→null, and drops id-less rows', async () => {
    const urls = stubFetch(() =>
      jsonOk({
        CurrencyCategories: [
          { ApiId: 'currency', Label: 'Currency', Icon: 'cur.png' }, // Label + Icon straight through
          { ApiId: 'fragments', Name: 'Fragments', IconUrl: 'frag.png' }, // Label→Name, Icon→IconUrl
          { Name: 'no id here' }, // no ApiId → filtered out
          {}, // wholly empty → label falls through to '' → filtered out
        ],
        UniqueCategories: [
          { ApiId: 'weapon' }, // no Label/Name → label falls back to ApiId; no icon → null
        ],
      }),
    )
    const cats = await fetchCategories('Runes of Aldur')
    expect(urls[0]).toBe('http://localhost:8787/api/economy/categories?league=Runes%20of%20Aldur')
    expect(cats.currency).toEqual([
      { apiId: 'currency', label: 'Currency', icon: 'cur.png' },
      { apiId: 'fragments', label: 'Fragments', icon: 'frag.png' },
    ])
    expect(cats.unique).toEqual([{ apiId: 'weapon', label: 'weapon', icon: null }])
  })

  it('fetchCategories tolerates a null body (both lists empty)', async () => {
    stubFetch(() => jsonOk(null))
    expect(await fetchCategories('Standard')).toEqual({ currency: [], unique: [] })
  })

  it('fetchExchangeSnapshot returns the raw market snapshot', async () => {
    const urls = stubFetch(() => jsonOk({ Epoch: 123, Volume: '1000', MarketCap: '5000' }))
    const snap = await fetchExchangeSnapshot('Runes of Aldur')
    expect(urls[0]).toBe('http://localhost:8787/api/economy/exchange?league=Runes%20of%20Aldur')
    expect(snap.MarketCap).toBe('5000')
  })

  it('fetchExchangeHistory unwraps Data and defaults the limit to 336', async () => {
    const urls = stubFetch(() => jsonOk({ Data: [{ Epoch: 1, MarketCap: '1', Volume: '2' }] }))
    const pts = await fetchExchangeHistory('Runes of Aldur')
    expect(urls[0]).toBe('http://localhost:8787/api/economy/exchange-history?league=Runes%20of%20Aldur&limit=336')
    expect(pts).toHaveLength(1)
    expect(pts[0]?.Epoch).toBe(1)
  })

  it('fetchExchangeHistory returns [] when the BFF sends no Data (and honours a custom limit)', async () => {
    const urls = stubFetch(() => jsonOk(null))
    expect(await fetchExchangeHistory('Standard', 24)).toEqual([])
    expect(urls[0]).toContain('limit=24')
  })

  it('fetchPairs hits the pairs route and returns the raw pair rows', async () => {
    const urls = stubFetch(() =>
      jsonOk([
        {
          CurrencyOne: { ApiId: 'exalted', Text: 'Exalted Orb' },
          CurrencyTwo: { ApiId: 'divine', Text: 'Divine Orb' },
        },
      ]),
    )
    const pairs = await fetchPairs('Runes of Aldur')
    expect(urls[0]).toBe('http://localhost:8787/api/economy/pairs?league=Runes%20of%20Aldur')
    expect(pairs[0]?.CurrencyOne.ApiId).toBe('exalted')
  })

  it('fetchReferenceCurrencies lowercases ApiId/apiId and drops blank ids', async () => {
    const urls = stubFetch(() => jsonOk([{ ApiId: 'Exalted' }, { apiId: 'Divine' }, { ApiId: '' }, {}]))
    const refs = await fetchReferenceCurrencies('Runes of Aldur')
    expect(urls[0]).toBe('http://localhost:8787/api/economy/reference-currencies?league=Runes%20of%20Aldur')
    expect(refs).toEqual(['exalted', 'divine'])
  })

  it('fetchReferenceCurrencies tolerates a null body', async () => {
    stubFetch(() => jsonOk(null))
    expect(await fetchReferenceCurrencies('Standard')).toEqual([])
  })

  it('fetchUniques omits the search param when none is given (the else branch of the query builder)', async () => {
    const urls = stubFetch(() => jsonOk({ CurrentPage: 1, Pages: 1, Total: 0, Items: [] }))
    await fetchUniques('Runes of Aldur', 'jewel')
    expect(urls[0]).toBe('http://localhost:8787/api/economy/unique?league=Runes%20of%20Aldur&category=jewel')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BFF client — error + edge plumbing
// ─────────────────────────────────────────────────────────────────────────────
describe('BFF client — error + edge plumbing', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('surfaces a malformed 200 body as an upstream BffError (not a raw SyntaxError)', async () => {
    stubFetch(() => new Response('not json at all', { status: 200, headers: { 'content-type': 'application/json' } }))
    const err = (await fetchLeagues().catch((e: unknown) => e)) as BffError
    expect(err).toBeInstanceOf(BffError)
    expect(err.kind).toBe('upstream')
    expect(err.status).toBe(200)
    expect(err.message).toContain('malformed')
  })

  it('fires the 12 s abort timer and reports the aborted request as unreachable', async () => {
    vi.useFakeTimers()
    try {
      // Never resolves on its own — only the client's abort timer can end it. Rejects when the
      // AbortController fires, exactly like a real fetch() aborted mid-flight.
      vi.stubGlobal('fetch', (_url: string, opts: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        })
      })
      const p = fetchLeagues().catch((e: unknown) => e as BffError)
      await vi.advanceTimersByTimeAsync(12_000) // trip requestOk's FETCH_TIMEOUT_MS abort callback
      const err = await p
      expect(err).toBeInstanceOf(BffError)
      expect((err as BffError).kind).toBe('unreachable')
    } finally {
      vi.useRealTimers()
    }
  })

  it('getBffBase falls back to the default when localStorage is absent entirely (typeof undefined)', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    try {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined })
      expect(getBffBase()).toBe('http://localhost:8787') // safeLocalStorage returns null → default
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })

  it('getBffBase falls back to the default when referencing localStorage throws (privacy mode)', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('SecurityError: storage is disabled')
        },
      })
      // safeLocalStorage() swallows the throw → no stored value → the dev default under vitest.
      expect(getBffBase()).toBe('http://localhost:8787')
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fileWatch — the OS picker (pick) branches
// ─────────────────────────────────────────────────────────────────────────────
type PickerOpts = { multiple?: boolean; types?: Array<{ accept: Record<string, string[]> }> }

function installPicker(fn: (opts?: PickerOpts) => Promise<WatchableFileHandle[]>): void {
  ;(window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = fn
}
function removePicker(): void {
  delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker
}

describe('fileWatch — OS picker (pick)', () => {
  afterEach(() => removePicker())

  it('pick() opens the picker with the .xml/.build filter, reads once, and begins watching', async () => {
    const onChange = vi.fn()
    const file = { name: 'my.build', lastModified: 5, text: async () => '<A/>' } as unknown as File
    const handle: WatchableFileHandle = { getFile: async () => file }
    const picker = vi.fn(async (_opts?: PickerOpts) => [handle])
    installPicker(picker)

    const w = createFileWatcher({ onChange, intervalMs: 100 })
    const initial = await w.pick()
    expect(initial).toEqual({ name: 'my.build', text: '<A/>' })
    expect(w.watching).toBe(true)
    expect(w.fileName).toBe('my.build')

    expect(picker).toHaveBeenCalledTimes(1)
    const opts = picker.mock.calls[0]![0]!
    expect(opts.multiple).toBe(false)
    expect(opts.types?.[0]?.accept['application/xml']).toContain('.xml')
    expect(opts.types?.[0]?.accept['text/plain']).toContain('.build')

    w.stop() // release the poll timer the initial read scheduled
  })

  it('pick() returns null when the File System Access API is absent (unsupported browser)', async () => {
    removePicker()
    const w = createFileWatcher({ onChange: vi.fn() }) // no intervalMs → also exercises the 700 ms default
    expect(await w.pick()).toBeNull()
    expect(w.watching).toBe(false)
  })

  it('pick() returns null (not an error) when the user dismisses the picker / denies permission', async () => {
    installPicker(async () => {
      throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })
    })
    const w = createFileWatcher({ onChange: vi.fn() })
    expect(await w.pick()).toBeNull()
    expect(w.watching).toBe(false)
  })

  it('pick() returns null when the picker resolves with no file', async () => {
    installPicker(async () => [])
    const w = createFileWatcher({ onChange: vi.fn() })
    expect(await w.pick()).toBeNull()
    expect(w.watching).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fileWatch — visibility re-poll, re-entry guard, and a stop() mid-read
// ─────────────────────────────────────────────────────────────────────────────
describe('fileWatch — visibility re-poll + in-flight guards', () => {
  let hiddenDesc: PropertyDescriptor | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    hiddenDesc = Object.getOwnPropertyDescriptor(document, 'hidden')
  })
  afterEach(() => {
    vi.useRealTimers()
    // document.hidden lives on the prototype; delete any own shadow we installed to restore it.
    if (hiddenDesc) Object.defineProperty(document, 'hidden', hiddenDesc)
    else delete (document as unknown as { hidden?: unknown }).hidden
  })
  const setHidden = (v: boolean): void => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => v })
  }

  it('returning to the tab (visibilitychange, not hidden) polls immediately; a re-entrant fire hits the busy guard', async () => {
    setHidden(false)
    const onChange = vi.fn()
    const state = { text: '<A/>', lastModified: 1, name: 'build.xml' }
    const handle: WatchableFileHandle = {
      getFile: async () =>
        ({ name: state.name, lastModified: state.lastModified, text: async () => state.text }) as unknown as File,
    }
    // Interval far larger than anything we advance → only an immediate onVisible poll can deliver.
    const w = createFileWatcher({ onChange, intervalMs: 100_000 })
    await w.watchHandle(handle)
    expect(onChange).not.toHaveBeenCalled()

    state.text = '<B/>'
    state.lastModified = 2
    document.dispatchEvent(new Event('visibilitychange')) // poll #1 starts, sets busy, suspends at getFile
    document.dispatchEvent(new Event('visibilitychange')) // poll #2 bails at the busy re-entry guard
    await vi.advanceTimersByTimeAsync(0) // flush poll #1's microtasks (NOT the 100 s interval)

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('<B/>', 'build.xml')
    w.stop()
  })

  it('a visibilitychange while the tab is still hidden does not poll', async () => {
    setHidden(true)
    const onChange = vi.fn()
    const state = { text: '<A/>', lastModified: 1 }
    const handle: WatchableFileHandle = {
      getFile: async () =>
        ({ name: 'build.xml', lastModified: state.lastModified, text: async () => state.text }) as unknown as File,
    }
    const w = createFileWatcher({ onChange, intervalMs: 100_000 })
    await w.watchHandle(handle)

    state.text = '<B/>'
    state.lastModified = 2
    document.dispatchEvent(new Event('visibilitychange')) // onVisible sees document.hidden → no poll
    await vi.advanceTimersByTimeAsync(0)
    expect(onChange).not.toHaveBeenCalled()
    w.stop()
  })

  it('a stop() during the text() read abandons the poll — no onChange, mtime not committed', async () => {
    const onChange = vi.fn()
    let releaseText: (() => void) | null = null
    let getCount = 0
    const handle: WatchableFileHandle = {
      getFile: async () => {
        getCount += 1
        if (getCount === 1) {
          return { name: 'build.xml', lastModified: 1, text: async () => '<A/>' } as unknown as File
        }
        // A newer save (mtime 2) whose text() stays pending until we release it — long enough to stop() first.
        return {
          name: 'build.xml',
          lastModified: 2,
          text: () => new Promise<string>((resolve) => (releaseText = () => resolve('<B/>'))),
        } as unknown as File
      },
    }
    const w = createFileWatcher({ onChange, intervalMs: 100 })
    await w.watchHandle(handle) // initial read (getCount 1)
    await vi.advanceTimersByTimeAsync(100) // poll fires (getCount 2) → suspends awaiting text()
    expect(releaseText).not.toBeNull()

    w.stop() // running=false / handle=null while text() is still in flight
    releaseText!() // resolve the read AFTER stop → the post-text() guard must bail
    await vi.advanceTimersByTimeAsync(0)
    expect(onChange).not.toHaveBeenCalled()
    expect(w.watching).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fileWatch — the two framed-context detections in isFileWatchSupported
// ─────────────────────────────────────────────────────────────────────────────
describe('fileWatch — isFileWatchSupported framing detection', () => {
  afterEach(() => removePicker())

  it('is false when ancestorOrigins reveals a framed context (Chromium signal)', () => {
    installPicker(async () => [])
    const original = Object.getOwnPropertyDescriptor(window.location, 'ancestorOrigins')
    try {
      Object.defineProperty(window.location, 'ancestorOrigins', {
        configurable: true,
        get: () => ({ length: 1 }) as unknown as DOMStringList,
      })
      expect(isFileWatchSupported()).toBe(false)
    } finally {
      if (original) Object.defineProperty(window.location, 'ancestorOrigins', original)
      else delete (window.location as unknown as { ancestorOrigins?: unknown }).ancestorOrigins
    }
  })

  it('is false when reading window.top throws (sandboxed cross-origin frame)', () => {
    installPicker(async () => [])
    const original = Object.getOwnPropertyDescriptor(window, 'top')
    try {
      Object.defineProperty(window, 'top', {
        configurable: true,
        get() {
          throw new Error('SecurityError: cross-origin')
        },
      })
      expect(isFileWatchSupported()).toBe(false) // the try/catch swallows the throw → unsupported
    } finally {
      if (original) Object.defineProperty(window, 'top', original)
      else delete (window as unknown as { top?: unknown }).top
    }
  })
})
