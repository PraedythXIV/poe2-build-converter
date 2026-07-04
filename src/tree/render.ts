// B1 — Canvas2D renderer for the passive tree. Stateless: renderScene() draws one frame from
// a SceneState snapshot; the mount (index.ts) owns dirty-tracking and only calls this when
// something changed (no rAF spin while idle).
//
// Render conventions follow cvenzin/poe2-skilltree (MIT, © 2026 cvenzin — conventions only,
// reimplemented for Canvas2D) and poe2-tools/poe2-build-planner (MIT, © 2026 theofbonin):
// - LOD tiers by zoom: < 0.05 dots, < 0.18 icons, else full sprites (poe2-tools lod.ts).
// - Edges: minor arc around the export-shipped centre when the edge carries orbitX/orbitY;
//   fallback arc around the group centre when both endpoints share group + orbit (> 0);
//   straight line otherwise. Radius sanity check: |rA - rB| <= rA * 0.02, else straight.
// - Sprites: TexturePacker atlases (frame/skills/skills-disabled), frame-key conventions
//   `<kind>Active:<icon>` / `<kind>Inactive:<icon>` + `frame:<State>` keys; frames are packed
//   at meta.scale = 0.5, so they draw at rect/scale world units.
// - Edges touching hideConnection or hidden (mastery / foreign-ascendancy) nodes are skipped.

import type { TreeGraph, TreeNode, NodeKind } from './graph'
import { resolveNode } from './graph'
import type { Viewport, Size } from './viewport'
import { visibleWorldRect } from './viewport'
import type { SpatialIndex } from './spatial'
import { queryRect } from './spatial'
import { collectRadii, firstRadiusAt, inDisc } from './jewelRadius'
import { iconForBase, itemIconsAtlasUrl } from '../items/icons'

import frameAtlasJson from '../assets/tree/frame.json'
import skillsAtlasJson from '../assets/tree/skills.json'
import skillsDisabledAtlasJson from '../assets/tree/skills-disabled.json'
import frameUrl from '../assets/tree/frame.webp'
import skillsUrl from '../assets/tree/skills.webp'
import skillsDisabledUrl from '../assets/tree/skills-disabled.webp'
import atlasIconsUrl from '../assets/tree/atlas-icons.webp'
import atlasIconsJson from '../data/atlasIcons.json'
import genesisIconsUrl from '../assets/tree/genesis-icons.webp'
import genesisIconsJson from '../data/genesisIcons.json'
import genesisBgUrl from '../assets/tree/genesis-bg.webp'
import atlasBgUrl from '../assets/tree/atlas-bg.webp'
import atlasBgGeneralUrl from '../assets/tree/atlas-bg-general.webp'
import atlasBgJson from '../data/atlasBg.json'
import passiveBgUrl from '../assets/tree/passive-bg.webp'
import passiveBgJson from '../data/passiveBg.json'
import passiveMasteryUrl from '../assets/tree/passive-mastery.webp'
import passiveMasteryJson from '../data/passiveMastery.json'
import jewelRadiusUrl from '../assets/tree/jewel-radius.webp'
import jewelRadiusJson from '../data/jewelRadius.json'
import uniqueIconsUrl from '../assets/items/unique-icons.webp'
import uniqueIconsJson from '../data/uniqueIcons.json'
import conquerorIconsUrl from '../assets/tree/conqueror-icons.webp'
import conquerorIconsJson from '../data/conquerorIcons.json'
import conquerorPassiveSkillsJson from '../data/conquerorPassiveSkills.json'
import conquerorTreeVersionsJson from '../data/conquerorTreeVersions.json'

// ── LOD (ported from poe2-tools src/render/lod.ts, MIT © 2026 theofbonin) ───────────────────
export type Lod = 'dots' | 'icons' | 'full'

/** Choose detail by zoom (screen px per world unit). */
function lodFor(zoom: number): Lod {
  if (zoom < 0.05) return 'dots'
  if (zoom < 0.18) return 'icons'
  return 'full'
}

/** Base node radius in world units, by kind (poe2-tools values). */
export const NODE_WORLD_RADIUS: Record<NodeKind, number> = {
  small: 27,
  notable: 40,
  keystone: 54,
  mastery: 40,
  jewel: 35,
  ascStart: 35,
  classStart: 35,
}

/** Atlas-icon circle radius as a multiple of the node radius — sized to fill the frame opening
 *  so the (square) art, clipped to this circle, leaves no corners and the frame finishes the rim. */
const ATLAS_ICON_FILL = 1.5
// Genesis nodes wear the authentic Breach ring frame: the Keepers icon sits SMALLER inside the frame's
// transparent opening, the frame rings it. (vs the atlas, where the icon fills and a sprite frame caps it.)
const GENESIS_ICON_FILL = 1.05
const GENESIS_FRAME_FILL = 1.62

// ── sprite atlases ───────────────────────────────────────────────────────────────────────────
interface AtlasRect {
  x: number
  y: number
  w: number
  h: number
}
interface AtlasJson {
  frames: Record<string, { frame: AtlasRect } | undefined>
  meta: { scale: string }
}
interface Sheet {
  img: CanvasImageSource
  atlas: AtlasJson
  /** 1 / meta.scale — multiply packed rect sizes by this to get world units. */
  invScale: number
  loaded: boolean
}
export interface SpriteSheets {
  skills: Sheet
  skillsDisabled: Sheet
  frame: Sheet
}

let sheetsSingleton: SpriteSheets | null = null
const readyCallbacks: Array<() => void> = []

/**
 * Load `url` and hand `onReady` a fully-decoded, blit-ready image source. A plain `<img>` decodes its
 * pixels LAZILY, on the render thread, at the first `drawImage` — for the 3.8k-square background
 * facades a one-off 130–170ms freeze the instant the art first paints (the "tree stutters when
 * background art is on" hitch the owner reported). `createImageBitmap()` decodes off that path, so the
 * first paint is already cheap (~5ms vs ~170ms, both measured). NOTE: `HTMLImageElement.decode()` does
 * NOT fix this — the GPU-canvas `drawImage` re-decodes regardless (verified: still 166ms). `onReady`
 * receives the `ImageBitmap`, or the raw `<img>` as a fallback when `createImageBitmap` is unavailable
 * or rejects (older engines / jsdom). Gated on `onload`, so environments that never fetch images
 * (jsdom in tests) behave exactly as before — `onReady` simply never fires and the renderer draws dots.
 */
function loadBitmap(url: string, onReady: (src: CanvasImageSource) => void): void {
  const img = new Image()
  img.onload = () => {
    if (typeof createImageBitmap === 'function') createImageBitmap(img).then(onReady, () => onReady(img))
    else onReady(img)
  }
  img.src = url
}

function makeSheet(url: string, atlas: AtlasJson): Sheet {
  const sheet: Sheet = { img: new Image(), atlas, invScale: 1 / Number.parseFloat(atlas.meta.scale), loaded: false }
  loadBitmap(url, (src) => {
    sheet.img = src
    sheet.loaded = true
    for (const cb of readyCallbacks) cb()
  })
  return sheet
}

/**
 * Load (once, shared across mounts) the three atlas sheets. `onReady` fires after each sheet
 * finishes decoding so the caller can repaint; until then the renderer falls back to dots.
 */
export function loadSprites(onReady: () => void): SpriteSheets {
  readyCallbacks.push(onReady)
  if (!sheetsSingleton) {
    sheetsSingleton = {
      skills: makeSheet(skillsUrl, skillsAtlasJson as unknown as AtlasJson),
      skillsDisabled: makeSheet(skillsDisabledUrl, skillsDisabledAtlasJson as unknown as AtlasJson),
      frame: makeSheet(frameUrl, frameAtlasJson as unknown as AtlasJson),
    }
  }
  return sheetsSingleton
}

/** Drop a previously registered onReady callback (mount teardown). */
export function unloadSprites(onReady: () => void): void {
  const i = readyCallbacks.indexOf(onReady)
  if (i >= 0) readyCallbacks.splice(i, 1)
}

// ── atlas-tree icon sheet (separate atlas: BC1 skill icons keyed by .dds path) ───────────────
// The character sprites are TexturePacker-keyed; the atlas builder (scripts/build-atlas-icons.mjs)
// emits a flat {ddsPath -> rect} table instead, so atlas nodes draw their real game icon.
export interface AtlasIconSheet {
  img: CanvasImageSource
  rects: Record<string, AtlasRect>
  loaded: boolean
}
let atlasIconSingleton: AtlasIconSheet | null = null

