// B4 — DOM tests for the Currency Exchange view (src/economy/exchange.ts). Mounts the real
// mountExchangeView() into a container, stubs the four BFF fetches with canned Responses, and
// asserts on the rendered head/stats/chart/pairs-table plus the sort · search · paginate
// interaction handlers. Runs in jsdom; every fetch is stubbed (zero real network), unstubbed
// after each test. The numbers are pinned against the exact poe2scout formatting + the faithful
// normalizeSnapshotPair orientation/rate reimplementation the view ports.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mountExchangeView } from '../src/economy/exchange'
import type { ScoutExchange, ScoutHistoryPoint, ScoutLeague, ScoutPair } from '../src/economy/client'

// ── stub plumbing ────────────────────────────────────────────────────────────
function jsonOk(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

type Handler = () => Response | Promise<Response>
interface Routes {
  exchange?: Handler
  history?: Handler
  pairs?: Handler
  refs?: Handler
}

/** Route the four economy fetches to per-route handlers (history is checked first because its
 *  path is a superstring of the exchange path). Returns the ordered list of requested URLs. */
function stubRoutes(routes: Routes): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const pick = url.includes('/api/economy/exchange-history')
      ? routes.history
      : url.includes('/api/economy/exchange')
        ? routes.exchange
        : url.includes('/api/economy/pairs')
          ? routes.pairs
          : url.includes('/api/economy/reference-currencies')
            ? routes.refs
            : undefined
    if (!pick) return Promise.reject(new Error(`unexpected route ${url}`))
    return Promise.resolve(pick())
  })
  return urls
}

// ── canned data ──────────────────────────────────────────────────────────────
const LEAGUE: ScoutLeague = {
  Value: 'Runes of Aldur',
  ShortName: 'RoA',
  IsCurrent: true,
  DivinePrice: null,
  ChaosDivinePrice: null,
  BaseCurrencyApiId: 'exalted',
  BaseCurrencyText: 'Exalted Orb',
  BaseCurrencyIconUrl: 'https://cdn.example/ex.png',
}

const REFS = [{ ApiId: 'exalted' }, { ApiId: 'chaos' }, { ApiId: 'divine' }]

const SNAPSHOT: ScoutExchange = {
  Epoch: 1_700_000_000,
  Volume: '123456',
  MarketCap: '9876543',
  BaseCurrencyText: 'Exalted Orb',
}

const HISTORY: ScoutHistoryPoint[] = [
  { Epoch: 1000, MarketCap: '100', Volume: '10' },
  { Epoch: 2000, MarketCap: '200', Volume: '20' },
  { Epoch: 3000, MarketCap: '150', Volume: '15' },
]

// Four pairs, each exercising a distinct normalizePair branch:
//   A both-base (exalted+divine)        → lower-volume first, rate = 1000/100 = 10
//   B one-base, currencyOne non-base    → non-base first,      rate = 5000/5  = 1000
//   C one-base, currencyOne IS the base → non-base first,      rate = 8000/40 = 200
//   D non-base first with 0 volumeTraded → rate 0 → "—" cell
const PAIRS: ScoutPair[] = [
  {
    Volume: '500',
    CurrencyOne: { ApiId: 'exalted', Text: 'Exalted Orb', IconUrl: 'https://cdn.example/ex.png' },
    CurrencyTwo: { ApiId: 'divine', Text: 'Divine Orb', IconUrl: null },
    CurrencyOneData: { VolumeTraded: 100 },
    CurrencyTwoData: { VolumeTraded: 1000 },
  },
  {
    Volume: '3000',
    CurrencyOne: { ApiId: 'mirror', Text: 'Mirror of Kalandra', IconUrl: 'https://cdn.example/mirror.png' },
    CurrencyTwo: { ApiId: 'exalted', Text: 'Exalted Orb', IconUrl: 'https://cdn.example/ex.png' },
    CurrencyOneData: { VolumeTraded: 5 },
    CurrencyTwoData: { VolumeTraded: 5000 },
  },
  {
    Volume: '1000',
    CurrencyOne: { ApiId: 'exalted', Text: 'Exalted Orb' },
    CurrencyTwo: { ApiId: 'regal', Text: 'Regal Orb' },
    CurrencyOneData: { VolumeTraded: 8000 },
    CurrencyTwoData: { VolumeTraded: 40 },
  },
  {
    Volume: '10',
    CurrencyOne: { ApiId: 'zerocoin', Text: 'Zero Coin' },
    CurrencyTwo: { ApiId: 'exalted', Text: 'Exalted Orb' },
    CurrencyOneData: { VolumeTraded: 0 },
    CurrencyTwoData: { VolumeTraded: 100 },
  },
]

