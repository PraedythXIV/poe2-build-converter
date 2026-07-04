// One-command data refresh: probe live patch -> datamine tables -> vendored lookups ->
// render-ready tree/atlas/genesis graphs + emotions/jewel data + art atlases.
//
//   node scripts/refresh-data.mjs [--accept-structural]
//
// Only the core character-data path (extract -> fetch-data -> tree graph) is fatal; every
// other data/art step is optional (warn + continue) because the art builds need a warm CDN
// cache and the live-fetch builders need network. Finishes by:
//   1. running scripts/diff-data.mjs against a pre-refresh snapshot of src/data — a STRUCTURAL
//      regression (shape change, >10% row-collapse, raw stat-id leak) FAILS the run so a human
//      reviews it; content-only diffs auto-pass. Pass --accept-structural to downgrade to a warning.
//   2. writing data-version.json (the freshness marker CI compares against) and a summary.
//
// This is the local full pipeline (run it with the game installed for a warm cache); the
// .github/workflows/data-refresh.yml CI path runs the same scripts + the same diff gate.

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { ROOT, kb, resolveTreeSha } from './lib.mjs'
import { probePatchServer } from './patch-version.mjs'

const SCRIPTS = join(ROOT, 'scripts')
const DATA = join(ROOT, 'src', 'data')
const SNAPSHOT = join(ROOT, '_workbench', 'data-extract', '.refresh-ref') // pre-refresh src/data copy (gitignored)

/** Run a pipeline script; returns true on success. Fatal unless optional.
 *  nodeArgs are node runtime flags (e.g. --max-old-space-size) placed before the script path. */
function runStep(script, args = [], { optional = false, nodeArgs = [] } = {}) {
  const file = join(SCRIPTS, script)
  if (!existsSync(file)) {
    if (optional) {
      console.log(`-- ${script} not present yet — skipped (lands with a later feature)`)
      return false
    }
    throw new Error(`missing required script ${script}`)
  }
  console.log(`\n========== ${script} ${args.join(' ')} ==========`)
  const res = spawnSync(process.execPath, [...nodeArgs, file, ...args], { cwd: ROOT, stdio: 'inherit' })
  if (res.status === 0) return true
  if (optional) {
    console.warn(`WARN: ${script} failed (exit ${res.status}) — continuing, this step is optional`)
    return false
  }
  throw new Error(`${script} failed with exit code ${res.status}`)
}

/** Copy the CURRENT src/data/*.json into SNAPSHOT before any build overwrites it, so the diff
 *  gate at the end can classify the refresh against the pre-refresh state. Returns file count. */
