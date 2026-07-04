// Datamine orchestrator: exports PoE2 game tables + raw files from the live patch CDN
// using the `pathofexile-dat` CLI (MIT, (c) SnosMe — https://github.com/SnosMe/poe-dat-viewer).
// Verified end-to-end against the live patch CDN export.
//
//   node scripts/extract-tables.mjs [--patch 4.5.2.1.2]
//
// Output layout (_workbench/data-extract/ is gitignored — downstream scripts read from it):
//   _workbench/data-extract/tables/<Table>.json   flattened English table exports
//   _workbench/data-extract/files/<path with @>   raw .csd stat-description files (UTF-16LE)
//   _workbench/data-extract/psg/<path with @>     the 5 passive-skill-graph binaries
//   _workbench/data-extract/extract-meta.json     patch + schema release + row counts
//   _workbench/data-extract/.work/                CLI working dir (config.json, .cache CDN cache)
//
// Mechanics (see dat-spike.md for the why):
// - The CLI is config-driven (config.json in cwd), wipes ./files and ./tables/English on
//   every run, and hard-exits on any unknown column or missing file. So we run it in a
//   scratch dir (.work), harvest outputs after each run, and split the export into a
//   FATAL core pass and per-item OPTIONAL passes (atlas tables / extra .csd files survive
//   a rename or removal in a future patch without killing the character-data path).
// - Column lists are generated from the same "latest" dat-schema release the CLI itself
//   fetches (never hand-maintained): named columns only, minus the types the CLI does not
//   support (u8/u64/i8/i64/f64 would throw "Corrupted header").
// - The 113 MB bundle index is cached in .work/.cache/<patch>/ — only the first run pays.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEMA_URL, SCHEMA_VERSION } from 'pathofexile-dat-schema'
import { ROOT, argValue, getJson } from './lib.mjs'
import { probePatchServer } from './patch-version.mjs'

const EXTRACT = join(ROOT, '_workbench', 'data-extract')
const WORK = join(EXTRACT, '.work')
const CLI_BIN = join(ROOT, 'node_modules', 'pathofexile-dat', 'dist', 'cli', 'run.js')

const VALID_FOR_POE2 = 2 // schema validFor bit
const UNSUPPORTED_COLUMN_TYPES = new Set(['u8', 'u64', 'i8', 'i64', 'f64'])

