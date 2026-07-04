// B4 — economy panel: a poe2scout-style price BROWSER (category sidebar + rich table) + the currency
// exchange, fed by the BFF. OFFLINE GUARANTEE: renderEconomyPanel() is pure markup and
// wireEconomyPanel() attaches listeners only — ZERO network happens until the user clicks "Load
// prices". The app's core conversion flow never depends on this panel.
//
// All prices are poe2scout SNAPSHOTS (daily points, in the league's base currency, exalted), shown as
// snapshots — never an appraisal of a specific item. Data © GGG via poe2scout (attributed below).

import './panel.css'
import { escapeHtml } from '../ui/escapeHtml'
import { copy } from '../copy'
import { skeletonLoading, errorState, emptyState, PG_PREV_SVG, PG_NEXT_SVG } from './states'
import {
  BffError,
  fetchCategories,
  fetchCurrency,
  fetchLeagues,
  fetchUniques,
  type ScoutCategories,
  type ScoutCurrencyItem,
  type ScoutLeague,
  type ScoutPriceLog,
  type ScoutUniqueItem,
  type UniqueCategory,
} from './client'
import { mountExchangeView } from './exchange'

// ── module state (single panel instance, like the other src/ui panels) ────────
let activeLeague: ScoutLeague | null = null

// ── initial render — explanation + placeholder select + explicit consent button ─
export function renderEconomyPanel(): string {
  const card = (key: string, title: string, desc: string, label: string): string =>
    `<article class="ec-card"><h3 class="ec-card-t">${title}</h3>` +
    `<p class="ec-card-d">${desc}</p>` +
    `<button type="button" class="ix-btn ec-enter" data-enter="${key}">${label}</button></article>`
  return (
    `<section class="ec" aria-label="Economy — market prices">` +
    `<p class="ec-intro">${copy.economy.intro}</p>` +
    `<div class="ec-landing" id="ec-landing">` +
    card('economy', copy.economy.cardEconomyTitle, copy.economy.cardEconomyDesc, copy.economy.cardEconomyLabel) +
    card('exchange', copy.economy.cardExchangeTitle, copy.economy.cardExchangeDesc, copy.economy.cardExchangeLabel) +
    card('uniques', copy.economy.cardUniquesTitle, copy.economy.cardUniquesDesc, copy.economy.cardUniquesLabel) +
    `</div>` +
    `<p class="ec-status" id="ec-status" role="status"></p>` +
    `<div class="ec-app" id="ec-app" hidden>` +
    `<div class="ec-topbar">` +
    `<button type="button" class="ix-btn ix-btn--xs ix-btn--ghost" id="ec-back">${copy.economy.overview}</button>` +
    `<span class="ec-lab">${copy.economy.leagueLabel}</span><span class="ec-league-name" id="ec-league-name">${copy.economy.leagueNone}</span>` +
    `<div class="ix-seg ec-views" id="ec-views" style="--n: 2" role="tablist" aria-label="Economy view">` +
    `<span class="ix-seg-thumb" style="--i: 0" aria-hidden="true"></span>` +
    `<button type="button" class="ec-viewbtn on" data-ecview="browse" role="tab" aria-selected="true" aria-controls="ec-main">${copy.economy.viewBrowse}</button>` +
    `<button type="button" class="ec-viewbtn" data-ecview="exchange" role="tab" aria-selected="false" aria-controls="ec-exchange">${copy.economy.viewExchange}</button>` +
    `</div>` +
    `<button type="button" class="ix-btn ix-btn--xs ec-refresh" id="ec-refresh">${copy.economy.refresh}</button>` +
    `</div>` +
    `<div class="ec-body">` +
    `<nav class="ec-side" id="ec-side" aria-label="Price categories"></nav>` +
    `<div class="ec-main" id="ec-main" role="tabpanel" aria-label="Prices" aria-live="polite"></div>` +
    `<div class="ec-exchange" id="ec-exchange" role="tabpanel" aria-label="Currency Exchange" aria-live="polite" hidden></div>` +
    `</div>` +
    `</div>` +
    `</section>`
  )
}

// ── wiring ─────────────────────────────────────────────────────────────────────
type Group = 'currency' | 'unique'
type EnterTarget = 'economy' | 'exchange' | 'uniques'
interface Row {
  name: string // display name (currency Text / unique Name)
  sub: string | null // unique base type, if any
  icon: string | null
  logs: ScoutPriceLog[] // non-null price points, newest-first
}