/** Load (once, shared) the atlas-tree icon sheet. Reuses the sprite repaint callbacks. */
export function loadAtlasIcons(): AtlasIconSheet {
  if (!atlasIconSingleton) {
    const sheet: AtlasIconSheet = {
      img: new Image(),
      rects: atlasIconsJson as unknown as Record<string, AtlasRect>,
      loaded: false,
    }
    loadBitmap(atlasIconsUrl, (src) => {
      sheet.img = src
      sheet.loaded = true
      for (const cb of readyCallbacks) cb() // repaint mounts waiting on art
    })
    atlasIconSingleton = sheet
  }
  return atlasIconSingleton
}

let genesisIconSingleton: AtlasIconSheet | null = null

/** Load (once, shared) the Genesis-tree icon sheet — same shape/render path as the atlas sheet. */
export function loadGenesisIcons(): AtlasIconSheet {
  if (!genesisIconSingleton) {
    const sheet: AtlasIconSheet = {
      img: new Image(),
      rects: genesisIconsJson as unknown as Record<string, AtlasRect>,
      loaded: false,
    }
    loadBitmap(genesisIconsUrl, (src) => {
      sheet.img = src
      sheet.loaded = true
      for (const cb of readyCallbacks) cb() // repaint mounts waiting on art
    })
    genesisIconSingleton = sheet
  }
  return genesisIconSingleton
}

/** A loaded image + its flag (the Genesis background facade — drawn behind the whole tree). */
export interface GenesisBgImage {
  img: CanvasImageSource
  loaded: boolean
}
let genesisBgSingleton: GenesisBgImage | null = null

/** Load (once, shared) the Genesis-tree background image (one large facade behind the tree). */
export function loadGenesisBg(): GenesisBgImage {
  if (!genesisBgSingleton) {
    const sheet: GenesisBgImage = { img: new Image(), loaded: false }
    loadBitmap(genesisBgUrl, (src) => {
      sheet.img = src
      sheet.loaded = true
      for (const cb of readyCallbacks) cb()
    })
    genesisBgSingleton = sheet
  }
  return genesisBgSingleton
}

// ── atlas-tree background discs (per-group "skin" art, BC7-decoded at build time) ─────────────
export interface AtlasBgSheet {
  img: CanvasImageSource // packed atlas of the small per-mechanic panels
  rects: Record<string, AtlasRect>
  loaded: boolean
  facade: CanvasImageSource // the large main-tree facade (standalone, high-res)
  facadeLoaded: boolean
}
/** One panel placement: world centre, world size, and which panel art to draw
 *  (a per-mechanic subtree panel, or `general` = the main-tree facade). */
export interface AtlasBgPanel {
  cx: number
  cy: number
  /** World width (and height when `sizeY` is absent → square). */
  size: number
  /** Optional world height for non-square placement; defaults to `size`. */
  sizeY?: number
  key: string
  /** Optional per-panel alpha; defaults to 0.85. */
  alpha?: number
}
let atlasBgSingleton: AtlasBgSheet | null = null
/** Load (once, shared) the atlas background art: the per-mechanic panel atlas + the facade. */
export function loadAtlasBg(): AtlasBgSheet {
  if (!atlasBgSingleton) {
    const sheet: AtlasBgSheet = {
      img: new Image(),
      rects: atlasBgJson as unknown as Record<string, AtlasRect>,
      loaded: false,
      facade: new Image(),
      facadeLoaded: false,
    }
    loadBitmap(atlasBgUrl, (src) => {
      sheet.img = src
      sheet.loaded = true
      for (const cb of readyCallbacks) cb()
    })
    loadBitmap(atlasBgGeneralUrl, (src) => {
      sheet.facade = src
      sheet.facadeLoaded = true
      for (const cb of readyCallbacks) cb()
    })
    atlasBgSingleton = sheet
  }
  return atlasBgSingleton
}

/** Passive-tree central art: class/ascendancy disc + central ring, all drawn at world origin.
 *  Frame keys + sizes + per-class ring rotation come from scripts/build-passive-bg.mjs. */
export interface PassiveBgSheet {
  img: CanvasImageSource
  frames: Record<string, AtlasRect>
  discSize: number
  ringSize: number
  classFrame0: Record<string, string> // classIndex -> "class<Name>:Class0"
  ascFrame: Record<string, string> // ascendancyId -> "class<Name>:Class<n>"
  ringRotation: Record<string, number> // classIndex -> radians for the active ring overlay
  loaded: boolean
}
let passiveBgSingleton: PassiveBgSheet | null = null
export function loadPassiveBg(): PassiveBgSheet {
  if (!passiveBgSingleton) {
    const j = passiveBgJson as unknown as Omit<PassiveBgSheet, 'img' | 'loaded'>
    const sheet: PassiveBgSheet = {
      img: new Image(),
      frames: j.frames,
      discSize: j.discSize,
      ringSize: j.ringSize,
      classFrame0: j.classFrame0,
      ascFrame: j.ascFrame,
      ringRotation: j.ringRotation,
      loaded: false,
    }
    loadBitmap(passiveBgUrl, (src) => {
      sheet.img = src
      sheet.loaded = true
      for (const cb of readyCallbacks) cb()
    })
    passiveBgSingleton = sheet
  }
  return passiveBgSingleton
}

/** Mastery effect "glow rays": the lit art behind a cluster once a connected notable is allocated.
 *  Frames + the node-id→effect map come from scripts/build-passive-masteries.mjs. */
interface MasteryFrame {
  x: number
  y: number
  w: number
  h: number
  ww: number // native world width
  wh: number // native world height
}
export interface MasterySheet {
  img: CanvasImageSource
  active: Record<string, MasteryFrame> // bright variant — drawn once a connected notable is allocated
  inactive: Record<string, MasteryFrame> // dim variant — always shown
  byNode: Record<string, string> // mastery node id -> effect base key
  loaded: boolean
}
let masterySingleton: MasterySheet | null = null
export function loadPassiveMastery(): MasterySheet {
  if (!masterySingleton) {
    const j = passiveMasteryJson as unknown as {
      active: Record<string, MasteryFrame>
      inactive: Record<string, MasteryFrame>
      byNode: Record<string, string>
    }
    const sheet: MasterySheet = {
      img: new Image(),
      active: j.active,
      inactive: j.inactive,
      byNode: j.byNode,
      loaded: false,
    }
    loadBitmap(passiveMasteryUrl, (src) => {
      sheet.img = src
      sheet.loaded = true
      for (const cb of readyCallbacks) cb()
    })
    masterySingleton = sheet
  }
  return masterySingleton
}

// One glow per drawable mastery: its position, effect frame, and the notables wired to it (the glow
// lights when any is allocated). Derived once from the graph + sheet (both build-once singletons).
interface MasteryGlow {
  mx: number
  my: number
  base: string
  notables: string[]
}
let masteryGlowCache: { graph: TreeGraph; glows: MasteryGlow[] } | null = null
function getMasteryGlows(graph: TreeGraph, sheet: MasterySheet): MasteryGlow[] {
  if (masteryGlowCache?.graph === graph) return masteryGlowCache.glows
  const glows: MasteryGlow[] = []
  for (const [id, node] of graph.nodeById) {
    if (node.kind !== 'mastery') continue
    const baseKey = sheet.byNode[id]
    if (!baseKey || (!sheet.active[baseKey] && !sheet.inactive[baseKey])) continue
    const notables = (graph.adjacency.get(id) ?? []).filter((nb) => graph.nodeById.get(nb)?.kind === 'notable')
    if (notables.length === 0) continue
    glows.push({ mx: node.x, my: node.y, base: baseKey, notables })
  }
  masteryGlowCache = { graph, glows }
  return glows
}

// Atlas decorative mastery-ring icons (IsJustIcon) are filler hubs at each cluster centre. They
// carry no stats and can't be allocated, but light up once any allocatable node in their cluster
// (same group) is taken. Map each decorative id -> its group's allocatable members, derived once.
const ATLAS_DECOR_RADIUS = 38 // a touch bigger than a small node (27), per the in-game ring size
let atlasDecorCache: { graph: TreeGraph; members: Map<string, string[]> } | null = null
function getAtlasDecorMembers(graph: TreeGraph): Map<string, string[]> {
  if (atlasDecorCache?.graph === graph) return atlasDecorCache.members
  const byGroup = new Map<number, string[]>()
  for (const [id, node] of graph.nodeById) {
    if (node.decorative || node.atlasRoot) continue // hubs + seeds don't count as "their keystone"
    const arr = byGroup.get(node.group)
    if (arr) arr.push(id)
    else byGroup.set(node.group, [id])
  }
  const members = new Map<string, string[]>()
  for (const [id, node] of graph.nodeById) {
    if (node.decorative) members.set(id, byGroup.get(node.group) ?? [])
  }
  atlasDecorCache = { graph, members }
  return members
}

/** Jewel-socket radius rings: a fixed-radius coloured circle drawn around a socket that holds a
 *  radius jewel. All radius jewels share one in-game radius; the frame differs only by faction. */
