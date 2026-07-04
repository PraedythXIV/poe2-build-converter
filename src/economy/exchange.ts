// B4 — Currency Exchange view (poe2scout's "Market" page: cap + hourly volume + history chart + the
// trading-pair matrix). Mounted lazily; all fetches go through the BFF. The pair matrix is ~2.8 MB, so
// it's fetched once per league and the table sorts/searches/paginates client-side.
//
// The pair ORIENTATION + rate are a FAITHFUL reimplementation of poe2scout's own exchange UI
// (github.com/poe2scout/poe2scout — MIT; see THIRD-PARTY-NOTICES.md), ported to vanilla TS (poe2scout
// is React — this is a behaviour reimplementation, not a code copy):
//   • rate (pairPrice) = second.volumeTraded / first.volumeTraded
//   • orientation (normalizeSnapshotPair): if BOTH currencies are reference currencies (exalted/chaos/
//     divine) → the lower-volumeTraded one is shown first (so the rate reads ≥ 1); if exactly ONE is a
//     reference currency → the NON-reference currency is shown first; otherwise keep currencyOne.
// Every figure is a poe2scout snapshot, not an appraisal.

import { escapeHtml } from '../ui/escapeHtml'
import { copy } from '../copy'
import { skeletonLoading, errorState, PG_PREV_SVG, PG_NEXT_SVG } from './states'
import {
  BffError,
  fetchExchangeHistory,
  fetchExchangeSnapshot,
  fetchPairs,
  fetchReferenceCurrencies,
  type ScoutHistoryPoint,
  type ScoutLeague,
  type ScoutPair,
  type ScoutPairCurrency,
} from './client'

const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100] as const
type SortCol = 'pair' | 'volume'
type SortDir = 'asc' | 'desc'

interface NormPair {
  first: ScoutPairCurrency
  second: ScoutPairCurrency
  rate: number // pairPrice = second.volumeTraded / first.volumeTraded
  volume: number
  name: string // "first/second" (for sorting)
  search: string // first/second text + apiIds (for filtering)
}

const num = (x: unknown): number => {
  const n = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(n) ? n : 0
}
/** Full integer with thousands separators (poe2scout formatNumber: maximumFractionDigits 0). */
const formatNumber = (v: number): string =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'
/** Up to 2 decimals (poe2scout formatPrice). */
const formatPrice = (v: number): string =>
  Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'
/** Medium date + short time, local (poe2scout formatEpoch). */
const formatEpoch = (epoch: number): string =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(epoch * 1000))

/** Orient a pair + compute its rate exactly as poe2scout's normalizeSnapshotPair + computePairPrices. */
function normalizePair(p: ScoutPair, baseSet: Set<string>): NormPair {
  const isBase = (c: ScoutPairCurrency): boolean => baseSet.has((c.ApiId ?? '').toLowerCase())
  const v1 = num(p.CurrencyOneData?.VolumeTraded)
  const v2 = num(p.CurrencyTwoData?.VolumeTraded)

  let first: ScoutPairCurrency
  let second: ScoutPairCurrency
  let fv: number
  let sv: number
  if (isBase(p.CurrencyOne) && isBase(p.CurrencyTwo)) {
    const correct = v1 <= v2 // lower volumeTraded first → rate ≥ 1
    first = correct ? p.CurrencyOne : p.CurrencyTwo
    second = correct ? p.CurrencyTwo : p.CurrencyOne
    fv = correct ? v1 : v2
    sv = correct ? v2 : v1
  } else if (!isBase(p.CurrencyOne)) {
    first = p.CurrencyOne
    second = p.CurrencyTwo
    fv = v1
    sv = v2
  } else {
    first = p.CurrencyTwo // currencyOne is a base currency, currencyTwo isn't → show the non-base first
    second = p.CurrencyOne
    fv = v2
    sv = v1
  }
  const rate = fv > 0 ? sv / fv : 0
  const ai = (c: ScoutPairCurrency): string => (c.ApiId ?? '').toLowerCase()
  return {
    first,
    second,
    rate,
    volume: num(p.Volume),
    name: `${first.Text}/${second.Text}`,
    search:
      `${first.Text} ${second.Text} ${ai(first)} ${ai(second)} ${first.Text}/${second.Text} ${ai(first)}/${ai(second)}`.toLowerCase(),
  }
}

