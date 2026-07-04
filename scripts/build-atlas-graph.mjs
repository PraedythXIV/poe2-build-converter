// Render-ready ATLAS passive-tree graph, decoded from the game's AtlasSkillGraph.psg
// and joined to the PassiveSkills table (own pathofexile-dat extraction — GGG publishes
// no atlas-tree export, unlike the character tree). Same output shape as treeGraph.json
// so the B1 renderer consumes it unchanged.
//
//   node scripts/build-atlas-graph.mjs
//
// Inputs (run `npm run data:extract` first; all under _workbench/data-extract/):
//   psg/Metadata@AtlasSkillGraphs@AtlasSkillGraph.psg     geometry (decode-psg.mjs)
//   tables/PassiveSkills.json                             names/flags, joined on PassiveSkillGraphId
//   tables/Stats.json                                     stat row index -> stat id string
//   tables/AtlasPassiveSkillSubTrees.json                 subtree names (Breach, Ritual, ...)
//   files/Data@StatDescriptions@*.csd                     OPTIONAL — English stat text, looked
//     up in atlas_stat_descriptions first, then passive_skill_*, then stat_descriptions
//     (3 atlas stat ids only exist in the generic file). Any id still unresolved falls back
//     to a raw "stat_id = value" line (build still succeeds, never silently wrong).
//
// Geometry trust: node x/y and edge arc centres come from the orbit math in decode-psg.mjs,
// which is fit-validated against GGG's baked character-tree coordinates (5150/5150 nodes
// and 1733/1733 arc centres within 1 world unit — `node scripts/decode-psg.mjs --verify`).
// The atlas psg uses the same format version, orbit table and arc encoding.
//
// Output: src/data/atlasGraph.json — { _provenance, bounds, classes: [], nodes, edges }
//   nodes:  { <PassiveSkillGraphId>: { id, name, icon, stats[], x, y, group, orbit,
//             orbitIndex, notable?, keystone?, atlasRoot?, subTree? } }
//   edges:  [{ from, to, orbitX?, orbitY? }]   (same arc-centre contract as treeGraph)
//   classes: [] — the atlas tree has no classes/ascendancies; key kept for shape parity.
// Icons: PassiveSkills carries .dds paths that do NOT resolve in the character-tree webp
// sprite atlases — the renderer's dot/circle fallback is the intended display for now.

import { readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT, kb, readExtractJson, runMain } from './lib.mjs'
import { decodePsg, flattenNodes } from './decode-psg.mjs'
import {
  readGraphInputs,
  detectChoices,
  buildEdges,
  computeBounds,
  psgGraphHeader,
  statValues,
  round1,
} from './lib-psg-graph.mjs'
import { readDatTable } from './lib-dat.mjs'

/**
 * Per-subtree precursor art→world SCALE, recovered from the game table's UNNAMED f32 column (the schema
 * doesn't label it, so the CLI export drops it — see lib-dat.mjs). atlasPanels() uses `size = scale ×
 * native_px`, so this is what makes the backdrop size data-driven (no hand constant). Identified by TYPE,
 * not a fixed index: the SOLE unmapped f32 (uniform 4.5 = the precursor art scale). Defensive — if that
 * assumption breaks (0 or >1 unmapped f32, or an implausible value) we return {} and atlasPanels falls
 * back to the verified constant, never shipping a wrong scale. Keyed by subtree Id.
 */
async function readSubtreeScales(patch) {
  const table = await readDatTable('AtlasPassiveSkillSubTrees', {
    patch,
    cacheDir: join(ROOT, '_workbench', 'data-extract', '.work', '.cache'),
  })
  if (!table) return {}
  const f32 = table.columns.filter((c) => c.unmapped && c.type === 'f32').map((c) => c.name)
  if (f32.length !== 1) {
    console.warn(
      `  atlas scale: expected exactly 1 unmapped f32 column, found ${f32.length} — skipping (atlasPanels will fall back)`,
    )
    return {}
  }
  const col = f32[0]
  const scales = {}
  for (const row of table.rows) {
    const v = row[col]
    if (typeof v === 'number' && v >= 0.5 && v <= 20 && typeof row.Id === 'string') scales[row.Id] = +v.toFixed(4)
  }
  return scales
}
import { resolveStats } from './lib-csd.mjs'

const EXTRACT = join(ROOT, '_workbench', 'data-extract')
const PSG = join(EXTRACT, 'psg', 'Metadata@AtlasSkillGraphs@AtlasSkillGraph.psg')
// Lookup order matters: the atlas file has the atlas-specific wording.
const CSD_FILES = [
  'Data@StatDescriptions@atlas_stat_descriptions.csd',
  'Data@StatDescriptions@passive_skill_stat_descriptions.csd',
  'Data@StatDescriptions@stat_descriptions.csd',
]
const OUT = join(ROOT, 'src', 'data', 'atlasGraph.json')