interface JewelFrame {
  x: number
  y: number
  w: number
  h: number
  ww: number
  wh: number
}
export interface JewelSheet {
  img: CanvasImageSource
  frames: Record<string, JewelFrame>
  loaded: boolean
}
/** One socket's radius ring. In-game it's TWO concentric rings that counter-rotate; `frameA` spins
 *  clockwise, `frameB` counter-clockwise. `diameter` is the OUTER world size (varies per jewel — Small
 *  … Very Large). The colour/faction is baked into the frames. */
export interface JewelRing {
  frameA: string
  frameB: string
  diameter: number
  /** Set for a RING (annulus) jewel — the inner boundary diameter; affected nodes lie BETWEEN this and
   *  `diameter` (e.g. "Only affects Passives in Medium-Large Ring"). Absent ⇒ a solid disc. */
  innerDiameter?: number
  /** Conqueror/faction colour (css) used to tint the nodes inside the radius — the in-game
   *  "these passives are Conquered by X" cue. Decorative; the geometry (which nodes) is exact. */
  tint?: string
}
/** A socketed jewel as the tree needs it: name/base/radius + stat lines (for the tooltip) and, when
 *  it's a radius jewel, the ring to draw. Presence in the map = the socket is filled. */
export interface JewelInfo {
  name: string
  baseType?: string
  radius?: string
  /** Item rarity (NORMAL | MAGIC | RARE | UNIQUE | RELIC) — tiers the tooltip card's colour. */
  rarity?: string
  /** True if the jewel is corrupted (renders a "Corrupted" stamp on the tooltip). */
  corrupted?: boolean
  stats: readonly string[]
  ring?: JewelRing
  /** Conqueror faction (timeless-jewel `ConquerorType`: Vaal | Karui | … | Abyss) when the jewel's
   *  mods name one. Drives the one-art-per-(faction,kind) node-icon override for in-radius nodes —
   *  NOT the exact per-seed art a real Timeless Jewel resolves (that's deferred; honesty). */
  version?: ConquerorType
  /** Time-Lost Diamond deterministic attribute swap (e.g. Strength → Dexterity), read from
   *  PassiveJewelTransformations. Tooltip-only cue; the renderer does not transform stats. */
  swap?: { from: string; to: string }
}
let jewelSingleton: JewelSheet | null = null
export function loadJewelRadius(): JewelSheet {
  if (!jewelSingleton) {
    const j = jewelRadiusJson as unknown as { frames: Record<string, JewelFrame> }
    const sheet: JewelSheet = { img: new Image(), frames: j.frames, loaded: false }
    loadBitmap(jewelRadiusUrl, (src) => {
      sheet.img = src
      sheet.loaded = true
      for (const cb of readyCallbacks) cb()
    })
    jewelSingleton = sheet
  }
  return jewelSingleton
}

// ── socketed-unique jewel art (the jewel's OWN in-game icon, not its base) ─────────────────────
// scripts/build-unique-icons.mjs packs one webp (src/assets/items/unique-icons.webp) + a flat
// {nameLower -> rect} table (src/data/uniqueIcons.json) from GGG's UniqueStashLayout → Words +
// ItemVisualIdentity (real game art) — zero network at runtime. Keyed by the unique's lowercased
// name. Unlike a base-art lookup this IS the unique's own art, so no rarity suppression applies.
export interface UniqueIconSheet {
  img: CanvasImageSource
  rects: Record<string, AtlasRect>
  loaded: boolean
}
let uniqueIconSingleton: UniqueIconSheet | null = null
/** Load (once, shared) the socketed-unique icon sheet. Reuses the sprite repaint callbacks. */
function loadUniqueIcons(): UniqueIconSheet {
  if (!uniqueIconSingleton) {
    // _provenance/_atlas are metadata; every other key is a lowercased unique name -> tile rect.
    const { _provenance, _atlas, ...rects } = uniqueIconsJson as unknown as Record<string, AtlasRect> & {
      _provenance: unknown
      _atlas: unknown
    }
    void _provenance
    void _atlas
    const sheet: UniqueIconSheet = { img: new Image(), rects, loaded: false }
    loadBitmap(uniqueIconsUrl, (src) => {
      sheet.img = src
      sheet.loaded = true
      for (const cb of readyCallbacks) cb() // repaint mounts waiting on art
    })
    uniqueIconSingleton = sheet
  }
  return uniqueIconSingleton
}

// ── conqueror (Timeless Jewel) node-icon override art ───────────────────────────────────────────
// A node inside a conqueror radius jewel takes that faction's node art. The full game picks the
// EXACT per-node art via GGG's seeded RNG (deferred — see docs/atlas-background-art.md); here we
// show ONE deterministic art per (faction, node-kind) — the owner's honest simplification. The
// table below is derived ONCE from conquerorPassiveSkills.json (the faction node list, with its
// AlternateTreeVersion + PassiveType + DDSIcon); the atlas (conquerorIcons.json + .webp) holds the
// decoded BC1/BC7 art keyed by DDS path. Source: GGG game data via pathofexile-dat (MIT).

/** Timeless-jewel conqueror factions, indexed by AlternateTreeVersion (1..7); 'None' = index 0. */
export type ConquerorType = 'Vaal' | 'Karui' | 'Maraketh' | 'Templar' | 'Eternal' | 'Kalguuran' | 'Abyss'
/** AlternateTreeVersion index -> faction, DERIVED from GGG's `AlternateTreeVersions` table
 *  (conquerorTreeVersions.json, in row order) rather than hand-typed — a reordered/added faction
 *  follows the source automatically. `ConquerorType` (the TS union) is pinned to this list by
 *  tests/tree.test.ts; index 0 is the un-conquered base tree ('None'). */
export const CONQUEROR_BY_VERSION: readonly (ConquerorType | 'None')[] = (
  conquerorTreeVersionsJson as unknown as { versions: { ConquerorType: string }[] }
).versions.map((v) => v.ConquerorType) as readonly (ConquerorType | 'None')[]

/** Node kinds the override applies to (small / notable / keystone). Masteries, jewels, starts keep
 *  their own art. PassiveType buckets: [4]→keystone, [3]→notable, else (attribute/normal small). */
type ConquerorKind = 'small' | 'notable' | 'keystone'
function conquerorKindForNode(kind: NodeKind): ConquerorKind | null {
  if (kind === 'keystone') return 'keystone'
  if (kind === 'notable') return 'notable'
  if (kind === 'small') return 'small'
  return null // mastery / jewel / ascStart / classStart — no faction node art
}

interface RawConquerorSkill {
  AlternateTreeVersion: number
  PassiveType: number[]
  DDSIcon: string
}
/** Conqueror-icon atlas sheet: image + {ddsPath -> rect}, plus the derived one-art-per-(faction,kind)
 *  DDS lookup. Built once (lazy). Reuses the sprite repaint callbacks so art appears once decoded. */
export interface ConquerorIconSheet {
  img: CanvasImageSource
  rects: Record<string, AtlasRect>
  /** `${ConquerorType}|${ConquerorKind}` -> representative DDS path present in `rects`. Only combos
   *  with genuine faction REPLACEMENT art are populated (additions-only factions keep base art). */
  byFactionKind: Record<string, string>
  loaded: boolean
}
let conquerorIconSingleton: ConquerorIconSheet | null = null

function passiveTypeKind(passiveType: readonly number[]): ConquerorKind | null {
  if (passiveType.includes(4)) return 'keystone'
  if (passiveType.includes(3)) return 'notable'
  if (passiveType.includes(1) || passiveType.includes(2)) return 'small'
  return null
}

/** Derive the deterministic (faction,kind) -> DDS table from the faction node list. For each
 *  (AlternateTreeVersion, kind) we pick the icon used by the MOST faction nodes that also exists in
 *  the atlas — a stable, data-driven representative. Combos with no atlas-backed icon stay absent
 *  (the node keeps its base art — we never invent faction art that isn't in the data). */
function buildFactionKindTable(rects: Record<string, AtlasRect>): Record<string, string> {
  const skills = (conquerorPassiveSkillsJson as unknown as { skills: RawConquerorSkill[] }).skills
  const counts = new Map<string, Map<string, number>>() // "faction|kind" -> (dds -> count)
  for (const sk of skills) {
    const faction = CONQUEROR_BY_VERSION[sk.AlternateTreeVersion]
    if (!faction || faction === 'None') continue
    const kind = passiveTypeKind(sk.PassiveType)
    if (!kind) continue
    const dds = sk.DDSIcon
    if (!dds || !(dds in rects)) continue // only icons we actually packed
    const key = `${faction}|${kind}`
    const m = counts.get(key) ?? new Map<string, number>()
    m.set(dds, (m.get(dds) ?? 0) + 1)
    counts.set(key, m)
  }
  const out: Record<string, string> = {}
  for (const [key, m] of counts) {
    // most-used DDS wins; tie broken by lexicographic DDS path for determinism across rebuilds.
    let best: string | null = null
    let bestN = -1
    for (const [dds, n] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (n > bestN) {
        best = dds
        bestN = n
      }
    }
    if (best) out[key] = best
  }
  return out
}

