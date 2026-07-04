// Atlas-Masters data: the 3 atlas masters (Doryani / Hilda / Jado), each a 4-row x
// 3-column grid of keystones where you allocate ANY of the 12 up to a 4-point cap (no
// per-row limit — the row index is just the display layout). PLANNER-ONLY: the .build
// format carries no atlas data (verified), so this never round-trips an export.
//
//   node scripts/build-atlas-masters.mjs            # reads the live install (current patch)
//
// Why this reads the install directly (not _workbench/data-extract/): the display row + point budget
// live in UNMAPPED columns of AtlasClassPassives / AtlasClassPassiveClasses that the
// schema-named CLI export (scripts/extract-tables.mjs) drops. We read them low-level with
// the same pathofexile-dat reader the CLI uses. Stats + the .csd text are read from the
// SAME loader so the patch can't mismatch (stat row-indices are patch-specific — a stale
// Stats.json would silently mis-resolve text, violating the no-approximate rule).
//
// Output: src/data/atlasMasters.json
//   { _provenance, budget, masters: [{ id, name, description, keystones: [
//       { id, row, col, name, flavour, stats: string[], iconDds, iconDdsActive } ] }] }
//   - row 1..4, col 1..3 (col derived from the keystone's 1..12 order within its master)
//   - stats: exact English lines via scripts/lib-csd.mjs (shared with build-atlas-graph)
// Icons (.dds paths) are recorded here; decoding them to a sprite is build-atlas-master-icons.mjs.

import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, kb, runMain } from './lib.mjs'
import { SCHEMA_URL } from 'pathofexile-dat-schema'
import { parseCsd, resolveStats } from './lib-csd.mjs'
import { buildDatHeaders } from './lib-dat.mjs'

const INSTALL = process.env.POE2_INSTALL // optional local game install; unset → CDN fallback below
const OUT = join(ROOT, 'src', 'data', 'atlasMasters.json')
const DAT = join(ROOT, 'node_modules', 'pathofexile-dat', 'dist')
const imp = (p) => import(pathToFileURL(join(DAT, p)).href)

// Lookup order matches build-atlas-graph: atlas wording first, then passive, then generic.
const CSD_FILES = [
  'Data/StatDescriptions/atlas_stat_descriptions.csd',
  'Data/StatDescriptions/passive_skill_stat_descriptions.csd',
  'Data/StatDescriptions/stat_descriptions.csd',
]
// Names for the columns the dat-schema leaves UNMAPPED (`_`), per table + 0-based index.
// Verified by reading the raw column values from the install:
//   AtlasClassPassives[9] (i32) = the row (1..4); [8] (u16) is a UI/sort ref we don't need.
//   AtlasClassPassiveClasses[3] (i32) = the point budget (4 for each real master);
//   [2] (i32[]) is 4 per-master ids (unused — the in-game UI shows no row labels).
const UNMAPPED_NAMES = {
  AtlasClassPassives: { 8: '_uiRef', 9: 'Row' },
  AtlasClassPassiveClasses: { 2: '_rowRefs', 3: 'MaxPoints' },
}

