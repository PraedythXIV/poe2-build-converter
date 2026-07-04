// B2 — ATLAS passive tree wrapper around the B1 tree renderer.
//
// The atlas graph (src/data/atlasGraph.json, built by scripts/build-atlas-graph.mjs from
// the game's AtlasSkillGraph.psg + PassiveSkills table) ships in the exact same shape as
// treeGraph.json, so the B1 render/viewport/spatial modules consume it unchanged.
//
// The default mount is VIEWER-ONLY: the .build format cannot carry atlas trees — no atlas
// field, no id namespace, no discriminator (verified against the live .build format).
// `editable: true` enables PLANNING-ONLY allocation: edits live in the view (shareable as
// text via src/atlas/share.ts) and are never written into a .build.
//
// The atlas has no class starts; editing seeds allocation BFS with the 6 atlasRoot nodes
// (IsRootOfAtlasTree in the .psg) through MountTreeOptions.seedIds, so nodes unreachable
// from a root can never be allocated.
//
// Icons: atlas nodes carry .dds icon paths (BC1/DXT1 art). scripts/build-atlas-icons.mjs
// packs them into src/assets/tree/atlas-icons.webp + src/data/atlasIcons.json; the renderer
// loads that sheet when mounted with `atlasIcons: true` and falls back to the dot/ring only
// for any icon that failed to decode.

import atlasGraphData from '../data/atlasGraph.json'
import atlasBgData from '../data/atlasBg.json'
import { buildGraph, mountTree } from '../tree/index'
import type { MountTreeOptions, RawTreeGraph, TreeGraph, TreeView } from '../tree/index'
import type { AtlasBgPanel } from '../tree/render'
import { copy } from '../copy'

/** Raw graph contract — same shape as treeGraph.json (see scripts/build-atlas-graph.mjs).
 *  Structurally compatible with the RawTreeGraph interface in src/tree/graph.ts. */
export interface AtlasGraphNode {
  /** PassiveSkills.Id, e.g. "AtlasRitualNotable16_". */
  id: string
  name: string
  /** Game .dds path — resolved by the dedicated atlas-icon sheet (src/data/atlasIcons.json). */
  icon: string
  stats: string[]
  x: number
  y: number
  group: number
  orbit: number
  orbitIndex: number
  notable?: boolean
  keystone?: boolean
  jewel?: boolean
  /** One of the 6 atlas sub-tree start nodes (IsRootOfAtlasTree). */
  atlasRoot?: boolean
  /** Sub-tree this node belongs to (Breach, Ritual, Delirium, Abyss, Incursion). */
  subTree?: string
}

export interface AtlasGraphEdge {
  from: number
  to: number
  /** Arc centre (same contract as treeGraph edges); absent = straight line. */
  orbitX?: number
  orbitY?: number
}

export interface AtlasGraph {
  bounds: { min_x: number; min_y: number; max_x: number; max_y: number }
  /** Always empty — the atlas tree has no classes; key kept for treeGraph shape parity. */
  classes: never[]
  /** Per-subtree precursor-art placement, DATA-DERIVED from the game's AtlasPassiveSkillSubTrees table:
   *  IllustrationX/Y world offset from the subtree start node, the art path, and `scale` = the art→world
   *  SCALE (the unnamed col [12] f32 = 4.5; absent only if a pre-scale graph is loaded). Keyed by subtree
   *  Id ("Breach", "Expedition", …) — see scripts/build-atlas-graph.mjs. */
  subTrees: Record<string, { dx: number; dy: number; bg: string; scale?: number }>
  /** Keyed by PassiveSkillGraphId (the numeric id namespace of the psg file). */
  nodes: Record<string, AtlasGraphNode>
  edges: AtlasGraphEdge[]
}

/** The vendored atlas graph — same raw shape the shared tree renderer consumes. */
export const atlasGraph = atlasGraphData as unknown as AtlasGraph

