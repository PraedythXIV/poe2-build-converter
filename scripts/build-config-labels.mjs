// Offline builder: PoB config-option VAR -> human LABEL map, so the read-only Config panel can show the
// build's calc assumptions with Path of Building's OWN wording ("Is the enemy Ignited?") instead of the
// raw PoB XML keys ("conditionEnemyIgnited"). This is REAL name resolution from PoB's data, not a guessed
// camelCase-spacing — the labels are PoB's exact strings, so nothing is fabricated.
//
//   node scripts/build-config-labels.mjs
//
// Source: _workbench/pob2/src/Modules/ConfigOptions.lua (a local, gitignored `git clone --depth 1` of
// PathOfBuildingCommunity/PathOfBuilding-PoE2). PoB is MIT (Copyright (c) 2016 David Gowor) — these UI
// label strings are reused with attribution (see THIRD-PARTY-NOTICES.md). Output is VENDORED so the app
// needs neither PoB nor network at runtime; re-run this when PoB adds/renames config options.
//
// Output: src/data/configLabels.json — { "<var>": "<label>", …, _provenance }

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, runMain } from './lib.mjs'

const SRC = join(ROOT, '_workbench', 'pob2', 'src', 'Modules', 'ConfigOptions.lua')
const OUT = join(ROOT, 'src', 'data', 'configLabels.json')

// Strip PoB inline colour codes: ^xRRGGBB (6-hex) and ^N (single-digit palette index), collapse whitespace.
const stripCodes = (s) =>
  s
    .replace(/\^x[0-9A-Fa-f]{6}/g, '')
    .replace(/\^[0-9]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

async function main() {
  if (!existsSync(SRC)) {
    throw new Error(
      `PoB source not found at ${SRC} — clone PathOfBuildingCommunity/PathOfBuilding-PoE2 into _workbench/pob2/ (gitignored) first`,
    )
  }
  const lua = readFileSync(SRC, 'utf8')
  // Each option entry is `{ var = "X", type = "...", label = "Y", ... }`. var + its OWN label sit on the
  // same line (before any multi-line `apply = function`); the non-greedy `[^\n]*?` keeps us on that line,
  // so the FIRST label after var is the option's (not a nested list option's). Entries with no own label
  // (pure list groups) are skipped.
  const re = /\bvar\s*=\s*"(\w+)"[^\n]*?\blabel\s*=\s*"((?:[^"\\]|\\.)*)"/g
  const labels = {}
  let m
  while ((m = re.exec(lua))) {
    const [, varName, rawLabel] = m
    if (labels[varName]) continue // keep the first (the option's own label)
    const label = stripCodes(rawLabel)
    if (label) labels[varName] = label
  }
  const count = Object.keys(labels).length
  if (count < 300)
    throw new Error(`only ${count} config labels extracted (expected >300) — ConfigOptions.lua format may have changed`)

  const out = {
    _provenance: {
      source: 'Path of Building (PathOfBuildingCommunity/PathOfBuilding-PoE2) src/Modules/ConfigOptions.lua',
      license: 'MIT (Copyright (c) 2016 David Gowor) — UI label strings reused with attribution',
      captured: new Date().toISOString().slice(0, 10),
      count,
      note: 'Config option labels are Path of Building’s own wording, vendored so the read-only Config panel resolves raw PoB keys to real labels (no fabricated names).',
    },
    ...labels,
  }
  writeFileSync(OUT, JSON.stringify(out))
  console.log(`Wrote src/data/configLabels.json  ${count} var->label pairs`)
}

runMain('build-config-labels', main)
