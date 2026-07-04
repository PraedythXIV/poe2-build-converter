// F2 — thin BFF (proxy + cache) for the PoE2 build planner.
//
// WHY THIS EXISTS: poe2scout and pobb.in return no Access-Control-Allow-Origin for our
// origin (live-verified against the real API responses), so the browser cannot call them
// directly. This worker is the smallest possible middleman: a strict-allowlist proxy with
// a per-route TTL cache and a polite User-Agent. It is NOT a generic proxy — every
// upstream URL is constructed server-side from validated parts; clients never supply URLs.
//
// PORTABILITY: a single `export default { fetch(request, env) }` handler — deploys to
// Cloudflare Workers unchanged (see server/README.md for wrangler.toml), and runs locally
// via the Node shim in server/dev.mjs. No frameworks, no dependencies.
//
// CACHE: in-memory Map. Fine for both runtimes — a CF isolate keeps it warm between
// requests on the same machine (best-effort, resets on eviction), and the Node shim is a
// single long-lived process. Upgrade path if this ever serves real traffic:
//   - Cloudflare: swap cacheGet/cacheSet for caches.default (Cache API) or a KV namespace
//     (KV gives cross-isolate + cross-PoP persistence; Cache API is per-PoP).
//   - Node: any LRU; the Map below already evicts FIFO past MAX_CACHE_ENTRIES.

const SCOUT_HOST = 'api.poe2scout.com'
const POBBIN_HOST = 'pobb.in'
const ALLOWED_HOSTS = new Set([SCOUT_HOST, POBBIN_HOST])

// Per poe2scout's README ("include a User-Agent with contact information") and pobb.in's
// UA policy — identifies the app and points at the repo for contact.
const USER_AGENT = 'PoE 2 - Sweet Vision BFF (non-commercial fan tool; github.com/PraedythXIV/poe2-build-converter)'

// Unique categories from the live /poe2/Items/Categories capture (UniqueCategories[].ApiId).
// Fixed allowlist — reject anything else with 400. Mirror of src/economy/client.ts UNIQUE_CATEGORIES.
export const UNIQUE_CATEGORIES = ['accessory', 'armour', 'flask', 'jewel', 'map', 'sanctum', 'weapon']
const UNIQUE_CATEGORY_SET = new Set(UNIQUE_CATEGORIES)

const TTL_MS = {
  leagues: 60 * 60 * 1000, // league list + divine price move slowly
  prices: 15 * 60 * 1000, // poe2scout snapshots are daily points; 15 min is plenty fresh
  pob: 24 * 60 * 60 * 1000, // pobb.in pastes are immutable (upstream sends s-max-age=1y)
}

// ── in-memory state (cache + rate limiter) ─────────────────────────────────────
const MAX_CACHE_ENTRIES = 500
const MAX_CACHE_BYTES = 48 * 1024 * 1024 // ~48 MB ceiling so a few large /pairs bodies (~2.8 MB each) can't dominate memory
/** @type {Map<string, {expires: number, body: string, contentType: string, extra?: Record<string,string>}>} */
const cache = new Map()
let cacheBytes = 0

// Best-effort politeness limiter: a token bucket per client IP, 30 requests / 60 s.
// In-memory ⇒ per-isolate on CF (good enough; it protects the upstreams, not us).
export const RATE_LIMIT = { capacity: 30, windowMs: 60_000 }
/** @type {Map<string, {tokens: number, stamp: number}>} */
const buckets = new Map()

/** Test hook: clear cache + rate-limit buckets between unit tests. */
export function resetState() {
  cache.clear()
  cacheBytes = 0
  buckets.clear()
}

// ── small helpers ──────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-max-age': '86400',
  }
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
  })
}

function clientIp(request) {
  // CF sets cf-connecting-ip; behind other proxies x-forwarded-for; locally neither.
  const cf = request.headers.get('cf-connecting-ip')
  if (cf) return cf
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return 'local'
}

