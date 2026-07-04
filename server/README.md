# server/ — thin BFF (proxy + cache)

A tiny backend-for-frontend that proxies two community APIs the browser can't reach directly. **The
converter never needs it** — conversion stays client-side (no third-party calls; build data never leaves
the browser). The BFF powers only the optional **Prices** tab (live economy data) and the **pobb.in**
link import.

## Why

poe2scout (`api.poe2scout.com`) sends `Access-Control-Allow-Origin` only to its own site; pobb.in sends
none — so browser calls from our origin are CORS-blocked (live-verified against the two upstreams'
response headers). This hop is deliberately thin: a strict upstream allowlist
(never a generic proxy — clients never supply URLs), a per-route TTL cache, a descriptive User-Agent, and
a best-effort per-IP token bucket (30 req / 60 s).

## Files

| File           | Role                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| `worker.mjs`   | The whole BFF — a portable `export default { fetch(request, env) }`. No frameworks, no deps. |
| `dev.mjs`      | Local-dev Node shim: `node:http` → web `Request` → `worker.fetch` → response.                |
| `worker.d.mts` | Hand-written TS declarations so the vitest suite imports the worker under strict TS.         |

## Routes (all GET, JSON, CORS `*`)

| Route                                           | Upstream                                                                                                 | TTL    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| `/api/health`                                   | — (returns `{ok, upstreams}`)                                                                            | —      |
| `/api/economy/leagues`                          | poe2scout `/poe2/Leagues`                                                                                | 1 h    |
| `/api/economy/categories?league=`               | poe2scout `…/Items/Categories`                                                                           | 1 h    |
| `/api/economy/currency?league=&category=`       | poe2scout `…/Currencies/ByCategory` (category defaults `currency`)                                       | 15 min |
| `/api/economy/unique?league=&category=&search=` | poe2scout `…/Uniques/ByCategory` (category ∈ allowlist: accessory armour flask jewel map sanctum weapon) | 15 min |
| `/api/economy/reference-currencies?league=`     | poe2scout `…/ReferenceCurrencies`                                                                        | 1 h    |
| `/api/economy/exchange?league=`                 | poe2scout `…/ExchangeSnapshot`                                                                           | 15 min |
| `/api/economy/exchange-history?league=&limit=`  | poe2scout `…/SnapshotHistory` (limit clamped ≤ 2000)                                                     | 15 min |
| `/api/economy/pairs?league=`                    | poe2scout `…/SnapshotPairs` (~2.8 MB)                                                                    | 15 min |
| `/api/pob/:id`                                  | pobb.in `/:id/raw` → `text/plain`, browser-`immutable`                                                   | 24 h   |

Upstream failures pass through as `{error, status, upstream}` (status preserved); an unreachable upstream
is `502 {error:"upstream_unreachable"}`. Non-GET → 405; non-`/api/` → 404; over rate limit → 429.

## Run locally

```sh
npm run serve:bff               # http://localhost:8787  (PORT=… to override)
curl http://localhost:8787/api/health
```

The web app's BFF base defaults to `http://localhost:8787` (dev) and the deployed proxy (prod); override
with the `VITE_BFF_BASE` build env or the localStorage key `poe2-bff` — see `src/economy/client.ts`.

## Deploy (Cloudflare Pages)

Deploys to `https://poe2-planner-bff.pages.dev` as a Cloudflare **Pages** project ("advanced mode"
`_worker.js`), not a classic Worker — a pages.dev URL carries no identity-bearing `workers.dev`
subdomain. `scripts/deploy-bff.mjs` stages `worker.mjs` as `server/.pages/_worker.js` and hands off to
wrangler:

```sh
npm run deploy:bff              # auth: CLOUDFLARE_API_TOKEN in .env, or wrangler login
```

Scaling note: the in-memory `Map` cache is per-isolate on CF — swap for `caches.default` (per-PoP) or a
KV namespace (global), which would arrive via the `env` param `worker.fetch` already accepts.

## GGG cxapi (currency exchange) — out of scope

`GET api.pathofexile.com/currency-exchange/poe2` returns 401 without an OAuth **confidential client**
(`client_credentials` + the `service:cxapi` scope), granted only through GGG's app-approval process
(oauth@grindinggear.com). Until approved, poe2scout's exchange mirror (the `/api/economy/exchange*`
routes above) covers the need.

## Privacy

No request logging (the dev shim prints one startup line; the worker logs nothing). No persistence —
caches are in-memory and vanish on restart. Nothing user-identifying is read or forwarded; only league
names, category/search terms, and pobb.in paste ids go upstream, with our User-Agent
`PoE 2 - Sweet Vision BFF (non-commercial fan tool; github.com/PraedythXIV/poe2-build-converter)`.
