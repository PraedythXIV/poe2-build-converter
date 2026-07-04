// B4/B6 — browser client for the BFF (server/worker.mjs). All economy + pobb.in traffic
// goes through the BFF because poe2scout and pobb.in block cross-origin browser calls
// (verified against the live APIs). This module performs NO network on import — fetchers run
// only when called.

import { copy } from '../copy'

const BFF_STORAGE_KEY = 'poe2-bff'
// Default base, weakest to strongest: production builds point at the deployed Pages
// proxy (project-name-only URL — deliberately no account subdomain), dev builds (vite
// dev server / vitest, where import.meta.env.DEV is true) at the local shim; a
// VITE_BFF_BASE build-time env overrides both defaults; a user-set localStorage value
// (setBffBase) wins over everything and survives reloads.
const DEFAULT_BFF_BASE: string =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BFF_BASE) ||
  (typeof import.meta !== 'undefined' && import.meta.env?.DEV
    ? 'http://localhost:8787'
    : 'https://poe2-planner-bff.pages.dev')
const FETCH_TIMEOUT_MS = 12_000

// ── error taxonomy ─────────────────────────────────────────────────────────────
// 'unreachable' → the BFF itself didn't answer (not running / wrong base URL / timeout).
// 'upstream'    → the BFF answered but the request failed (upstream 4xx/5xx, bad params,
//                 rate limit). `status` carries the HTTP status the BFF reported.
export type BffErrorKind = 'unreachable' | 'upstream'

export class BffError extends Error {
  readonly kind: BffErrorKind
  readonly status: number | undefined

  constructor(kind: BffErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'BffError'
    this.kind = kind
    this.status = status
  }
}

// ── base-URL handling (persisted so a deployed Workers URL survives reloads) ──
function safeLocalStorage(): Storage | null {
  // localStorage can throw in privacy modes; the economy panel is optional, never fatal
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '')
}

export function getBffBase(): string {
  const stored = safeLocalStorage()?.getItem(BFF_STORAGE_KEY)
  if (!stored) return DEFAULT_BFF_BASE
  try {
    new URL(stored) // stale/hand-edited garbage falls back to the default
    return normalizeBase(stored)
  } catch {
    return DEFAULT_BFF_BASE
  }
}

export function setBffBase(url: string): void {
  const normalized = normalizeBase(url.trim())
  new URL(normalized) // throws on invalid input — surface it to the caller
  safeLocalStorage()?.setItem(BFF_STORAGE_KEY, normalized)
}

// ── poe2scout response shapes (from live captures) ──────────────────────────────────────
export interface ScoutPriceLog {
  Price: number // in the league's base currency (exalted)
  Time: string // "2026-06-12T00:00:00" — UTC, no zone suffix
  Quantity: number
}

export interface ScoutLeague {
  Value: string // use as the league parameter, e.g. "Runes of Aldur"
  ShortName: string
  IsCurrent: boolean
  DivinePrice: number | null // divine value in exalted — gives the div ratio for free
  ChaosDivinePrice: number | null
  BaseCurrencyApiId: string
  BaseCurrencyText: string
  DivineCurrencyIconUrl?: string | null
  BaseCurrencyIconUrl?: string | null
}

export interface ScoutCurrencyItem {
  ApiId: string
  Text: string // display name, e.g. "Mirror of Kalandra"
  CategoryApiId: string
  IconUrl: string | null // poe2scout/GGG CDN — render only after user consent
  PriceLogs: (ScoutPriceLog | null)[] // newest first; days without data may be null
}

export interface ScoutUniqueItem {
  Name: string // unique name, e.g. "Temporalis"
  Text: string // full text, e.g. "Temporalis Silk Robe"
  Type?: string
  CategoryApiId: string
  IconUrl: string | null
  IsChanceable?: boolean
  PriceLogs: (ScoutPriceLog | null)[]
}

export interface ScoutPage<T> {
  CurrentPage: number
  Pages: number
  Total: number
  Items: T[]
}

// Mirror of the worker's fixed allowlist (poe2scout UniqueCategories[].ApiId).
export const UNIQUE_CATEGORIES = ['accessory', 'armour', 'flask', 'jewel', 'map', 'sanctum', 'weapon'] as const
export type UniqueCategory = (typeof UNIQUE_CATEGORIES)[number]

// ── fetch plumbing (shared by the economy routes and the pobb.in raw route) ───
async function requestOk(path: string): Promise<Response> {
  const base = getBffBase()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(`${base}${path}`, { signal: controller.signal })
  } catch {
    // network refusal AND our own timeout abort both land here — the BFF never answered.
    // The serve:bff hint only makes sense on a dev machine; end users get an actionable message.
    throw new BffError('unreachable', import.meta.env.DEV ? copy.bff.unreachableDev(base) : copy.bff.unreachable)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    // the BFF reports upstream failures as {error, status} with the upstream status preserved
    let status = res.status
    try {
      const body = (await res.json()) as { status?: unknown }
      if (typeof body.status === 'number') status = body.status
    } catch {
      /* non-JSON error body — keep the HTTP status */
    }
    throw new BffError('upstream', `Proxy request failed (HTTP ${status}).`, status)
  }

  return res
}

async function getJson<T>(path: string): Promise<T> {
  const res = await requestOk(path)
  try {
    return (await res.json()) as T
  } catch {
    // 200 OK but the body isn't valid JSON — surface it through the shared taxonomy
    // instead of letting a raw SyntaxError escape (callers only handle BffError).
    throw new BffError('upstream', 'Proxy returned a malformed response (invalid JSON).', res.status)
  }
}

