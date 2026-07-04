// Render-ready passive-tree graph + sprite atlases from GGG's official PoE2 export
// (github.com/grindinggear/poe2-skilltree-export — official GGG data for tool developers,
// no OSS license: we attribute GGG and never claim ownership; see THIRD-PARTY-NOTICES.md).
// Source shapes characterized against the live export data.
//
//   node scripts/build-tree-graph.mjs [--ref <tag|sha|branch>]
//
// Emits:
//   src/data/treeGraph.json     ~1.2 MB pruned graph (nodes/edges/classes/bounds)
//   src/assets/tree/            skills + skills-disabled + frame atlases (.json + .webp)
//
// Pruning contract (what a renderer needs, nothing more):
//   nodes:  { <numeric id>: { id, name, icon, stats[], x, y, group, orbit, orbitIndex,
//             keystone?/notable?/mastery?/jewel?/ascStart?, ascendancyId?,
//             classStartIndex?, hideConnection? } }      (synthetic "root" node dropped)
//   edges:  [{ from, to, orbitX?, orbitY? }]  — arc CENTRES kept (radius = hypot to an
//           endpoint; straight line when no centre), root edges dropped
//   classes: PoE2-playable only (= has ascendancies; idx kept = position in GGG's 12-class
//           array, which is what node.classStartIndex references), ascendancies with panel
//           image offsets
//   bounds: { min_x, min_y, max_x, max_y }

import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ROOT,
  DEFAULT_TREE_REF,
  TREE_REPO,
  argValue,
  downloadTo,
  getJson,
  kb,
  resolveTreeSha,
  runMain,
  treeRawUrl,
} from './lib.mjs'

const OUT_GRAPH = join(ROOT, 'src', 'data', 'treeGraph.json')
const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')

// skills (active icons) + frame (node rings) are the render minimum; skills-disabled is
// required by the frame-key convention `<kind>Inactive:<icon>` for idle nodes (refs.md §1.4).
const SPRITE_SHEETS = ['skills', 'skills-disabled', 'frame']

/** `[Tag]` -> `Tag`, `[Tag|Display Text]` -> `Display Text` (keep the readable part). */
function stripMarkup(stat) {
  return stat.replace(/\[([^\]|]+)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]+)\]/g, '$1')
}

/** GGG ships an empty `overridePairs` as `[]` (array) but a populated one as a keyed object.
 *  Normalize the empty case to `{}` so the resolver in graph.ts always reads one (object) shape —
 *  it spreads base-id keys, never array indices. (See _workbench/Docs/tree-data-fields.md.) */
function normalizeOverridePairs(pairs) {
  return pairs && !Array.isArray(pairs) ? pairs : {}
}

/** A skillOverrides[] entry, with its `stats` run through stripMarkup() so override text matches the
 *  node-stat convention (ONE source of truth — same [tag|Display] strip pruneNode applies to nodes).
 *  id/skill/name/icon are kept verbatim. */
function pruneSkillOverride(ov) {
  return { ...ov, stats: (ov.stats ?? []).map(stripMarkup) }
}

const round1 = (v) => Math.round(v * 10) / 10

// POLICY: keep every export field EXCEPT the redundant ones below. The full kept/pruned inventory +
// reasons is tracked in _workbench/Docs/tree-data-fields.md — keep that doc in sync with any change here.
//
// Redundant NODE fields (dropped; the reason each is safe to lose):
const REDUNDANT_NODE_FIELDS = {
  in: 'inbound adjacency — graph.ts rebuilds adjacency from the top-level edges[]; the per-node lists are never read',
  out: 'outbound adjacency — same as `in`',
  edges: 'per-node edge-id list — superseded by the top-level edges[] union we already keep',
}
// is*-flag -> short key the renderer + graph.ts read. A lossless RENAME (not a drop).
const FLAG_RENAMES = [
  ['isKeystone', 'keystone'],
  ['isNotable', 'notable'],
  ['isMastery', 'mastery'],
  ['isJewelSocket', 'jewel'],
  ['isAscendancyStart', 'ascStart'],
]

