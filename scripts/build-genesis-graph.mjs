// Render-ready GENESIS TREE graph ("Brequel" internally — the 0.5 Breach/Chayula crafting
// tree), decoded from the game's ChayulaTreePassiveSkillGraph.psg and joined to PassiveSkills.
// Same output shape as atlasGraph.json / treeGraph.json so the shared B1 renderer (mountTree)
// consumes it unchanged — the Genesis tab is the atlas wrapper with a different graph.
//
//   node scripts/build-genesis-graph.mjs   (npm run data:genesis)
//
// Inputs (run `npm run data:extract` first; all under _workbench/data-extract/):
//   psg/Metadata@LeagueSkillGraphs@ChayulaTreePassiveSkillGraph.psg   geometry (decode-psg.mjs)
//   tables/PassiveSkills.json   names/flags/subtree, joined on PassiveSkillGraphId
//   tables/Stats.json           stat row index -> stat id string
//   files/Data@StatDescriptions@*.csd   English stat text (passive-skill wording first)
//
// The Genesis tree is FIVE disconnected subtrees, one per item category. The .psg ships 5 roots
// (one StartNode each) which double as the BFS allocation seeds; PassiveSkills.BrequelTree (0..4)
// tags every node with its subtree. We derive each subtree's canonical id/name from its StartNode
// Id ("BrequelTree<Name>StartNode") — these ARE GGG's own category names (Currency / Rings /
// Amulets / Belts / Breachstones), never fabricated.
//
// Geometry trust: identical orbit math to the atlas (decode-psg.mjs), fit-validated against GGG's
// baked character-tree coordinates. The Chayula psg uses the same format version + orbit table.
//
// Output: src/data/genesisGraph.json — { _provenance, bounds, classes: [], subTrees, nodes, edges }
//   subTrees: [{ index, id, name, root }]  — the 5 subtrees (index == BrequelTree value)
//   nodes:    { <PassiveSkillGraphId>: { id, name, icon, stats[], x, y, group, orbit, orbitIndex,
//               notable?, keystone?, jewel?, atlasRoot?, subTree, choices? } }
//   edges:    [{ from, to, orbitX?, orbitY? }]   (same arc-centre contract as treeGraph)
//   classes:  [] — kept for shape parity (the Genesis tree has no classes/ascendancies).
// atlasRoot reuses the engine's start-node semantics (no tooltip; click resets the tree).

import { readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT, kb, runMain } from './lib.mjs'
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
import { resolveStats } from './lib-csd.mjs'

const EXTRACT = join(ROOT, '_workbench', 'data-extract')
const PSG = join(EXTRACT, 'psg', 'Metadata@LeagueSkillGraphs@ChayulaTreePassiveSkillGraph.psg')
// Genesis stats are passive-skill + crafting-mod wording — no atlas-specific file applies.
// The `_live` supplement (LAST = lowest priority) is the live-patch general file fetched by
// scripts/fetch-genesis-csd.mjs; it only fills brequel_reward_* gaps absent from the pinned files
// (those reward stats were added after 4.5.2.1.2). Missing it just restores the raw-fallback lines.
const CSD_FILES = [
  'Data@StatDescriptions@passive_skill_stat_descriptions.csd',
  'Data@StatDescriptions@advanced_mod_stat_descriptions.csd',
  'Data@StatDescriptions@stat_descriptions.csd',
  'Data@StatDescriptions@stat_descriptions_live.csd',
]
const OUT = join(ROOT, 'src', 'data', 'genesisGraph.json')

// The 5 "Womb" keystones are the start of each subtree. GGG leaves their PassiveSkills Icon_DDSFile
// as the blank "MasteryBlank.dds" placeholder — the REAL womb is the Breach inventory-SLOT art: a
// vertical purple egg/nest with a square item-slot hole (per allocation state, see GENESIS_WOMB_PATHS).
// node.icon is the NORMAL state; the renderer swaps in active/can-allocate. (No placeholders.)
const WOMB_ICON = 'art/textures/interface/2d/2dart/uiimages/ingame/breachleague/breachtreeinventoryslot1x1.dds'
const BLANK_ICON = 'MasteryBlank' // the placeholder we refuse to ship

