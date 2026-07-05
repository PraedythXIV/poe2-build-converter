// B4 — DOM tests for the economy BROWSE panel (src/economy/panel.ts) + the shared loading/empty/
// error renderers (src/economy/states.ts). Mounts the real panel into a container, drives a browse
// flow with STUBBED BFF responses (loading → results → empty → error), and asserts the rendered
// rows / skeleton / empty-state DOM. Runs in jsdom; every fetch is stubbed (zero real network).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderEconomyPanel, wireEconomyPanel } from '../src/economy/panel'
import { skeletonLoading, emptyState, errorState, PG_PREV_SVG, PG_NEXT_SVG } from '../src/economy/states'
import { copy } from '../src/copy'

// ── fetch stubbing ───────────────────────────────────────────────────────────────
function jsonOk(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}
/** A BFF upstream-error body (the worker mirrors upstream failures as {error, status}). */
function upstream(status: number): Response {
  return jsonOk({ error: 'upstream_error', status, upstream: 'api.poe2scout.com' }, status)
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function installFetch(dispatch: (url: string) => Response | Promise<Response>): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return Promise.resolve(dispatch(url))
  })
  return calls
}

// ── fixtures (poe2scout response shapes, from the live-capture types in client.ts) ──
// Two "current" leagues: the HC variant (runeshc ShortName) must be skipped by pickCurrentLeague,
// leaving the softcore "Runes of Aldur" with its 200-ex divine price.
const LEAGUES = [
  {
    Value: 'HC Runes of Aldur',
    ShortName: 'runeshc',
    IsCurrent: true,
    DivinePrice: 200,
    ChaosDivinePrice: null,
    BaseCurrencyApiId: 'exalted',
    BaseCurrencyText: 'Exalted Orb',
  },
  {
    Value: 'Runes of Aldur',
    ShortName: 'runes',
    IsCurrent: true,
    DivinePrice: 200,
    ChaosDivinePrice: null,
    BaseCurrencyApiId: 'exalted',
    BaseCurrencyText: 'Exalted Orb',
  },
]
const LEAGUES_NO_DIV = LEAGUES.map((l) => ({ ...l, DivinePrice: null }))

// Category icons: one has an icon URL (→ <img>), one is null (→ styled placeholder) in each group.
// Unique group uses the Name/IconUrl aliases to exercise mapCategory's field fallbacks.
const CATEGORIES = {
  CurrencyCategories: [
    { ApiId: 'currency', Label: 'Currency', Icon: 'https://cdn.example/curr.webp' },
    { ApiId: 'fragments', Label: 'Fragments', Icon: null },
  ],
  UniqueCategories: [
    { ApiId: 'weapon', Name: 'Weapons', IconUrl: 'https://cdn.example/wep.webp' },
    { ApiId: 'jewel', Label: 'Jewels', Icon: null },
  ],
}

// Four currency rows exercising every cell branch: an iconned multi-log row (250 ex → fmtNum ≥100,
// div ratio 1.25 ≥ 0.1 → div text, rising sparkline), a single-log row (15 ex → fmtNum ≥10, no
// sparkline "—"), a mixed-with-null-logs row (3.5 ex → fmtNum <10, falling sparkline), and a
// fully-unpriced row (all-null logs) that the rows.filter drops.
const CURRENCY_PAGE = {
  CurrentPage: 1,
  Pages: 1,
  Total: 4,
  Items: [
    {
      ApiId: 'mirror',
      Text: 'Mirror of Kalandra',
      CategoryApiId: 'currency',
      IconUrl: 'https://cdn.example/mirror.webp',
      PriceLogs: [
        { Price: 250, Time: '2026-06-12T00:00:00', Quantity: 1234 },
        { Price: 200, Time: '2026-06-11T00:00:00', Quantity: 1000 },
        { Price: 180, Time: '2026-06-10T00:00:00', Quantity: 900 },
      ],
    },
    {
      ApiId: 'divine',
      Text: 'Divine Orb',
      CategoryApiId: 'currency',
      IconUrl: null,
      PriceLogs: [{ Price: 15, Time: '2026-06-12T00:00:00', Quantity: 50 }],
    },
    {
      ApiId: 'exalted',
      Text: 'Exalted Orb',
      CategoryApiId: 'currency',
      IconUrl: null,
      PriceLogs: [
        { Price: 3.5, Time: '2026-06-12T00:00:00', Quantity: 9 },
        { Price: 4, Time: '2026-06-11T00:00:00', Quantity: 8 },
        null,
      ],
    },
    {
      ApiId: 'dead',
      Text: 'No Price Currency',
      CategoryApiId: 'currency',
      IconUrl: null,
      PriceLogs: [null, null],
    },
  ],
}