async function main() {
  const [{ readDatFile }, { readColumn }, { getHeaderLength }, loaders] = await Promise.all([
    imp('dat/dat-file.js'),
    imp('dat/reader.js'),
    imp('dat/header.js'),
    imp('cli/bundle-loaders.js'),
  ])
  const schema = await (await fetch(SCHEMA_URL)).json()

  let loader
  try {
    if (!INSTALL) throw new Error('POE2_INSTALL not set')
    loader = await loaders.FileLoader.create(new loaders.SteamBundleLoader(INSTALL))
    console.log(`loader: SteamBundleLoader(${INSTALL})`)
  } catch (e) {
    const cache = join(ROOT, '_workbench', 'data-extract', '.work', '.cache')
    console.warn(`Steam loader failed (${e.message}); falling back to CDN cache at ${cache}`)
    loader = await loaders.FileLoader.create(await loaders.CdnBundleLoader.create(cache, '4.5.2.1.2'))
  }

  /** Read a whole table including unmapped columns (named via UNMAPPED_NAMES). The header layout
   *  comes from the shared lib-dat builder; only the override naming is this script's. */
  async function readTable(name) {
    const buf =
      (await loader.tryGetFileContents(`Data/Balance/${name}.datc64`)) ??
      (await loader.getFileContents(`Data/Balance/${name}.datc64`))
    const datFile = readDatFile('.datc64', buf)
    const cands = schema.tables.filter((t) => t.name === name)
    const sch = cands.find((t) => t.validFor & 2) ?? cands[0]
    const overrides = UNMAPPED_NAMES[name] ?? {}
    const headers = buildDatHeaders(sch, datFile, getHeaderLength, (c, i) => c.name || overrides[i] || `_col${i}`)
    const cols = headers.map((x) => ({ name: x.name, data: readColumn(x.h, datFile) }))
    return Array.from({ length: datFile.rowCount }, (_, r) => Object.fromEntries(cols.map((c) => [c.name, c.data[r]])))
  }

  const classes = await readTable('AtlasClassPassiveClasses')
  const passives = await readTable('AtlasClassPassives')
  const statRows = await readTable('Stats')

  // .csd text — read from the SAME loader (same patch as Stats), parsed atlas-first.
  const descriptions = new Map()
  for (const path of CSD_FILES) {
    const buf = await loader.tryGetFileContents(path)
    if (!buf) {
      console.warn(`WARN: ${path} not found — its stat ids fall back to raw "stat_id = value".`)
      continue
    }
    for (const [id, entry] of parseCsd(
      Buffer.from(buf)
        .toString('utf16le')
        .replace(/^\uFEFF/, ''),
    )) {
      if (!descriptions.has(id)) descriptions.set(id, entry)
    }
  }
  // Class index is the 1-based row in AtlasClassPassiveClasses; row 0 is the "None" placeholder.
  let totalResolved = 0
  let totalFallback = 0
  const masters = classes
    .map((cls, classIdx) => ({ cls, classIdx }))
    .filter(({ cls }) => cls.Id && cls.Id !== 'None')
    .map(({ cls, classIdx }) => {
      const rows = passives.filter((p) => p.Class === classIdx)
      // order within the master by the keystone's 1..12 Id suffix → (row, col)
      const ordered = rows
        .map((p) => ({ p, n: Number(String(p.Id).match(/(\d+)$/)?.[1] ?? 0) }))
        .sort((a, b) => a.n - b.n)
      const keystones = ordered.map(({ p, n }) => {
        const { stats, resolved, fallback } = resolveStats(p.Stats, p.StatValues ?? [], descriptions, statRows)
        totalResolved += resolved
        totalFallback += fallback
        return {
          id: p.Id,
          row: p.Row,
          col: ((n - 1) % 3) + 1,
          name: p.Name || p.Id,
          flavour: (p.FlavourText || '').replace(/\r/g, ''),
          stats,
          iconDds: p.KeystoneArt || '',
          iconDdsActive: p.KeystoneArtActive || '',
        }
      })
      return {
        id: cls.Id,
        name: cls.Description || cls.Id,
        budget: cls.MaxPoints ?? 4,
        portrait: cls.MasterNormal || '', // the master's character art (MasterNormal)
        keystones,
      }
    })

  // Sanity gates — fail loud, never ship a malformed/approximate table.
  if (masters.length !== 3) throw new Error(`expected 3 masters, got ${masters.length}`)
  for (const m of masters) {
    if (m.keystones.length !== 12) throw new Error(`${m.id}: expected 12 keystones, got ${m.keystones.length}`)
    const rowCounts = {}
    for (const k of m.keystones) rowCounts[k.row] = (rowCounts[k.row] || 0) + 1
    const rowsOk = [1, 2, 3, 4].every((r) => rowCounts[r] === 3)
    if (!rowsOk) throw new Error(`${m.id}: expected 4 rows x 3 keystones, got ${JSON.stringify(rowCounts)}`)
    if (m.budget !== 4) console.warn(`NOTE: ${m.id} budget = ${m.budget} (expected 4)`)
  }

  const out = {
    _provenance: {
      source: 'pathofexile-dat (SnosMe, MIT) — AtlasClassPassives + AtlasClassPassiveClasses + Stats',
      note: 'display row + point budget read from schema-unmapped columns; verified against the in-game UI (4 rows x 3 layout; pick ANY keystones up to a 4-point cap, no per-row limit).',
      builtAt: new Date().toISOString(),
    },
    budget: 4,
    masters,
  }
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(out, null, 2))

  const lines = masters.flatMap((m) => m.keystones).reduce((a, k) => a + k.stats.length, 0)
  console.log(
    `\nWrote ${kb(Buffer.byteLength(JSON.stringify(out)))} → src/data/atlasMasters.json\n` +
      `  3 masters (${masters.map((m) => m.id).join(', ')}) × 12 keystones × 4 rows\n` +
      `  stat lines: ${lines}  (resolved ${totalResolved}, raw-fallback ${totalFallback})`,
  )
  if (totalFallback > 0) {
    console.warn(`  ⚠ ${totalFallback} stat line(s) fell back to raw form — review before shipping (no-approximate).`)
  }
}

runMain('build-atlas-masters', main)