/** Stub all four routes; each override replaces one canned response (an explicit `[]`/`{}` wins
 *  over the default because `??` only falls through on null/undefined). */
function happy(overrides?: { snapshot?: unknown; history?: unknown; pairs?: unknown; refs?: unknown }): string[] {
  return stubRoutes({
    exchange: () => jsonOk(overrides?.snapshot ?? SNAPSHOT),
    history: () => jsonOk({ Data: overrides?.history ?? HISTORY }),
    pairs: () => jsonOk(overrides?.pairs ?? PAIRS),
    refs: () => jsonOk(overrides?.refs ?? REFS),
  })
}

/** Happy history/pairs/refs, but route `exchange` to a custom handler — the error-state tests use
 *  this to inject an upstream failure / a rejected fetch on the exchange snapshot specifically. */
function stubExchangeError(exchange: Handler): string[] {
  return stubRoutes({
    exchange,
    history: () => jsonOk({ Data: HISTORY }),
    pairs: () => jsonOk(PAIRS),
    refs: () => jsonOk(REFS),
  })
}

// ── fixture ──────────────────────────────────────────────────────────────────
let container: HTMLElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})
afterEach(() => {
  vi.unstubAllGlobals()
  container.remove()
})

const pairTexts = (): string[] => [...container.querySelectorAll('tbody tr .ex-pair')].map((e) => e.textContent ?? '')
const rowCells = (i: number): HTMLTableCellElement[] =>
  [...container.querySelectorAll('tbody tr')[i]!.querySelectorAll('td')] as HTMLTableCellElement[]

describe('mountExchangeView — loading state', () => {
  it('shows the vendored skeleton with the league in an sr-only status before the fetches resolve', async () => {
    happy()
    const p = mountExchangeView(container, LEAGUE) // do NOT await — skeleton is set synchronously first
    expect(container.querySelector('.ec-loading-sk')?.getAttribute('role')).toBe('status')
    expect(container.querySelector('.sr-only')?.textContent).toBe('Loading Runes of Aldur market…')
    await p
    expect(container.querySelector('.ec-loading-sk')).toBeNull() // replaced by the real view
  })
})

