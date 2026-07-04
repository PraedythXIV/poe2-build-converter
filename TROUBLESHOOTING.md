# Troubleshooting (developers)

Build, test, and data-pipeline snags and their fixes. **User-facing import questions live in the app's
FAQ tab** (`copy.faq` in `src/copy.ts`), not here. For how the pieces fit, see [ARCHITECTURE.md](ARCHITECTURE.md).

## `npm test` fails on id-specific assertions after a data refresh

Passive/atlas node ids are stable only **within a tree version**, so `npm run fetch-data` / `data:refresh`
to a new patch shifts them and fixture-pinned assertions in `tests/` start failing. That signals a tree
change, not a regression — update the affected expected ids/fixtures rather than the code.

## A `data:*` build script aborts with a missing-extract error (e.g. "… `data-extract/tables/…` missing — run `npm run data:extract` first")

The datamine cache is gitignored and lives under `_workbench/data-extract/`. Regenerate it with
`npm run data:extract` (or the full `npm run data:refresh`). The builders fail loud rather than emit
partial data, so a missing cache stops the run instead of shipping a hole.

## `npm run data:refresh` aborts on an invariant gate ("only N … expected ≥ M")

A vendored count regressed versus the previous patch — usually a stale `_workbench/data-extract`, an
upstream `dat-schema` lag, or a broken join. The gate is deliberate (counts must never silently
regress); fix the extract/upstream, never bypass it.

## `npm run dev` dies with `EBUSY: … watch …`

Vite's watcher (chokidar) tries to watch every file under the repo root and chokes on a large non-app
directory. All heavy/non-app material must live under `_workbench/`, which `vite.config.ts` excludes via
`server.watch.ignored`. If it recurs, a big directory landed outside `_workbench/`.

## My source edits have no effect (the build/tests keep running old code)

A stray `tsc` run **without `--noEmit`** emits `.js`/`.js.map` files next to the `.ts` sources, and
Vite/Vitest resolve an extensionless `./x` import to `x.js` **before** `x.ts` — so the stale compiled
`.js` silently shadows every later edit to that module (only the explicit entry `main.ts`, CSS, and HTML
still build from source). Fix: delete the strays (`src/**/*.js(.map)` and `tests/**/*.js(.map)` that have
a `.ts` sibling — everything except the vendored `src/vendor/uikit/behaviors.js`), then rebuild.
`.gitignore` ignores these patterns so strays can't be committed, but ignored files still shadow —
if it recurs, find what ran `tsc` without `--noEmit`.

## `npm run preview` (or opening `dist/index.html`) renders blank

The build is multi-file — ES module scripts and asset `fetch`es need an **http origin**, so `file://`
won't work. Use `npm run preview`, or serve `dist/` with any static server, and open the printed URL.

## Market prices error locally

The BFF isn't running. Start `npm run serve:bff` (`http://localhost:8787`, the dev default; set `PORT`
to override). Only the Prices tab and the pobb.in import use it — conversion, tree, and stats never do.

## `npm run check:compliance` fails

A dependency or vendored source isn't on the license allowlist, or is missing its provenance header.
Fix the source or its attribution — **never** weaken the guard; it's the CI backstop for the
"permissive sources only" and "GGG data, our own extraction" rules.