const ROWS_PER_PAGE = [25, 50, 100] as const

// Lazy-loaded thumbnail with a styled placeholder fallback — used for both sidebar category icons and
// table-row item icons. `cls` is the base class; `phCls` is the placeholder-only modifier (the two
// callers use different, non-derivable modifier names: ec-cat-ph vs ec-icon-ph).
const iconHtml = (url: string | null, cls: string, phCls: string): string =>
  url
    ? `<img class="${cls}" src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="${cls} ${phCls}" aria-hidden="true"></span>`

// Sweep a group of buttons, toggling the `on` class and an aria flag from a per-button predicate — the
// shared shape behind the category sidebar (aria-current) and the view tablist (aria-selected).
const markActive = (
  container: HTMLElement,
  selector: string,
  isActive: (el: HTMLButtonElement) => boolean,
  ariaAttr: string,
): void => {
  for (const el of container.querySelectorAll<HTMLButtonElement>(selector)) {
    const on = isActive(el)
    el.classList.toggle('on', on)
    el.setAttribute(ariaAttr, String(on))
  }
}

export function wireEconomyPanel(root: HTMLElement): void {
  // Non-null assertions + a runtime guard: the `!` lets TS keep the refs non-null inside the nested
  // closures below (control-flow narrowing doesn't cross closure boundaries), while the guard still
  // bails safely if the markup is ever missing.
  const landing = root.querySelector<HTMLElement>('#ec-landing')!
  const intro = root.querySelector<HTMLElement>('.ec-intro')
  const leagueNameEl = root.querySelector<HTMLElement>('#ec-league-name')!
  const status = root.querySelector<HTMLElement>('#ec-status')!
  const app = root.querySelector<HTMLElement>('#ec-app')!
  const side = root.querySelector<HTMLElement>('#ec-side')!
  const main = root.querySelector<HTMLElement>('#ec-main')!
  const exchange = root.querySelector<HTMLElement>('#ec-exchange')!
  const views = root.querySelector<HTMLElement>('.ec-views')!
  const backBtn = root.querySelector<HTMLButtonElement>('#ec-back')!
  const refreshBtn = root.querySelector<HTMLButtonElement>('#ec-refresh')!
  if (!landing || !leagueNameEl || !status || !app || !side || !main || !exchange || !views || !backBtn || !refreshBtn)
    return

  let leagues: ScoutLeague[] = []
  let categories: ScoutCategories | null = null
  let current: { group: Group; apiId: string; label: string } | null = null
  let rows: Row[] = []
  let page = 0
  let perPage: number = ROWS_PER_PAGE[1]
  let exchangeMounted = false
  let loaded = false
  let lastTarget: EnterTarget = 'economy'
  // Monotonic token: every loadCategory() bumps it and captures its own value, so a slower earlier
  // fetch that resolves after a newer one is discarded instead of rendering stale rows under the new
  // header (rapid category switching race).
  let loadToken = 0

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text
    status.classList.toggle('err', isError)
  }

  // ── sidebar ──
  function renderSidebar(): void {
    if (!categories) return
    const group = (title: string, g: Group, cats: ScoutCategories['currency']): string =>
      `<div class="ec-side-grp"><h4 class="ec-side-h">${escapeHtml(title)}</h4>` +
      cats
        .map(
          (c) =>
            `<button type="button" class="ec-cat" data-group="${g}" data-cat="${escapeHtml(c.apiId)}" ` +
            `data-label="${escapeHtml(c.label)}">` +
            iconHtml(c.icon, 'ec-cat-ico', 'ec-cat-ph') +
            `<span class="ec-cat-lbl">${escapeHtml(c.label)}</span></button>`,
        )
        .join('') +
      `</div>`
    side.innerHTML =
      group(copy.economy.currencyCategories, 'currency', categories.currency) +
      group(copy.economy.uniqueCategories, 'unique', categories.unique)
    markActiveCat()
  }
  function markActiveCat(): void {
    markActive(
      side,
      '.ec-cat',
      (b) => current != null && b.dataset.group === current.group && b.dataset.cat === current.apiId,
      'aria-current',
    )
  }

  // ── category load + table ──
  async function loadCategory(group: Group, apiId: string, label: string): Promise<void> {
    const league = activeLeague
    if (!league) return
    const token = ++loadToken
    current = { group, apiId, label }
    page = 0
    markActiveCat()
    main.innerHTML = skeletonLoading(copy.economy.loading(label))
    try {
      const fetched =
        group === 'currency'
          ? (await fetchCurrency(league.Value, apiId)).Items.map(currencyRow)
          : (await fetchUniques(league.Value, apiId as UniqueCategory)).Items.map(uniqueRow)
      if (token !== loadToken) return // a newer category load superseded this one — drop the stale result
      rows = fetched.filter((r) => r.logs.length > 0) // drop rows with no price data at all
      renderTable()
    } catch (err) {
      if (token !== loadToken) return // stale failure for a superseded load — don't clobber the new view
      main.innerHTML = errorState(errorMessage(err))
    }
  }

  function renderTable(): void {
    const league = activeLeague
    if (!current || !league) return
    const div = league.DivinePrice
    const total = rows.length
    if (total === 0) {
      main.innerHTML = emptyState('results', copy.economy.noPricedItemsTitle, copy.economy.noPricedItems)
      return
    }
    const pages = Math.max(1, Math.ceil(total / perPage))
    page = Math.max(0, Math.min(page, pages - 1)) // clamp both ends — prev clicks can drive page negative
    const offset = page * perPage
    const slice = rows.slice(offset, offset + perPage)
    const body = slice
      .map((r) => {
        const latest = r.logs[0]!
        return (
          `<tr><td><span class="ec-item">` +
          iconHtml(r.icon, 'ec-icon', 'ec-icon-ph') +
          `<span class="ec-nm"><span class="ec-name">${escapeHtml(r.name)}</span>` +
          (r.sub ? `<span class="ec-sub">${escapeHtml(r.sub)}</span>` : '') +
          `</span></span></td>` +
          priceCell(latest.Price, div) +
          `<td class="ec-num">${fmtInt(latest.Quantity)}</td>` +
          `<td class="ec-hist"><span class="ec-hist-in">${historyCell(r.logs)}</span></td>` +
          actionsCell(r.name, league.Value) +
          `</tr>`
        )
      })
      .join('')
    const rowsOpts = ROWS_PER_PAGE.map(
      (n) => `<option value="${n}"${n === perPage ? ' selected' : ''}>${n}</option>`,
    ).join('')
    main.innerHTML =
      `<div class="ec-tbl-scroll"><table class="dt-table ec-table" aria-label="${escapeHtml(current.label)} prices in ${escapeHtml(league.Value)}">` +
      `<thead><tr><th scope="col">${copy.economy.colItem}</th><th scope="col" class="ec-num">${copy.economy.colPrice}</th>` +
      `<th scope="col" class="ec-num">${copy.economy.colQuantity}</th><th scope="col">${copy.economy.colHistory}</th><th scope="col">${copy.economy.colActions}</th></tr></thead>` +
      `<tbody>${body}</tbody></table></div>` +
      `<nav class="pg ec-pager" aria-label="Pagination"><span class="pg-status ec-pginfo">${copy.economy.pagerInfo(page + 1, pages, total, total === 1 ? '' : 's')}</span>` +
      `<label class="ec-rows">${copy.economy.rowsLabel}<select class="ec-rows-sel">${rowsOpts}</select></label>` +
      `<ul class="pg-list">` +
      `<li><button type="button" class="icb icb--xs pg-btn ec-pg" data-pg="prev" aria-label="${copy.economy.pagePrev}"${page === 0 ? ' disabled' : ''}>${PG_PREV_SVG}</button></li>` +
      `<li><button type="button" class="icb icb--xs pg-btn ec-pg" data-pg="next" aria-label="${copy.economy.pageNext}"${page >= pages - 1 ? ' disabled' : ''}>${PG_NEXT_SVG}</button></li>` +
      `</ul></nav>`
  }

  // ── view toggle (Browse / Currency Exchange) ──
  async function showView(view: 'browse' | 'exchange'): Promise<void> {
    markActive(views, '.ec-viewbtn', (b) => b.dataset.ecview === view, 'aria-selected')
    // slide the ix-seg gold thumb to the active segment (0 = browse, 1 = exchange)
    views.querySelector<HTMLElement>('.ix-seg-thumb')?.style.setProperty('--i', view === 'browse' ? '0' : '1')
    const browsing = view === 'browse'
    side.hidden = !browsing
    main.hidden = !browsing
    exchange.hidden = browsing
    if (!browsing && activeLeague) {
      if (!exchangeMounted) {
        await mountExchangeView(exchange, activeLeague)
        // mountExchangeView swallows its own errors and renders an `.es--error` empty-state instead
        // of throwing, so latch "mounted" only on success — otherwise a failed mount is retryable by
        // re-clicking the Exchange tab rather than forcing a full Refresh.
        exchangeMounted = !exchange.querySelector('.es--error')
      }
    }
  }

  // ── entry: a landing card loads the league + categories once (data-driven, current non-HC league),
  //    then routes to its section. Zero network until a card is opened (offline guarantee). ──
  async function loadCore(): Promise<boolean> {
    setStatus(copy.economy.loadingLeague)
    try {
      leagues = await fetchLeagues()
      const cur = pickCurrentLeague(leagues)
      if (!cur) {
        setStatus(copy.economy.noCurrentLeague, true)
        return false
      }
      activeLeague = cur
      leagueNameEl.textContent = cur.Value
      exchangeMounted = false
      exchange.innerHTML = ''
      categories = await fetchCategories(cur.Value)
      renderSidebar()
      setStatus(statusLine(cur))
      loaded = true
      return true
    } catch (err) {
      setStatus(errorMessage(err), true)
      return false
    }
  }

  async function route(target: EnterTarget): Promise<void> {
    if (target === 'exchange') return void showView('exchange')
    void showView('browse')
    const list = target === 'uniques' ? categories?.unique : categories?.currency
    const first = list?.[0]
    if (first) await loadCategory(target === 'uniques' ? 'unique' : 'currency', first.apiId, first.label)
  }

  // Size the panel from its live top offset to the viewport bottom so the pinned footer is always
  // on-screen and only the inner sidebar/table scroll (the category sidebar alone can exceed the
  // viewport). A fixed CSS offset can't know the panel's top, so measure it.
  const fitAppHeight = (): void => {
    const top = app.getBoundingClientRect().top
    app.style.maxHeight = `${Math.max(360, Math.round(window.innerHeight - top - 16))}px`
  }

  async function enter(target: EnterTarget): Promise<void> {
    lastTarget = target
    if (!loaded && !(await loadCore())) return
    landing.hidden = true
    if (intro) intro.hidden = true // the blurb is overview-only; reclaim the height for the table
    app.hidden = false
    requestAnimationFrame(fitAppHeight)
    await route(target)
  }

  // ── events ──
  landing.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.ec-enter')
    if (btn) void enter(btn.dataset.enter as EnterTarget)
  })
  backBtn.addEventListener('click', () => {
    app.hidden = true
    landing.hidden = false
    if (intro) intro.hidden = false
  })
  refreshBtn.addEventListener('click', () => {
    loaded = false
    refreshBtn.disabled = true
    void enter(lastTarget).finally(() => {
      refreshBtn.disabled = false
    })
  })
  window.addEventListener('resize', () => {
    if (!app.hidden) fitAppHeight()
  })
  side.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.ec-cat')
    if (btn) void loadCategory(btn.dataset.group as Group, btn.dataset.cat!, btn.dataset.label ?? btn.dataset.cat!)
  })
  views.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.ec-viewbtn')
    if (!btn) return
    const v = btn.dataset.ecview as 'browse' | 'exchange'
    void showView(v)
    // entering via the Exchange card leaves Browse empty — load the first currency category on demand
    if (v === 'browse' && !current && categories?.currency[0]) {
      const f = categories.currency[0]
      void loadCategory('currency', f.apiId, f.label)
    }
  })
  main.addEventListener('click', (ev) => {
    const pg = (ev.target as HTMLElement).closest<HTMLButtonElement>('.ec-pg')
    if (pg) {
      page += pg.dataset.pg === 'next' ? 1 : -1
      renderTable()
    }
  })
  main.addEventListener('change', (ev) => {
    const sel = (ev.target as HTMLElement).closest<HTMLSelectElement>('.ec-rows-sel')
    if (sel) {
      perPage = Number(sel.value) || ROWS_PER_PAGE[1]
      page = 0
      renderTable()
    }
  })
}