async function main() {
  const decoded = decodePsg(readFileSync(PSG))
  if (decoded.graphType !== 2) throw new Error(`expected league graphType 2, got ${decoded.graphType}`)
  const psgNodes = flattenNodes(decoded)

  // Tables + .csd stat text + placement-deduped psg nodes — the shared builder preamble
  // (lib-psg-graph). The Chayula psg currently places each id once.
  const { passiveRows, statRows, meta, byGraphId, descriptions, chosen } = readGraphInputs(EXTRACT, CSD_FILES, psgNodes)

  // ── subtrees: BrequelTree value (0..4) -> canonical id/name from the StartNode's Id ──────────
  // Each root passive is a "BrequelTree<Name>StartNode"; <Name> is the official category name. The
  // StartNodes themselves are degree-1 leaves on the Womb keystones and are DROPPED from the graph —
  // the Womb (the organic socket) IS the start/seed of each subtree (owner-confirmed). subTree.root
  // therefore points at the Womb (the new seed), not the removed StartNode.
  const rootSet = new Set(decoded.rootPassives) // StartNode passiveIds — removed from the output graph
  const wombByTree = new Map() // BrequelTree idx -> Womb keystone PassiveSkillGraphId
  for (const r of passiveRows) {
    if (r.IsKeystone && typeof r.BrequelTree === 'number') wombByTree.set(r.BrequelTree, r.PassiveSkillGraphId)
  }
  const subTrees = []
  for (const rootId of decoded.rootPassives) {
    const row = byGraphId.get(rootId)
    if (!row) throw new Error(`psg root ${rootId} has no PassiveSkills row`)
    const idx = row.BrequelTree
    if (typeof idx !== 'number') throw new Error(`root ${row.Id} has no BrequelTree subtree index`)
    const name = row.Id.match(/^BrequelTree(.+?)StartNode_?$/)?.[1] ?? `Subtree ${idx}`
    const womb = wombByTree.get(idx)
    if (womb === undefined) throw new Error(`subtree ${name} (${idx}) has no Womb keystone`)
    subTrees[idx] = { index: idx, id: name, name, root: String(womb) }
  }
  for (let i = 0; i < subTrees.length; i++) {
    if (!subTrees[i]) throw new Error(`subtree index ${i} has no root StartNode`)
  }

  // ── nodes ──────────────────────────────────────────────────────────────────────────────────
  const nodes = {}
  let statLines = 0
  let fallbackLines = 0
  let droppedUndocumented = 0
  const byTreeCount = {}
  for (const pn of chosen.values()) {
    if (rootSet.has(pn.passiveId)) continue // drop the StartNode leaves — the Womb is the subtree start/seed
    const row = byGraphId.get(pn.passiveId)
    if (!row) throw new Error(`psg node ${pn.passiveId} has no PassiveSkills row (PassiveSkillGraphId join failed)`)
    if (row.BrequelTree === null || row.BrequelTree === undefined) {
      throw new Error(`placed node ${row.Id} (${pn.passiveId}) has no BrequelTree subtree tag`)
    }

    const { stats: rawStats, resolved, fallback } = resolveStats(row.Stats, statValues(row), descriptions, statRows)
    statLines += resolved
    // Two reward stats (brequel_reward_additional_jewel_catalyst_{same,different}_type_chance_%) have NO
    // description in ANY of the game's 587 .csd files (verified), so they only ever resolve to a cryptic
    // raw "id = value" line — and their %-scaling is ambiguous (the documented sibling reward stats divide
    // by 100, so "30" likely means 0.3%, not 30%). The carrying nodes are self-describing by NAME
    // ("Additional Duplicate/Different Catalyst Chance"), so drop the raw line rather than show an ambiguous
    // number or fabricate wording. Any OTHER raw fallback is kept (honest exact id+value).
    const stats = rawStats.filter((s) => {
      if (/^brequel_reward_\S+ = /.test(s)) {
        droppedUndocumented++
        return false
      }
      return true
    })
    fallbackLines += fallback - (rawStats.length - stats.length)
    byTreeCount[row.BrequelTree] = (byTreeCount[row.BrequelTree] ?? 0) + 1

    // The Womb keystones ship the blank MasteryBlank placeholder — swap in the real womb socket art.
    const isWomb = row.IsKeystone === true
    const icon = isWomb || (row.Icon_DDSFile ?? '').includes(BLANK_ICON) ? WOMB_ICON : (row.Icon_DDSFile ?? '')

    const node = {
      id: row.Id,
      // GGG leaves Name empty for the 5 StartNodes — keep empty (the renderer shows no title).
      name: row.Name || '',
      icon,
      stats,
      x: round1(pn.x),
      y: round1(pn.y),
      group: pn.groupIndex + 1,
      orbit: pn.radius,
      orbitIndex: pn.position,
      subTree: subTrees[row.BrequelTree].id,
    }
    if (row.IsNotable) node.notable = true
    if (row.IsKeystone) node.keystone = true
    if (row.IsJewelSocket) node.jewel = true
    // The Womb keystones are the subtree start/seed: render their organic socket art uncropped + glowing.
    if (isWomb) node.iconUncropped = true

    // Choose-one nodes (same Id-sibling convention as the atlas — lib-psg-graph.detectChoices):
    // the genesis "Crafted Modifier" choosers (e.g. "Unrestrained" -> "of Amplification" /
    // "of Drenching") and any "Select a bonus" mastery.
    const choices = detectChoices(row, passiveRows, descriptions, statRows)
    if (choices.length >= 2) node.choices = choices
    nodes[String(pn.passiveId)] = node
  }

  // ── edges + bounds (shared with the atlas builder — lib-psg-graph); StartNodes are removed,
  // so edges touching them (the Womb→Start leaf edge) are skipped ─────────────────────────────
  const edges = buildEdges(chosen, (id) => rootSet.has(id))
  const { minX, minY, maxX, maxY } = computeBounds(nodes)
  const nodeCount = Object.keys(nodes).length
  if (nodeCount < 200) throw new Error(`only ${nodeCount} genesis nodes (expected >= 200)`)
  if (edges.length < 200) throw new Error(`only ${edges.length} genesis edges (expected >= 200)`)
  if (subTrees.length !== 5) throw new Error(`expected 5 subtrees, got ${subTrees.length}`)
  for (const rootId of decoded.rootPassives) {
    if (nodes[String(rootId)]) throw new Error(`StartNode ${rootId} should have been dropped (the Womb is the seed)`)
  }
  const wombs = Object.values(nodes).filter((n) => n.keystone)
  if (wombs.length !== 5) throw new Error(`expected 5 Womb keystones (the seeds), got ${wombs.length}`)
  for (const w of wombs) {
    if (!w.iconUncropped || !w.icon.includes('inventoryslot'))
      throw new Error(`Womb ${w.id} missing its uncropped socket art`)
  }

  const graph = {
    ...psgGraphHeader('Metadata/LeagueSkillGraphs/ChayulaTreePassiveSkillGraph.psg', meta.poe2Patch, {
      minX,
      minY,
      maxX,
      maxY,
    }),
    subTrees,
    nodes,
    edges,
  }
  const json = JSON.stringify(graph)
  await mkdir(join(ROOT, 'src', 'data'), { recursive: true })
  await writeFile(OUT, json)
  console.log(`src/data/genesisGraph.json  ${kb(Buffer.byteLength(json))}`)
  console.log(
    `  ${nodeCount} nodes (${Object.values(nodes).filter((n) => n.notable).length} notable, ${Object.values(nodes).filter((n) => n.keystone).length} Womb keystones = the seeds, ${decoded.rootPassives.length} StartNode leaves dropped)`,
  )
  console.log(`  subtrees: ${subTrees.map((s) => `${s.id}(${byTreeCount[s.index] ?? 0})`).join(', ')}`)
  console.log(`  ${edges.length} edges (${edges.filter((e) => e.orbitX !== undefined).length} arcs)`)
  console.log(
    `  stats: ${statLines} formatted, ${fallbackLines} raw fallback lines, ${droppedUndocumented} undocumented brequel_reward lines dropped (no game .csd text)`,
  )
  console.log(`  bounds x [${minX}, ${maxX}] y [${minY}, ${maxY}]`)
}

runMain('build-genesis-graph', main)