describe('mountExchangeView — successful render', () => {
  let urls: string[]
  beforeEach(async () => {
    urls = happy()
    await mountExchangeView(container, LEAGUE)
  })

  it('requests all four BFF economy routes against the dev base with the league URL-encoded', () => {
    expect(urls.sort()).toEqual([
      'http://localhost:8787/api/economy/exchange-history?league=Runes%20of%20Aldur&limit=336',
      'http://localhost:8787/api/economy/exchange?league=Runes%20of%20Aldur',
      'http://localhost:8787/api/economy/pairs?league=Runes%20of%20Aldur',
      'http://localhost:8787/api/economy/reference-currencies?league=Runes%20of%20Aldur',
    ])
  })

  it('renders the market head: title, "last updated" sub, and the base-currency icon', () => {
    expect(container.querySelector('.ex-title h3')?.textContent).toBe('Runes of Aldur Market')
    // Epoch present → the "Last updated <local time>" sub (exact time is locale/TZ dependent)
    expect(container.querySelector('.ex-sub')?.textContent).toContain('Last updated')
    const baseIco = container.querySelector<HTMLImageElement>('.ex-base-ico')
    expect(baseIco).not.toBeNull()
    expect(baseIco!.getAttribute('src')).toBe('https://cdn.example/ex.png')
  })

  it('renders both stat boxes with the poe2scout integer formatting of the snapshot numbers', () => {
    const stats = container.querySelectorAll('.ex-stat')
    expect(stats.length).toBe(2)
    expect(stats[0]!.textContent).toContain('Hourly Volume')
    expect(stats[0]!.textContent).toContain('123,456') // Number('123456') → thousands separators
    expect(stats[1]!.textContent).toContain('Market Cap')
    expect(stats[1]!.textContent).toContain('9,876,543')
  })

  it('renders the history chart (cap polyline + one volume bar per point) when ≥2 points exist', () => {
    const chart = container.querySelector('.ex-chart')
    expect(chart).not.toBeNull()
    expect(chart!.querySelector('polyline.ex-cap')).not.toBeNull()
    expect(chart!.querySelectorAll('.ex-vol rect').length).toBe(3)
    expect(chart!.querySelector('figcaption')?.textContent).toContain('3 hourly points')
    // aria-label carries the last (time-sorted) market-cap value: Epoch 3000 → cap 150
    expect(chart!.querySelector('svg')?.getAttribute('aria-label')).toBe('Market cap 150 exalted over time')
  })

  it('lists every trading pair with the count, and sorts by volume desc by default', () => {
    expect(container.querySelector('#ex-pairs-count')?.textContent).toBe('4 current pairs')
    expect(container.querySelectorAll('tbody tr').length).toBe(4)
    // default sort = volume desc → 3000, 1000, 500, 10
    expect(pairTexts()).toEqual([
      'Mirror of Kalandra/Exalted Orb',
      'Regal Orb/Exalted Orb',
      'Exalted Orb/Divine Orb',
      'Zero Coin/Exalted Orb',
    ])
    // the volume header carries the active aria-sort; the pair header none
    expect(container.querySelector('[data-sort="volume"]')?.getAttribute('aria-sort')).toBe('descending')
    expect(container.querySelector('[data-sort="pair"]')?.getAttribute('aria-sort')).toBe('none')
  })

  it('computes each pair rate + orientation exactly per normalizeSnapshotPair, formatting volumes', () => {
    // row 0 = Mirror (one-base, currencyOne non-base): rate 5000/5 = 1000, volume 3000
    const mirror = rowCells(0)
    expect(mirror[1]!.textContent).toBe('1=1,000') // "1 =[icons] 1,000"
    expect(mirror[2]!.textContent).toBe('3,000')
    expect(container.querySelector('tbody tr .ex-rate')?.getAttribute('title')).toBe(
      '1 Mirror of Kalandra = 1,000 Exalted Orb',
    )
    // row 1 = Regal (currencyOne IS the base → non-base shown first): rate 8000/40 = 200
    expect(rowCells(1)[1]!.textContent).toBe('1=200')
    expect(rowCells(1)[2]!.textContent).toBe('1,000')
    // row 2 = Exalted/Divine (both base, lower volume first): rate 1000/100 = 10
    expect(rowCells(2)[1]!.textContent).toBe('1=10')
    expect(rowCells(2)[2]!.textContent).toBe('500')
    // row 3 = Zero Coin (fromVolume 0 → rate 0): rate cell collapses to an em dash
    expect(rowCells(3)[1]!.textContent).toBe('—')
    expect(rowCells(3)[2]!.textContent).toBe('10')
  })

  it('renders currency icons or a placeholder per curName branch', () => {
    // Exalted has an IconUrl → an <img.ec-icon>; Divine's is null → an .ec-icon-ph placeholder
    expect(container.querySelector('tbody img.ec-icon')).not.toBeNull()
    expect(container.querySelector('tbody .ec-icon-ph')).not.toBeNull()
    // the rate cell also renders its currency icon (ex-rate-ico) for a pair whose sides have art
    expect(container.querySelector('.ex-rate .ex-rate-ico')).not.toBeNull()
  })

  it('renders a single-page pager with both chevrons disabled and the page/total line', () => {
    expect(container.querySelector('.ec-pginfo')?.textContent).toBe('Page 1 of 1 · 4 pairs')
    expect(container.querySelector<HTMLButtonElement>('.ec-pg[data-pg="prev"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('.ec-pg[data-pg="next"]')?.disabled).toBe(true)
  })
})

describe('mountExchangeView — sort handler', () => {
  beforeEach(async () => {
    happy()
    await mountExchangeView(container, LEAGUE)
  })

  const clickSort = (col: string): void => {
    container.querySelector<HTMLButtonElement>(`[data-sort="${col}"] .dt-sort`)!.click()
  }

  it('clicking the Trading Pair header sorts name asc, then desc on a second click', () => {
    clickSort('pair')
    expect(container.querySelector('[data-sort="pair"]')?.getAttribute('aria-sort')).toBe('ascending')
    expect(pairTexts()).toEqual([
      'Exalted Orb/Divine Orb',
      'Mirror of Kalandra/Exalted Orb',
      'Regal Orb/Exalted Orb',
      'Zero Coin/Exalted Orb',
    ])
    clickSort('pair')
    expect(container.querySelector('[data-sort="pair"]')?.getAttribute('aria-sort')).toBe('descending')
    expect(pairTexts()).toEqual([
      'Zero Coin/Exalted Orb',
      'Regal Orb/Exalted Orb',
      'Mirror of Kalandra/Exalted Orb',
      'Exalted Orb/Divine Orb',
    ])
  })

  it('clicking the Volume header (already desc) flips it to volume asc', () => {
    clickSort('volume')
    expect(container.querySelector('[data-sort="volume"]')?.getAttribute('aria-sort')).toBe('ascending')
    // volume asc → 10, 500, 1000, 3000
    expect(pairTexts()).toEqual([
      'Zero Coin/Exalted Orb',
      'Exalted Orb/Divine Orb',
      'Regal Orb/Exalted Orb',
      'Mirror of Kalandra/Exalted Orb',
    ])
  })
})

describe('mountExchangeView — search handler', () => {
  beforeEach(async () => {
    happy()
    // The input handler coalesces on requestAnimationFrame (`if (raf) return`). Run it
    // synchronously AND return 0 as the handle: the callback resets `raf` to 0, and the 0 return
    // keeps the post-assignment guard falsy, so each search() renders deterministically in-test.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    await mountExchangeView(container, LEAGUE)
  })

  const search = (q: string): void => {
    const el = container.querySelector<HTMLInputElement>('.ex-search')!
    el.value = q
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('filters by currency text and updates the count', () => {
    search('mirror')
    expect(pairTexts()).toEqual(['Mirror of Kalandra/Exalted Orb'])
    expect(container.querySelector('#ex-pairs-count')?.textContent).toBe('1 current pairs')
  })

  it('matches on the currency apiId, not just the display text', () => {
    search('regal') // matches "Regal Orb" + apiId "regal"
    expect(pairTexts()).toEqual(['Regal Orb/Exalted Orb'])
  })

  it('shows the no-match empty row when nothing matches, then restores on clear', () => {
    search('zzz-no-such-currency')
    expect(container.querySelectorAll('tbody tr .ex-pair').length).toBe(0)
    expect(container.querySelector('.ec-empty')?.textContent).toBe('No trading pairs match your search.')
    expect(container.querySelector('#ex-pairs-count')?.textContent).toBe('0 current pairs')
    search('')
    expect(pairTexts().length).toBe(4)
  })
})

describe('mountExchangeView — pagination handler', () => {
  // 23 non-base-first pairs (deterministic orientation), volumes 10..230 so the desc order is stable
  const manyPairs: ScoutPair[] = Array.from({ length: 23 }, (_, i) => ({
    Volume: String((i + 1) * 10),
    CurrencyOne: { ApiId: `coin${i + 1}`, Text: `Coin ${i + 1}` },
    CurrencyTwo: { ApiId: 'exalted', Text: 'Exalted Orb' },
    CurrencyOneData: { VolumeTraded: i + 1 },
    CurrencyTwoData: { VolumeTraded: (i + 1) * 2 },
  }))

  beforeEach(async () => {
    happy({ pairs: manyPairs })
    await mountExchangeView(container, LEAGUE)
  })

  const pgInfo = (): string | undefined => container.querySelector('.ec-pginfo')?.textContent ?? undefined
  const rowCount = (): number => container.querySelectorAll('tbody tr').length
  const setRows = (n: string): void => {
    const sel = container.querySelector<HTMLSelectElement>('.ec-rows-sel')!
    sel.value = n
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const clickPg = (dir: 'prev' | 'next'): void => {
    container.querySelector<HTMLButtonElement>(`.ec-pg[data-pg="${dir}"]`)!.click()
  }

  it('fits all 23 rows on one page at the default 25-per-page', () => {
    expect(rowCount()).toBe(23)
    expect(pgInfo()).toBe('Page 1 of 1 · 23 pairs')
  })

  it('re-paginates when rows-per-page changes, and next/prev walk the pages', () => {
    setRows('10') // 23 / 10 → 3 pages, back to page 1
    expect(rowCount()).toBe(10)
    expect(pgInfo()).toBe('Page 1 of 3 · 23 pairs')
    expect(container.querySelector<HTMLButtonElement>('.ec-pg[data-pg="prev"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('.ec-pg[data-pg="next"]')?.disabled).toBe(false)

    clickPg('next')
    expect(pgInfo()).toBe('Page 2 of 3 · 23 pairs')
    expect(rowCount()).toBe(10)

    clickPg('next')
    expect(pgInfo()).toBe('Page 3 of 3 · 23 pairs')
    expect(rowCount()).toBe(3) // remainder
    expect(container.querySelector<HTMLButtonElement>('.ec-pg[data-pg="next"]')?.disabled).toBe(true)

    clickPg('prev')
    expect(pgInfo()).toBe('Page 2 of 3 · 23 pairs')
  })
})

describe('mountExchangeView — degraded snapshot', () => {
  it('falls back to the snapshot label + em-dash stats + the "ex" text icon when data is missing', async () => {
    happy({ snapshot: { Epoch: 0, Volume: '', MarketCap: '' } })
    await mountExchangeView(container, { ...LEAGUE, BaseCurrencyIconUrl: null })
    // Epoch 0 (falsy) → the generic snapshot label instead of "Last updated …"
    expect(container.querySelector('.ex-sub')?.textContent).toBe('poe2scout exchange snapshot')
    // empty Volume/MarketCap → NaN → formatNumber renders the em dash
    const stats = container.querySelectorAll('.ex-stat-v')
    expect(stats[0]!.textContent).toContain('—')
    expect(stats[1]!.textContent).toContain('—')
    // no BaseCurrencyIconUrl → the small "ex" text fallback, not an <img>
    expect(container.querySelector('.ex-base-ico')).toBeNull()
    expect(container.querySelector('.ex-base-ex')?.textContent).toBe('ex')
  })

  it('renders no chart when history has fewer than two points', async () => {
    happy({ history: [] })
    await mountExchangeView(container, LEAGUE)
    expect(container.querySelector('.ex-chart')).toBeNull()
    // the rest of the view still renders
    expect(container.querySelector('.ex-head')).not.toBeNull()
  })
})

describe('mountExchangeView — error state', () => {
  it('renders the error surface with the BffError message when a fetch fails upstream', async () => {
    // exchange returns an upstream 503 (the BFF's {error,status} shape); the rest stay happy
    stubExchangeError(() => jsonOk({ error: 'upstream_error', status: 503, upstream: 'api.poe2scout.com' }, 503))
    await mountExchangeView(container, LEAGUE)
    expect(container.querySelector('.es--error')).not.toBeNull()
    expect(container.querySelector('.es-title')?.textContent).toBe("Couldn't load prices")
    expect(container.querySelector('.es-desc')?.textContent).toBe('Proxy request failed (HTTP 503).')
    expect(container.querySelector('.ex-pairs')).toBeNull() // the table never renders
  })

  it('surfaces the unreachable BffError (with the serve:bff hint) when the BFF does not answer', async () => {
    stubExchangeError(() => Promise.reject(new TypeError('fetch failed')))
    await mountExchangeView(container, LEAGUE)
    expect(container.querySelector('.es-title')?.textContent).toBe("Couldn't load prices")
    expect(container.querySelector('.es-desc')?.textContent).toContain('serve:bff')
  })

  it('falls back to the generic message when a non-BffError escapes (malformed reference payload)', async () => {
    // reference-currencies returns an object, not an array → fetchReferenceCurrencies throws a
    // TypeError (not a BffError) → the ternary picks the generic exCouldNotLoad copy
    stubRoutes({
      exchange: () => jsonOk(SNAPSHOT),
      history: () => jsonOk({ Data: HISTORY }),
      pairs: () => jsonOk(PAIRS),
      refs: () => jsonOk({ not: 'an array' }),
    })
    await mountExchangeView(container, LEAGUE)
    expect(container.querySelector('.es-desc')?.textContent).toBe('Could not load the market.')
  })
})