// ── row normalisation ──
const liveLogs = (logs: (ScoutPriceLog | null)[]): ScoutPriceLog[] => logs.filter((l): l is ScoutPriceLog => l !== null)
const currencyRow = (i: ScoutCurrencyItem): Row => ({
  name: i.Text,
  sub: null,
  icon: i.IconUrl,
  logs: liveLogs(i.PriceLogs),
})
const uniqueRow = (i: ScoutUniqueItem): Row => ({
  name: i.Name,
  sub: i.Type ?? null,
  icon: i.IconUrl,
  logs: liveLogs(i.PriceLogs),
})

// The current NON-HC league, derived from the live league list — never a hardcoded league name. Both
// the softcore and HC variant carry IsCurrent; HC variants have a 'hc'-suffixed ShortName ("runeshc")
// or an "HC …"/"Hardcore" Value, so we exclude those. Re-derived on every Refresh, so a new league
// rotating in is picked up automatically.
function pickCurrentLeague(leagues: ScoutLeague[]): ScoutLeague | null {
  const isHC = (l: ScoutLeague): boolean =>
    /hc$/i.test(l.ShortName ?? '') || /^hc\b/i.test(l.Value) || /hardcore/i.test(l.Value)
  return leagues.find((l) => l.IsCurrent && !isHC(l)) ?? leagues.find((l) => l.IsCurrent) ?? leagues[0] ?? null
}