// A page whose only row has no live price points → the panel filters it out → "no priced items".
const EMPTY_CURRENCY_PAGE = {
  CurrentPage: 1,
  Pages: 1,
  Total: 1,
  Items: [{ ApiId: 'x', Text: 'Unpriced', CategoryApiId: 'fragments', IconUrl: null, PriceLogs: [null, null] }],
}

const UNIQUE_PAGE = {
  CurrentPage: 1,
  Pages: 1,
  Total: 2,
  Items: [
    {
      Name: 'Temporalis',
      Text: 'Temporalis Silk Robe',
      Type: 'Silk Robe',
      CategoryApiId: 'armour',
      IconUrl: 'https://cdn.example/temp.webp',
      PriceLogs: [
        { Price: 120, Time: '2026-06-12T00:00:00', Quantity: 3 },
        { Price: 100, Time: '2026-06-11T00:00:00', Quantity: 2 },
      ],
    },
    {
      Name: 'Wanderlust',
      Text: 'Wanderlust Wool Shoes',
      CategoryApiId: 'armour',
      IconUrl: null,
      PriceLogs: [{ Price: 5, Time: '2026-06-12T00:00:00', Quantity: 40 }],
    },
  ],
}

function currencyPage(n: number): unknown {
  return {
    CurrentPage: 1,
    Pages: 1,
    Total: n,
    Items: Array.from({ length: n }, (_, i) => ({
      ApiId: `c${i}`,
      Text: `Currency ${i}`,
      CategoryApiId: 'currency',
      IconUrl: i % 2 ? null : `https://cdn.example/${i}.webp`,
      PriceLogs: [
        { Price: 10 + i, Time: '2026-06-12T00:00:00', Quantity: 100 + i },
        { Price: 9 + i, Time: '2026-06-11T00:00:00', Quantity: 90 + i },
      ],
    })),
  }
}

/** Base BFF dispatcher: leagues + categories always resolve; currency/unique/exchange are overridable. */
function makeDispatch(
  opts: {
    leagues?: unknown
    currency?: (url: string) => Response | Promise<Response>
    unique?: (url: string) => Response | Promise<Response>
    exchange?: (url: string) => Response | Promise<Response>
  } = {},
): (url: string) => Response | Promise<Response> {
  return (url: string) => {
    if (url.includes('/api/economy/leagues')) return jsonOk(opts.leagues ?? LEAGUES)
    if (url.includes('/api/economy/categories')) return jsonOk(CATEGORIES)
    if (url.includes('/api/economy/currency')) return (opts.currency ?? (() => jsonOk(CURRENCY_PAGE)))(url)
    if (url.includes('/api/economy/unique')) return (opts.unique ?? (() => jsonOk(UNIQUE_PAGE)))(url)
    // exchange snapshot / history / pairs / reference-currencies — default to an upstream error so the
    // exchange view mounts quickly into its `.es--error` state (this suite is about the browse panel).
    return (opts.exchange ?? (() => upstream(503)))(url)
  }
}

// ── mount helper ───────────────────────────────────────────────────────────────
interface Mounted {
  root: HTMLElement
  side: HTMLElement
  main: HTMLElement
  exchange: HTMLElement
  app: HTMLElement
  landing: HTMLElement
  status: HTMLElement
  clickEnter: (target: string) => void
}
function mountPanel(): Mounted {
  const root = document.createElement('div')
  root.innerHTML = renderEconomyPanel()
  document.body.appendChild(root)
  wireEconomyPanel(root)
  const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!
  return {
    root,
    side: q('#ec-side'),
    main: q('#ec-main'),
    exchange: q('#ec-exchange'),
    app: q('#ec-app'),
    landing: q('#ec-landing'),
    status: q('#ec-status'),
    clickEnter: (target: string) => q<HTMLButtonElement>(`.ec-enter[data-enter="${target}"]`).click(),
  }
}
const clickCat = (side: HTMLElement, group: string, cat: string): void =>
  side.querySelector<HTMLButtonElement>(`.ec-cat[data-group="${group}"][data-cat="${cat}"]`)!.click()