/** Load (once, shared) the conqueror node-icon atlas + its derived (faction,kind) lookup. */
function loadConquerorIcons(): ConquerorIconSheet {
  if (!conquerorIconSingleton) {
    // _provenance/_atlas are metadata; every other key is a DDS path -> tile rect.
    const { _provenance, _atlas, ...rects } = conquerorIconsJson as unknown as Record<string, AtlasRect> & {
      _provenance: unknown
      _atlas: unknown
    }
    void _provenance
    void _atlas
    const sheet: ConquerorIconSheet = {
      img: new Image(),
      rects,
      byFactionKind: buildFactionKindTable(rects),
      loaded: false,
    }
    loadBitmap(conquerorIconsUrl, (src) => {
      sheet.img = src
      sheet.loaded = true
      for (const cb of readyCallbacks) cb() // repaint mounts waiting on art
    })
    conquerorIconSingleton = sheet
  }
  return conquerorIconSingleton
}

/** The faction node-art rect for a node of `kind` inside a `faction` radius, or null when this
 *  (faction,kind) has no replacement art in the data (the node then keeps its base/override icon). */
function conquerorIconRect(sheet: ConquerorIconSheet, faction: ConquerorType, kind: NodeKind): AtlasRect | null {
  const ck = conquerorKindForNode(kind)
  if (!ck) return null
  const dds = sheet.byFactionKind[`${faction}|${ck}`]
  return (dds && sheet.rects[dds]) || null
}

// ── base-item icon atlas (loaded for canvas drawing) ──────────────────────────────────────────
// items/icons.ts owns the base-art TABLE (iconForBase) but only ever draws it as a CSS
// background-image (HTML item cards). To paint base art onto the tree canvas we need the atlas as
// a loaded Image; this singleton wraps the same webp URL. Reuses the sprite repaint callbacks.
interface LoadedImage {
  img: CanvasImageSource
  loaded: boolean
}
let baseIconAtlasSingleton: LoadedImage | null = null
function loadBaseIconAtlas(): LoadedImage {
  if (!baseIconAtlasSingleton) {
    const wrap: LoadedImage = { img: new Image(), loaded: false }
    loadBitmap(itemIconsAtlasUrl, (src) => {
      wrap.img = src
      wrap.loaded = true
      for (const cb of readyCallbacks) cb()
    })
    baseIconAtlasSingleton = wrap
  }
  return baseIconAtlasSingleton
}

const JEWEL_SPIN_PERIOD_MS = 200000 // one revolution per ~3.3 min — a very subtle drift; rings counter-rotate
const JEWEL_RING_ALPHA = 0.7 // rings drawn subtly so they don't dominate the tree
/** "#rrggbb" + alpha -> "rgba(r,g,b,a)" (for the conqueror radius tint gradient stops). */
function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '')
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
}

/** The class/ascendancy disc frame key for the current selection (ascendancy art if present,
 *  else the base class image). */
function centralDiscKey(s: SceneState, pb: PassiveBgSheet): string | null {
  if (s.classIndex === null) return null
  if (s.ascendancyId) {
    const k = pb.ascFrame[s.ascendancyId]
    if (k && pb.frames[k]) return k
  }
  return pb.classFrame0[s.classIndex] ?? null
}

// ── palette (token-driven; resolved from CSS custom properties at mount) ────────────────────
export interface Palette {
  edgeIdle: string
  edgeAllocated: string
  dotIdle: string
  dotAllocated: string
  hover: string
  search: string
  startRing: string
  /** PoB weapon-set tints: set 1 greenish, set 2 reddish (tree.css --tree-ws1/--tree-ws2). */
  ws1: string
  ws2: string
  /** Per-faction conqueror radius tints (recolour in-radius nodes), keyed by ConquerorType, plus a
   *  generic (no-faction) tint. Token-driven so a future theme retones them; the curated hex baked in
   *  jewelSockets.ts (FACTION_ART.tint / GENERIC_RING.tint) is the fallback when no token overrides. */
  factionTint: Record<ConquerorType, string>
  factionTintGeneric: string
  /** Genesis Womb central item-slot fill + rim (rgba). */
  wombFill: string
  wombRim: string
}

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = style.getPropertyValue(name).trim()
  return v.length > 0 ? v : fallback
}

/**
 * Read the render palette from the element's resolved CSS tokens. styles.css reserves a
 * dedicated passive-tree ramp (warm-on-cool inversion: --poe-void backdrop, --poe-node-on
 * gold for allocated, --poe-node-off for idle); fall back to the generic contract tokens.
 */
export function resolvePalette(el: Element): Palette {
  const style = getComputedStyle(el)
  return {
    edgeIdle: cssVar(style, '--poe-node-off', '#4a463e'),
    edgeAllocated: cssVar(style, '--poe-node-on', '#e6c16a'),
    dotIdle: cssVar(style, '--poe-node-off', '#4a463e'),
    dotAllocated: cssVar(style, '--poe-node-on', '#e6c16a'),
    hover: cssVar(style, '--accent-hover', '#f0d18a'),
    search: cssVar(style, '--status-info', '#5aa7d4'),
    startRing: cssVar(style, '--poe-nebula', '#2a3550'),
    ws1: cssVar(style, '--tree-ws1', '#79c97e'),
    ws2: cssVar(style, '--tree-ws2', '#d9705c'),
    // Conqueror faction tints — fallbacks are the curated hexes in jewelSockets.ts (FACTION_ART.tint).
    factionTint: {
      Vaal: cssVar(style, '--tree-faction-vaal', '#d23b3b'),
      Karui: cssVar(style, '--tree-faction-karui', '#d07a3a'),
      Maraketh: cssVar(style, '--tree-faction-maraketh', '#36c0c0'),
      Templar: cssVar(style, '--tree-faction-templar', '#d9b54a'),
      Eternal: cssVar(style, '--tree-faction-eternal', '#8a6fd0'),
      Kalguuran: cssVar(style, '--tree-faction-kalguuran', '#b6864a'),
      Abyss: cssVar(style, '--tree-faction-abyss', '#3fae5a'),
    },
    factionTintGeneric: cssVar(style, '--tree-faction-generic', '#6aa0ff'), // GENERIC_RING.tint
    wombFill: cssVar(style, '--tree-womb-fill', 'rgba(54, 58, 40, 0.92)'), // recessed dark-olive socket
    wombRim: cssVar(style, '--tree-womb-rim', 'rgba(120, 126, 88, 0.7)'), // faint olive rim
  }
}

// ── weapon-set classification (PoB convention: greenish set 1, reddish set 2) ───────────────
export type WeaponSetTint = 'none' | 'ws1' | 'ws2'

/**
 * Tint for an ALLOCATED node: in set 1 only → ws1, in set 2 only → ws2; in both sets the
 * node is shared (normal allocated colour), in neither it is plain — both map to 'none'.
 */
export function weaponSetTint(id: string, set1: ReadonlySet<string>, set2: ReadonlySet<string>): WeaponSetTint {
  const in1 = set1.has(id)
  const in2 = set2.has(id)
  if (in1 === in2) return 'none'
  return in1 ? 'ws1' : 'ws2'
}

/**
 * Tint for an ALLOCATED edge: BOTH endpoints must sit in the set. An edge fully inside both
 * sets (shared segment) keeps the normal allocated colour, like shared nodes.
 */
export function edgeWeaponSetTint(
  a: string,
  b: string,
  set1: ReadonlySet<string>,
  set2: ReadonlySet<string>,
): WeaponSetTint {
  const in1 = set1.has(a) && set1.has(b)
  const in2 = set2.has(a) && set2.has(b)
  if (in1 === in2) return 'none'
  return in1 ? 'ws1' : 'ws2'
}

// ── edge geometry (refs.md §1.3 arc math + §4.2 group-centre fallback) ──────────────────────
export type EdgeGeom =
  { kind: 'line' } | { kind: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number; anticlockwise: boolean }

/**
 * Geometry for the edge a→b given an arc centre candidate (export orbitX/Y or group centre).
 * Falls back to a straight line when no centre is given or the endpoints are not equidistant
 * from it (within 2% — the export guarantee for true arc edges).
 */
