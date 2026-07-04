// Offline builder: vendor the TIMELESS-JEWEL / CONQUEROR passive-tree override tables into
// src/data/ as the app's render-ready lookups. These tables drive the conqueror (timeless-jewel)
// transform of the passive tree: which Time-Lost / faction nodes spawn, their replacement stats,
// the faction-versioned art, and the 16 deterministic Stat swaps a Time-Lost jewel applies.
//
// SOURCE = GGG PoE2 game data, datamined from GGG's patch CDN via pathofexile-dat (MIT). The
// upstream tables are extracted (gitignored) to _workbench/data-extract/tables/ by `npm run data:extract`;
// this script is a pure COPY + SLIM step (no DDS decode, no CDN/Steam loader) that stamps each
// output with a _provenance block keyed to the captured patch (_workbench/data-extract/extract-meta.json).
//
//   node scripts/build-conqueror-data.mjs
//
// Outputs (under src/data/, each carrying _provenance):
//   conquerorTreeVersions.json    8 AlternateTreeVersions (faction spawn-replacement rules)
//   conquerorPassiveSkills.json   231 AlternatePassiveSkills, SLIMMED (the faction node overrides)
//
// The read-only timeless-jewel viewer consumes only those two (+ conquerorIcons.json from
// build-conqueror-icons.mjs). Three further datamined tables — AlternateTreeArt,
// PassiveJewelTransformations, AlternatePassiveAdditions — have no app/test consumer and are PARKED
// under _workbench/parked/conqueror-tables/ (revive their read+writeOut branches from git history if a
// faction-art / Time-Lost-swap feature lands).
//
// SLIMMING CONTRACT — for the big shipped table we keep only the fields the renderer + .itc-card
// tooltip consume, and drop purely-internal / unused columns:
//
//   AlternatePassiveSkills (231): the named faction notables/keystones/smalls a timeless jewel
//   can spawn. KEEP: Id, AlternateTreeVersion, Name, PassiveType, Stats, Stat1..Stat6, SpawnWeight,
//   ConquerorIndex, ConquerorVersion, ConquerorSpawnWeight, DDSIcon, FlavourText.
//     - Id is the override join token; AlternateTreeVersion ties the row to a faction (1..7).
//     - Name + FlavourText + DDSIcon feed the tooltip header / art (DDSIcon = the faction node art).
//     - PassiveType + Stats + Stat1..Stat6 are the stat-id + rolled-range payload the tooltip renders.
//     - SpawnWeight / ConquerorIndex / ConquerorVersion / ConquerorSpawnWeight = which conqueror
//       seed this row belongs to and how likely it is — needed to attribute a node to its faction.
//   DROP: AchievementItems (internal reward links, never displayed), Random (internal RNG flag),
//     _index (positional artifact of the dat export — the stable key is Id).
//
// conquerorTreeVersions.json is copied VERBATIM (already tiny + every field is meaningful) except
// _index is dropped (positional, redundant with array order).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, assertFloor, kb, logDone, readExtractJson, runMain } from './lib.mjs'

const EXTRACT = join(ROOT, '_workbench', 'data-extract')
const SRC = join(EXTRACT, 'tables')
const OUT = join(ROOT, 'src', 'data')

/** Read a datamined table from the gitignored data-extract; fail loudly if it's missing. */
function readTable(name) {
  const path = join(SRC, `${name}.json`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(
      `cannot read ${name} at ${path} (${e.code || e.message}). ` +
        `Run "npm run data:extract" first — these tables are the gitignored datamine output.`,
      { cause: e },
    )
  }
}

/** Copy each row keeping only `fields` (in the given order), preserving absent-key semantics. */
function pick(rows, fields) {
  return rows.map((row) => {
    const out = {}
    for (const f of fields) if (f in row) out[f] = row[f]
    return out
  })
}

function provenance(patch, note) {
  return {
    source: 'GGG PoE2 game data via pathofexile-dat',
    patch,
    captured: new Date().toISOString().slice(0, 10),
    note: `${note} © Grinding Gear Games. Not affiliated with or endorsed by Grinding Gear Games.`,
  }
}

/** Write `{ _provenance, <key>: rows }` and log the result. */
function writeOut(file, key, rows, prov) {
  const out = { _provenance: prov, [key]: rows }
  const json = JSON.stringify(out)
  writeFileSync(join(OUT, file), json)
  console.log(`  src/data/${file}  ${rows.length} rows  ${kb(json.length)}`)
}

async function main() {
  const t0 = Date.now()
  const meta = readExtractJson('extract-meta.json')
  const patch = meta.poe2Patch
  mkdirSync(OUT, { recursive: true })

  // --- small tables: verbatim minus the positional _index ---
  const treeVersions = readTable('AlternateTreeVersions').map(({ _index, ...r }) => r)
  // Fail-loud gates (floors just under the 2026-06 live values: 8 versions / 231 skills) — a
  // shrunken extract aborts instead of vendoring a truncated conqueror table.
  assertFloor(treeVersions.length, 8, 'AlternateTreeVersions rows')

  // --- big tables: slim to renderer/tooltip fields (see header SLIMMING CONTRACT) ---
  const SKILL_FIELDS = [
    'Id',
    'AlternateTreeVersion',
    'Name',
    'PassiveType',
    'Stats',
    'Stat1',
    'Stat2',
    'Stat3',
    'Stat4',
    'Stat5',
    'Stat6',
    'SpawnWeight',
    'ConquerorIndex',
    'ConquerorVersion',
    'ConquerorSpawnWeight',
    'DDSIcon',
    'FlavourText',
  ]
  const passiveSkills = pick(readTable('AlternatePassiveSkills'), SKILL_FIELDS)
  assertFloor(passiveSkills.length, 225, 'AlternatePassiveSkills rows')

  console.log(`Vendoring conqueror/timeless tables (patch ${patch}):`)
  writeOut(
    'conquerorTreeVersions.json',
    'versions',
    treeVersions,
    provenance(patch, 'Conqueror (timeless-jewel) passive-tree spawn-replacement rules'),
  )
  writeOut(
    'conquerorPassiveSkills.json',
    'skills',
    passiveSkills,
    provenance(patch, 'Conqueror faction passive-node overrides'),
  )

  console.log('')
  logDone(t0)
}

runMain('build-conqueror-data', main)