/** Mount the panel, enter the economy tab, and wait for the first currency table to render. */
async function enterEconomy(): Promise<Mounted> {
  const m = mountPanel()
  m.clickEnter('economy')
  await vi.waitFor(() => expect(m.main.querySelector('.ec-table')).not.toBeNull(), { timeout: 3000 })
  return m
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// ── states.ts direct unit tests ──────────────────────────────────────────────────
describe('economy states helpers', () => {
  it('skeletonLoading renders n sk-rows in an aria-live status with an escaped sr-only label', () => {
    const wrap = document.createElement('div')
    wrap.innerHTML = skeletonLoading('Loading <Currency> & prices…')
    const region = wrap.querySelector('.ec-loading-sk')!
    expect(region.getAttribute('role')).toBe('status')
    expect(wrap.querySelectorAll('.sk-list .sk-row').length).toBe(6) // default n
    // each bone row carries the icon / line / badge parts, and the line has a % width
    const first = wrap.querySelector('.sk-row')!
    expect(first.querySelector('.sk-ico')).not.toBeNull()
    expect(first.querySelector<HTMLElement>('.sk-line')!.style.width).toMatch(/%$/)
    expect(first.querySelector('.sk-badge')).not.toBeNull()
    // the label is escaped (no live < > & survive into the sr-only span)
    const sr = wrap.querySelector('.sr-only')!
    expect(sr.textContent).toBe('Loading <Currency> & prices…')
    expect(wrap.innerHTML).toContain('&lt;Currency&gt;')
    expect(wrap.innerHTML).not.toContain('<Currency>')
  })

  it('skeletonLoading honours a custom row count', () => {
    const wrap = document.createElement('div')
    wrap.innerHTML = skeletonLoading('x', 3)
    expect(wrap.querySelectorAll('.sk-row').length).toBe(3)
  })

  it('emptyState("results") uses the warning es--results class + the search glyph, escaping title/desc', () => {
    const wrap = document.createElement('div')
    wrap.innerHTML = emptyState('results', 'No <b>hits</b>', 'Nothing & nobody')
    const es = wrap.querySelector('.es')!
    expect(es.classList.contains('es--results')).toBe(true)
    expect(es.classList.contains('es--error')).toBe(false)
    expect(es.classList.contains('ec-state')).toBe(true)
    expect(wrap.querySelector('.es-glyph svg circle')).not.toBeNull() // magnifier glyph
    expect(wrap.querySelector('.es-title')!.textContent).toBe('No <b>hits</b>') // decoded, so it was escaped
    expect(wrap.querySelector('.es-desc')!.textContent).toBe('Nothing & nobody')
    expect(wrap.innerHTML).toContain('&lt;b&gt;hits&lt;/b&gt;')
  })

  it('emptyState("error") uses the danger es--error class + the alert glyph', () => {
    const wrap = document.createElement('div')
    wrap.innerHTML = emptyState('error', 'Boom', 'It broke')
    const es = wrap.querySelector('.es')!
    expect(es.classList.contains('es--error')).toBe(true)
    // the alert glyph has a triangle path, the search glyph has a <circle> — assert we got the triangle
    expect(wrap.querySelector('.es-glyph svg circle')).toBeNull()
    expect(wrap.querySelector('.es-glyph svg path')).not.toBeNull()
  })

  it('errorState wraps a thrown message in the error empty-state under the load-error title', () => {
    const wrap = document.createElement('div')
    wrap.innerHTML = errorState('Proxy request failed (HTTP <503>).')
    const es = wrap.querySelector('.es')!
    expect(es.classList.contains('es--error')).toBe(true)
    expect(wrap.querySelector('.es-title')!.textContent).toBe(copy.economy.loadErrorTitle)
    expect(wrap.querySelector('.es-desc')!.textContent).toBe('Proxy request failed (HTTP <503>).')
    expect(wrap.innerHTML).toContain('&lt;503&gt;') // message escaped
  })

  it('PG_PREV_SVG and PG_NEXT_SVG are distinct chevron SVGs', () => {
    expect(PG_PREV_SVG).toContain('<svg')
    expect(PG_NEXT_SVG).toContain('<svg')
    expect(PG_PREV_SVG).toContain('M15 6l-6 6 6 6') // left chevron
    expect(PG_NEXT_SVG).toContain('M9 6l6 6-6 6') // right chevron
    expect(PG_PREV_SVG).not.toBe(PG_NEXT_SVG)
  })
})

// ── panel.ts browse flow ──────────────────────────────────────────────────────────
describe('economy panel — browse flow', () => {
  it('renders idle + zero-network until a landing card is clicked', () => {
    const calls = installFetch(makeDispatch())
    const m = mountPanel()
    // three landing cards, the app hidden, no league picked, and NOTHING fetched on mount/wire
    expect(m.root.querySelectorAll('#ec-landing .ec-enter').length).toBe(3)
    expect(m.app.hidden).toBe(true)
    expect(m.root.querySelector('#ec-league-name')!.textContent).toBe(copy.economy.leagueNone)
    expect(calls.length).toBe(0)
  })

  it('drives loading → results: skeleton, then the priced-rows table with every cell branch', async () => {
    const curr = deferred<Response>()
    const calls = installFetch(makeDispatch({ currency: () => curr.promise }))
    const m = mountPanel()

    m.clickEnter('economy')

    // Phase 1 — loadCore resolves (leagues + categories), then the first category shows the skeleton
    // while its currency fetch is still pending.
    await vi.waitFor(() => expect(m.main.querySelector('.ec-loading-sk .sk-row')).not.toBeNull(), { timeout: 3000 })
    expect(m.landing.hidden).toBe(true)
    expect(m.app.hidden).toBe(false)
    // the softcore league was picked (HC variant skipped) + the status line carries the divine ratio
    expect(m.root.querySelector('#ec-league-name')!.textContent).toBe('Runes of Aldur')
    expect(m.status.textContent).toContain('Runes of Aldur')
    expect(m.status.textContent).toContain('1 divine ≈ 200 ex')
    // sidebar rendered both category groups with the active (first currency) category flagged
    expect(m.side.querySelectorAll('.ec-side-grp').length).toBe(2)
    expect(m.side.querySelectorAll('.ec-cat').length).toBe(4)
    expect([...m.side.querySelectorAll('.ec-side-h')].map((h) => h.textContent)).toEqual([
      copy.economy.currencyCategories,
      copy.economy.uniqueCategories,
    ])
    expect(m.side.querySelector('.ec-cat[data-cat="currency"]')!.getAttribute('aria-current')).toBe('true')
    // category icons: one real <img>, one styled placeholder
    expect(m.side.querySelector('img.ec-cat-ico')).not.toBeNull()
    expect(m.side.querySelector('.ec-cat-ph')).not.toBeNull()

    // Phase 2 — resolve the currency fetch → the results table renders
    curr.resolve(jsonOk(CURRENCY_PAGE))
    await vi.waitFor(() => expect(m.main.querySelector('.ec-table')).not.toBeNull(), { timeout: 3000 })

    // the fully-unpriced row was filtered out → 3 body rows
    const bodyRows = m.main.querySelectorAll('tbody tr')
    expect(bodyRows.length).toBe(3)
    const names = [...m.main.querySelectorAll('.ec-name')].map((n) => n.textContent)
    expect(names).toEqual(['Mirror of Kalandra', 'Divine Orb', 'Exalted Orb'])
    expect(names).not.toContain('No Price Currency')

    // price cells across the three fmtNum branches (≥100 int / ≥10 one-decimal / <10 two-decimal)
    expect(m.main.textContent).toContain('250 ex')
    expect(m.main.textContent).toContain('15.0 ex')
    expect(m.main.textContent).toContain('3.50 ex')
    // divine ratio shown only when ≥ 0.1 (mirror 250/200 = 1.25); the sub-0.1 rows get no div text
    expect(m.main.textContent).toContain('1.25 div')
    expect(m.main.querySelectorAll('.ec-div').length).toBe(1)
    // quantity is thousands-formatted
    expect(m.main.textContent).toContain('1,234')

    // history: a rising sparkline, a falling sparkline, and one "—" (single point)
    expect(m.main.querySelector('.ec-spark.up')).not.toBeNull()
    expect(m.main.querySelector('.ec-spark.down')).not.toBeNull()
    expect(m.main.querySelector('.ec-spark-na')).not.toBeNull()

    // row icons: mirror has a real <img>, the null-icon rows use the placeholder span
    expect(m.main.querySelector('img.ec-icon')).not.toBeNull()
    expect(m.main.querySelector('.ec-icon-ph')).not.toBeNull()

    // actions cell links out to the wiki + the league trade site
    const links = [...m.main.querySelectorAll('.ec-actions a')].map((a) =>
      (a as HTMLAnchorElement).getAttribute('href'),
    )
    expect(links.some((h) => h!.includes('poe2wiki.net/wiki/Mirror_of_Kalandra'))).toBe(true)
    expect(links.some((h) => h!.includes('pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur'))).toBe(true)

    // single-page pager: info line + both chevrons disabled
    expect(m.main.querySelector('.ec-pager')).not.toBeNull()
    expect(m.main.querySelector('.ec-pginfo')!.textContent).toBe('Page 1 of 1 · 3 items')
    expect(m.main.querySelector<HTMLButtonElement>('.ec-pg[data-pg="prev"]')!.disabled).toBe(true)
    expect(m.main.querySelector<HTMLButtonElement>('.ec-pg[data-pg="next"]')!.disabled).toBe(true)

    // only the four economy routes were ever hit (leagues, categories, currency) — no third-party host
    expect(calls.every((u) => u.includes('/api/economy/'))).toBe(true)
  })

  it('renders the "no priced items" empty state when a category has no live prices', async () => {
    installFetch(
      makeDispatch({
        currency: (url) => (url.includes('category=fragments') ? jsonOk(EMPTY_CURRENCY_PAGE) : jsonOk(CURRENCY_PAGE)),
      }),
    )
    const m = await enterEconomy()

    // click the empty category via the sidebar
    clickCat(m.side, 'currency', 'fragments')
    await vi.waitFor(() => expect(m.main.querySelector('.es--results')).not.toBeNull(), { timeout: 3000 })
    expect(m.main.querySelector('.ec-table')).toBeNull()
    expect(m.main.textContent).toContain(copy.economy.noPricedItemsTitle)
    expect(m.main.textContent).toContain(copy.economy.noPricedItems)
  })

  it('renders the error state with the BFF message when a category load fails upstream', async () => {
    installFetch(makeDispatch({ currency: () => upstream(503) }))
    const m = mountPanel()
    m.clickEnter('economy')
    await vi.waitFor(() => expect(m.main.querySelector('.es--error')).not.toBeNull(), { timeout: 3000 })
    expect(m.main.querySelector('.es-title')!.textContent).toBe(copy.economy.loadErrorTitle)
    expect(m.main.textContent).toContain('HTTP 503')
  })

  it('renders the unexpected-error state when the payload is malformed (non-BffError path)', async () => {
    // 200 OK but no `Items` → `.Items.map` throws a TypeError → errorMessage falls back to errUnexpected
    installFetch(makeDispatch({ currency: () => jsonOk({}) }))
    const m = mountPanel()
    m.clickEnter('economy')
    await vi.waitFor(() => expect(m.main.querySelector('.es--error')).not.toBeNull(), { timeout: 3000 })
    expect(m.main.textContent).toContain(copy.economy.errUnexpected)
  })

  it('paginates and re-pages the table when Rows-per-page changes (no-divine league)', async () => {
    installFetch(makeDispatch({ leagues: LEAGUES_NO_DIV, currency: () => jsonOk(currencyPage(30)) }))
    const m = mountPanel()
    m.clickEnter('economy')
    await vi.waitFor(() => expect(m.main.querySelectorAll('tbody tr').length).toBe(30), { timeout: 3000 })
    // no-divine league → the status line has no divine ratio and no price shows a div sub-line
    expect(m.status.textContent).not.toContain('divine')
    expect(m.main.querySelector('.ec-div')).toBeNull()

    // shrink the page to 25 rows → 2 pages, prev disabled / next enabled
    const sel = m.main.querySelector<HTMLSelectElement>('.ec-rows-sel')!
    sel.value = '25'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(m.main.querySelectorAll('tbody tr').length).toBe(25), { timeout: 3000 })
    expect(m.main.querySelector('.ec-pginfo')!.textContent).toBe('Page 1 of 2 · 30 items')
    expect(m.main.querySelector<HTMLButtonElement>('.ec-pg[data-pg="prev"]')!.disabled).toBe(true)
    expect(m.main.querySelector<HTMLButtonElement>('.ec-pg[data-pg="next"]')!.disabled).toBe(false)

    // next → page 2 shows the remaining 5 rows, next now disabled / prev enabled
    m.main.querySelector<HTMLButtonElement>('.ec-pg[data-pg="next"]')!.click()
    await vi.waitFor(() => expect(m.main.querySelector('.ec-pginfo')!.textContent).toBe('Page 2 of 2 · 30 items'), {
      timeout: 3000,
    })
    expect(m.main.querySelectorAll('tbody tr').length).toBe(5)
    expect(m.main.querySelector<HTMLButtonElement>('.ec-pg[data-pg="next"]')!.disabled).toBe(true)
    expect(m.main.querySelector<HTMLButtonElement>('.ec-pg[data-pg="prev"]')!.disabled).toBe(false)

    // prev → back to page 1
    m.main.querySelector<HTMLButtonElement>('.ec-pg[data-pg="prev"]')!.click()
    await vi.waitFor(() => expect(m.main.querySelector('.ec-pginfo')!.textContent).toBe('Page 1 of 2 · 30 items'), {
      timeout: 3000,
    })
  })

  it('browses uniques via the Unique Items card (Type shown as the row sub-label)', async () => {
    installFetch(makeDispatch())
    const m = mountPanel()
    m.clickEnter('uniques')
    await vi.waitFor(() => expect(m.main.querySelector('.ec-table')).not.toBeNull(), { timeout: 3000 })
    const names = [...m.main.querySelectorAll('.ec-name')].map((n) => n.textContent)
    expect(names).toEqual(['Temporalis', 'Wanderlust'])
    // the typed unique surfaces its base type as a sub; the type-less one does not
    const subs = [...m.main.querySelectorAll('.ec-sub')].map((s) => s.textContent)
    expect(subs).toEqual(['Silk Robe'])
  })

  it('toggles between the Browse and Exchange views (and enters straight into Exchange)', async () => {
    installFetch(makeDispatch())
    const m = mountPanel()
    m.clickEnter('exchange') // route('exchange') → straight to the exchange view

    // exchange view shown, browse hidden; the exchange fetches fail → it mounts its own error state
    await vi.waitFor(() => expect(m.exchange.querySelector('.es--error')).not.toBeNull(), { timeout: 3000 })
    expect(m.exchange.hidden).toBe(false)
    expect(m.side.hidden).toBe(true)
    expect(m.main.hidden).toBe(true)
    const thumb = m.root.querySelector<HTMLElement>('.ec-views .ix-seg-thumb')!
    expect(thumb.style.getPropertyValue('--i')).toBe('1')

    // switch to Browse — with no category loaded yet, the handler lazy-loads the first currency category
    m.root.querySelector<HTMLButtonElement>('.ec-viewbtn[data-ecview="browse"]')!.click()
    await vi.waitFor(() => expect(m.main.querySelector('.ec-table')).not.toBeNull(), { timeout: 3000 })
    expect(m.side.hidden).toBe(false)
    expect(m.main.hidden).toBe(false)
    expect(m.exchange.hidden).toBe(true)
    expect(thumb.style.getPropertyValue('--i')).toBe('0')

    // back to Exchange — the failed mount is retryable, so it re-mounts (still errors) and shows again
    m.root.querySelector<HTMLButtonElement>('.ec-viewbtn[data-ecview="exchange"]')!.click()
    await vi.waitFor(() => expect(m.exchange.hidden).toBe(false), { timeout: 3000 })
    expect(m.side.hidden).toBe(true)
  })

  it('supports Overview back-out and Refresh (re-fetches league + categories)', async () => {
    const calls = installFetch(makeDispatch())
    const m = await enterEconomy()
    const afterEnter = calls.length

    // Overview → hides the app, shows the landing again
    m.root.querySelector<HTMLButtonElement>('#ec-back')!.click()
    expect(m.app.hidden).toBe(true)
    expect(m.landing.hidden).toBe(false)

    // Refresh → disables itself, re-runs loadCore (fresh leagues + categories fetch), re-enables
    const refresh = m.root.querySelector<HTMLButtonElement>('#ec-refresh')!
    refresh.click()
    expect(refresh.disabled).toBe(true)
    await vi.waitFor(() => expect(refresh.disabled).toBe(false), { timeout: 3000 })
    expect(calls.length).toBeGreaterThan(afterEnter) // network happened again on refresh
    expect(calls.some((u) => u.includes('/api/economy/leagues'))).toBe(true)
    expect(m.root.querySelector('#ec-league-name')!.textContent).toBe('Runes of Aldur')
  })

  it('drops a stale category result when a newer category load supersedes it', async () => {
    const frag = deferred<Response>()
    installFetch(
      makeDispatch({
        currency: (url) => (url.includes('category=fragments') ? frag.promise : jsonOk(CURRENCY_PAGE)),
        unique: () => jsonOk(UNIQUE_PAGE),
      }),
    )
    const m = await enterEconomy()

    // start loading fragments (its fetch stays pending) …
    clickCat(m.side, 'currency', 'fragments')
    await vi.waitFor(() => expect(m.main.querySelector('.ec-loading-sk')).not.toBeNull(), { timeout: 3000 })
    // … then immediately switch to a unique category, which resolves first and renders
    clickCat(m.side, 'unique', 'weapon')
    await vi.waitFor(() => expect(m.main.textContent).toContain('Temporalis'), { timeout: 3000 })

    // now the superseded fragments fetch resolves — it must NOT clobber the unique table
    frag.resolve(
      jsonOk({
        CurrentPage: 1,
        Pages: 1,
        Total: 1,
        Items: [
          {
            ApiId: 'stale',
            Text: 'StaleFragment',
            CategoryApiId: 'fragments',
            IconUrl: null,
            PriceLogs: [{ Price: 1, Time: '2026-06-12T00:00:00', Quantity: 1 }],
          },
        ],
      }),
    )
    // give the dropped resolution a chance to (wrongly) render, then assert the unique table survived
    await Promise.resolve()
    await vi.waitFor(() => expect(m.main.textContent).toContain('Temporalis'), { timeout: 500 })
    expect(m.main.textContent).not.toContain('StaleFragment')
  })

  it('surfaces "no current league" when poe2scout returns no current league', async () => {
    installFetch(makeDispatch({ leagues: [] }))
    const m = mountPanel()
    m.clickEnter('economy')
    await vi.waitFor(() => expect(m.status.textContent).toBe(copy.economy.noCurrentLeague), { timeout: 3000 })
    expect(m.status.classList.contains('err')).toBe(true)
    expect(m.app.hidden).toBe(true) // never left the landing
    expect(m.landing.hidden).toBe(false)
  })

  it('surfaces a connectivity error on the status line when the leagues fetch is unreachable', async () => {
    installFetch(() => Promise.reject(new TypeError('fetch failed')))
    const m = mountPanel()
    m.clickEnter('economy')
    await vi.waitFor(() => expect(m.status.classList.contains('err')).toBe(true), { timeout: 3000 })
    expect(m.status.textContent).toContain('serve:bff') // dev unreachable hint from the BFF client
    expect(m.app.hidden).toBe(true)
  })
})

