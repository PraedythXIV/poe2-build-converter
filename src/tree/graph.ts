// B1 — passive-tree graph model. Loads the vendored treeGraph.json (pruned from GGG's
// official PoE2 tree export — see THIRD-PARTY-NOTICES.md) and derives everything the other
// tree modules consume: node lookup, undirected adjacency, a navigation adjacency for
// allocation (masteries and main↔ascendancy bridge edges removed), class starts, ascendancy
// clusters + their overlay offsets, and per-group centres for fallback arc rendering.
//
// Facts this module relies on (verified against the vendored data, 2026-06-12):
// - The synthetic "root" node and its 6 edges were already dropped by the pruning script;
//   edges with endpoints missing from `nodes` are skipped defensively anyway.
// - Node keys are the NUMERIC tree ids as strings — the same id space as PoB `spec.nodes`.
// - 368 mastery nodes are PoE2 leftovers (pure decoration): never navigable, never drawn.
// - 40 edges bridge the main tree to ascendancy clusters (class start ↔ ascendancy nodes);
//   they are kept out of `navAdjacency` so pathfinding never crosses — ascendancy clusters
//   are reached by seeding BFS with the selected ascendancy's start node instead.

import treeGraphData from '../data/treeGraph.json'

export type NodeKind = 'small' | 'notable' | 'keystone' | 'mastery' | 'jewel' | 'ascStart' | 'classStart'

export interface TreeNode {
  /** Numeric tree id as a string (object key in the export; same ids as PoB spec.nodes). */
  id: string
  /** Human-readable export id, e.g. "lightning14". */
  exportId: string
  name: string
  icon: string
  stats: string[]
  x: number
  y: number
  group: number
  orbit: number
  orbitIndex: number
  kind: NodeKind
  /** Atlas-only: a decorative mastery-ring icon (IsJustIcon) — no name/stats, shows no tooltip. */
  decorative?: boolean
  /** Atlas-only: a "Select a bonus" mastery's choose-one options (exact name + resolved stats). */
  choices?: Array<{ name: string; stats: string[] }>
  /** Atlas-only: a tree-start root (always-on seed). No tooltip; clicking it resets the tree. */
  atlasRoot?: boolean
  /** Genesis-only: draw this node's icon UNCROPPED (no circle clip) + larger, with a glow when
   *  allocated — for organic, non-circular art like the Genesis "womb" start sockets. */
  iconUncropped?: boolean
  ascendancyId: string | null
  /** Class indices that start at this node (PoE2 pairs two per start), or null. */
  classStartIndex: number[] | null
  /** ~12 nodes whose connections PoE never draws (edges stay pathable). */
  hideConnection: boolean
  /** Flavour quote(s) — 46 keystones carry one (tooltip polish). */
  flavour?: string[]
  /** A skill gem this node grants (53 nodes), surfaced in the tooltip. */
  grantedSkill?: { name: string; desc?: string }
  /** Group key for a mutually-exclusive option set (e.g. Point Blank ⟷ Far Shot). Options that
   *  share an mcParent are "choose one"; siblings are looked up via `graph.mcGroups`. */
  mcParent?: string
  // Phase 0 plumbing — gating + attribute/point grants. Pure metadata; nothing wires these yet.
  /** Prerequisite gate: this node unlocks only once `.nodes` are allocated. Ids are stringified
   *  to the node id space (source ids are numeric). ~200 nodes carry one. */
  unlockConstraint?: { nodes: string[]; ascendancy?: string }
  /** Attribute small whose stat is generic Str/Dex/Int (~293 nodes). */
  isGenericAttribute?: boolean
  grantedStrength?: number
  grantedDexterity?: number
  grantedIntelligence?: number
  grantedPassivePoints?: number
  /** GGG export flag: this node costs NO passive/ascendancy point (e.g. Sacred Unity). */
  isFree?: boolean
  weaponPassivePointsGranted?: number
  passivePointsGranted?: number
  /** Node is one option of an in-place multiple-choice swap (~5 nodes). */
  isMultipleChoice?: boolean
}

