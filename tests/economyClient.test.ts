// B4 — unit tests for the browser-side BFF client: base-URL persistence and the
// unreachable-vs-upstream error taxonomy. Runs in jsdom (localStorage available).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  BffError,
  UNIQUE_CATEGORIES,
  fetchCurrency,
  fetchLeagues,
  fetchPobRaw,
  fetchUniques,
  getBffBase,
  setBffBase,
} from '../src/economy/client'
import { UNIQUE_CATEGORIES as WORKER_UNIQUE_CATEGORIES } from '../server/worker.mjs'
import { jsonOk, stubFetch } from './helpers/economyStub'

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BFF base URL', () => {
  // The default is environment-split: import.meta.env.DEV picks localhost:8787, production
  // builds get the deployed Workers URL. Vitest runs with DEV === true, so the dev default
  // is the only branch observable here (the prod literal is asserted nowhere — it would
  // just re-state the constant).
  it('defaults to localhost:8787 under vitest (import.meta.env.DEV is true)', () => {
    expect(import.meta.env.DEV).toBe(true)
    expect(getBffBase()).toBe('http://localhost:8787')
  })

  it('persists via localStorage and strips trailing slashes', () => {
    setBffBase('https://poe2-bff.example.workers.dev/')
    expect(getBffBase()).toBe('https://poe2-bff.example.workers.dev')
    expect(localStorage.getItem('poe2-bff')).toBe('https://poe2-bff.example.workers.dev')
  })

  it('rejects invalid URLs and falls back when the stored value is garbage', () => {
    expect(() => setBffBase('not a url')).toThrow()
    localStorage.setItem('poe2-bff', 'hand-edited junk')
    expect(getBffBase()).toBe('http://localhost:8787')
  })
})

describe('typed fetchers', () => {
  it('fetchLeagues hits the BFF leagues route on the configured base', async () => {
    setBffBase('http://127.0.0.1:9999')
    const urls = stubFetch(() => jsonOk([{ Value: 'Runes of Aldur', IsCurrent: true }]))
    const leagues = await fetchLeagues()
    expect(urls).toEqual(['http://127.0.0.1:9999/api/economy/leagues'])
    expect(leagues[0]?.Value).toBe('Runes of Aldur')
  })

  it('fetchCurrency and fetchUniques URL-encode their parameters', async () => {
    const urls = stubFetch(() => jsonOk({ CurrentPage: 1, Pages: 1, Total: 0, Items: [] }))
    await fetchCurrency('Runes of Aldur') // category defaults to "currency"
    await fetchCurrency('Runes of Aldur', 'fragments')
    await fetchUniques('Runes of Aldur', 'weapon', 'The Searing Touch')
    expect(urls[0]).toBe('http://localhost:8787/api/economy/currency?league=Runes%20of%20Aldur&category=currency')
    expect(urls[1]).toBe('http://localhost:8787/api/economy/currency?league=Runes%20of%20Aldur&category=fragments')
    expect(urls[2]).toBe(
      'http://localhost:8787/api/economy/unique?league=Runes%20of%20Aldur&category=weapon&search=The%20Searing%20Touch',
    )
  })
})

/** Assert a fetcher rejects with the BFF "unreachable" taxonomy + the dev serve:bff hint — the
 *  SAME contract is deliberately asserted for different fetchers (coverage, one assertion home). */
async function expectUnreachable(p: Promise<unknown>): Promise<void> {
  const err = (await p.catch((e: unknown) => e)) as BffError
  expect(err).toBeInstanceOf(BffError)
  expect(err.kind).toBe('unreachable')
  expect(err.message).toContain('serve:bff') // actionable hint for the (dev) user
}

describe('fetchPobRaw (B6 — pobb.in raw paste via the BFF)', () => {
  it('hits /api/pob/{id} on the configured base and returns the raw text body', async () => {
    const urls = stubFetch(() => new Response('<PathOfBuilding2/>', { status: 200 }))
    const raw = await fetchPobRaw('AbCd123_-')
    expect(urls).toEqual(['http://localhost:8787/api/pob/AbCd123_-'])
    expect(raw).toBe('<PathOfBuilding2/>')
  })

  it('shares the unreachable taxonomy (with the serve:bff hint) when the BFF is down', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    await expectUnreachable(fetchPobRaw('abcd'))
  })

  it('shares the upstream taxonomy with the preserved status (e.g. a 404 paste id)', async () => {
    stubFetch(() => jsonOk({ error: 'upstream_error', status: 404, upstream: 'pobb.in' }, 404))
    const err = (await fetchPobRaw('nope').catch((e: unknown) => e)) as BffError
    expect(err).toBeInstanceOf(BffError)
    expect(err.kind).toBe('upstream')
    expect(err.status).toBe(404)
  })
})

describe('worker allowlist mirror', () => {
  // client.ts deliberately keeps its own copy of the worker's category allowlist (the worker is
  // dependency-free/portable, so neither side can import the other at runtime) — this pin is the
  // drift guard the comment-acknowledged mirror otherwise lacks.
  it('UNIQUE_CATEGORIES in client.ts equals the BFF worker allowlist', () => {
    expect([...UNIQUE_CATEGORIES]).toEqual([...WORKER_UNIQUE_CATEGORIES])
  })
})

describe('error taxonomy', () => {
  it('reports "unreachable" when the BFF does not answer at all', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    await expectUnreachable(fetchLeagues())
  })

  it('treats our own timeout abort as "unreachable" too', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    const err = (await fetchLeagues().catch((e: unknown) => e)) as BffError
    expect(err).toBeInstanceOf(BffError)
    expect(err.kind).toBe('unreachable')
  })

  it('reports "upstream" with the preserved status when the BFF answers with an error', async () => {
    stubFetch(() => jsonOk({ error: 'upstream_error', status: 503, upstream: 'api.poe2scout.com' }, 503))
    const err = (await fetchCurrency('Standard').catch((e: unknown) => e)) as BffError
    expect(err).toBeInstanceOf(BffError)
    expect(err.kind).toBe('upstream')
    expect(err.status).toBe(503)
  })

  it('keeps the HTTP status when the BFF error body is not JSON', async () => {
    stubFetch(() => new Response('<html>gateway error</html>', { status: 500 }))
    const err = (await fetchLeagues().catch((e: unknown) => e)) as BffError
    expect(err).toBeInstanceOf(BffError)
    expect(err.kind).toBe('upstream')
    expect(err.status).toBe(500)
  })
})
