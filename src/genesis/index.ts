// Genesis Tree ("Brequel") wrapper around the shared B1 tree renderer (mountTree) — the
// 0.5 Breach/Chayula crafting tree, decoded from ChayulaTreePassiveSkillGraph.psg.
//
// The genesis graph (src/data/genesisGraph.json, built by scripts/build-genesis-graph.mjs)
// ships in the exact same shape as treeGraph.json / atlasGraph.json, so the shared render/
// viewport/spatial modules consume it unchanged — this is the atlas wrapper with a different
// graph, minus the atlas-only chrome (no background art, no masters, no icon sheet yet).
//
// The tree is FIVE disconnected subtrees (Currency / Rings / Amulets / Belts / Breachstones),
// one per item category. Editing allocation BFS uses the 5 Womb keystones (allocatable roots) via
// genesisRootIds() and MountTreeOptions.rootIds — each subtree paths only from its own Womb, so a
// node in one subtree can never be reached from another. Planning-only: the .build format has no
// Genesis fields, so a plan is shareable by link but never written to a .build.

import genesisGraphData from '../data/genesisGraph.json'
import genesisBgData from '../data/genesisBg.json'
import { buildGraph, mountTree } from '../tree/index'
import type { MountTreeOptions, RawTreeGraph, TreeGraph, TreeNode, TreeView } from '../tree/index'
import type { AtlasBgPanel } from '../tree/render'
import { copy } from '../copy'

/** One of the 5 Genesis subtrees (index == PassiveSkills.BrequelTree value). */
export interface GenesisSubTree {
  index: number
  /** Canonical category id == subtree name (Currency / Rings / Amulets / Belts / Breachstones). */
  id: string
  name: string
  /** PassiveSkillGraphId (string) of this subtree's StartNode root. */
  root: string
}

/** Raw graph contract — same shape as treeGraph.json plus the 5-subtree index. */
export interface GenesisGraphNode {
  id: string
  name: string
  icon: string
  stats: string[]
  x: number
  y: number
  group: number
  orbit: number
  orbitIndex: number
  notable?: boolean
  /** The Womb keystone — the start/seed of its subtree (one per subtree); organic socket art. */
  keystone?: boolean
  jewel?: boolean
  /** Render the icon uncropped + glowing when allocated (the organic Womb sockets). */
  iconUncropped?: boolean
  /** Subtree this node belongs to (one of GenesisSubTree.id). */
  subTree: string
}

export interface GenesisGraph {
  bounds: { min_x: number; min_y: number; max_x: number; max_y: number }
  classes: never[]
  subTrees: GenesisSubTree[]
  /** Keyed by PassiveSkillGraphId (the numeric id namespace of the psg file). */
  nodes: Record<string, GenesisGraphNode>
  edges: Array<{ from: number; to: number; orbitX?: number; orbitY?: number }>
}

/** The vendored Genesis graph — same raw shape the shared tree renderer consumes. */
export const genesisGraph = genesisGraphData as unknown as GenesisGraph

/** The 5 subtrees in BrequelTree-index order. */
export const GENESIS_SUBTREES: readonly GenesisSubTree[] = genesisGraph.subTrees

/** Per-subtree identity hues — the in-game UI theme colours (owner-provided 2026-06-26: ring/currency purple,
 *  amulet blue, belt orange). The SINGLE source, consumed by BOTH the per-mini-tree counter (main.ts) and the
 *  Wombgift crafting cards (crafting.ts). NOT data-derivable — the genesis backdrop art is near-black (sampled
 *  per-subtree region: rgb(~20,15,22)), so the colours live only in the game CLIENT UI, like the atlas dots.
 *  Keyed by subtree id. */
export const GENESIS_SUBTREE_RGB: Record<string, string> = {
  Currency: '167, 107, 255', // purple
  Rings: '235, 115, 185', // pink
  Amulets: '74, 144, 226', // blue
  Belts: '214, 120, 77', // orange
  Breachstones: '190, 90, 200', // (lone node — no counter; used by the crafting card)
}

export interface MountGenesisTreeOptions {
  /** Enable planning-only allocation (default false = read-only viewer). */
  editable?: boolean
  /** Called after USER-driven allocation changes (only ever fires when editable). */
  onChange?: (allocated: ReadonlySet<string>) => void
  /** Replace a node's tooltip with custom HTML (used for the 5 womb keystones → Wombgift reference). */
  tooltipOverride?: (node: TreeNode) => string | null
}

/** The authentic Breach-tree node FRAME art (per allocation state), packed into the Genesis icon
 *  sheet by scripts/build-genesis-icons.mjs. Keys MUST match EXTRA_ART there. Two ring styles:
 *  `small` (regular nodes) and `fancy` (the bigger/ornate ring on notables). */
