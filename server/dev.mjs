// F2 — local dev shim: adapts Node's http server to the portable fetch-handler in
// worker.mjs (IncomingMessage → web Request → worker.fetch → Response → res). This is
// the only Node-specific file; the worker itself deploys to Cloudflare unchanged.
//
// Run: npm run serve:bff   (PORT env to override, default 8787)
// Privacy: nothing is logged per-request — only the startup line below.

import { createServer } from 'node:http'
import worker from './worker.mjs'

const PORT = Number(process.env.PORT ?? 8787)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`PORT must be an integer in 1-65535 (got ${JSON.stringify(process.env.PORT)})`)
}

/** Build a web Request from a Node IncomingMessage (GET/OPTIONS only — no body needed). */
function toRequest(req) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v)
  }
  const host = req.headers.host ?? `localhost:${PORT}`
  return new Request(`http://${host}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers })
}

const server = createServer(async (req, res) => {
  try {
    const response = await worker.fetch(toRequest(req), process.env)
    const body = Buffer.from(await response.arrayBuffer())
    // The Headers iterator combines same-name values EXCEPT Set-Cookie, which it yields as
    // separate entries that Object.fromEntries would collapse to the last one — recover the
    // full list via getSetCookie() so a proxied upstream's multiple cookies survive (Node's
    // writeHead emits an array value as repeated header lines).
    const headers = Object.fromEntries(response.headers)
    const setCookie = response.headers.getSetCookie?.()
    if (setCookie && setCookie.length) headers['set-cookie'] = setCookie
    res.writeHead(response.status, headers)
    res.end(body)
  } catch (err) {
    // the worker catches upstream errors itself; this guards the adapter only. Log the unexpected
    // throw so a local crash leaves a diagnostic (dev-only shim — never deployed; no per-request logging).
    console.error('[dev-shim]', err)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'dev_shim_error', status: 500 }))
  }
})

server.listen(PORT, () => {
  console.log(`poe2 BFF listening on http://localhost:${PORT}  (try /api/health)`)
})