/** Render + wire the exchange view into `container` for one league (idempotent per mount). */
export async function mountExchangeView(container: HTMLElement, league: ScoutLeague): Promise<void> {
  container.innerHTML = skeletonLoading(copy.economy.exLoadingMarket(league.Value))
  let snapshot, history: ScoutHistoryPoint[], pairs: ScoutPair[], refs: string[]
  try {
    ;[snapshot, history, pairs, refs] = await Promise.all([
      fetchExchangeSnapshot(league.Value),
      fetchExchangeHistory(league.Value),
      fetchPairs(league.Value),
      fetchReferenceCurrencies(league.Value),
    ])
  } catch (err) {
    container.innerHTML = errorState(err instanceof BffError ? err.message : copy.economy.exCouldNotLoad)
    return
  }

  const baseSet = new Set(refs.length ? refs : ['exalted', 'chaos', 'divine'])
  const normalized = pairs.map((p) => normalizePair(p, baseSet))

  const cap = snapshot.MarketCap ? Number(snapshot.MarketCap) : NaN
  const vol = snapshot.Volume ? Number(snapshot.Volume) : NaN
  const baseIco = baseIcon(league.BaseCurrencyIconUrl, snapshot.BaseCurrencyText ?? copy.economy.exDefaultBaseCurrency)
  const updated = snapshot.Epoch ? copy.economy.exUpdated(formatEpoch(num(snapshot.Epoch))) : copy.economy.exSnapshot

  container.innerHTML =
    `<div class="ex-head">` +
    `<div class="ex-title"><h3>${copy.economy.exMarket(escapeHtml(league.Value))}</h3><span class="ex-sub">${updated}</span></div>` +
    `<div class="ex-stats">` +
    statBox(copy.economy.exHourlyVolume, vol, baseIco) +
    statBox(copy.economy.exMarketCap, cap, baseIco) +
    `</div></div>` +
    chartHtml(history) +
    `<div class="ex-pairs"><div class="ex-pairs-bar"><div><h4>${copy.economy.exTradingPairs}</h4>` +
    `<p class="ex-pairs-n" id="ex-pairs-count">${copy.economy.exPairsCount(formatNumber(normalized.length))}</p></div>` +
    `<div class="in-field in-field--search"><input type="search" class="in-input ex-search" placeholder="${copy.economy.exSearchPairs}" aria-label="Search trading pairs"></div></div>` +
    `<div class="ex-pairs-tbl" data-pairs-host></div></div>`

  // ── trading-pairs table (sort + search + paginate over the normalised matrix) ──
  const host = container.querySelector<HTMLElement>('[data-pairs-host]')!
  const searchEl = container.querySelector<HTMLInputElement>('.ex-search')!
  const countEl = container.querySelector<HTMLElement>('#ex-pairs-count')!
  let page = 1
  let perPage = 25
  let sortCol: SortCol = 'volume'
  let sortDir: SortDir = 'desc'

  const filtered = (): NormPair[] => {
    const q = searchEl.value.trim().toLowerCase()
    return q ? normalized.filter((p) => p.search.includes(q)) : normalized
  }
  const sorted = (list: NormPair[]): NormPair[] =>
    [...list].sort((a, b) => {
      const cmp = sortCol === 'pair' ? a.name.localeCompare(b.name) : a.volume - b.volume
      return sortDir === 'desc' ? -cmp : cmp
    })

  const render = (): void => {
    const flist = filtered()
    const list = sorted(flist)
    const totalPages = Math.max(Math.ceil(list.length / perPage), 1)
    if (page > totalPages) page = totalPages
    if (page < 1) page = 1
    const slice = list.slice((page - 1) * perPage, page * perPage)
    countEl.textContent = copy.economy.exPairsCount(formatNumber(flist.length))
    const rowsOpts = ROWS_PER_PAGE_OPTIONS.map(
      (n) => `<option value="${n}"${n === perPage ? ' selected' : ''}>${n}</option>`,
    ).join('')
    host.innerHTML =
      `<div class="ec-tbl-scroll"><table class="dt-table ex-table" aria-label="Trading pairs"><thead><tr>` +
      sortTh(copy.economy.exColTradingPair, 'pair') +
      `<th scope="col" class="ec-num">${copy.economy.exColExchangeRate}</th>` +
      sortTh(copy.economy.exColVolume, 'volume', true) +
      `</tr></thead><tbody>${slice.map(pairRow).join('') || `<tr><td colspan="3" class="ec-empty">${copy.economy.exNoPairsMatch}</td></tr>`}</tbody></table></div>` +
      `<nav class="pg ec-pager" aria-label="Pagination"><span class="pg-status ec-pginfo">${copy.economy.exPagerInfo(formatNumber(page), formatNumber(totalPages), formatNumber(list.length))}</span>` +
      `<label class="ec-rows">${copy.economy.rowsLabel}<select class="ec-rows-sel">${rowsOpts}</select></label>` +
      `<ul class="pg-list">` +
      `<li><button type="button" class="icb icb--xs pg-btn ec-pg" data-pg="prev" aria-label="${copy.economy.pagePrev}"${page <= 1 ? ' disabled' : ''}>${PG_PREV_SVG}</button></li>` +
      `<li><button type="button" class="icb icb--xs pg-btn ec-pg" data-pg="next" aria-label="${copy.economy.pageNext}"${page >= totalPages ? ' disabled' : ''}>${PG_NEXT_SVG}</button></li>` +
      `</ul></nav>`
  }

  const sortTh = (label: string, col: SortCol, numeric = false): string => {
    const active = sortCol === col
    return (
      `<th scope="col" class="ex-th-sort${numeric ? ' ec-num dt-num' : ''}" data-sort="${col}" ` +
      `aria-sort="${active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}">` +
      // the vendored dt- sortable-header affordance: caret direction/colour ride th[aria-sort]
      `<button type="button" class="dt-sort">${escapeHtml(label)}<span class="dt-caret" aria-hidden="true"></span></button></th>`
    )
  }

  const toggleSort = (col: SortCol): void => {
    sortDir = sortCol === col && sortDir === 'asc' ? 'desc' : 'asc' // poe2scout toggleSort
    sortCol = col
    page = 1
    render()
  }

  let raf = 0
  searchEl.addEventListener('input', () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      page = 1
      render()
    })
  })
  host.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement
    const sortHdr = target.closest<HTMLElement>('[data-sort]')
    if (sortHdr) return toggleSort(sortHdr.dataset.sort as SortCol)
    const pg = target.closest<HTMLButtonElement>('.ec-pg')
    if (pg) {
      page += pg.dataset.pg === 'next' ? 1 : -1
      render()
    }
  })
  host.addEventListener('change', (ev) => {
    const sel = (ev.target as HTMLElement).closest<HTMLSelectElement>('.ec-rows-sel')
    if (sel) {
      perPage = Number(sel.value) || 25
      page = 1
      render()
    }
  })
  render()
}