function pruneNode(node) {
  const out = { ...node } // keep everything by default…
  for (const k of Object.keys(REDUNDANT_NODE_FIELDS)) delete out[k] // …minus the redundant adjacency
  // lossless cleanups + renames (the stable output contract — see _workbench/Docs/tree-data-fields.md):
  out.name = stripMarkup(node.name ?? '') // strip [tag|Display] markup (e.g. Sinister Jewel Socket nodes)
  out.icon = node.icon ?? ''
  out.stats = (node.stats ?? []).map(stripMarkup) // strip [tag|Display] markup
  out.x = round1(node.x)
  out.y = round1(node.y)
  for (const [from, to] of FLAG_RENAMES) {
    if (out[from]) out[to] = true
    delete out[from]
  }
  // flavourText -> flavour (markup-stripped); the heavy grantedSkill gem object -> {name, desc};
  // multipleChoiceParent (numeric) -> mcParent (string group key for "choose one" siblings).
  if (node.flavourText?.length) out.flavour = node.flavourText.map(stripMarkup)
  delete out.flavourText
  if (node.grantedSkill) {
    const g = node.grantedSkill
    out.grantedSkill = { name: g.typeLine || g.name || '' }
    const desc = g.secDescrText || g.descrText
    if (desc) out.grantedSkill.desc = stripMarkup(desc)
    if (!out.grantedSkill.name) delete out.grantedSkill
  }
  if (node.isMultipleChoiceOption && node.multipleChoiceParent != null) out.mcParent = String(node.multipleChoiceParent)
  delete out.multipleChoiceParent
  return out
}

function pruneEdge(edge) {
  const out = { ...edge } // keep from/to/orbitX/orbitY…
  delete out.orbit // …minus `orbit` (redundant): the arc RADIUS is recomputed at render time as
  // hypot((orbitX,orbitY) centre -> endpoint), so the stored orbit index is never read. (See doc.)
  if (typeof out.orbitX === 'number') out.orbitX = round1(out.orbitX)
  if (typeof out.orbitY === 'number') out.orbitY = round1(out.orbitY)
  return out
}

function pruneClasses(classes) {
  // Keep EVERY class field (incl. image/image_offset_* + overridePairs). The only exclusions are two
  // ROW filters (not field prunes), both tracked in _workbench/Docs/tree-data-fields.md:
  //   1. legacy PoE1 placeholder classes with no ascendancies (Marauder/Duelist/Shadow/Templar) —
  //      not playable, in no build;
  //   2. unreleased ascendancy placeholders (no `name`, e.g. Ranger2/Druid3).
  const out = []
  for (let idx = 0; idx < classes.length; idx++) {
    const cls = classes[idx]
    if (!cls.ascendancies?.length) continue // row filter 1
    out.push({
      idx, // position in GGG's array — node.classStartIndex pairs reference THIS index (export-positional)
      ...cls,
      overridePairs: normalizeOverridePairs(cls.overridePairs), // empty [] -> {} (resolver reads object shape)
      ascendancies: cls.ascendancies
        .filter((a) => a.name != null) // row filter 2; keep all fields on real ones
        .map((a) => ({ ...a, overridePairs: normalizeOverridePairs(a.overridePairs) })),
    })
  }
  return out
}