function takeToken(ip) {
  const now = Date.now()
  // Bound memory WITHOUT wiping everyone's limit: drop only fully-refilled (stale) buckets. A bucket
  // untouched for a whole window has refilled to capacity, so deleting it just frees memory (it would be
  // recreated at capacity anyway); active limiters (recent stamp, possibly throttled) are kept — so a
  // wide-IP flood can't reset enforcement for everyone the way a blanket clear() did.
  if (buckets.size > 1000) {
    for (const [k, v] of buckets) {
      if (now - v.stamp >= RATE_LIMIT.windowMs) buckets.delete(k)
    }
  }
  const b = buckets.get(ip) ?? { tokens: RATE_LIMIT.capacity, stamp: now }
  // continuous refill: capacity tokens per window
  b.tokens = Math.min(RATE_LIMIT.capacity, b.tokens + ((now - b.stamp) / RATE_LIMIT.windowMs) * RATE_LIMIT.capacity)
  b.stamp = now
  if (b.tokens < 1) {
    buckets.set(ip, b)
    return false
  }
  b.tokens -= 1
  buckets.set(ip, b)
  return true
}

function cacheDelete(key) {
  const hit = cache.get(key)
  if (hit) {
    cacheBytes -= hit.body.length
    cache.delete(key)
  }
}

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (hit.expires < Date.now()) {
    cacheDelete(key)
    return null
  }
  return hit
}

function cacheSet(key, entry) {
  cacheDelete(key) // drop any stale copy first so the byte tally stays accurate
  const size = entry.body.length
  if (size > MAX_CACHE_BYTES) return // never cache a single body larger than the whole budget
  // FIFO-evict (Map preserves insertion order) until both the count AND byte budgets fit
  while ((cache.size >= MAX_CACHE_ENTRIES || cacheBytes + size > MAX_CACHE_BYTES) && cache.size > 0) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cacheDelete(oldest)
  }
  cache.set(key, entry)
  cacheBytes += size
}

/**
 * Fetch an allowlisted upstream with caching. Only 200s are cached; upstream failures are
 * passed through as {error, status} JSON with the upstream's status code preserved.
 * @param {string} upstreamUrl  full URL — its host MUST be in ALLOWED_HOSTS
 * @param {number} ttlMs
 * @param {{contentType: string, extra?: Record<string,string>}} out  response shaping
 */
async function proxied(upstreamUrl, ttlMs, out) {
  const host = new URL(upstreamUrl).hostname
  if (!ALLOWED_HOSTS.has(host)) {
    // defense in depth — routes only build allowlisted URLs, but never trust that silently
    return json(500, { error: 'blocked_upstream', status: 500 })
  }

  const hit = cacheGet(upstreamUrl)
  if (hit) {
    return new Response(hit.body, {
      status: 200,
      headers: { 'content-type': hit.contentType, 'x-bff-cache': 'hit', ...hit.extra, ...corsHeaders() },
    })
  }

  let res
  try {
    res = await fetch(upstreamUrl, {
      headers: {
        'user-agent': USER_AGENT,
        accept: out.contentType.startsWith('application/json') ? 'application/json' : '*/*',
      },
    })
  } catch {
    return json(502, { error: 'upstream_unreachable', status: 502, upstream: host })
  }
  if (!res.ok) {
    // preserve the upstream status so the client can tell 404 (bad league/id) from 5xx
    return json(res.status, { error: 'upstream_error', status: res.status, upstream: host })
  }

  const body = await res.text()
  cacheSet(upstreamUrl, { expires: Date.now() + ttlMs, body, contentType: out.contentType, extra: out.extra })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': out.contentType, 'x-bff-cache': 'miss', ...out.extra, ...corsHeaders() },
  })
}