function edgeGeometry(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  center: { x: number; y: number } | null,
): EdgeGeom {
  if (!center) return { kind: 'line' }
  const r = Math.hypot(ax - center.x, ay - center.y)
  const rB = Math.hypot(bx - center.x, by - center.y)
  if (r <= 0 || Math.abs(r - rB) > r * 0.02) return { kind: 'line' }
  const a0 = Math.atan2(ay - center.y, ax - center.x)
  const a1 = Math.atan2(by - center.y, bx - center.x)
  let delta = a1 - a0
  while (delta <= -Math.PI) delta += 2 * Math.PI
  while (delta > Math.PI) delta -= 2 * Math.PI
  return { kind: 'arc', cx: center.x, cy: center.y, r, a0, a1, anticlockwise: delta < 0 }
}

// ── scene ────────────────────────────────────────────────────────────────────────────────────
/** Per-allocation-state dds-path keys for one Genesis node-frame ring style. */
export interface GenesisFrameStates {
  normal: string
  canallocate: string
  active: string
}

export interface SceneState {
  graph: TreeGraph
  vp: Viewport
  /** CSS-pixel canvas size. */
  size: Size
  dpr: number
  allocated: ReadonlySet<string>
  /** PoB weapon-set memberships — allocated nodes/edges fully inside ONE set get its tint. */
  weaponSet1: ReadonlySet<string>
  weaponSet2: ReadonlySet<string>
  hovered: string | null
  searchMatches: ReadonlySet<string>
  ascendancyId: string | null
  classIndex: number | null
  /** Overlay translation of the selected ascendancy cluster (graph.ascendancyOverlayDelta). */
  ascDelta: { dx: number; dy: number } | null
  /** Spatial index over DISPLAYED node positions — also the single source of visibility. */
  spatial: SpatialIndex
  sprites: SpriteSheets | null
  /** Atlas-tree icon sheet (atlas mount only); null for the character tree. Also carries the Genesis
   *  icon + frame sheet for the Genesis mount. */
  atlasIcons?: AtlasIconSheet | null
  /** Genesis mount only: dds-path keys (into atlasIcons) of the Breach node FRAME art per allocation
   *  state, in two ring styles — `small` (regular nodes) + `fancy` (notables). Absent elsewhere. */
  genesisFrames?: { small: GenesisFrameStates; fancy: GenesisFrameStates }
  /** Genesis mount only: dds-path keys of the Womb socket art (egg + square slot hole), per state. */
  genesisWomb?: { normal: string; canallocate: string; active: string }
  /** Genesis mount only: the background facade image + its placement panel (drawn behind the tree).
   *  `panel` is the data-driven AtlasBgPanel (the _workbench/dev/calib/ tool can mutate it live for emergency re-cal). */
  genesisBg?: { img: GenesisBgImage; panel: AtlasBgPanel } | null
  /** Atlas-tree background art sheet + per-subtree panel placements (atlas mount only). */
  atlasBg?: AtlasBgSheet | null
  bgPanels?: readonly AtlasBgPanel[]
  /** Passive-tree central art sheet (character mount only). */
  passiveBg?: PassiveBgSheet | null
  /** Passive-tree mastery effect ("glow rays") sheet (character mount only). */
  mastery?: MasterySheet | null
  /** Jewel-radius ring sheet (character mount only). */
  jewels?: JewelSheet | null
  /** Socketed-unique icon sheet (the jewel's own art). Optional: when absent the renderer
   *  lazily loads the shared singleton itself, so the mount need not wire it. */
  uniqueIcons?: UniqueIconSheet | null
  /** Conqueror (Timeless Jewel) node-icon atlas. Optional: when absent the renderer lazily loads
   *  the shared singleton itself, so the mount need not wire it. */
  conquerorIcons?: ConquerorIconSheet | null
  /** Socket node id -> socketed-jewel info (tooltip name/stats + optional radius ring). */
  jewelSockets?: ReadonlyMap<string, JewelInfo>
  /** Animation clock (ms) for the spinning radius rings; 0 = no spin. */
  time?: number
  /** Draw the central class/ascendancy art + mastery glows (gated by the bg-visible toggle). */
  showCentralArt?: boolean
  palette: Palette
}

const VIEW_PAD = 1600 // max orbit radius (1320) + node radius — arcs near the rim still draw

function frameKeyFor(node: TreeNode, allocated: boolean, hovered: boolean): string | null {
  const state = allocated ? 'Allocated' : hovered ? 'CanAllocate' : 'Unallocated'
  switch (node.kind) {
    case 'keystone':
      return `frame:KeystoneFrame${state}`
    case 'notable':
      return node.ascendancyId ? `frame:AscendancyFrameNotable${state}` : `frame:NotableFrame${state}`
    case 'small':
      if (node.ascendancyId) return `frame:AscendancyFrameNormal${state}`
      return allocated ? 'frame:PSSkillFrameActive' : hovered ? 'frame:PSSkillFrameHighlighted' : 'frame:PSSkillFrame'
    case 'jewel':
      return `frame:JewelSocketAlt${allocated ? 'Active' : hovered ? 'CanAllocate' : 'Normal'}`
    case 'ascStart':
      return 'frame:AscendancyStartNode'
    default:
      return null // mastery (never drawn) / classStart (ring)
  }
}

/** Skills-atlas icon key from a node's kind + an icon path. Keyed on (kind, icon) — not the whole
 *  node — so a resolved override icon (resolveNode / SkillOverride, which carries no `kind`) reuses
 *  the SAME key construction: one source of truth for the `<prefix>:<icon>` convention. */
function iconKeyForKind(kind: NodeKind, icon: string): string | null {
  if (kind === 'mastery' || kind === 'jewel' || kind === 'classStart') return null
  const prefix = kind === 'keystone' ? 'keystone' : kind === 'notable' ? 'notable' : 'normal'
  return `${prefix}:${icon}` // caller inserts Active/Inactive
}

function drawSprite(ctx: CanvasRenderingContext2D, sheet: Sheet, key: string, wx: number, wy: number): boolean {
  if (!sheet.loaded) return false
  const entry = sheet.atlas.frames[key]
  if (!entry) return false
  const r = entry.frame
  const w = r.w * sheet.invScale
  const h = r.h * sheet.invScale
  ctx.drawImage(sheet.img, r.x, r.y, r.w, r.h, wx - w / 2, wy - h / 2, w, h)
  return true
}

/** The Genesis Womb's central "item input" slot — the socket a Wombgift is placed into (an empty
 *  inventory slot, shown in-game through the egg's square hole). Drawn as a recessed olive rect of
 *  the given width×height, centred at (x,y) — sized/placed to fill the egg's actual hole. */
function drawWombSlot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  rim: string,
): void {
  ctx.save()
  ctx.fillStyle = fill // recessed dark-olive socket (empty) — palette.wombFill
  ctx.fillRect(x - w / 2, y - h / 2, w, h)
  ctx.lineWidth = Math.max(1.5, Math.min(w, h) * 0.05)
  ctx.strokeStyle = rim // faint olive rim — palette.wombRim
  ctx.strokeRect(x - w / 2, y - h / 2, w, h)
  ctx.restore()
}

function addCircle(path: Path2D, x: number, y: number, r: number): void {
  path.moveTo(x + r, y)
  path.arc(x, y, r, 0, Math.PI * 2)
}

/** True when the axis-aligned box (cx±halfW, cy±halfH) overlaps the padded view bounds. The single
 *  on-screen test for every drawable; pass `radius` for both halves when the extent is symmetric. */
function isRectVisible(
  b: { minX: number; minY: number; maxX: number; maxY: number },
  cx: number,
  cy: number,
  halfW: number,
  halfH: number = halfW,
): boolean {
  return cx + halfW >= b.minX && cx - halfW <= b.maxX && cy + halfH >= b.minY && cy - halfH <= b.maxY
}

/** Draw `img`'s `sr` source rect circle-clipped to radius `r` at (cx,cy) as a square cover tile
 *  (2r × 2r), at the given alpha. Restores ctx state (clip + alpha) on return. */
function drawCircleClipped(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  sr: AtlasRect,
  cx: number,
  cy: number,
  r: number,
  alpha: number,
): void {
  const d = r * 2
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.clip()
  ctx.globalAlpha = alpha
  ctx.drawImage(img, sr.x, sr.y, sr.w, sr.h, cx - d / 2, cy - d / 2, d, d)
  ctx.restore()
}