async function main() {
  const ref = argValue('--ref') ?? DEFAULT_TREE_REF
  const sha = await resolveTreeSha(ref)
  console.log(`Fetching ${TREE_REPO}@${ref} data.json...`)
  const tree = await getJson(treeRawUrl(ref, 'data.json'))

  const nodes = {}
  for (const [numId, node] of Object.entries(tree.nodes ?? {})) {
    if (numId === 'root' || typeof node.x !== 'number') continue // synthetic root has no position
    nodes[numId] = pruneNode(node)
  }
  const edges = (tree.edges ?? []).filter((e) => e.from !== 'root').map(pruneEdge)
  const classes = pruneClasses(tree.classes ?? [])
  const ascCount = classes.reduce((n, c) => n + c.ascendancies.length, 0)

  // Fail-loud invariants (thresholds just under the 2026-06 live values).
  const nodeCount = Object.keys(nodes).length
  if (nodeCount < 4800) throw new Error(`only ${nodeCount} tree nodes (expected >= 4800)`)
  if (edges.length < 5500) throw new Error(`only ${edges.length} edges (expected >= 5500)`)
  // 8 playable as of 0.5.1 (Witch + Ranger kept their PoE1 names; legacy unplayable four are
  // Marauder/Duelist/Shadow/Templar). GGG adds playable classes over time — gate on the floor.
  if (classes.length < 6) throw new Error(`only ${classes.length} playable classes (expected >= 6)`)
  if (ascCount < 18) throw new Error(`only ${ascCount} ascendancies (expected >= 18)`)

  const graph = {
    _provenance: {
      source: `https://github.com/${TREE_REPO}`,
      ref,
      sha,
      captured: new Date().toISOString().slice(0, 10),
      note: 'Official GGG tree export, pruned for rendering. Not affiliated with or endorsed by Grinding Gear Games.',
    },
    bounds: { min_x: tree.min_x, min_y: tree.min_y, max_x: tree.max_x, max_y: tree.max_y },
    classes,
    // per-class/ascendancy stat rewrites (a base node's text differs by class). Each entry's `stats`
    // is stripMarkup'd to match the node-stat convention (one source of truth); name/icon/skill kept.
    // Two-hop lookup: overridePairs[baseNodeId] -> overrideSkillId -> skillOverrides[overrideSkillId].
    skillOverrides: Object.fromEntries(
      Object.entries(tree.skillOverrides ?? {}).map(([k, ov]) => [k, pruneSkillOverride(ov)]),
    ),
    nodes,
    edges,
    // Top-level export keys deliberately NOT emitted (redundant — see _workbench/Docs/tree-data-fields.md):
    //   groups   — group centres/membership/orbits are all rebuilt from nodes in src/tree/graph.ts
    //   jewelSlots — redundant with the per-node `jewel` flag (isJewelSocket)
    //   tree     — a constant label ("Default")
  }
  const json = JSON.stringify(graph)
  await mkdir(join(ROOT, 'src', 'data'), { recursive: true })
  await writeFile(OUT_GRAPH, json)
  console.log(
    `src/data/treeGraph.json  ${kb(Buffer.byteLength(json))} (${nodeCount} nodes, ${edges.length} edges, ${classes.length} classes / ${ascCount} ascendancies)`,
  )

  console.log('Downloading sprite atlases...')
  await mkdir(OUT_ASSETS, { recursive: true })
  for (const sheet of SPRITE_SHEETS) {
    const metaBytes = await downloadTo(treeRawUrl(ref, `assets/${sheet}.json`), join(OUT_ASSETS, `${sheet}.json`))
    const webpBytes = await downloadTo(treeRawUrl(ref, `assets/${sheet}.webp`), join(OUT_ASSETS, `${sheet}.webp`))
    // Sanity: sidecar must be TexturePacker-shaped, sheet must be a real image.
    const meta = JSON.parse(await readFile(join(OUT_ASSETS, `${sheet}.json`), 'utf8'))
    if (!meta.frames || !meta.meta) throw new Error(`${sheet}.json is not a TexturePacker sidecar`)
    if (webpBytes < 10_000) throw new Error(`${sheet}.webp is suspiciously small (${webpBytes} B)`)
    console.log(`  ${sheet}: ${kb(webpBytes)} webp + ${kb(metaBytes)} json (${Object.keys(meta.frames).length} frames)`)
  }
}

runMain('build-tree-graph', main)