// ── row + cell renderers ──
function statBox(title: string, value: number, icon: string): string {
  return (
    `<div class="ex-stat"><span class="ex-stat-l">${escapeHtml(title)}</span>` +
    `<span class="ex-stat-v">${formatNumber(value)} ${icon}</span></div>`
  )
}

function curName(c: ScoutPairCurrency): string {
  return (
    (c.IconUrl
      ? `<img class="ec-icon ec-icon-sm" src="${escapeHtml(c.IconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="ec-icon ec-icon-sm ec-icon-ph" aria-hidden="true"></span>`) + `<span>${escapeHtml(c.Text)}</span>`
  )
}

function pairRow(p: NormPair): string {
  const rateIco = (c: ScoutPairCurrency): string =>
    c.IconUrl
      ? `<img class="ex-rate-ico" src="${escapeHtml(c.IconUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : ''
  const rate =
    p.rate > 0
      ? `<span class="ex-rate" title="${copy.economy.exRate(escapeHtml(p.first.Text), formatPrice(p.rate), escapeHtml(p.second.Text))}">` +
        `<span>1</span>${rateIco(p.first)}<span class="ex-rate-eq">=</span><span>${formatPrice(p.rate)}</span>${rateIco(p.second)}</span>`
      : '—'
  return (
    `<tr><td><span class="ex-pair">${curName(p.first)}<span class="ex-pair-sep" aria-hidden="true">/</span>${curName(p.second)}</span></td>` +
    `<td class="ec-num">${rate}</td>` +
    `<td class="ec-num">${formatNumber(p.volume)}</td></tr>`
  )
}

// ── market-cap line + volume bars, from the history series ──
function chartHtml(history: ScoutHistoryPoint[]): string {
  const pts = history
    .map((h) => ({ t: h.Epoch, cap: Number(h.MarketCap), vol: Number(h.Volume) }))
    .filter((p) => Number.isFinite(p.cap) && Number.isFinite(p.vol))
    .sort((a, b) => a.t - b.t)
  if (pts.length < 2) return ''
  const W = 600
  const CAP_H = 120
  const VOL_H = 36
  const GAP = 6
  const H = CAP_H + GAP + VOL_H
  const caps = pts.map((p) => p.cap)
  const vols = pts.map((p) => p.vol)
  const capMin = Math.min(...caps)
  const capMax = Math.max(...caps)
  const capRange = capMax - capMin || 1
  const volMax = Math.max(...vols) || 1
  const x = (i: number): number => (i / (pts.length - 1)) * W
  const line = caps
    .map((c, i) => `${x(i).toFixed(1)},${(CAP_H - ((c - capMin) / capRange) * CAP_H).toFixed(1)}`)
    .join(' ')
  const bw = Math.max(1, (W / pts.length) * 0.7)
  const bars = vols
    .map((v, i) => {
      const h = (v / volMax) * VOL_H
      return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(CAP_H + GAP + VOL_H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`
    })
    .join('')
  const last = caps[caps.length - 1]!
  return (
    `<figure class="ex-chart"><figcaption>${copy.economy.exChartCaption(pts.length)}</figcaption>` +
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${copy.economy.exChartAria(formatNumber(last))}">` +
    `<polyline class="ex-cap" points="${line}" fill="none" stroke-width="1.5"/>` +
    `<g class="ex-vol">${bars}</g></svg></figure>`
  )
}

/** The base-currency (exalted) icon, or a small text fallback. */
function baseIcon(url: string | null | undefined, alt: string): string {
  return url
    ? `<img class="ec-icon ec-icon-sm ex-base-ico" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="ex-base-ex">${copy.economy.exBaseExFallback}</span>`
}