function snapshotData() {
  rmSync(SNAPSHOT, { recursive: true, force: true })
  mkdirSync(SNAPSHOT, { recursive: true })
  let n = 0
  for (const f of readdirSync(DATA)) {
    if (f.endsWith('.json')) {
      copyFileSync(join(DATA, f), join(SNAPSHOT, f))
      n++
    }
  }
  return n
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

async function main() {
  const t0 = Date.now()
  const acceptStructural = process.argv.includes('--accept-structural')

  console.log('Probing live PoE2 patch...')
  const { patch, cdnUrl } = await probePatchServer()
  console.log(`  patch ${patch} (${cdnUrl})`)
  const treeSha = (await resolveTreeSha('main')) ?? 'main'
  console.log(`  tree export main @ ${treeSha}`)

  // Snapshot the current vendored data BEFORE any build overwrites it — the diff gate (below)
  // classifies the whole refresh against this. Skipped only on a truly empty src/data.
  const snapN = snapshotData()
  console.log(`  snapshot: ${snapN} src/data/*.json -> ${SNAPSHOT}`)

  // ---- required character-data path (fatal on failure) ----
  runStep('extract-tables.mjs', ['--patch', patch])
  runStep('fetch-data.mjs', ['--ref', treeSha])
  runStep('build-tree-graph.mjs', ['--ref', treeSha])

  // ---- vendored data tables (deterministic table joins; optional = warn+continue) ----
  // Genesis/emotions/atlas-masters have a HARD internal order: csd -> graph -> icons, masters -> icons.
  runStep('build-conqueror-data.mjs', [], { optional: true }) // timeless/conqueror override tables (datamine)
  runStep('build-atlas-graph.mjs', ['--ref', treeSha], { optional: true }) // atlas tree + 38 Id-sibling choosers
  runStep('build-jewel-radii.mjs', ['--patch', patch], { optional: true }) // real PassiveJewelRadii (no fabricated radii)
  runStep('build-emotions.mjs', ['--patch', patch], { optional: true }) // Distilled-Emotion crafting tables
  runStep('fetch-genesis-csd.mjs', [], { optional: true }) // live stat_descriptions supplement — PREREQ for genesis graph
  runStep('build-genesis-graph.mjs', [], { optional: true }) // Genesis tree + 37 Id-sibling choosers (needs the live csd)
  runStep('build-genesis-crafting.mjs', [], { optional: true }) // Genesis fruit/crafting reference
  runStep('build-atlas-masters.mjs', [], { optional: true }) // atlas master node data — PREREQ for master icons/portraits
  runStep('build-mod-tiers.mjs', [], { optional: true })

  // ---- art / sprite atlases (DDS -> webp; need a WARM CDN cache — a partial cache silently drops
  //      rows, which the diff gate below catches as a ROW-COLLAPSE) ----
  runStep('build-passive-bg.mjs', ['--ref', treeSha], { optional: true }) // central class/ascendancy art (export-sourced)
  runStep('build-class-art.mjs', [], { optional: true }) // class/ascendancy splash illustrations (treeGraph.json + CDN cache)
  runStep('build-passive-masteries.mjs', ['--ref', treeSha], { optional: true }) // mastery effect "glow rays"
  runStep('build-passive-jewels.mjs', ['--ref', treeSha], { optional: true }) // jewel-socket radius rings
  runStep('build-emotion-icons.mjs', [], { optional: true }) // emotion currency icons (needs emotions.json)
  runStep('build-genesis-icons.mjs', [], { optional: true }) // Genesis node icons (needs genesisGraph.json)
  runStep('build-genesis-bg.mjs', [], { optional: true, nodeArgs: ['--max-old-space-size=6144'] }) // 4k Genesis backdrop (heavy)
  runStep('build-atlas-master-icons.mjs', [], { optional: true }) // atlas master node icons (needs atlasMasters.json)
  runStep('build-atlas-master-portraits.mjs', [], { optional: true }) // atlas master portraits (needs atlasMasters.json)
  runStep('build-item-icons.mjs', ['--patch', patch], { optional: true })
  runStep('build-unique-icons.mjs', [], { optional: true }) // unique-item OWN art (UniqueStashLayout join)
  runStep('build-conqueror-icons.mjs', [], { optional: true }) // Timeless-Jewel conqueror node art (AlternatePassiveSkills.DDSIcon)
  // ATLAS bg facade + per-subtree precursor panels, and node icons (DDS->webp, CDN cache-first = CI-runnable, no game
  // install). MUST run after build-atlas-graph.mjs above: build-atlas-icons reads src/data/atlasGraph.json for node-icon
  // paths, build-atlas-bg reads the AtlasPassiveSkillSubTrees table — so a NEW subtree's art (panel + icons) auto-ships.
  runStep('build-atlas-bg.mjs', [], { optional: true })
  runStep('build-atlas-icons.mjs', [], { optional: true })

  // ---- SAFETY GATE: structural-diff the refreshed src/data vs the pre-refresh snapshot ----
  // A structural regression (shape change, >10% row-collapse, raw stat-id leak) exits non-zero,
  // so this FAILS the refresh — and data-version.json below is never written (the refresh isn't
  // marked fresh on a regression). --accept-structural downgrades it to a warning for a reviewed change.
  if (snapN > 0) {
    runStep('diff-data.mjs', [SNAPSHOT], { optional: acceptStructural })
  } else {
    console.log('\n-- diff gate skipped (empty pre-refresh snapshot — nothing to compare against)')
  }

  // Freshness marker — CI compares the live patch + tree SHA against this file.
  const extractMeta = JSON.parse(readFileSync(join(ROOT, '_workbench', 'data-extract', 'extract-meta.json'), 'utf8'))
  const version = {
    poe2Patch: patch,
    treeSha,
    schemaRelease: `v${extractMeta.schema.version} (${extractMeta.schema.createdAt})`,
    refreshed: new Date().toISOString(),
  }
  writeFileSync(join(ROOT, 'data-version.json'), JSON.stringify(version, null, 2) + '\n')

  console.log('\n========== freshness summary ==========')
  console.log(JSON.stringify(version, null, 2))
  console.log('\nArtifacts:')
  for (const f of readdirSync(DATA)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    console.log(`  src/data/${f}  ${kb(fileSize(join(DATA, f)))}`)
  }
  for (const sub of ['tree', 'items']) {
    const assetDir = join(ROOT, 'src', 'assets', sub)
    if (existsSync(assetDir)) {
      for (const f of readdirSync(assetDir)) console.log(`  src/assets/${sub}/${f}  ${kb(fileSize(join(assetDir, f)))}`)
    }
  }
  console.log(`\nFull refresh took ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch((e) => {
  console.error('refresh-data failed:', e)
  process.exit(1)
})