export interface TreeEdge {
  a: string
  b: string
  /** Arc centre shipped by the export (1733 edges); absent → straight or fallback arc. */
  arcX?: number
  arcY?: number
  /** True when either endpoint is a hideConnection node — skipped by the renderer. */
  hidden: boolean
}

export interface Ascendancy {
  id: string
  name: string
  classIdx: number
  /** Panel offset from the export's classes[] entry (overlay target = (-offsetX, -offsetY)). */
  offsetX: number
  offsetY: number
  nodeIds: string[]
  startNodeId: string | null
  // Phase 6 bridge — panel art + flavour, copied through from the export's classes[].ascendancies[].
  image?: string
  flavourText?: string | string[]
  flavourTextColour?: string
  flavourTextRect?: unknown
}

export interface WorldBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** A per-class/ascendancy stat rewrite for a base node (top-level `skillOverrides[overrideSkillId]`).
 *  Resolved via the two-hop join `overridePairs[baseNodeId] → overrideSkillId → skillOverrides[…]`
 *  (see _workbench/Docs/tree-data-fields.md). `stats` is already markup-stripped by the build (one source of
 *  truth with node stats); `skill` is the numeric override skill id, `id` its export string id. */
export interface SkillOverride {
  id: string
  skill: number
  name: string
  icon: string
  stats: string[]
}

export interface TreeGraph {
  nodeById: Map<string, TreeNode>
  edges: TreeEdge[]
  /** Undirected adjacency over every node that has edges (render-truth connectivity). */
  adjacency: Map<string, string[]>
  /** Allocation adjacency: no masteries, no main↔ascendancy bridge edges. */
  navAdjacency: Map<string, string[]>
  /** classIndex (0..11, both members of each pair) → start node id. */
  classStartByIndex: Map<number, string>
  classStartIds: ReadonlySet<string>
  /** Only selectable ascendancies (those listed in classes[] with a name). */
  ascendancies: Map<string, Ascendancy>
  /** group id → centre point, derived from orbit-0 nodes + export arc centres. */
  groupCenters: Map<number, { x: number; y: number }>
  /** Bounds of the export (includes far-out raw ascendancy positions). */
  bounds: WorldBounds
  /** Bounds of the main tree only (asc/mastery excluded) — what fit-to-view frames. */
  mainBounds: WorldBounds
  /** Mutually-exclusive option groups: mcParent key → the node ids that "choose one". */
  mcGroups: Map<string, string[]>
  /** Phase 0 plumbing — gated node id → its prerequisite gate (prereq ids + optional ascendancy). */
  unlockGates: Map<string, { nodes: string[]; ascendancy?: string }>
  /** Phase 0 plumbing — prereq node id → the gated node ids it unlocks (reverse of unlockGates). */
  gateDependents: Map<string, string[]>
  /** Phase 3 — per-class stat overrides: classIdx → (base node id → its SkillOverride). Joined from
   *  `classes[].overridePairs` + top-level `skillOverrides`. Base ids absent from `nodeById` skipped. */
  overridesByClassIdx: Map<number, Map<string, SkillOverride>>
  /** Phase 3 — per-ascendancy stat overrides: ascendancy id → (base node id → its SkillOverride).
   *  Takes precedence over the class override for the same base node (see `resolveNode`). */
  overridesByAscId: Map<string, Map<string, SkillOverride>>
}

// ── raw JSON shape (cast away the giant literal type, like src/convert/lookups.ts) ──────────
interface RawNode {
  id: string
  name: string
  icon: string
  stats: string[]
  x: number
  y: number
  group: number
  orbit: number
  orbitIndex: number
  ascendancyId?: string
  notable?: boolean
  keystone?: boolean
  mastery?: boolean
  jewel?: boolean
  decorative?: boolean
  choices?: Array<{ name: string; stats: string[] }>
  atlasRoot?: boolean
  iconUncropped?: boolean
  ascStart?: boolean
  hideConnection?: boolean
  classStartIndex?: number[]
  flavour?: string[]
  grantedSkill?: { name: string; desc?: string }
  mcParent?: string
  // Phase 0 plumbing — gating + attribute/point grants (all optional, present in treeGraph.json).
  // Note: unlockConstraint.nodes are NUMERIC source ids; stringified at map time to the node id space.
  unlockConstraint?: { nodes: number[]; ascendancy?: string }
  isGenericAttribute?: boolean
  grantedStrength?: number
  grantedDexterity?: number
  grantedIntelligence?: number
  grantedPassivePoints?: number
  isFree?: boolean
  weaponPassivePointsGranted?: number
  passivePointsGranted?: number
  isMultipleChoice?: boolean
}
interface RawEdge {
  from: number
  to: number
  orbitX?: number
  orbitY?: number
}
/** `{ [baseNodeId]: overrideSkillId }` — the build normalizes the export's empty `[]` to `{}`, but the
 *  array form is still typed (and guarded at read time) for resilience against a raw/un-normalized feed. */