// Core character-data path — any failure here is fatal.
const REQUIRED_TABLES = ['BaseItemTypes', 'Mods', 'ModType', 'SkillGems', 'GrantedEffects', 'Words']
const REQUIRED_FILES = [
  'Data/StatDescriptions/stat_descriptions.csd',
  'Data/StatDescriptions/passive_skill_stat_descriptions.csd',
  'Metadata/PassiveSkillGraph.psg',
  'Metadata/LeagueSkillGraphs/ChayulaTreePassiveSkillGraph.psg',
  'Metadata/AtlasSkillGraphs/AtlasSkillGraph.psg',
  'Metadata/AtlasSkillGraphs/EndgameMapLayoutGraph.psg',
  'Metadata/AlternateSkillGraphs/RoyalePassiveSkillGraph.psg',
]
// Atlas/extra path — warn + continue on failure (consumed by the later atlas/mod-tier features).
// Schema check (2026-06-12, schema v7): AtlasPassiveSkillSubTrees, AtlasClassPassives,
// AtlasClassPassiveClasses, PassiveSkills and Stats all exist and are PoE2-valid.
// Stats joins Mods.Stat1..6 (bare row indices) to the stat string ids the .csd files key on —
// required by scripts/build-mod-tiers.mjs.
// ItemVisualIdentity + ItemClasses (schema check 2026-06-12, schema v7: both PoE2-valid):
// BaseItemTypes.ItemVisualIdentity (foreignrow) -> ItemVisualIdentity.DDSFile is the item-art
// path, ItemClasses.Id filters bases to equippables — consumed by scripts/build-item-icons.mjs.
// UniqueStashLayout + KeywordPopupItemReference (schema check 2026-06-15, schema v7: both
// PoE2-valid): UniqueStashLayout.WordsKey -> Words.Text (unique name) and .ItemVisualIdentityKey
// -> ItemVisualIdentity.DDSFile (the unique's OWN art) — the sanctioned unique->art join consumed
// by scripts/build-unique-icons.mjs. KeywordPopupItemReference is a name cross-check.
// Brequel* + ClientStrings2 (schema check 2026-06-20, schema v7: all PoE2-valid): the "Genesis
// Tree" (internal codename "Brequel" — the 0.5 Breach/Chayula crafting tree). BrequelPassiveSubTrees
// (5 subtree names) + BrequelTreeSlots (5 anchor PassiveSkills) + BrequelTreePassiveUnlocks (per-node
// subtree) drive scripts/build-genesis-graph.mjs (geometry = the Chayula psg, joined on PassiveSkills
// like the atlas). BrequelCraftingItems/Fruit*/EncounterSkills/ItemResourceValues +
// ClientStrings2 (reward strings) feed the crafting-reference panel. Each is its own OPTIONAL pass —
// a rename in a future patch only loses itself. (BrequelGrafts was REMOVED by GGG in 4.5.4.1.2 — it was
// never consumed by any builder, so it's dropped from the list to avoid a spurious "file no longer exists" warn.)
// (PassiveSkillMasteryEffects was dropped — PoE2 doesn't use masteries; its builder is parked at
// _workbench/parked/mastery-effects/, with re-activation steps in that folder's README.)
const OPTIONAL_TABLES = [
  'AtlasPassiveSkillSubTrees',
  'AtlasClassPassives',
  'AtlasClassPassiveClasses',
  'PassiveSkills',
  'Stats',
  'ItemVisualIdentity',
  'ItemClasses',
  'UniqueStashLayout',
  'KeywordPopupItemReference',
  // AlternateTreeVersions + AlternatePassiveSkills (schema check 2026-06-28, schema v8: both present):
  // the timeless-jewel CONQUEROR override tables — AlternateTreeVersions (faction spawn-replacement
  // rules) + AlternatePassiveSkills (faction node overrides; .DDSIcon = node art). Consumed by
  // build-conqueror-data.mjs (-> conquerorTreeVersions/PassiveSkills.json) + build-conqueror-icons.mjs
  // (-> conquerorIcons.json). The 3 unused Alternate*/jewel tables are parked at
  // _workbench/parked/conqueror-tables/ and intentionally not extracted.
  'AlternateTreeVersions',
  'AlternatePassiveSkills',
  'BrequelPassiveSubTrees',
  'BrequelTreeSlots',
  'BrequelTreePassiveUnlocks',
  'BrequelCraftingItems',
  'BrequelFruitTypes',
  'BrequelFruitRewardTypes',
  'BrequelEncounterSkills',
  'BrequelItemResourceValues',
  'BrequelFruitQuests',
  'ClientStrings2',
]
const OPTIONAL_FILES = [
  'Data/StatDescriptions/advanced_mod_stat_descriptions.csd',
  'Data/StatDescriptions/gem_stat_descriptions.csd',
  'Data/StatDescriptions/atlas_stat_descriptions.csd',
]

/** Schema entry for a table, preferring the PoE2-valid variant (mirrors the CLI's pick). */
function findTableSchema(schema, name) {
  const candidates = schema.tables.filter((t) => t.name === name)
  return candidates.find((t) => t.validFor & VALID_FOR_POE2) ?? candidates[0] ?? null
}

/** Exportable column names for a table (named + CLI-supported types only). */
function columnsFor(tableSchema) {
  return tableSchema.columns.filter((c) => c.name && !UNSUPPORTED_COLUMN_TYPES.has(c.type)).map((c) => c.name)
}

/** Run the pathofexile-dat CLI in .work with the given config. Returns true on success. */
function runCli(config) {
  writeFileSync(join(WORK, 'config.json'), JSON.stringify(config, null, 2))
  const res = spawnSync(process.execPath, [CLI_BIN], { cwd: WORK, stdio: 'inherit' })
  return res.status === 0
}

/** Copy CLI outputs out of .work (which the next run wipes) into the stable layout. */
function harvest() {
  const tablesDir = join(WORK, 'tables', 'English')
  if (existsSync(tablesDir)) {
    for (const f of readdirSync(tablesDir)) {
      cpSync(join(tablesDir, f), join(EXTRACT, 'tables', f))
    }
  }
  const filesDir = join(WORK, 'files')
  if (existsSync(filesDir)) {
    for (const f of readdirSync(filesDir)) {
      cpSync(join(filesDir, f), join(EXTRACT, f.endsWith('.psg') ? 'psg' : 'files', f))
    }
  }
}