// ── cell renderers ──
function priceCell(ex: number, divinePrice: number | null): string {
  const div = divinePrice != null && divinePrice > 0 ? ex / divinePrice : null
  const divTxt = div != null && div >= 0.1 ? ` <span class="ec-div">${copy.economy.priceDiv(fmtNum(div))}</span>` : ''
  return `<td class="ec-num"><span class="ec-ex">${copy.economy.priceEx(fmtNum(ex))}</span>${divTxt}</td>`
}

/** History sparkline + % change over the snapshot window (oldest → newest of the price points). */
function historyCell(logs: ScoutPriceLog[]): string {
  const prices = logs
    .map((l) => l.Price)
    .filter(Number.isFinite)
    .reverse() // logs are newest-first → chronological
  if (prices.length < 2) return `<span class="ec-spark-na" aria-hidden="true">—</span>`
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const range = max - min || 1
  const W = 72
  const H = 22
  const pts = prices
    .map((p, i) => `${((i / (prices.length - 1)) * W).toFixed(1)},${(H - ((p - min) / range) * H).toFixed(1)}`)
    .join(' ')
  const first = prices[0]!
  const last = prices[prices.length - 1]!
  const up = last >= first
  const pct = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0
  const pctTxt = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
  return (
    `<svg class="ec-spark ${up ? 'up' : 'down'}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ` +
    `preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>` +
    `<span class="ec-pct ${up ? 'up' : 'down'}">${pctTxt}</span>`
  )
}