/** Draw one frame. The canvas backing store must already be size*dpr. */
export function renderScene(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const { vp, size, dpr, graph, spatial, palette } = s
  // Atlas decorative hubs render a bit bigger and light up once their cluster is taken.
  const decorMembers = getAtlasDecorMembers(graph)
  const decorLit = (id: string): boolean => decorMembers.get(id)?.some((m) => s.allocated.has(m)) ?? false
  const nodeRadius = (node: TreeNode): number => (node.decorative ? ATLAS_DECOR_RADIUS : NODE_WORLD_RADIUS[node.kind])
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size.width, size.height)

  // World transform: all subsequent coordinates are world units.
  ctx.setTransform(
    dpr * vp.zoom,
    0,
    0,
    dpr * vp.zoom,
    dpr * (size.width / 2 - vp.x * vp.zoom),
    dpr * (size.height / 2 - vp.y * vp.zoom),
  )

  const view = visibleWorldRect(vp, size)
  const padded = {
    minX: view.minX - VIEW_PAD,
    minY: view.minY - VIEW_PAD,
    maxX: view.maxX + VIEW_PAD,
    maxY: view.maxY + VIEW_PAD,
  }
  const lod = lodFor(vp.zoom)

  // ── genesis background facade: one large image behind the whole tree (its silhouette is in the art) ─
  const gbg = s.genesisBg
  if (gbg?.img.loaded) {
    const pnl = gbg.panel
    const w = pnl.size
    const h = pnl.sizeY ?? pnl.size
    ctx.globalAlpha = pnl.alpha ?? 1
    ctx.drawImage(gbg.img.img, pnl.cx - w / 2, pnl.cy - h / 2, w, h)
    ctx.globalAlpha = 1
  }

  // ── atlas background art: the main-tree facade + one panel per mechanic subtree ───────────
  // One drawImage per visible panel, behind everything; the shape silhouette is in the art's
  // alpha. Culled to on-screen panels — at most ~6, fixed per-frame cost (no per-node work).
  const bg = s.atlasBg
  if (bg && s.bgPanels?.length) {
    for (const p of s.bgPanels) {
      const w = p.size,
        h = p.sizeY ?? p.size
      const hw = w / 2,
        hh = h / 2
      if (!isRectVisible(padded, p.cx, p.cy, hw, hh)) continue
      ctx.globalAlpha = p.alpha ?? 0.85
      if (p.key === 'general') {
        if (bg.facadeLoaded) ctx.drawImage(bg.facade, p.cx - hw, p.cy - hh, w, h)
      } else if (bg.loaded) {
        const rect = bg.rects[p.key]
        if (rect) ctx.drawImage(bg.img, rect.x, rect.y, rect.w, rect.h, p.cx - hw, p.cy - hh, w, h)
      }
    }
    ctx.globalAlpha = 1
  }

  // ── passive-tree central art (character mount): class/ascendancy disc behind the centre ─────
  const pb = s.passiveBg
  if (s.showCentralArt && pb?.loaded && s.classIndex !== null) {
    const key = centralDiscKey(s, pb)
    const r = key ? pb.frames[key] : undefined
    if (r) {
      const half = pb.discSize / 2
      ctx.globalAlpha = 0.9
      ctx.drawImage(pb.img, r.x, r.y, r.w, r.h, -half, -half, pb.discSize, pb.discSize)
      ctx.globalAlpha = 1
    }
  }
  // mastery "glow rays": the dim effect is always shown; it brightens (active art) once a notable
  // connected to that mastery is allocated.
  const ms = s.mastery
  if (s.showCentralArt && ms?.loaded) {
    for (const glow of getMasteryGlows(graph, ms)) {
      const lit = glow.notables.some((id) => s.allocated.has(id))
      const fr = lit
        ? (ms.active[glow.base] ?? ms.inactive[glow.base])
        : (ms.inactive[glow.base] ?? ms.active[glow.base])
      if (!fr) continue
      const hw = fr.ww / 2
      const hh = fr.wh / 2
      if (!isRectVisible(padded, glow.mx, glow.my, hw, hh)) continue
      ctx.globalAlpha = lit ? 0.8 : 0.42
      ctx.drawImage(ms.img, fr.x, fr.y, fr.w, fr.h, glow.mx - hw, glow.my - hh, fr.ww, fr.wh)
    }
    ctx.globalAlpha = 1
  }

  // ── edges: batched into four paths, one stroke each (perf bar: no per-edge stroking) ─────
  const idlePath = new Path2D()
  const allocPath = new Path2D()
  const ws1Path = new Path2D()
  const ws2Path = new Path2D()
  for (const edge of graph.edges) {
    if (edge.hidden) continue
    const pa = spatial.points.get(edge.a)
    const pb = spatial.points.get(edge.b)
    if (!pa || !pb) continue // an endpoint is hidden (mastery / foreign ascendancy)
    const aIn = pa.x >= padded.minX && pa.x <= padded.maxX && pa.y >= padded.minY && pa.y <= padded.maxY
    const bIn = pb.x >= padded.minX && pb.x <= padded.maxX && pb.y >= padded.minY && pb.y <= padded.maxY
    if (!aIn && !bIn) continue

    // Arc centre: export-shipped (shifted with the ascendancy overlay when the edge lives in
    // the selected cluster), else the group centre for same-group same-orbit ring edges.
    let center: { x: number; y: number } | null = null
    const na = graph.nodeById.get(edge.a)!
    const nb = graph.nodeById.get(edge.b)!
    const inSelectedAsc = s.ascDelta !== null && na.ascendancyId !== null && na.ascendancyId === nb.ascendancyId
    if (edge.arcX !== undefined && edge.arcY !== undefined) {
      center = inSelectedAsc
        ? { x: edge.arcX + s.ascDelta!.dx, y: edge.arcY + s.ascDelta!.dy }
        : { x: edge.arcX, y: edge.arcY }
    } else if (na.group === nb.group && na.orbit === nb.orbit && na.orbit > 0) {
      const gc = graph.groupCenters.get(na.group)
      if (gc) center = inSelectedAsc ? { x: gc.x + s.ascDelta!.dx, y: gc.y + s.ascDelta!.dy } : gc
    }

    const geom = edgeGeometry(pa.x, pa.y, pb.x, pb.y, center)
    let target = idlePath
    if (s.allocated.has(edge.a) && s.allocated.has(edge.b)) {
      const tint = edgeWeaponSetTint(edge.a, edge.b, s.weaponSet1, s.weaponSet2)
      target = tint === 'ws1' ? ws1Path : tint === 'ws2' ? ws2Path : allocPath
    }
    target.moveTo(pa.x, pa.y)
    if (geom.kind === 'arc') target.arc(geom.cx, geom.cy, geom.r, geom.a0, geom.a1, geom.anticlockwise)
    else target.lineTo(pb.x, pb.y)
  }
  ctx.lineWidth = Math.max(6, 1.2 / vp.zoom)
  ctx.lineCap = 'round'
  ctx.globalAlpha = 0.9
  ctx.strokeStyle = palette.edgeIdle
  ctx.stroke(idlePath)
  ctx.strokeStyle = palette.edgeAllocated
  ctx.stroke(allocPath)
  ctx.strokeStyle = palette.ws1
  ctx.stroke(ws1Path)
  ctx.strokeStyle = palette.ws2
  ctx.stroke(ws2Path)
  ctx.globalAlpha = 1

  // ── nodes (spatial query = view culling) ──────────────────────────────────────────────────
  const visibleIds = queryRect(spatial, padded)
  const sprites = s.sprites
  const spritesUsable =
    sprites !== null && sprites.skills.loaded && sprites.skillsDisabled.loaded && sprites.frame.loaded

  if (lod === 'dots' || !spritesUsable) {
    const idleDots = new Path2D()
    const allocDots = new Path2D()
    const ws1Dots = new Path2D()
    const ws2Dots = new Path2D()
    const hoverDots = new Path2D()
    for (const id of visibleIds) {
      const p = spatial.points.get(id)!
      const node = graph.nodeById.get(id)!
      const r = nodeRadius(node)
      if (id === s.hovered) addCircle(hoverDots, p.x, p.y, r * 1.2)
      else if (s.allocated.has(id) || (node.decorative && decorLit(id))) {
        const tint = weaponSetTint(id, s.weaponSet1, s.weaponSet2)
        addCircle(tint === 'ws1' ? ws1Dots : tint === 'ws2' ? ws2Dots : allocDots, p.x, p.y, r)
      } else addCircle(idleDots, p.x, p.y, r)
    }
    ctx.fillStyle = palette.dotIdle
    ctx.fill(idleDots)
    ctx.fillStyle = palette.dotAllocated
    ctx.fill(allocDots)
    ctx.fillStyle = palette.ws1
    ctx.fill(ws1Dots)
    ctx.fillStyle = palette.ws2
    ctx.fill(ws2Dots)
    ctx.fillStyle = palette.hover
    ctx.fill(hoverDots)
  } else {
    // Weapon-set rings collect into one batch per set (same no-per-node-stroke bar as edges).
    const ws1Rings = new Path2D()
    const ws2Rings = new Path2D()
    let wsRingCount = 0

    // ── conqueror (Timeless Jewel) node-icon override — precompute the in-radius sockets ──────────
    // Each radius jewel that names a conqueror faction (info.version) recolours the NODE ART of every
    // in-radius small/notable/keystone to that faction's art. The SET of affected nodes is exact
    // geometry (same distance test as the conqueror tint block); the chosen art is one-per-(faction,
    // kind) — NOT the exact per-seed art (deferred, see docs/atlas-background-art.md). First matching
    // socket wins, mirroring the tint block. Resolved once per frame to keep the node loop cheap.
    const conquerorIcons = s.jewelSockets?.size ? (s.conquerorIcons ?? loadConquerorIcons()) : null
    const conquerorDiscs =
      conquerorIcons?.loaded && s.jewelSockets
        ? collectRadii(
            s.jewelSockets,
            (id) => graph.nodeById.get(id),
            (info) => info.version ?? null,
          )
        : []
    /** The conqueror node-art rect for an in-radius node, or null (not in radius / no faction art).
     *  First matching socket WITH art wins, so we fall through sockets whose (faction,kind) has no
     *  replacement art — hence the explicit loop rather than a plain firstRadiusAt. */
    const conquerorRectFor = (node: TreeNode, px: number, py: number): AtlasRect | null => {
      if (!conquerorIcons || conquerorDiscs.length === 0) return null
      for (const d of conquerorDiscs) {
        if (!inDisc(d, px, py)) continue
        const rect = conquerorIconRect(conquerorIcons, d.data, node.kind)
        if (rect) return rect
      }
      return null
    }

    // Genesis "can-allocate" set: unallocated nodes adjacent to an allocated node, plus every
    // unallocated Womb (a free root you can always take) — drives the per-state Breach frame art.
    let genesisReachable: Set<string> | null = null
    if (s.genesisFrames && s.atlasIcons?.loaded) {
      genesisReachable = new Set<string>()
      for (const allocId of s.allocated) {
        for (const nb of graph.adjacency.get(allocId) ?? []) if (!s.allocated.has(nb)) genesisReachable.add(nb)
      }
      for (const n of graph.nodeById.values()) if (n.iconUncropped && !s.allocated.has(n.id)) genesisReachable.add(n.id)
    }

    for (const id of visibleIds) {
      const p = spatial.points.get(id)!
      const node = graph.nodeById.get(id)!
      const isAlloc = s.allocated.has(id)
      const isHover = id === s.hovered
      const tint = isAlloc ? weaponSetTint(id, s.weaponSet1, s.weaponSet2) : 'none'
      if (tint !== 'none') {
        addCircle(tint === 'ws1' ? ws1Rings : ws2Rings, p.x, p.y, NODE_WORLD_RADIUS[node.kind] * 1.25)
        wsRingCount++
      }

      if (node.kind === 'classStart') {
        // No vendored class-art atlas — a token-coloured ring marks the start position.
        const own =
          s.classIndex !== null && node.classStartIndex !== null && node.classStartIndex.includes(s.classIndex)
        ctx.beginPath()
        ctx.arc(p.x, p.y, NODE_WORLD_RADIUS.classStart, 0, Math.PI * 2)
        ctx.lineWidth = 10
        ctx.strokeStyle = own ? palette.edgeAllocated : palette.startRing
        ctx.stroke()
        continue
      }

      let drew = false
      // atlas-tree nodes carry a .dds icon path resolved by the dedicated atlas-icon sheet;
      // character-tree nodes fall through to the TexturePacker skills sheets below.
      const atlasRect = s.atlasIcons?.loaded ? s.atlasIcons.rects[node.icon] : undefined
      if (atlasRect && node.iconUncropped) {
        // Genesis WOMB start socket: the vertical egg/nest with a square item-slot hole. Draw the olive
        // item slot FIRST (it shows through the egg's transparent square), then the egg art UNCROPPED on
        // top, per allocation state (active / can-allocate / normal — the egg itself glows when active).
        const reachable = genesisReachable?.has(id) ?? false
        const wombKey = s.genesisWomb
          ? isAlloc
            ? s.genesisWomb.active
            : reachable
              ? s.genesisWomb.canallocate
              : s.genesisWomb.normal
          : node.icon
        const eggRect = (s.genesisWomb && s.atlasIcons!.rects[wombKey]) || atlasRect
        // draw at the egg's NATIVE aspect (it is taller than wide — never squashed to a square)
        const eggH = nodeRadius(node) * ATLAS_ICON_FILL * 2.5
        const eggW = eggH * (eggRect.w / eggRect.h)
        // 1) item-input slot, behind, EXACTLY over the egg's square hole. Measured on the 4k egg
        //    (324×496): hole x[110,242] y[160,296] vs art centre (162,248) → centre +0.04·W, −0.04·H;
        //    size 0.41·W × 0.27·H (the dest hole is ~square since the egg is drawn taller-than-wide).
        drawWombSlot(
          ctx,
          p.x + eggW * 0.04,
          p.y - eggH * 0.04,
          eggW * 0.41,
          eggH * 0.27,
          palette.wombFill,
          palette.wombRim,
        )
        // 2) the egg socket on top
        ctx.save()
        ctx.globalAlpha = isAlloc || isHover || reachable ? 1 : 0.78
        ctx.drawImage(
          s.atlasIcons!.img,
          eggRect.x,
          eggRect.y,
          eggRect.w,
          eggRect.h,
          p.x - eggW / 2,
          p.y - eggH / 2,
          eggW,
          eggH,
        )
        ctx.restore()
        drew = true
      } else if (atlasRect) {
        // round + frame-filling: clip the square art to a circle (no corners) and cover-size it to
        // the frame opening; the ornate frame (drawn on top at full LOD) finishes the rim. With the
        // Breach frames on (Genesis), the icon sits SMALLER inside the frame's transparent opening.
        const ir = nodeRadius(node) * (s.genesisFrames ? GENESIS_ICON_FILL : ATLAS_ICON_FILL)
        const litDecor = node.decorative === true && decorLit(id) // hub lit by its cluster
        if (litDecor) {
          // illuminate the hub: a soft gold glow behind the icon once any cluster node is taken
          ctx.save()
          ctx.globalAlpha = 0.4
          ctx.fillStyle = palette.dotAllocated
          ctx.beginPath()
          ctx.arc(p.x, p.y, ir * 1.3, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
        // dim unallocated/unlit
        drawCircleClipped(ctx, s.atlasIcons!.img, atlasRect, p.x, p.y, ir, isAlloc || isHover || litDecor ? 1 : 0.55)
        drew = true
      } else {
        // Phase 2C — conqueror node-art override: an in-radius node inside a faction radius jewel
        // takes that faction's art (clipped to a circle like the atlas-icon path). This REPLACES the
        // base/override skills-sheet icon, mirroring the in-game tree. One-art-per-(faction,kind).
        const cqRect = conquerorRectFor(node, p.x, p.y)
        if (cqRect) {
          const ir = NODE_WORLD_RADIUS[node.kind] * ATLAS_ICON_FILL
          // dim unallocated, like the disabled skills sheet
          drawCircleClipped(ctx, conquerorIcons!.img, cqRect, p.x, p.y, ir, isAlloc || isHover ? 1 : 0.55)
          drew = true
        } else {
          // Phase 3C — route the icon through resolveNode so an overridden class/ascendancy node
          // draws ITS override icon (no-op when class/ascendancy is unknown). The node's KIND is
          // unchanged by an override; only the icon (and stats, in the tooltip) differ.
          const resolved = resolveNode(graph, node, s.classIndex, s.ascendancyId)
          const iconBase = iconKeyForKind(node.kind, resolved.icon)
          if (iconBase) {
            drew =
              isAlloc || isHover
                ? drawSprite(ctx, sprites!.skills, iconBase.replace(':', 'Active:'), p.x, p.y)
                : drawSprite(ctx, sprites!.skillsDisabled, iconBase.replace(':', 'Inactive:'), p.x, p.y)
          }
        }
      }
      if (s.genesisFrames && s.atlasIcons?.loaded && !node.iconUncropped) {
        // Genesis: the authentic Breach ring frame per allocation state (active / can-allocate / normal),
        // in the `fancy` (bigger, ornate) style for notables and the `small` style for regular nodes.
        // (The Womb sockets are their own egg art with no ring frame — fully drawn in the icon branch above.)
        const set = node.kind === 'notable' ? s.genesisFrames.fancy : s.genesisFrames.small
        const reachable = genesisReachable?.has(id) ?? false
        const key = isAlloc ? set.active : reachable ? set.canallocate : set.normal
        const rect = s.atlasIcons.rects[key]
        if (rect) {
          const fr = nodeRadius(node) * GENESIS_FRAME_FILL
          ctx.save()
          ctx.globalAlpha = isAlloc || isHover || reachable ? 1 : 0.7
          ctx.drawImage(s.atlasIcons.img, rect.x, rect.y, rect.w, rect.h, p.x - fr, p.y - fr, fr * 2, fr * 2)
          ctx.restore()
        }
      } else if (lod === 'full' && !node.iconUncropped) {
        const fk = frameKeyFor(node, isAlloc, isHover)
        if (fk) drew = drawSprite(ctx, sprites!.frame, fk, p.x, p.y) || drew
      }
      if (!drew) {
        // No sprite resolved (e.g. jewel icon is a blank) — token dot keeps the node visible.
        ctx.beginPath()
        ctx.arc(p.x, p.y, NODE_WORLD_RADIUS[node.kind], 0, Math.PI * 2)
        ctx.fillStyle = isAlloc
          ? tint === 'ws1'
            ? palette.ws1
            : tint === 'ws2'
              ? palette.ws2
              : palette.dotAllocated
          : isHover
            ? palette.hover
            : palette.dotIdle
        ctx.fill()
      }
    }
    if (wsRingCount > 0) {
      ctx.lineWidth = Math.max(6, 1.5 / vp.zoom)
      ctx.strokeStyle = palette.ws1
      ctx.stroke(ws1Rings)
      ctx.strokeStyle = palette.ws2
      ctx.stroke(ws2Rings)
    }
  }

  // ── passive-tree central ring: drawn ABOVE nodes so the ornaments wrap the class-start frames ─
  if (s.showCentralArt && pb?.loaded && s.classIndex !== null) {
    const half = pb.ringSize / 2
    const active = pb.frames['startNode:MainCircleActive']
    const normal = pb.frames['startNode:MainCircle']
    // Active highlight is baked at the Witch (top) position — rotate it to the selected class.
    if (active) {
      ctx.save()
      ctx.rotate(pb.ringRotation[s.classIndex] ?? 0)
      ctx.drawImage(pb.img, active.x, active.y, active.w, active.h, -half, -half, pb.ringSize, pb.ringSize)
      ctx.restore()
    }
    if (normal) ctx.drawImage(pb.img, normal.x, normal.y, normal.w, normal.h, -half, -half, pb.ringSize, pb.ringSize)
  }

  // ── jewel-socket radius rings: a fixed-radius circle around each socket holding a radius jewel ─
  const jw = s.jewels
  if (s.jewelSockets?.size) {
    // socketed-jewel art sheets (resolved once per frame): the unique's own icon atlas and the
    // base-item icon atlas. The mount may pass the unique sheet via SceneState; if not, lazily load
    // the shared singleton here so jewel art works without any mount wiring. The base atlas is
    // always self-loaded (items/icons.ts owns the table, not a canvas-ready Image).
    const uniqueSheet = s.uniqueIcons ?? loadUniqueIcons()
    const baseAtlas = loadBaseIconAtlas()
    // conqueror tint — every node inside a radius jewel glows in the faction colour (the in-game
    // "Conquered by X" cue). The SET of in-radius nodes is exact geometry; the colour is decorative.
    // Additive ('lighter') as a soft halo so it tints without hiding the node icon. Shown whenever a
    // radius jewel is socketed — INDEPENDENT of the decorative bg-art toggle, since which passives a
    // jewel affects is functional info. (The exact per-node art/stat transformation is a separate,
    // deferred feature — it needs GGG's seeded RNG ported + validated in-game.)
    {
      // Prefer the token-driven faction tint (palette.factionTint[version], or the generic no-faction
      // token) so a theme can retone it; fall back to the curated hex baked on the ring (jewelSockets.ts).
      // Only radius jewels carry a ring, so a null ring still maps to null (no glow), unchanged.
      const tintDiscs = collectRadii(
        s.jewelSockets,
        (id) => graph.nodeById.get(id),
        (info) =>
          info.ring
            ? ((info.version ? palette.factionTint[info.version] : palette.factionTintGeneric) ?? info.ring.tint)
            : null,
      )
      if (tintDiscs.length) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        for (const id of visibleIds) {
          const p = spatial.points.get(id)
          if (!p) continue
          const node = graph.nodeById.get(id)
          if (!node || node.kind === 'jewel' || node.kind === 'mastery' || node.kind === 'classStart') continue
          const tint = firstRadiusAt(tintDiscs, p.x, p.y) // first matching jewel wins
          if (!tint) continue
          const gr = NODE_WORLD_RADIUS[node.kind] * 2.2
          const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, gr)
          grad.addColorStop(0, hexA(tint, 0.12))
          grad.addColorStop(0.55, hexA(tint, 0.34))
          grad.addColorStop(1, hexA(tint, 0))
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.arc(p.x, p.y, gr, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      }
    }
    const spin = ((s.time ?? 0) / JEWEL_SPIN_PERIOD_MS) * Math.PI * 2
    for (const [nodeId, info] of s.jewelSockets) {
      const node = graph.nodeById.get(nodeId)
      if (!node) continue
      // radius rings — two counter-rotating layers. Shown whenever a radius jewel is socketed,
      // INDEPENDENT of the decorative bg-art toggle (the ring is functional — it shows the jewel's
      // reach). A RING (annulus) jewel draws BOTH its outer and inner boundary circle (the two circles
      // the game shows); a disc jewel draws just the one.
      const ring = info.ring
      if (jw?.loaded && ring) {
        const onScreen = isRectVisible(padded, node.x, node.y, ring.diameter / 2)
        if (onScreen) {
          ctx.globalAlpha = JEWEL_RING_ALPHA
          const diameters = ring.innerDiameter ? [ring.diameter, ring.innerDiameter] : [ring.diameter]
          for (const dia of diameters) {
            const h = dia / 2
            for (const [key, dir] of [
              [ring.frameA, 1],
              [ring.frameB, -1],
            ] as const) {
              const fr = jw.frames[key]
              if (!fr) continue
              ctx.save()
              ctx.translate(node.x, node.y)
              ctx.rotate(spin * dir)
              ctx.drawImage(jw.img, fr.x, fr.y, fr.w, fr.h, -h, -h, dia, dia)
              ctx.restore()
            }
          }
          ctx.globalAlpha = 1
        }
      }
      // socketed-jewel art — resolved in PRIORITY ORDER (never wrong art):
      //   (1) the unique's OWN icon (unique-icons atlas, keyed by lowercased name) — no rarity
      //       suppression: this IS the jewel's art, so show it for every rarity.
      //   (2) the base-type icon (item-icon atlas) — exact for non-unique jewels.
      //   (3) the coloured gem dot — last resort, signals "a jewel is socketed here".
      // Art draws at ~2*NODE_WORLD_RADIUS.jewel, clipped to a circle (square corners off, like the
      // atlas-icon node path); gated on-screen + above the dots LOD (zoomed-out tree stays dots).
      const ar = NODE_WORLD_RADIUS.jewel // art circle radius (≈ half the ~2r tile)
      const onScreenArt = isRectVisible(padded, node.x, node.y, ar)
      let drewArt = false
      if (onScreenArt && lod !== 'dots') {
        // (1) unique art
        const ui = uniqueSheet?.loaded ? uniqueSheet.rects[info.name.toLowerCase()] : undefined
        // (2) base art (only if no unique art) — iconForBase returns null for unknown/unique-only bases
        const baseRect = !ui && baseAtlas?.loaded && info.baseType ? iconForBase(info.baseType) : null
        const src = ui ? { img: uniqueSheet!.img, rect: ui } : baseRect ? { img: baseAtlas!.img, rect: baseRect } : null
        if (src) {
          const { rect } = src
          // contain the (possibly non-square) tile inside the art circle, preserving aspect ratio
          const fit = (2 * ar) / Math.max(rect.w, rect.h)
          const dw = rect.w * fit
          const dh = rect.h * fit
          ctx.save()
          ctx.beginPath()
          ctx.arc(node.x, node.y, ar, 0, Math.PI * 2)
          ctx.clip()
          ctx.drawImage(src.img, rect.x, rect.y, rect.w, rect.h, node.x - dw / 2, node.y - dh / 2, dw, dh)
          ctx.restore()
          drewArt = true
        }
      }
      // (3) filled "gem" dot — last resort; always shown when no art resolved + in view
      if (!drewArt) {
        const gr = NODE_WORLD_RADIUS.jewel * 0.6
        if (isRectVisible(padded, node.x, node.y, gr)) {
          ctx.beginPath()
          ctx.arc(node.x, node.y, gr, 0, Math.PI * 2)
          ctx.fillStyle = palette.dotAllocated
          ctx.fill()
        }
      }
    }
  }

  // ── search highlight rings ────────────────────────────────────────────────────────────────
  if (s.searchMatches.size > 0) {
    const ringPath = new Path2D()
    for (const id of visibleIds) {
      if (!s.searchMatches.has(id)) continue
      const p = spatial.points.get(id)!
      const node = graph.nodeById.get(id)!
      const r = NODE_WORLD_RADIUS[node.kind] * 1.5
      addCircle(ringPath, p.x, p.y, r)
    }
    ctx.lineWidth = Math.max(8, 2 / vp.zoom)
    ctx.strokeStyle = palette.search
    ctx.stroke(ringPath)
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)
}