async function main() {
  if (!existsSync(CLI_BIN)) {
    throw new Error('pathofexile-dat is not installed — run `npm install` first')
  }

  let patch = argValue('--patch')
  if (!patch) {
    console.log('Probing live PoE2 patch version...')
    patch = (await probePatchServer()).patch
  }
  console.log(`Extracting from patch ${patch}`)

  // Same schema the CLI fetches at runtime; mismatch would hard-exit the CLI anyway,
  // so fail early with a clear message (fix = update the pathofexile-dat devDependency).
  console.log('Fetching dat-schema (latest release)...')
  const schema = await getJson(SCHEMA_URL)
  if (schema.version !== SCHEMA_VERSION) {
    throw new Error(
      `dat-schema release is v${schema.version} but pathofexile-dat expects v${SCHEMA_VERSION} — update the pathofexile-dat devDependency`,
    )
  }

  const tableConfig = (name) => {
    const sch = findTableSchema(schema, name)
    return sch ? { name, columns: columnsFor(sch) } : null
  }
  const requiredTables = REQUIRED_TABLES.map((name) => {
    const cfg = tableConfig(name)
    if (!cfg) throw new Error(`required table "${name}" is missing from the schema`)
    return cfg
  })

  // Fresh output dirs (keep .work/.cache — the 113 MB index cache).
  for (const dir of ['tables', 'files', 'psg']) {
    rmSync(join(EXTRACT, dir), { recursive: true, force: true })
    mkdirSync(join(EXTRACT, dir), { recursive: true })
  }
  mkdirSync(WORK, { recursive: true })

  const base = { patch, translations: ['English'] }
  console.log(`\n== Core pass: ${REQUIRED_TABLES.length} tables + ${REQUIRED_FILES.length} files ==`)
  if (!runCli({ ...base, files: REQUIRED_FILES, tables: requiredTables })) {
    throw new Error('core export failed — character data path is broken, aborting')
  }
  harvest()

  // Optional items one CLI run each: a missing/renamed item only loses itself.
  const missing = []
  for (const name of OPTIONAL_TABLES) {
    const cfg = tableConfig(name)
    if (!cfg) {
      console.warn(`WARN: optional table "${name}" not in schema — skipped`)
      missing.push(name)
      continue
    }
    console.log(`\n== Optional table: ${name} ==`)
    if (runCli({ ...base, files: [], tables: [cfg] })) harvest()
    else {
      console.warn(`WARN: optional table "${name}" failed to export — continuing`)
      missing.push(name)
    }
  }
  for (const file of OPTIONAL_FILES) {
    console.log(`\n== Optional file: ${file} ==`)
    if (runCli({ ...base, files: [file], tables: [] })) harvest()
    else {
      console.warn(`WARN: optional file "${file}" failed to export — continuing`)
      missing.push(file)
    }
  }

  // Row counts double as a sanity gate on the core tables.
  const tableRows = {}
  for (const f of readdirSync(join(EXTRACT, 'tables'))) {
    const rows = JSON.parse(readFileSync(join(EXTRACT, 'tables', f), 'utf8'))
    tableRows[f.replace(/\.json$/, '')] = rows.length
  }
  for (const name of REQUIRED_TABLES) {
    if (!tableRows[name]) throw new Error(`table ${name} exported 0 rows`)
  }

  const meta = {
    poe2Patch: patch,
    schema: { version: schema.version, createdAt: new Date(schema.createdAt * 1000).toISOString() },
    extractedAt: new Date().toISOString(),
    tables: tableRows,
    files: readdirSync(join(EXTRACT, 'files')),
    psg: readdirSync(join(EXTRACT, 'psg')),
    optionalMissing: missing,
  }
  writeFileSync(join(EXTRACT, 'extract-meta.json'), JSON.stringify(meta, null, 2))

  console.log('\nExtracted to _workbench/data-extract/:')
  for (const [name, rows] of Object.entries(tableRows)) console.log(`  tables/${name}.json  ${rows} rows`)
  console.log(`  files/: ${meta.files.join(', ')}`)
  console.log(`  psg/:   ${meta.psg.length} graphs`)
  if (missing.length) console.log(`  (optional items missing: ${missing.join(', ')})`)
}

main().catch((e) => {
  console.error('extract-tables failed:', e)
  process.exit(1)
})