function actionsCell(name: string, league: string): string {
  const wiki = `https://www.poe2wiki.net/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`
  // The official trade2 site has no reliable public by-name URL, so this opens the league's trade
  // search (not item-prefilled) — the title says so rather than over-promising an item-scoped search.
  const trade = `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}`
  return (
    `<td class="ec-actions">` +
    `<a href="${escapeHtml(wiki)}" target="_blank" rel="noopener noreferrer" title="${copy.economy.wikiTitle(escapeHtml(name))}">${copy.economy.actionWiki}</a>` +
    `<a href="${escapeHtml(trade)}" target="_blank" rel="noopener noreferrer" title="${copy.economy.tradeTitle(escapeHtml(league))}">${copy.economy.actionTrade}</a></td>`
  )
}

function statusLine(league: ScoutLeague): string {
  const div =
    league.DivinePrice != null && league.DivinePrice > 0 ? copy.economy.statusDiv(fmtNum(league.DivinePrice)) : ''
  return copy.economy.statusLine(league.Value, div)
}

function fmtNum(v: number): string {
  if (v >= 100) return Math.round(v).toLocaleString('en-US')
  if (v >= 10) return v.toFixed(1)
  return v.toFixed(2)
}
function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US')
}

function errorMessage(err: unknown): string {
  if (err instanceof BffError) return err.message
  return copy.economy.errUnexpected
}