type RawOverridePairs = Record<string, number> | unknown[]
interface RawAscendancy {
  id: string
  name: string
  offsetX: number
  offsetY: number
  image?: string
  flavourText?: string | string[]
  flavourTextColour?: string
  flavourTextRect?: unknown
  overridePairs?: RawOverridePairs
}
interface RawClass {
  idx: number
  name: string
  ascendancies: RawAscendancy[]
  image?: string
  image_offset_x?: number
  image_offset_y?: number
  overridePairs?: RawOverridePairs
}
/** Top-level `skillOverrides[overrideSkillId]` entry (the second hop). Shape mirrors `SkillOverride`. */
interface RawSkillOverride {
  id: string
  skill: number
  name: string
  icon: string
  stats: string[]
}
export interface RawTreeGraph {
  bounds: { min_x: number; min_y: number; max_x: number; max_y: number }
  classes: RawClass[]
  nodes: Record<string, RawNode>
  edges: RawEdge[]
  /** Keyed by **override** skill id (NOT base node id) — the second hop of the override join. */
  skillOverrides?: Record<string, RawSkillOverride>
}

function kindOf(n: RawNode): NodeKind {
  if (n.classStartIndex) return 'classStart'
  if (n.ascStart) return 'ascStart'
  if (n.mastery) return 'mastery'
  if (n.keystone) return 'keystone'
  if (n.jewel) return 'jewel'
  if (n.notable) return 'notable'
  return 'small'
}

/**
 * Resolve one `overridePairs` dict into `baseNodeId → SkillOverride` by the second hop into
 * `skillOverrides`. Guards the export's empty-`[]`-vs-object shape (only object keys are base ids;
 * an array carries none). Base ids are stringified to the node-id space and SKIPPED when absent from
 * `nodeById` (the 2 Druid bases 19680/55194 are genuinely absent — skip, never throw) or when the
 * override skill id has no `skillOverrides` entry.
 */
function buildOverrideMap(
  pairs: RawOverridePairs | undefined,
  skillOverrides: Record<string, RawSkillOverride>,
  nodeById: Map<string, TreeNode>,
): Map<string, SkillOverride> {
  const out = new Map<string, SkillOverride>()
  // []-vs-object guard: an array (the empty export form) has no base-id keys to read.
  if (!pairs || Array.isArray(pairs)) return out
  for (const [baseId, overrideSkillId] of Object.entries(pairs)) {
    const key = baseId // already a string from Object.entries — matches the node-id space
    if (!nodeById.has(key)) continue // missing base (e.g. Druid 19680/55194) — skip, never throw
    const ov = skillOverrides[String(overrideSkillId)]
    if (!ov) continue // no second-hop entry — nothing to apply
    out.set(key, { id: ov.id, skill: ov.skill, name: ov.name, icon: ov.icon, stats: ov.stats })
  }
  return out
}

let cached: TreeGraph | null = null

export interface TreeClassInfo {
  /** Class index as the export states it (the same idx space as classStartByIndex). */
  idx: number
  name: string
  // Phase 6 bridge — base-class illustration + its panel offset, from the export's classes[].
  image?: string
  imageOffsetX?: number
  imageOffsetY?: number
}

/** PoE2-playable classes exactly as the vendored export's classes[] lists them (idx + display
 *  name, export order). The derived TreeGraph drops class names — this is the only accessor. */
