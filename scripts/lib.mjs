// Shared helpers + single source of truth for data-pipeline constants.
// Plain node (>=20), zero dependencies. Used by the scripts/ data pipeline only —
// nothing here ships in the app bundle.

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The gitignored datamine working area every pipeline script reads from (npm run data:extract). */
export const EXTRACT = join(ROOT, '_workbench', 'data-extract')
/** The CDN bundle cache inside it (pathofexile-dat loaders). */
export const EXTRACT_CACHE = join(EXTRACT, '.work', '.cache')

// Load a gitignored .env into process.env once, on import — no dotenv dependency (same approach as
// scripts/deploy-bff.mjs). Real shell/CI env vars WIN (never clobbered), and surrounding quotes are
// stripped so an unquoted path with spaces works. Lets the data pipeline read optional vars like
// POE2_INSTALL / POE2_OFFLINE from a local .env (node doesn't auto-load .env for plain scripts).
{
  const envFile = join(ROOT, '.env')
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    }
  }
}

/** GGG's official PoE2 passive-tree export (data + sprite atlases). No OSS license —
 *  official data published for tool developers; we attribute GGG and never claim ownership. */
export const TREE_REPO = 'grindinggear/poe2-skilltree-export'

/** Pinned ref = tag 0.5.1 (== current `main` HEAD). The refresh orchestrator resolves the
 *  live `main` SHA and passes --ref, so bumping this constant is only a fallback default. */
export const DEFAULT_TREE_REF = '39eafcff848e5dec994c2d7c7cb9694158e69370'

export const UA = 'poe2-build-converter data-vendor (offline build tool)'

export function treeRawUrl(ref, file) {
  return `https://raw.githubusercontent.com/${TREE_REPO}/${ref}/${file}`
}

export async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

/** Fetch a (possibly binary) resource into a Buffer, identified UA, fail-loud on HTTP errors.
 *  (Dedupe refactor while green: MOVED VERBATIM here from its two identical copies in
 *  build-passive-bg.mjs and build-passive-masteries.mjs — the check:dedupe gate flagged the twin.) */
export async function fetchBytes(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Read a JSON file from the extract working area, e.g. readExtractJson('extract-meta.json') or
 *  readExtractJson('tables/PassiveSkills.json'). (Dedupe refactor while green: the identical
 *  JSON.parse(readFileSync(join(EXTRACT, …))) openings of the packer scripts.) */
export const readExtractJson = (rel) => JSON.parse(readFileSync(join(EXTRACT, rel), 'utf8'))

/** Uniform "Done in Xs" trailer every pipeline script prints. */
export const logDone = (t0) => console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

/** Uniform fail-loud entry point — `runMain('build-x', main)` replaces the per-script
 *  main().catch tail. (Dedupe refactor while green: identical across all pipeline scripts.) */
export function runMain(name, main) {
  main().catch((e) => {
    console.error(`${name} failed:`, e)
    process.exit(1)
  })
}

/** Fail-loud dataset count gate: a vendored count that shrinks below its floor aborts the build
 *  instead of shipping a truncated dataset (floors sit at/just under the verified live values).
 *  Returns the count so it can wrap an expression. Tested in tests/pipelineGates.test.ts. */
export function assertFloor(count, floor, what) {
  if (count < floor) throw new Error(`only ${count} ${what} decoded — expected >= ${floor}`)
  return count
}

/** No-fabrication guard: a lookup that must resolve, or the build aborts — never ship a
 *  placeholder ('?', '', null) as a game-data claim. Tested in tests/pipelineGates.test.ts. */
export function mustResolve(value, what) {
  if (!value) throw new Error(`${what} did not resolve — refusing to fabricate a substitute`)
  return value
}

/** Download a (possibly binary) file to disk; returns byte length. */
export async function downloadTo(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, buf)
  return buf.length
}

/** Resolve a git ref of the tree-export repo to a commit SHA via the GitHub API.
 *  Returns null on API failure (rate limit etc.) — callers treat the SHA as optional metadata. */
export async function resolveTreeSha(ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref
  try {
    const commit = await getJson(`https://api.github.com/repos/${TREE_REPO}/commits/${ref}`, {
      Accept: 'application/vnd.github+json',
    })
    return typeof commit.sha === 'string' ? commit.sha : null
  } catch (err) {
    console.warn(`  (could not resolve "${ref}" to a SHA: ${err.message})`)
    return null
  }
}

/** `--name=value` or `--name value` from argv; returns undefined when absent. */
export function argValue(name, argv = process.argv.slice(2)) {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + '='))
  if (i === -1) return undefined
  return argv[i].includes('=') ? argv[i].slice(name.length + 1) : argv[i + 1]
}

export function kb(bytes) {
  return (bytes / 1024).toFixed(0) + ' KB'
}
