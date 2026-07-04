// @vitest-environment node
// F2 — unit tests for the BFF worker. worker.fetch is exercised directly (no HTTP server);
// upstream traffic is intercepted by stubbing globalThis.fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import worker, { resetState, RATE_LIMIT } from '../server/worker.mjs'

/** Stub the global fetch; records upstream URLs + init for assertions. */
function stubUpstream(respond: (url: string) => Response | Promise<Response>) {
  const urls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input))
    inits.push(init)
    return Promise.resolve(respond(String(input)))
  })
  return { urls, inits }
}

function jsonOk(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

function call(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`http://localhost:8787${path}`, init))
}

beforeEach(() => {
  resetState()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('routing + CORS', () => {
  it('serves /api/health with upstream list and CORS header', async () => {
    const res = await call('/api/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await res.json()) as { ok: boolean; upstreams: string[] }
    expect(body.ok).toBe(true)
    expect(body.upstreams).toContain('api.poe2scout.com')
    expect(body.upstreams).toContain('pobb.in')
  })

  it('answers OPTIONS preflight with 204 + CORS headers', async () => {
    const res = await call('/api/economy/leagues', { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
  })

  it('rejects non-GET methods and unknown routes', async () => {
    expect((await call('/api/health', { method: 'POST' })).status).toBe(405)
    expect((await call('/api/nope')).status).toBe(404)
    expect((await call('/outside')).status).toBe(404)
  })
})

describe('economy proxying', () => {
  it('proxies /api/economy/leagues to poe2scout with the descriptive User-Agent', async () => {
    const upstream = stubUpstream(() => jsonOk([{ Value: 'Runes of Aldur', IsCurrent: true }]))
    const res = await call('/api/economy/leagues')
    expect(res.status).toBe(200)
    expect(upstream.urls).toEqual(['https://api.poe2scout.com/poe2/Leagues'])
    const headers = upstream.inits[0]?.headers as Record<string, string>
    expect(headers['user-agent']).toContain('PoE 2 - Sweet Vision BFF')
    expect(headers['user-agent']).toContain('github.com')
  })

  it('serves the second identical request from cache (no upstream re-fetch)', async () => {
    const upstream = stubUpstream(() => jsonOk([{ Value: 'x' }]))
    const first = await call('/api/economy/leagues')
    const second = await call('/api/economy/leagues')
    expect(upstream.urls.length).toBe(1)
    expect(first.headers.get('x-bff-cache')).toBe('miss')
    expect(second.headers.get('x-bff-cache')).toBe('hit')
    expect(await second.json()).toEqual([{ Value: 'x' }])
  })

  it('requires a league for /api/economy/currency and builds the upstream query', async () => {
    expect((await call('/api/economy/currency')).status).toBe(400)

    const upstream = stubUpstream(() => jsonOk({ Items: [] }))
    const res = await call('/api/economy/currency?league=Runes%20of%20Aldur')
    expect(res.status).toBe(200)
    expect(upstream.urls[0]).toContain('/poe2/Leagues/Runes%20of%20Aldur/Currencies/ByCategory')
    expect(upstream.urls[0]).toContain('Category=currency')
  })

  it('rejects a unique category outside the allowlist with 400, without contacting upstream', async () => {
    const upstream = stubUpstream(() => jsonOk({ Items: [] }))
    const res = await call('/api/economy/unique?league=Standard&category=weapons') // plural = invalid
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('bad_request')
    expect(upstream.urls.length).toBe(0)
  })

  it('proxies a valid unique search', async () => {
    const upstream = stubUpstream(() => jsonOk({ Items: [{ Name: 'Temporalis' }] }))
    const res = await call('/api/economy/unique?league=Runes%20of%20Aldur&category=armour&search=Temporalis')
    expect(res.status).toBe(200)
    expect(upstream.urls[0]).toContain('/Uniques/ByCategory')
    expect(upstream.urls[0]).toContain('Category=armour')
    expect(upstream.urls[0]).toContain('Search=Temporalis')
  })

  it('proxies /api/economy/currency with a chosen category, validating its format', async () => {
    const upstream = stubUpstream(() => jsonOk({ Items: [] }))
    const res = await call('/api/economy/currency?league=Runes%20of%20Aldur&category=fragments')
    expect(res.status).toBe(200)
    expect(upstream.urls[0]).toContain('/Currencies/ByCategory')
    expect(upstream.urls[0]).toContain('Category=fragments')
    // junk category rejected before any upstream call (it's a filter on a fixed path, but still gated)
    const bad = await call('/api/economy/currency?league=Standard&category=DROP%20TABLE')
    expect(bad.status).toBe(400)
  })

  it('serves the live category list via /api/economy/categories', async () => {
    const upstream = stubUpstream(() => jsonOk({ CurrencyCategories: [], UniqueCategories: [] }))
    expect((await call('/api/economy/categories')).status).toBe(400) // league required
    const res = await call('/api/economy/categories?league=Runes%20of%20Aldur')
    expect(res.status).toBe(200)
    expect(upstream.urls[0]).toBe('https://api.poe2scout.com/poe2/Leagues/Runes%20of%20Aldur/Items/Categories')
  })

  it('proxies the exchange snapshot, history (Limit) and pairs routes', async () => {
    const upstream = stubUpstream(() => jsonOk({ ok: true }))
    expect((await call('/api/economy/exchange?league=Standard')).status).toBe(200)
    expect((await call('/api/economy/exchange-history?league=Standard&limit=48')).status).toBe(200)
    expect((await call('/api/economy/pairs?league=Standard')).status).toBe(200)
    expect(upstream.urls[0]).toContain('/ExchangeSnapshot')
    expect(upstream.urls[1]).toContain('/SnapshotHistory')
    expect(upstream.urls[1]).toContain('Limit=48')
    expect(upstream.urls[2]).toContain('/SnapshotPairs')
    // a non-numeric limit is rejected
    expect((await call('/api/economy/exchange-history?league=Standard&limit=all')).status).toBe(400)
  })

  it('propagates upstream HTTP errors as {error, status} without caching them', async () => {
    let status = 500
    const upstream = stubUpstream(() => jsonOk({ boom: true }, status))
    const res = await call('/api/economy/leagues')
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'upstream_error', status: 500 })

    status = 200 // upstream recovers — the failure must not have been cached
    const retry = await call('/api/economy/leagues')
    expect(retry.status).toBe(200)
    expect(upstream.urls.length).toBe(2)
  })

  it('maps upstream network failure to 502 upstream_unreachable', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    const res = await call('/api/economy/leagues')
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'upstream_unreachable', status: 502 })
  })
})