export interface MountAtlasTreeOptions {
  /** Enable planning-only allocation (default false = read-only viewer). */
  editable?: boolean
  /** Called after USER-driven allocation changes (only ever fires when editable). */
  onChange?: (allocated: ReadonlySet<string>) => void
}

let derived: TreeGraph | null = null
let rootIds: readonly string[] | null = null

// Precursor art→world SCALE. The subtree panels' world size is now FULLY DATA-DRIVEN: `scale × native px`,
// where `scale` is the game table's unnamed col [12] f32 (atlasGraph.subTrees[*].scale = 4.5) and native px
// is the decoded art width (atlasBg.json._native). `size` is world-units, NOT pixels, so the stored webp
// resolution never affects alignment. SUBTREE_FALLBACK_SCALE is used ONLY if a pre-scale graph is loaded
// (older atlasGraph.json without `scale`) — it's the same verified 4.5, so the result is identical.
const SUBTREE_FALLBACK_SCALE = 4.5
// FACADE scale, TIED to the (data-driven) subtree scale: facade:subtree = 2:3 (the facade .dds is authored
// at 3/2 the px-density of the subtree art). `facade_scale = subtree_scale × 2/3 ≈ 3.0`. This is the ONLY
// un-sourced facade number — GGG ships no facade-scale field (whole schema + install + PoB + online all
// checked); the 2/3 is a clean ratio, not a table value. Expressing it as a ratio TO the data scale means
// the facade auto-tracks any future patch that changes the subtree scale. (2/3 reproduces the eyeballed
// ?calib size 11512 to ~8px / 0.07%.) (The genesis facade doesn't reuse this ratio — its placement is
// bounds-driven; see src/genesis/index.ts.)
const FACADE_TO_SUBTREE = 2 / 3
// Native art px dims + opaque-silhouette centroid fraction (src/data/atlasBg.json._native), both
// emitted by scripts/build-atlas-bg.mjs straight from the decoded DDS — the data the facade anchors on.
type NativeDim = { w: number; h: number; ax?: number; ay?: number }
const NATIVE = (atlasBgData as { _native?: Record<string, NativeDim> })._native ?? {}

let panelsCache: AtlasBgPanel[] | null = null
/** Background panels: facade behind the main tree + one precursor panel per subtree at start+offset.
 *  Placement is DATA-DRIVEN: subtree offsets come from atlasGraph.subTrees (the game table), so a NEW
 *  subtree (e.g. Expedition) renders automatically once its nodes + art ship — nothing hand-typed. */
