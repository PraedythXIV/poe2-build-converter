// Shared jsdom fetch stubbing for the economy CLIENT suites (economyClient / economyClientWatch):
// swap the global fetch for a per-URL responder that records the requested URLs, plus a canned
// JSON Response builder. The panel/exchange suites route by path and keep their own richer stubs.
import { vi } from 'vitest'

/** Stub global fetch with `respond`; returns the ordered list of URLs it was asked for. */
export function stubFetch(respond: (url: string) => Response | Promise<Response>): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    urls.push(String(input))
    return Promise.resolve(respond(String(input)))
  })
  return urls
}

/** A JSON Response (200 by default) with the application/json content-type. */
export function jsonOk(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}