async function main() {
  const decoded = decodePsg(readFileSync(PSG))
  if (decoded.graphType !== 1) throw new Error(`expected atlas graphType 1, got ${decoded.graphType}`)
  const psgNodes = flattenNodes(decoded)

  // Tables + .csd stat text (atlas wording first) + placement-deduped psg nodes — the shared
  // builder preamble (lib-psg-graph; duplicate placements resolve to the copy nearest neighbours).
  const { passiveRows, statRows, meta, byGraphId, descriptions, chosen } = readGraphInputs(EXTRACT, CSD_FILES, psgNodes)
  const subTrees = readExtractJson('tables/AtlasPassiveSkillSubTrees.json')

  // ── nodes ──────────────────────────────────────────────────────────────────────────────
  const rootSet = new Set(decoded.rootPassives)
  const nodes = {}
  let statLines = 0
  let fallbackLines = 0
  for (const pn of chosen.values()) {
    const row = byGraphId.get(pn.passiveId)
    if (!row) throw new Error(`psg node ${pn.passiveId} has no PassiveSkills row (PassiveSkillGraphId join failed)`)

    // Stats: the row's Stats array pairs positionally with Stat1..5Value + StatValue6/7.
    const { stats, resolved, fallback } = resolveStats(row.Stats, statValues(row), descriptions, statRows)
    statLines += resolved
    fallbackLines += fallback

    const node = {
      id: row.Id,
      // GGG leaves Name empty for the 6 tree-start nodes and the decorative mastery-ring icons
      // (IsJustIcon). NEVER fabricate a name from the internal Id ("AtlasGenericMastery28") —
      // an empty name renders as no title (the renderer drops the raw-id fallback for these).
      name: row.Name || '',
      icon: row.Icon_DDSFile ?? '',
      // Drop any raw "<stat_id> = value" fallback — an internal stat with no .csd description
      // (e.g. map_abyss_spawn_near_boss_chance_+); we never ship a raw id, and never invent wording.
      stats: stats.filter((s) => !/^[a-z][\w+%]*\s*=/.test(s)),
      x: round1(pn.x),
      y: round1(pn.y),
      group: pn.groupIndex + 1, // 1-based like the character export's group keys
      orbit: pn.radius,
      orbitIndex: pn.position,
    }
    if (row.IsNotable) node.notable = true
    if (row.IsKeystone) node.keystone = true
    if (row.IsJewelSocket) node.jewel = true
    if (row.IsJustIcon) node.decorative = true // mastery-ring filler art: no name, no stats, no tooltip
    if (rootSet.has(pn.passiveId) || row.IsRootOfAtlasTree) node.atlasRoot = true
    const subTree = typeof row.AtlasSubTree === 'number' ? subTrees[row.AtlasSubTree]?.Id : undefined
    if (subTree) node.subTree = subTree

    // Choose-one nodes — masteries ("Select a bonus within X Areas") AND the notables/selectors that
    // offer a pick (e.g. "The Journey Ahead", "Essence Dowsing"): Id-sibling detection shared with
    // the genesis builder (lib-psg-graph.detectChoices). 100% of the multi-choice data, nothing lost.
    const choices = detectChoices(row, passiveRows, descriptions, statRows)
    if (choices.length >= 2) node.choices = choices // >= 2 = a genuine "pick one of several"
    nodes[String(pn.passiveId)] = node
  }

  // ── edges + bounds (shared with the genesis builder — lib-psg-graph) ───────────────────
  const edges = buildEdges(chosen)
  const { minX, minY, maxX, maxY } = computeBounds(nodes)
  const nodeCount = Object.keys(nodes).length
  if (nodeCount < 500) throw new Error(`only ${nodeCount} atlas nodes (expected >= 500)`)
  if (edges.length < 500) throw new Error(`only ${edges.length} atlas edges (expected >= 500)`)
  if (decoded.rootPassives.some((id) => !nodes[String(id)]?.atlasRoot))
    throw new Error('a psg root is not flagged atlasRoot')

  // Per-subtree precursor-art placement, straight from the game table: IllustrationX/Y is the world-unit
  // OFFSET from that subtree's START node, UI_Background is the art path, and `scale` is the art→world
  // SCALE (the unnamed col [12] f32 — see readSubtreeScales). atlasPanels() (src/atlas/index.ts) reads all
  // three so BOTH placement AND size are DATA-DERIVED — a NEW GGG subtree (e.g. Expedition) auto-places and
  // auto-sizes the moment its nodes ship; nothing hand-typed.
  const subtreeScales = await readSubtreeScales(meta.poe2Patch)
  const subTreePlacement = {}
  for (const st of subTrees) {
    const placement = { dx: st.IllustrationX, dy: st.IllustrationY, bg: st.UI_Background }
    if (subtreeScales[st.Id] != null) placement.scale = subtreeScales[st.Id]
    subTreePlacement[st.Id] = placement
  }
  const scaleCount = Object.values(subTreePlacement).filter((p) => p.scale != null).length
  console.log(
    `  subtree art scale: ${scaleCount}/${subTrees.length} from data${scaleCount ? ` (${subTreePlacement[subTrees[0].Id]?.scale ?? '?'})` : ' — atlasPanels will fall back'}`,
  )

  const graph = {
    ...psgGraphHeader('Metadata/AtlasSkillGraphs/AtlasSkillGraph.psg', meta.poe2Patch, { minX, minY, maxX, maxY }),
    subTrees: subTreePlacement,
    nodes,
    edges,
  }
  const json = JSON.stringify(graph)
  await mkdir(join(ROOT, 'src', 'data'), { recursive: true })
  await writeFile(OUT, json)
  const arcEdges = edges.filter((e) => e.orbitX !== undefined).length
  console.log(`src/data/atlasGraph.json  ${kb(Buffer.byteLength(json))}`)
  console.log(
    `  ${nodeCount} nodes (${Object.values(nodes).filter((n) => n.notable).length} notable, ${Object.values(nodes).filter((n) => n.keystone).length} keystone, ${decoded.rootPassives.length} roots)`,
  )
  console.log(`  ${edges.length} edges (${arcEdges} arcs, ${edges.length - arcEdges} straight)`)
  console.log(`  stats: ${statLines} formatted from the stat-description files, ${fallbackLines} raw fallback lines`)
  console.log(`  bounds x [${minX}, ${maxX}] y [${minY}, ${maxY}]`)
  console.log(
    `  subTrees: ${Object.keys(subTreePlacement).length} placements (${Object.keys(subTreePlacement).join(', ')})`,
  )
}

runMain('build-atlas-graph', main)