describe('pob passthrough', () => {
  it('passes /api/pob/:id through as text/plain with aggressive caching', async () => {
    const upstream = stubUpstream(
      () => new Response('eNrdPWtT28hbcode', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )
    const res = await call('/api/pob/0CgCJ6HQE2Ma')
    expect(res.status).toBe(200)
    expect(upstream.urls).toEqual(['https://pobb.in/0CgCJ6HQE2Ma/raw'])
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.text()).toBe('eNrdPWtT28hbcode')
  })

  it('rejects malformed paste ids before any upstream call', async () => {
    const upstream = stubUpstream(() => jsonOk({}))
    expect((await call('/api/pob/has.dot')).status).toBe(400)
    expect((await call('/api/pob/' + 'x'.repeat(65))).status).toBe(400)
    expect(upstream.urls.length).toBe(0)
  })
})

describe('rate limiting (best-effort per IP)', () => {
  it('returns 429 once the token bucket is exhausted, per IP', async () => {
    for (let i = 0; i < RATE_LIMIT.capacity; i++) {
      expect((await call('/api/health')).status).toBe(200)
    }
    expect((await call('/api/health')).status).toBe(429)

    // a different client IP gets its own bucket
    const other = await call('/api/health', { headers: { 'cf-connecting-ip': '203.0.113.7' } })
    expect(other.status).toBe(200)
  })
})