// ── parameter validation (reject early, never interpolate raw input) ──────────
// League names ("Runes of Aldur", "HC Fate of the Vaal"). Deliberately excludes / ? # @ % so the
// validator ALONE forbids path/host confusion — encodeURIComponent below is then defense-in-depth.
const LEAGUE_RE = /^[A-Za-z0-9 '._-]{1,64}$/
const POB_ID = /^[A-Za-z0-9_-]{1,64}$/ // pobb.in ids are urlsafe-base64-ish
const CATEGORY_RE = /^[a-z]{1,32}$/ // poe2scout category ApiIds: "currency", "ultimatum", "vaultkeys"…
const LIMIT_RE = /^[0-9]{1,4}$/ // history point count

function badRequest(message) {
  return json(400, { error: 'bad_request', status: 400, detail: message })
}

// ── routes ─────────────────────────────────────────────────────────────────────
function routeLeagues() {
  return proxied(`https://${SCOUT_HOST}/poe2/Leagues`, TTL_MS.leagues, {
    contentType: 'application/json; charset=utf-8',
  })
}

function routeCurrency(params) {
  const league = params.get('league')
  if (!league || !LEAGUE_RE.test(league)) return badRequest('league is required (letters/digits/spaces, ≤64 chars)')
  // `category` is only a query-string FILTER on a fixed, server-built upstream path/host, so it cannot
  // redirect the request — a format check is enough. Defaults to "currency" (the old behaviour); any of
  // poe2scout's currency category ApiIds works (currency, fragments, runes, ultimatum, vaultkeys, …).
  const category = params.get('category') ?? 'currency'
  if (!CATEGORY_RE.test(category)) return badRequest('category must be lowercase letters (≤32 chars)')
  const u = new URL(`https://${SCOUT_HOST}/poe2/Leagues/${encodeURIComponent(league)}/Currencies/ByCategory`)
  u.searchParams.set('Category', category)
  u.searchParams.set('PerPage', '250') // whole category in one page (PerPage max per openapi)
  return proxied(u.toString(), TTL_MS.prices, { contentType: 'application/json; charset=utf-8' })
}

/** Live category list ({CurrencyCategories, UniqueCategories}) — labels aren't derivable from the
 *  ApiId (ultimatum = "Soul Cores"), so the UI reads them from here. Slow-moving → leagues TTL. */
function routeCategories(params) {
  const league = params.get('league')
  if (!league || !LEAGUE_RE.test(league)) return badRequest('league is required (letters/digits/spaces, ≤64 chars)')
  return proxied(`https://${SCOUT_HOST}/poe2/Leagues/${encodeURIComponent(league)}/Items/Categories`, TTL_MS.leagues, {
    contentType: 'application/json; charset=utf-8',
  })
}

/** Reference (base) currencies for the league — drives exchange-pair orientation (exalted/chaos/divine). */
function routeReferenceCurrencies(params) {
  const league = params.get('league')
  if (!league || !LEAGUE_RE.test(league)) return badRequest('league is required (letters/digits/spaces, ≤64 chars)')
  return proxied(
    `https://${SCOUT_HOST}/poe2/Leagues/${encodeURIComponent(league)}/ReferenceCurrencies`,
    TTL_MS.leagues,
    {
      contentType: 'application/json; charset=utf-8',
    },
  )
}

/** Currency-exchange summary (market cap + hourly volume) for the Exchange view. */
function routeExchange(params) {
  const league = params.get('league')
  if (!league || !LEAGUE_RE.test(league)) return badRequest('league is required (letters/digits/spaces, ≤64 chars)')
  return proxied(`https://${SCOUT_HOST}/poe2/Leagues/${encodeURIComponent(league)}/ExchangeSnapshot`, TTL_MS.prices, {
    contentType: 'application/json; charset=utf-8',
  })
}

/** Market-cap / volume HISTORY series for the Exchange chart (default ~14 days of hourly points). */
function routeExchangeHistory(params) {
  const league = params.get('league')
  if (!league || !LEAGUE_RE.test(league)) return badRequest('league is required (letters/digits/spaces, ≤64 chars)')
  const limit = params.get('limit') ?? '336'
  if (!LIMIT_RE.test(limit)) return badRequest('limit must be digits (≤4)')
  const n = Math.min(2000, Math.max(1, Number(limit))) // clamp to a sane history window (no oversized upstream fetch)
  const u = new URL(`https://${SCOUT_HOST}/poe2/Leagues/${encodeURIComponent(league)}/SnapshotHistory`)
  u.searchParams.set('Limit', String(n))
  return proxied(u.toString(), TTL_MS.prices, { contentType: 'application/json; charset=utf-8' })
}

/** Full trading-pair matrix (~2.8 MB) — only fetched when the user opens the Exchange view; cached. */
function routePairs(params) {
  const league = params.get('league')
  if (!league || !LEAGUE_RE.test(league)) return badRequest('league is required (letters/digits/spaces, ≤64 chars)')
  return proxied(`https://${SCOUT_HOST}/poe2/Leagues/${encodeURIComponent(league)}/SnapshotPairs`, TTL_MS.prices, {
    contentType: 'application/json; charset=utf-8',
  })
}

function routeUnique(params) {
  const league = params.get('league')
  if (!league || !LEAGUE_RE.test(league)) return badRequest('league is required (letters/digits/spaces, ≤64 chars)')
  const category = params.get('category')
  if (!category || !UNIQUE_CATEGORY_SET.has(category)) {
    return badRequest(`category must be one of: ${UNIQUE_CATEGORIES.join(', ')}`)
  }
  const search = params.get('search') ?? ''
  // eslint-disable-next-line no-control-regex -- the control chars ARE the check (reject them in the search)
  if (search.length > 100 || /[\x00-\x1f\x7f]/.test(search))
    return badRequest('search: <=100 chars, no control characters')

  const u = new URL(`https://${SCOUT_HOST}/poe2/Leagues/${encodeURIComponent(league)}/Uniques/ByCategory`)
  u.searchParams.set('Category', category)
  if (search) u.searchParams.set('Search', search)
  u.searchParams.set('PerPage', search ? '50' : '250') // browse the whole category when not searching
  return proxied(u.toString(), TTL_MS.prices, { contentType: 'application/json; charset=utf-8' })
}

function routePob(id) {
  // passthrough of the documented public endpoint; pastes are immutable → let the
  // browser cache hard too. Consumed by src/economy/client.ts (the pobb.in build import).
  return proxied(`https://${POBBIN_HOST}/${id}/raw`, TTL_MS.pob, {
    contentType: 'text/plain; charset=utf-8',
    extra: { 'cache-control': 'public, max-age=86400, immutable' },
  })
}

// ── entry point ────────────────────────────────────────────────────────────────
export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} [_env]  CF env bindings — unused today, kept for the
   *   Workers signature (a KV binding would arrive here when the cache is upgraded).
   */
  async fetch(request, _env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed', status: 405 })

    const url = new URL(request.url)
    const path = url.pathname
    if (!path.startsWith('/api/')) return json(404, { error: 'not_found', status: 404 })

    if (!takeToken(clientIp(request))) return json(429, { error: 'rate_limited', status: 429 })

    if (path === '/api/health') return json(200, { ok: true, upstreams: [SCOUT_HOST, POBBIN_HOST] })
    if (path === '/api/economy/leagues') return routeLeagues()
    if (path === '/api/economy/categories') return routeCategories(url.searchParams)
    if (path === '/api/economy/currency') return routeCurrency(url.searchParams)
    if (path === '/api/economy/unique') return routeUnique(url.searchParams)
    if (path === '/api/economy/reference-currencies') return routeReferenceCurrencies(url.searchParams)
    if (path === '/api/economy/exchange') return routeExchange(url.searchParams)
    if (path === '/api/economy/exchange-history') return routeExchangeHistory(url.searchParams)
    if (path === '/api/economy/pairs') return routePairs(url.searchParams)

    if (path.startsWith('/api/pob/')) {
      const id = path.slice('/api/pob/'.length)
      if (!POB_ID.test(id)) return badRequest('pob id: urlsafe [A-Za-z0-9_-], ≤64 chars')
      return routePob(id)
    }

    return json(404, { error: 'not_found', status: 404 })
  },
}