// ── B6 — pobb.in raw paste (one per BFF pob route) ─────────────────────────────
/**
 * Fetch the raw PoB export code behind a pobb.in paste id via the BFF (pobb.in sends no
 * CORS headers, same situation as poe2scout). Returns the raw text body; throws BffError
 * with the shared unreachable/upstream taxonomy.
 */
export async function fetchPobRaw(id: string): Promise<string> {
  return (await requestOk(`/api/pob/${encodeURIComponent(id)}`)).text()
}

// ── typed fetchers (one per BFF economy route) ─────────────────────────────────
export function fetchLeagues(): Promise<ScoutLeague[]> {
  return getJson<ScoutLeague[]>('/api/economy/leagues')
}

export function fetchCurrency(league: string, category = 'currency'): Promise<ScoutPage<ScoutCurrencyItem>> {
  return getJson<ScoutPage<ScoutCurrencyItem>>(
    `/api/economy/currency?league=${encodeURIComponent(league)}&category=${encodeURIComponent(category)}`,
  )
}

// ── live category list (the browser's sidebar) ─────────────────────────────────
// Labels aren't derivable from the ApiId (ultimatum = "Soul Cores", vaultkeys = "Reliquary Keys"),
// so the UI reads {ApiId, Label, Icon} straight from poe2scout's /Items/Categories.
export interface ScoutCategory {
  apiId: string
  label: string
  icon: string | null
}
export interface ScoutCategories {
  currency: ScoutCategory[]
  unique: ScoutCategory[]
}
interface RawCategory {
  ApiId?: string
  Label?: string
  Name?: string
  Icon?: string | null
  IconUrl?: string | null
}
const mapCategory = (c: RawCategory): ScoutCategory => ({
  apiId: c.ApiId ?? '',
  label: c.Label ?? c.Name ?? c.ApiId ?? '',
  icon: c.Icon ?? c.IconUrl ?? null,
})
export async function fetchCategories(league: string): Promise<ScoutCategories> {
  const raw = await getJson<{ CurrencyCategories?: RawCategory[]; UniqueCategories?: RawCategory[] } | null>(
    `/api/economy/categories?league=${encodeURIComponent(league)}`,
  )
  return {
    currency: (raw?.CurrencyCategories ?? []).map(mapCategory).filter((c) => c.apiId),
    unique: (raw?.UniqueCategories ?? []).map(mapCategory).filter((c) => c.apiId),
  }
}

// ── currency-exchange (the Market view) ────────────────────────────────────────
// MarketCap/Volume arrive as high-precision number STRINGS — parse with Number() at the call site.
export interface ScoutExchange {
  Epoch: number
  Volume: string
  MarketCap: string
  BaseCurrencyApiId?: string
  BaseCurrencyText?: string
}
export function fetchExchangeSnapshot(league: string): Promise<ScoutExchange> {
  return getJson<ScoutExchange>(`/api/economy/exchange?league=${encodeURIComponent(league)}`)
}

export interface ScoutHistoryPoint {
  Epoch: number
  MarketCap: string
  Volume: string
}
export async function fetchExchangeHistory(league: string, limit = 336): Promise<ScoutHistoryPoint[]> {
  const r = await getJson<{ Data?: ScoutHistoryPoint[] } | null>(
    `/api/economy/exchange-history?league=${encodeURIComponent(league)}&limit=${limit}`,
  )
  return r?.Data ?? []
}

export interface ScoutPairCurrency {
  ApiId: string
  Text: string
  IconUrl?: string | null
}
export interface ScoutPairSide {
  // Per-unit base (exalted) price = StockValue / HighestStock (≡ ValueTraded / VolumeTraded). NOTE:
  // RelativePrice is NOT a usable pair-relative unit price — do not derive the exchange rate from it.
  StockValue?: string
  ValueTraded?: string
  HighestStock?: number
  VolumeTraded?: number
  RelativePrice?: string
}
export interface ScoutPair {
  Volume?: string
  CurrencyOne: ScoutPairCurrency
  CurrencyTwo: ScoutPairCurrency
  CurrencyOneData?: ScoutPairSide
  CurrencyTwoData?: ScoutPairSide
}
export function fetchPairs(league: string): Promise<ScoutPair[]> {
  return getJson<ScoutPair[]>(`/api/economy/pairs?league=${encodeURIComponent(league)}`)
}

/** Reference/base currency ApiIds (exalted, chaos, divine) — drive exchange-pair orientation. */
export async function fetchReferenceCurrencies(league: string): Promise<string[]> {
  const raw = await getJson<Array<{ ApiId?: string; apiId?: string }>>(
    `/api/economy/reference-currencies?league=${encodeURIComponent(league)}`,
  )
  return (raw ?? []).map((c) => (c.ApiId ?? c.apiId ?? '').toLowerCase()).filter(Boolean)
}

export function fetchUniques(
  league: string,
  category: UniqueCategory,
  search?: string,
): Promise<ScoutPage<ScoutUniqueItem>> {
  const qs =
    `league=${encodeURIComponent(league)}&category=${encodeURIComponent(category)}` +
    (search ? `&search=${encodeURIComponent(search)}` : '')
  return getJson<ScoutPage<ScoutUniqueItem>>(`/api/economy/unique?${qs}`)
}