// ── coverage top-up: edge branches lcov flagged uncovered (source is read-only; each case is DOM-driven and
//    mutation-sensitive — the asserted value flips if the guarded line is removed or inverted) ──
const oneRowPage = (logs: Array<{ Price: number; Time: string; Quantity: number } | null>): unknown => ({
  CurrentPage: 1,
  Pages: 1,
  Total: 1,
  Items: [{ ApiId: 'solo', Text: 'Solo', CategoryApiId: 'currency', IconUrl: null, PriceLogs: logs }],
})

describe('economy panel — edge-branch coverage', () => {
  it('drops a stale category FAILURE so a superseded rejection cannot clobber the newer table', async () => {
    const pending = deferred<Response>()
    installFetch(
      makeDispatch({
        currency: (url) => (url.includes('category=fragments') ? pending.promise : jsonOk(CURRENCY_PAGE)),
      }),
    )
    const m = await enterEconomy() // first currency category rendered (Mirror of Kalandra)

    clickCat(m.side, 'currency', 'fragments') // superseded load — its fetch parks on `pending`
    clickCat(m.side, 'currency', 'currency') // newer load wins and re-renders
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the newer load settle (loadToken advances)

    pending.reject(new Error('fragments upstream died')) // the stale load now fails …
    await new Promise((resolve) => setTimeout(resolve, 0)) // … flush its rejection through the catch
    expect(m.main.querySelector('.es--error')).toBeNull() // the token guard dropped it — no error surface
    expect(m.main.textContent).toContain('Mirror of Kalandra') // the newer table survived intact
  })

  it('uses the singular "1 item" pager label when exactly one priced row survives', async () => {
    installFetch(
      makeDispatch({
        currency: () => jsonOk(oneRowPage([{ Price: 5, Time: '2026-06-12T00:00:00', Quantity: 1 }])),
      }),
    )
    const m = await enterEconomy()
    // total === 1 → the ternary must feed '' (not 's') into pagerInfo
    expect(m.main.querySelector('.ec-pginfo')!.textContent).toBe(copy.economy.pagerInfo(1, 1, 1, ''))
  })

  it('reuses a successfully-mounted Exchange view on re-entry instead of re-fetching (mount latch)', async () => {
    const exOk = (url: string): Response =>
      url.includes('exchange-history')
        ? jsonOk({ Data: [] })
        : url.includes('/exchange')
          ? jsonOk({ Epoch: 1, Volume: '1', MarketCap: '1' })
          : jsonOk([]) // pairs + reference-currencies both want an array
    const calls = installFetch(makeDispatch({ exchange: exOk }))
    const exCount = (): number => calls.filter((u) => u.includes('/api/economy/exchange')).length
    const m = mountPanel()

    m.clickEnter('exchange')
    await vi.waitFor(() => expect(m.exchange.querySelector('.ex-head')).not.toBeNull(), { timeout: 3000 })
    const afterMount = exCount()
    expect(afterMount).toBeGreaterThan(0) // snapshot + history fetched on first mount

    m.root.querySelector<HTMLButtonElement>('.ec-viewbtn[data-ecview="browse"]')!.click()
    await vi.waitFor(() => expect(m.exchange.hidden).toBe(true), { timeout: 3000 })
    m.root.querySelector<HTMLButtonElement>('.ec-viewbtn[data-ecview="exchange"]')!.click()
    await vi.waitFor(() => expect(m.exchange.hidden).toBe(false), { timeout: 3000 })

    expect(exCount()).toBe(afterMount) // the latch skipped a re-mount — zero new exchange fetches
  })

  it('fits the app height on window resize only while the app is visible (the !app.hidden gate)', async () => {
    installFetch(makeDispatch())
    const m = mountPanel()

    // app still hidden → the resize handler must skip fitAppHeight, leaving maxHeight untouched
    window.dispatchEvent(new Event('resize'))
    expect(m.app.style.maxHeight).toBe('')

    m.clickEnter('economy')
    await vi.waitFor(() => expect(m.main.querySelector('.ec-table')).not.toBeNull(), { timeout: 3000 })
    m.app.style.maxHeight = '' // clear whatever enter()'s rAF set so the resize effect is unambiguous
    window.dispatchEvent(new Event('resize'))
    expect(m.app.style.maxHeight).toMatch(/px$/) // visible → fitAppHeight measured + sized it
  })

  it('ignores delegated clicks that miss their target button (landing / sidebar / views / pager guards)', async () => {
    const calls = installFetch(makeDispatch())
    const m = await enterEconomy()
    const baseline = calls.length
    const pagerBefore = m.main.querySelector('.ec-pginfo')!.textContent

    m.side.querySelector<HTMLElement>('.ec-side-h')!.click() // group header — not a .ec-cat → no category load
    m.root.querySelector<HTMLElement>('.ec-views .ix-seg-thumb')!.click() // seg thumb — not a .ec-viewbtn → no view
    m.main.querySelector<HTMLElement>('tbody td')!.click() // a table cell — not a .ec-pg → no re-page
    m.root.querySelector<HTMLButtonElement>('#ec-back')!.click() // return to the landing
    m.landing.click() // landing backdrop — not a .ec-enter card → must not re-enter

    expect(calls.length).toBe(baseline) // none of the missed clicks fired a fetch
    expect(m.app.hidden).toBe(true) // the backdrop click never re-opened the app (312 guard held)
    expect(m.main.querySelector('.ec-pginfo')!.textContent).toBe(pagerBefore) // pager untouched (346 guard held)
  })

  it('draws a flat sparkline without NaN when every history price is equal (the range || 1 guard)', async () => {
    installFetch(
      makeDispatch({
        currency: () =>
          jsonOk(
            oneRowPage([
              { Price: 50, Time: '2026-06-12T00:00:00', Quantity: 7 },
              { Price: 50, Time: '2026-06-11T00:00:00', Quantity: 4 },
            ]),
          ),
      }),
    )
    const m = await enterEconomy()
    const poly = m.main.querySelector('.ec-spark polyline')
    expect(poly).not.toBeNull() // two equal points still draw a sparkline
    expect(poly!.getAttribute('points')).not.toContain('NaN') // range 0 → || 1 avoids the /0 that yields NaN
  })

  it('reports +0.0% change without dividing by zero when the oldest price is 0 (the first !== 0 guard)', async () => {
    installFetch(
      makeDispatch({
        currency: () =>
          jsonOk(
            oneRowPage([
              { Price: 12, Time: '2026-06-12T00:00:00', Quantity: 3 },
              { Price: 0, Time: '2026-06-11T00:00:00', Quantity: 2 },
            ]),
          ),
      }),
    )
    const m = await enterEconomy()
    // chronological first price is 0 → the guard returns pct 0; without it (12-0)/|0| → Infinity → "+Infinity%"
    expect(m.main.querySelector('.ec-pct')!.textContent).toBe('+0.0%')
  })
})