export function listClasses(): TreeClassInfo[] {
  const raw = treeGraphData as unknown as RawTreeGraph
  return raw.classes.map((c) => ({
    idx: c.idx,
    name: c.name,
    image: c.image,
    imageOffsetX: c.image_offset_x,
    imageOffsetY: c.image_offset_y,
  }))
}

/** Build (once) and return the derived graph for the vendored CHARACTER tree. */
export function loadGraph(): TreeGraph {
  if (cached) return cached
  cached = buildGraph(treeGraphData as unknown as RawTreeGraph)
  return cached
}

/** Derive a TreeGraph from any treeGraph.json-shaped export (character tree, atlas tree). */
export function buildGraph(raw: RawTreeGraph): TreeGraph {
  const nodeById = new Map<string, TreeNode>()
  for (const [key, rn] of Object.entries(raw.nodes)) {
    nodeById.set(key, {
      id: key,
      exportId: rn.id,
      name: rn.name,
      icon: rn.icon,
      stats: rn.stats,
      x: rn.x,
      y: rn.y,
      group: rn.group,
      orbit: rn.orbit,
      orbitIndex: rn.orbitIndex,
      kind: kindOf(rn),
      decorative: rn.decorative,
      choices: rn.choices,
      atlasRoot: rn.atlasRoot,
      iconUncropped: rn.iconUncropped,
      ascendancyId: rn.ascendancyId ?? null,
      classStartIndex: rn.classStartIndex ?? null,
      hideConnection: rn.hideConnection === true,
      flavour: rn.flavour,
      grantedSkill: rn.grantedSkill,
      mcParent: rn.mcParent,
      // Phase 0 — stringify each prereq id into the node id space (source ids are numeric).
      unlockConstraint: rn.unlockConstraint
        ? { nodes: rn.unlockConstraint.nodes.map(String), ascendancy: rn.unlockConstraint.ascendancy }
        : undefined,
      isGenericAttribute: rn.isGenericAttribute,
      grantedStrength: rn.grantedStrength,
      grantedDexterity: rn.grantedDexterity,
      grantedIntelligence: rn.grantedIntelligence,
      grantedPassivePoints: rn.grantedPassivePoints,
      isFree: rn.isFree, // GGG export flag: this node costs NO point (e.g. the Sacred Unity asc notable)
      weaponPassivePointsGranted: rn.weaponPassivePointsGranted,
      passivePointsGranted: rn.passivePointsGranted,
      isMultipleChoice: rn.isMultipleChoice,
    })
  }

  // mutually-exclusive option groups: mcParent key → its option node ids ("choose one").
  const mcGroups = new Map<string, string[]>()
  for (const node of nodeById.values()) {
    if (!node.mcParent) continue
    const group = mcGroups.get(node.mcParent)
    if (group) group.push(node.id)
    else mcGroups.set(node.mcParent, [node.id])
  }

  // Phase 0 plumbing — gate index: gated node id → its prereq gate, and the reverse fan-out
  // (prereq id → the ids it unlocks). Pure metadata; allocation is not wired to it yet.
  const unlockGates = new Map<string, { nodes: string[]; ascendancy?: string }>()
  const gateDependents = new Map<string, string[]>()
  for (const node of nodeById.values()) {
    if (!node.unlockConstraint) continue
    unlockGates.set(node.id, node.unlockConstraint)
    for (const prereqId of node.unlockConstraint.nodes) {
      // Each (prereqId, node.id) pair is reached at most once (every node iterated once; a node's
      // own prereq ids are unique), so no dedup check is needed before pushing.
      const dependents = gateDependents.get(prereqId)
      if (dependents) dependents.push(node.id)
      else gateDependents.set(prereqId, [node.id])
    }
  }

  // Undirected union of the top-level edges array (the pruned export has no in/out lists).
  const edges: TreeEdge[] = []
  // Build adjacency with Sets (O(1) dedup of the export's undirected edge pairs), then materialize to
  // the consumed `string[]` shape below — insertion order is preserved, so the arrays are unchanged.
  const adjacencySet = new Map<string, Set<string>>()
  const navAdjacencySet = new Map<string, Set<string>>()
  const addNeighbor = (adj: Map<string, Set<string>>, a: string, b: string): void => {
    const set = adj.get(a)
    if (set) set.add(b)
    else adj.set(a, new Set([b]))
  }
  for (const re of raw.edges) {
    const a = String(re.from)
    const b = String(re.to)
    const na = nodeById.get(a)
    const nb = nodeById.get(b)
    if (!na || !nb) continue // synthetic root / unknown endpoints — never wired in
    const edge: TreeEdge = { a, b, hidden: na.hideConnection || nb.hideConnection }
    if (re.orbitX !== undefined && re.orbitY !== undefined) {
      edge.arcX = re.orbitX
      edge.arcY = re.orbitY
    }
    edges.push(edge)
    addNeighbor(adjacencySet, a, b)
    addNeighbor(adjacencySet, b, a)

    // Navigation graph: masteries are decoration; a main↔ascendancy bridge is never walked
    // (ascendancy clusters are seeded through their start node instead).
    const decorated = na.kind === 'mastery' || nb.kind === 'mastery'
    const bridge = (na.ascendancyId === null) !== (nb.ascendancyId === null)
    if (!decorated && !bridge) {
      addNeighbor(navAdjacencySet, a, b)
      addNeighbor(navAdjacencySet, b, a)
    }
  }
  const materialize = (adj: Map<string, Set<string>>): Map<string, string[]> =>
    new Map([...adj].map(([k, v]) => [k, [...v]]))
  const adjacency = materialize(adjacencySet)
  const navAdjacency = materialize(navAdjacencySet)

  const classStartByIndex = new Map<number, string>()
  const classStartIds = new Set<string>()
  for (const node of nodeById.values()) {
    if (!node.classStartIndex) continue
    classStartIds.add(node.id)
    for (const idx of node.classStartIndex) classStartByIndex.set(idx, node.id)
  }

  // Selectable ascendancies come from classes[]; node membership from node.ascendancyId.
  // Nodes may carry ascendancy ids absent from classes[] (PoE1 placeholders like "Marauder1") —
  // those clusters are simply never selectable and always blocked.
  const ascendancies = new Map<string, Ascendancy>()
  for (const cls of raw.classes) {
    for (const asc of cls.ascendancies) {
      ascendancies.set(asc.id, {
        id: asc.id,
        name: asc.name,
        classIdx: cls.idx,
        offsetX: asc.offsetX,
        offsetY: asc.offsetY,
        nodeIds: [],
        startNodeId: null,
        // Phase 6 bridge — copy panel art + flavour straight through from the export.
        image: asc.image,
        flavourText: asc.flavourText,
        flavourTextColour: asc.flavourTextColour,
        flavourTextRect: asc.flavourTextRect,
      })
    }
  }
  for (const node of nodeById.values()) {
    if (!node.ascendancyId) continue
    const asc = ascendancies.get(node.ascendancyId)
    if (!asc) continue
    asc.nodeIds.push(node.id)
    if (node.kind === 'ascStart') asc.startNodeId = node.id
  }

  // Phase 3 — per-class / per-ascendancy stat overrides: join overridePairs (baseNodeId → overrideSkillId)
  // to the top-level skillOverrides (overrideSkillId → SkillOverride). `resolveNode` reads these.
  const skillOverrides = raw.skillOverrides ?? {}
  const overridesByClassIdx = new Map<number, Map<string, SkillOverride>>()
  const overridesByAscId = new Map<string, Map<string, SkillOverride>>()
  for (const cls of raw.classes) {
    overridesByClassIdx.set(cls.idx, buildOverrideMap(cls.overridePairs, skillOverrides, nodeById))
    for (const asc of cls.ascendancies) {
      overridesByAscId.set(asc.id, buildOverrideMap(asc.overridePairs, skillOverrides, nodeById))
    }
  }

  // Group centres: a node at orbit 0 sits exactly on its group centre; same-group arc edges
  // carry the centre too (used for groups without an orbit-0 node).
  const groupCenters = new Map<number, { x: number; y: number }>()
  for (const node of nodeById.values()) {
    if (node.orbit === 0 && !groupCenters.has(node.group)) {
      groupCenters.set(node.group, { x: node.x, y: node.y })
    }
  }
  for (const edge of edges) {
    if (edge.arcX === undefined || edge.arcY === undefined) continue
    const na = nodeById.get(edge.a)!
    const nb = nodeById.get(edge.b)!
    if (na.group === nb.group && !groupCenters.has(na.group)) {
      groupCenters.set(na.group, { x: edge.arcX, y: edge.arcY })
    }
  }

  // Main-tree bounds (the export bounds include raw ascendancy positions ~9k units out).
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodeById.values()) {
    if (node.ascendancyId || node.kind === 'mastery') continue
    if (node.x < minX) minX = node.x
    if (node.y < minY) minY = node.y
    if (node.x > maxX) maxX = node.x
    if (node.y > maxY) maxY = node.y
  }
  // Guard the degenerate case (no qualifying nodes): the sentinels would yield a NaN viewport
  // centre in fitToBounds ((Infinity + -Infinity) / 2). Fall back to a unit box. Real data has
  // thousands of qualifying nodes, so this only protects against an empty/all-filtered export.
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 1
    maxY = 1
  }

  return {
    nodeById,
    edges,
    adjacency,
    navAdjacency,
    classStartByIndex,
    classStartIds,
    ascendancies,
    groupCenters,
    bounds: { minX: raw.bounds.min_x, minY: raw.bounds.min_y, maxX: raw.bounds.max_x, maxY: raw.bounds.max_y },
    mainBounds: { minX, minY, maxX, maxY },
    mcGroups,
    unlockGates,
    gateDependents,
    overridesByClassIdx,
    overridesByAscId,
  }
}