const BREACH = 'art/textures/interface/2d/2dart/uiimages/ingame/breachleague/'
const frameSet = (kind: '' | 'fancy') => ({
  normal: `${BREACH}breachtree${kind}passiveskillscreenpassiveframenormal.dds`,
  canallocate: `${BREACH}breachtree${kind}passiveskillscreenpassiveframecanallocate.dds`,
  active: `${BREACH}breachtree${kind}passiveskillscreenpassiveframeactive.dds`,
})
const GENESIS_FRAME_PATHS = {
  small: frameSet(''),
  fancy: frameSet('fancy'),
} as const

/** The Genesis background facade placement — now DATA-DRIVEN (was hand-calibrated cx/cy/size/sizeY).
 *  CENTRE = the tree's structural ORIGIN (0,0): the psg lays the genesis tree out around origin and GGG
 *  authored the backdrop to sit there — verified the calibrated centre (25,-22) ≈ origin, NOT the node-
 *  cloud centre. SIZE covers the node extent from origin (so it auto-follows any patch that moves nodes
 *  further out) with a small decorative MARGIN, at the art's NATIVE aspect (one uniform scale; the calib's
 *  1.127 was a ~1% squish vs native 1.141). The MARGIN is the ONLY hand value — no Brequel table or PoB
 *  source exists for the genesis facade scale (verified 2026-06-26: BrequelPassiveSubTrees/TreeSlots/
 *  PassiveUnlocks carry no placement/scale, PoB doesn't model this tree). It reproduces the owner's
 *  calibrated sizeY (9728) exactly. */
const GENESIS_FACADE_MARGIN = 1.043 // decorative border beyond the outermost node (matches the owner's calib)
function genesisFacade(): AtlasBgPanel {
  const native = (genesisBgData as { native: { w: number; h: number } }).native
  const b = genesisGraph.bounds
  const hx = Math.max(Math.abs(b.min_x), Math.abs(b.max_x)) // furthest node from origin, each axis
  const hy = Math.max(Math.abs(b.min_y), Math.abs(b.max_y))
  const scale = Math.max((2 * hx) / native.w, (2 * hy) / native.h) * GENESIS_FACADE_MARGIN
  return { key: 'genesis', cx: 0, cy: 0, size: scale * native.w, sizeY: scale * native.h, alpha: 1 }
}
const GENESIS_BG: AtlasBgPanel = genesisFacade()

/** The Womb socket art (the vertical egg with a square item-slot hole), per allocation state. Keys
 *  MUST match EXTRA_ART + the womb node.icon in the build scripts. */
const GENESIS_WOMB_PATHS = {
  normal: `${BREACH}breachtreeinventoryslot1x1.dds`,
  canallocate: `${BREACH}breachtreeinventoryslot1x1canallocate.dds`,
  active: `${BREACH}breachtreeinventoryslot1x1active.dds`,
} as const

let derived: TreeGraph | null = null
let rootIds: readonly string[] | null = null

/** Numeric-string ids of the 5 Womb keystones — the start/seed of each subtree (one per subtree).
 *  The StartNode leaves are dropped from the graph; the Womb IS the start (owner-confirmed). */
export function genesisRootIds(): readonly string[] {
  if (!rootIds) {
    rootIds = Object.entries(genesisGraph.nodes)
      .filter(([, node]) => node.keystone === true)
      .map(([key]) => key)
  }
  return rootIds
}

/**
 * Mount the Genesis tree on the shared B1 renderer — read-only by default, editable for
 * planning when `opts.editable`. The derived graph is built once and cached (static data).
 */
export function mountGenesisTree(container: HTMLElement, opts: MountGenesisTreeOptions = {}): TreeView {
  if (!derived) derived = buildGraph(genesisGraphData as unknown as RawTreeGraph)
  const options: MountTreeOptions = {
    graph: derived,
    viewerOnly: opts.editable !== true,
    // The 5 Wombs are ALLOCATABLE ROOTS (not always-on seeds): each is taken/dropped by the player,
    // and other nodes path from a taken womb. Not allocated by default.
    rootIds: genesisRootIds(),
    genesisIcons: true, // ~9 generic "Keepers*" category icons (scripts/build-genesis-icons.mjs)
    genesisFrames: GENESIS_FRAME_PATHS, // authentic Breach node frames (small + fancy, per state)
    genesisWomb: GENESIS_WOMB_PATHS, // the egg-socket art for the Womb start nodes (per state)
    genesisBg: GENESIS_BG, // the full-tree background facade
    onChange: opts.onChange, // optional — undefined is fine (consumer guards truthily)
    tooltipOverride: opts.tooltipOverride, // optional — undefined is fine (consumer uses ?.)
    ariaLabel: copy.genesis.canvasAria,
  }
  // (GENESIS_BG is now DATA-DRIVEN — origin-centred, size = node-extent coverage × MARGIN at native aspect;
  //  see genesisFacade() above. No more calib for the genesis facade.)
  return mountTree(container, options)
}
