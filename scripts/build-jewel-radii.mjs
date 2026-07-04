// Passive-tree jewel radii — the REAL per-size radius (in tree-coordinate units) a radius jewel
// (Timeless / Time-Lost Diamond / conqueror) affects. Replaces the old hand-written PoE1×2 guess
// in main.ts (small 1600 / medium 2400 / … — never validated against PoE2 and demonstrably wrong).
//
//   node scripts/build-jewel-radii.mjs [--patch 4.5.3.1.4] [--refresh]   (npm run data:jewel-radii)
//
// Source: the GGG `PassiveJewelRadii` table (ID = size name, Radius = node-affecting radius,
// RingInnerRadius/RingOuterRadius = the visual ring band). Self-contained: the table is a stable
// game constant, extracted at the live patch into _workbench/data-extract/.work/ (cached;
// --refresh re-pulls). A sidecar live-PassiveJewelRadii.meta.json records the patch the cached
// rows were EXTRACTED at, so _provenance is stamped honestly on cached runs (no probe needed);
// an old cache without the sidecar is treated as stale and re-extracted.
//
// Output: src/data/jewelRadii.json — { _provenance, sizes: { "<normalised size>": { radius,
//   ringInner, ringOuter, id } } }. Keyed by the size name lowercased with spaces removed
// ("Very Large" -> "verylarge") so the jewel's "Radius: <size>" text maps straight onto it.

// jscpd:ignore-start — ESM import boilerplate: the two self-contained live-extractor scripts
// share the same toolchain imports by necessity; the shared code lives in lib.mjs / lib-csd.mjs
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SCHEMA_URL, SCHEMA_VERSION } from 'pathofexile-dat-schema'
import { ROOT, argValue, getJson, kb, runMain } from './lib.mjs'
import { probePatchServer } from './patch-version.mjs'
// jscpd:ignore-end

const EXTRACT = join(ROOT, '_workbench', 'data-extract')
const WORK = join(EXTRACT, '.work')
const CLI_BIN = join(ROOT, 'node_modules', 'pathofexile-dat', 'dist', 'cli', 'run.js')
const OUT = join(ROOT, 'src', 'data', 'jewelRadii.json')
const UNSUPPORTED = new Set(['u8', 'u64', 'i8', 'i64', 'f64'])

const norm = (s) => s.toLowerCase().replace(/\s+/g, '')

async function main() {
  const cached = join(WORK, 'live-PassiveJewelRadii.json')
  const metaPath = join(WORK, 'live-PassiveJewelRadii.meta.json')
  const explicitPatch = argValue('--patch')
  // Reuse the cache only when its extraction patch is on record (the sidecar) and not contradicted
  // by an explicit --patch — otherwise the _provenance stamp would claim a patch the rows may not be from.
  const cachedMeta =
    !process.argv.includes('--refresh') && existsSync(cached) && existsSync(metaPath)
      ? JSON.parse(readFileSync(metaPath, 'utf8'))
      : null
  let patch
  if (cachedMeta && (!explicitPatch || explicitPatch === cachedMeta.patch)) {
    patch = cachedMeta.patch // the patch the cached rows were EXTRACTED at (honest provenance, no probe)
    console.log(`Using cached live-PassiveJewelRadii.json (patch ${patch}) — pass --refresh to re-extract.`)
  } else {
    patch = explicitPatch
    if (!patch) {
      console.log('Probing live PoE2 patch version...')
      patch = (await probePatchServer()).patch
    }
    if (!existsSync(CLI_BIN)) throw new Error('pathofexile-dat is not installed — run `npm install` first')
    const schema = await getJson(SCHEMA_URL)
    if (schema.version !== SCHEMA_VERSION) {
      throw new Error(
        `dat-schema is v${schema.version} but pathofexile-dat expects v${SCHEMA_VERSION} — update the devDependency`,
      )
    }
    const cands = schema.tables.filter((t) => t.name === 'PassiveJewelRadii')
    const t = cands.find((x) => x.validFor & 2) ?? cands[0]
    if (!t) throw new Error('PassiveJewelRadii missing from schema')
    mkdirSync(WORK, { recursive: true })
    writeFileSync(
      join(WORK, 'config.json'),
      JSON.stringify(
        {
          patch,
          translations: ['English'],
          files: [],
          tables: [
            {
              name: 'PassiveJewelRadii',
              columns: t.columns.filter((c) => c.name && !UNSUPPORTED.has(c.type)).map((c) => c.name),
            },
          ],
        },
        null,
        2,
      ),
    )
    if (spawnSync(process.execPath, [CLI_BIN], { cwd: WORK, stdio: 'inherit' }).status !== 0)
      throw new Error('extraction failed')
    const td = join(WORK, 'tables', 'English')
    for (const f of readdirSync(td)) cpSync(join(td, f), join(WORK, `live-${f}`))
    writeFileSync(metaPath, JSON.stringify({ patch, extractedAt: new Date().toISOString() }))
  }

  const rows = JSON.parse(readFileSync(cached, 'utf8'))
  const sizes = {}
  for (const r of rows) {
    if (!r.ID || typeof r.Radius !== 'number') continue
    sizes[norm(r.ID)] = { id: r.ID, radius: r.Radius, ringInner: r.RingInnerRadius, ringOuter: r.RingOuterRadius }
  }
  if (!Object.keys(sizes).length) throw new Error('no jewel radii decoded')

  const out = {
    _provenance: {
      source:
        'GGG PoE2 game data via pathofexile-dat — PassiveJewelRadii (ID size name + Radius = node-affecting radius in tree-coordinate units; Ring* = visual ring band)',
      patch,
      captured: new Date().toISOString().slice(0, 10),
      note: 'Game data (c) Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    sizes,
  }
  const json = JSON.stringify(out)
  await mkdir(join(ROOT, 'src', 'data'), { recursive: true })
  await writeFile(OUT, json)
  console.log(`src/data/jewelRadii.json  ${kb(Buffer.byteLength(json))}  (${Object.keys(sizes).length} sizes)`)
  for (const [k, v] of Object.entries(sizes))
    console.log(`  ${k.padEnd(12)} radius ${v.radius} (ring ${v.ringInner}-${v.ringOuter})`)
}

runMain('build-jewel-radii', main)