export function atlasPanels(): AtlasBgPanel[] {
  if (panelsCache) return panelsCache
  const subOffsets = atlasGraph.subTrees ?? {}
  // start node per subtree + the subtree-less general root (main-tree start = the facade anchor)
  const startBySub = new Map<string, { x: number; y: number }>()
  let generalStart: { x: number; y: number } | null = null
  // bbox of the main-tree (general) nodes — used by the ?rawbg diagnostic to centre the native facade.
  let gMinX = Infinity,
    gMaxX = -Infinity,
    gMinY = Infinity,
    gMaxY = -Infinity
  for (const node of Object.values(atlasGraph.nodes)) {
    if (node.atlasRoot) {
      if (node.subTree) startBySub.set(node.subTree, { x: node.x, y: node.y })
      else generalStart = { x: node.x, y: node.y }
    } else if (!node.subTree) {
      if (node.x < gMinX) gMinX = node.x
      if (node.x > gMaxX) gMaxX = node.x
      if (node.y < gMinY) gMinY = node.y
      if (node.y > gMaxY) gMaxY = node.y
    }
  }
  // The precursor art→world scale (data-driven, col [12]; uniform across subtrees). The facade scale is
  // derived from it (× 2/3); subtree panels use their own row's scale. Fallback only for a pre-scale graph.
  const subScale = Object.values(subOffsets).find((o) => typeof o.scale === 'number')?.scale ?? SUBTREE_FALLBACK_SCALE
  const panels: AtlasBgPanel[] = []
  // FACADE (drawn behind the main tree) — now FULLY DATA-DRIVEN. Size = facade_scale × native px, where
  // facade_scale = subScale × 2/3 (FACADE_TO_SUBTREE) ties it to the data-driven subtree scale. Centre = the
  // main-tree node bbox centre, shifted so the art's opaque centroid (ax/ay) lands on it: the silhouette
  // sits low in its canvas (ay≈0.522), which is why the facade centre is BELOW the node centre — no hand
  // offset, centroid + bbox + scale all follow the art + nodes across patches. Falls back to the legacy
  // ?calib transform only if native dims are absent.
  const fn = NATIVE.general
  if (fn && Number.isFinite(gMinX) && Number.isFinite(gMinY) && Number.isFinite(gMaxY) && generalStart) {
    const size = subScale * FACADE_TO_SUBTREE * fn.w
    // x-anchor = the tree's structural symmetry axis (the general root's x, ≈0 — the radial tree is built
    // around it; the node bbox centre is skewed a few px by asymmetric outer nodes). y-anchor = the node
    // bbox vertical centre (the facade frames the full tree height). Both shifted so the art's opaque
    // centroid (ax/ay) lands on the anchor → matches the eyeballed calib to ~1px x / ~4px y, no hand offset.
    const treeYc = (gMinY + gMaxY) / 2
    const { ax = 0.5, ay = 0.5 } = fn
    panels.push({ key: 'general', cx: generalStart.x - (ax - 0.5) * size, cy: treeYc - (ay - 0.5) * size, size })
  } else if (generalStart) {
    panels.push({ key: 'general', cx: generalStart.x - 2, cy: generalStart.y - 4726.3, size: 11512 })
  }
  // one precursor panel per subtree that has BOTH a start node AND a placement offset. Size is DATA-DRIVEN:
  // the row's art→world scale (col [12]) × the art's native px width (atlasBg.json._native) → e.g. 4.5×600=2700.
  for (const [sub, start] of startBySub) {
    const o = subOffsets[sub]
    if (!o) continue
    const native = NATIVE[sub.toLowerCase()]?.w ?? 600
    panels.push({
      key: sub.toLowerCase(),
      cx: start.x + o.dx,
      cy: start.y + o.dy,
      size: (o.scale ?? SUBTREE_FALLBACK_SCALE) * native,
    })
  }
  panelsCache = panels
  return panels
}

/** Numeric-string ids of the 6 atlasRoot start nodes — the free allocation seeds. */
export function atlasRootIds(): readonly string[] {
  if (!rootIds) {
    rootIds = Object.entries(atlasGraph.nodes)
      .filter(([, node]) => node.atlasRoot === true)
      .map(([key]) => key)
  }
  return rootIds
}

/**
 * Mount the atlas tree on the shared B1 renderer — read-only by default, editable for
 * planning when `opts.editable`. The derived graph is built once and cached (static data).
 */
export function mountAtlasTree(container: HTMLElement, opts: MountAtlasTreeOptions = {}): TreeView {
  if (!derived) derived = buildGraph(atlasGraphData as unknown as RawTreeGraph)
  const options: MountTreeOptions = {
    graph: derived,
    viewerOnly: opts.editable !== true,
    seedIds: atlasRootIds(),
    atlasIcons: true, // atlas nodes carry real .dds icons (scripts/build-atlas-icons.mjs)
    bgPanels: atlasPanels(), // per-subtree background panels + facade (scripts/build-atlas-bg.mjs)
    ariaLabel: copy.atlas.canvasAria,
  }
  if (opts.onChange) options.onChange = opts.onChange
  // The facade + subtree panels are DATA-DRIVEN (atlasPanels above), so there is no calibration hook here.
  // To re-calibrate after a patch that breaks a derivation, see _workbench/dev/calib/README.md (emergency fallback).
  return mountTree(container, options)
}