/**
 * Resolve a node's class/ascendancy-specific stat override, if any.
 *
 * Returns the matching `SkillOverride` (rewritten name/icon/stats for this selection) when the base
 * node is overridden for the given class or ascendancy, else the base `TreeNode` unchanged.
 *
 * Precedence: **ascendancy over class** — if both override the same base node, the ascendancy wins
 * (its rewrite is the more specific one). A `null`/`null` selection is a no-op (returns the base),
 * so callers with no class/ascendancy context never see an override.
 */
export function resolveNode(
  graph: TreeGraph,
  node: TreeNode,
  classIndex: number | null,
  ascendancyId: string | null,
): TreeNode | SkillOverride {
  if (classIndex === null && ascendancyId === null) return node // no selection — no-op
  if (ascendancyId !== null) {
    const ascOv = graph.overridesByAscId.get(ascendancyId)?.get(node.id)
    if (ascOv) return ascOv // ascendancy precedence over class
  }
  if (classIndex !== null) {
    const classOv = graph.overridesByClassIdx.get(classIndex)?.get(node.id)
    if (classOv) return classOv
  }
  return node
}

/**
 * Node ids that allocation BFS must never traverse nor target for the given selection:
 * every foreign class start, plus every node belonging to a non-selected ascendancy
 * (including the unselectable PoE1 placeholder clusters).
 */
export function blockedNodeIds(graph: TreeGraph, classIndex: number | null, ascendancyId: string | null): Set<string> {
  const ownStart = classIndex !== null ? (graph.classStartByIndex.get(classIndex) ?? null) : null
  const blocked = new Set<string>()
  for (const id of graph.classStartIds) {
    if (id !== ownStart) blocked.add(id)
  }
  for (const node of graph.nodeById.values()) {
    if (node.ascendancyId && node.ascendancyId !== ascendancyId) blocked.add(node.id)
  }
  return blocked
}

/**
 * Translation applied to the selected ascendancy cluster so its start node lands at
 * (-offsetX, -offsetY) — between the tree origin and the class start, matching the in-game
 * panel placement. Null when the ascendancy is unknown or has no start node.
 */
export function ascendancyOverlayDelta(graph: TreeGraph, ascendancyId: string): { dx: number; dy: number } | null {
  const asc = graph.ascendancies.get(ascendancyId)
  if (!asc || !asc.startNodeId) return null
  const start = graph.nodeById.get(asc.startNodeId)
  if (!start) return null
  return { dx: -asc.offsetX - start.x, dy: -asc.offsetY - start.y }
}
