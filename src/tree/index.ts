// B1 — public API of the interactive passive tree: mountTree() + the toolbar fragment.
// Owns all mutable view state (viewport, allocation, hover, search) and the dirty-flag
// render loop (one rAF per invalidation — zero idle CPU); rendering, math, and allocation
// logic live in the sibling modules.

import './tree.css'
import { escapeHtml } from '../ui/escapeHtml'
import { rarityKey, poeTierVars } from '../ui/rarity'
import { copy } from '../copy'
import { loadGraph, blockedNodeIds, ascendancyOverlayDelta, resolveNode } from './graph'
import type { TreeGraph, TreeNode, NodeKind } from './graph'

export { buildGraph } from './graph'
export type { TreeGraph, RawTreeGraph, TreeNode } from './graph'
import { fitToBounds, worldToScreen } from './viewport'
import type { Viewport, Size, WorldRect } from './viewport'
import { buildSpatialIndex, nodeAt } from './spatial'
import type { SpatialIndex, SpatialPoint } from './spatial'
import {
  renderScene,
  loadSprites,
  unloadSprites,
  loadAtlasIcons,
  loadGenesisIcons,
  loadGenesisBg,
  loadAtlasBg,
  loadPassiveBg,
  loadPassiveMastery,
  loadJewelRadius,
  resolvePalette,
  weaponSetTint,
  NODE_WORLD_RADIUS,
} from './render'
import type {
  AtlasIconSheet,
  AtlasBgSheet,
  AtlasBgPanel,
  PassiveBgSheet,
  MasterySheet,
  JewelSheet,
  JewelInfo,
  GenesisFrameStates,
} from './render'
import type { SpriteSheets, Palette } from './render'
import { attachInteractions, allocateNode, deallocateNode, MAX_ZOOM } from './interact'
import type { GateContext } from './interact'
import { collectRadii, firstRadiusAt } from './jewelRadius'

export interface TreeBuild {
  classNodeIds?: never
  /** Numeric tree ids as strings (same id space as PoB spec.nodes). */
  allocated: Iterable<string>
  ascendancyId?: string | null
  classIndex?: number | null
  /** PoB weapon-set memberships: allocated nodes only in set 1 (resp. 2) render tinted
   *  (greenish/reddish); a node in BOTH sets is shared and keeps the normal colour. */
  weaponSet1?: Iterable<string>
  weaponSet2?: Iterable<string>
  /** Socket node id -> socketed-jewel info (name + stats for the tooltip, optional radius ring). */
  jewels?: ReadonlyMap<string, JewelInfo>
  /** Generic attribute-of-choice node id -> the exact attribute the player picked in PoB
   *  ("Strength" | "Dexterity" | "Intelligence"); shown in that node's tooltip. Empty/omitted
   *  when the build set none. */
  attributeChoices?: ReadonlyMap<string, string>
  /** Atlas "Select a bonus" mastery picks: node id -> chosen option index (into node.choices). */
  masteryChoices?: ReadonlyMap<string, number>
}

export interface TreeView {
  setBuild(b: TreeBuild): void
  getAllocated(): ReadonlySet<string>
  /** Atlas mastery bonus picks (node id -> chosen option index) for serialisation. */
  getMasteryChoices(): ReadonlyMap<string, number>
  /**
   * Allocated POINT split for the caps badge. `main` = main-tree points USED: shared nodes plus the
   * weapon-set overlap — weapon-set passives are part of the main pool but SHARE point slots between
   * the two sets (one specialised point holds a Set-I node AND a Set-II node), so cost is
   * `shared + max(ws1, ws2)`. `asc` = ascendancy points. START nodes and IsFree nodes (e.g. Sacred
   * Unity) cost nothing and are excluded. `available` = PASSIVE_CAP (the level-100 max) + any
   * grantedPassivePoints — always the level-100 max, so a legal build never reads over. `over` = main
   * exceeds available. `ws1`/`ws2` = nodes specialised to weapon set I / II (each shown as X/24).
   */
  getCounts(): { main: number; asc: number; available: number; over: boolean; ws1: number; ws2: number }
  /** The selected ascendancy id (null when none) — drives the "M/8 asc" badge visibility. */
  getAscendancyId(): string | null
  /**
   * Programmatic USER edit — exactly a canvas tap: BFS auto-path on allocate, cascade on
   * deallocate, pushes undo history, fires onChange. No-op in viewerOnly mode.
   */
  toggle(id: string): void
  /** Undo the last user edit. Returns false when the undo stack is empty. Fires onChange. */
  undo(): boolean
  /** Redo the last undone user edit. Returns false when the redo stack is empty. Fires onChange. */
  redo(): boolean
  canUndo(): boolean
  canRedo(): boolean
  destroy(): void
  focusSearch(q: string): void
  /** Refit the camera to the main tree. */
  fit(): void
  /** Force a redraw (e.g. after mutating an externally-held bgPanels entry). */
  redraw(): void
  /** Show/hide the atlas background art (facade + subtree panels); caller persists the choice. */
  setBgVisible(visible: boolean): void
  /** Ids passed to setBuild that do not exist in the vendored tree graph. */
  getMissing(): readonly string[]
  /** Notified on every allocation change (user edits AND setBuild). Returns unsubscribe. */
  subscribe(fn: (allocated: ReadonlySet<string>) => void): () => void
}

export interface MountTreeOptions {
  /** Called after USER-driven allocation changes only (setBuild does not re-trigger it). */
  onChange?: (allocated: ReadonlySet<string>) => void
  /** Render this graph instead of the vendored character tree (e.g. the atlas graph). */
  graph?: TreeGraph
  /** Read-only mode: hover/tooltip/search/pan/zoom work, click never (de)allocates. */
  viewerOnly?: boolean
  /** Accessible label for the `<canvas role="img">` — per tree (passive / atlas / genesis). The
   *  detailed text alternative is the allocated-stats panel / breakdown list beside each canvas. */
  ariaLabel?: string
  /**
   * Extra free allocation roots, unioned with the class/ascendancy starts. Graphs without
   * class starts (the atlas tree seeds its 6 atlasRoot nodes here) stay editable: BFS can
   * only ever reach nodes connected to a seed, so unreachable nodes stay unallocatable.
   */
  seedIds?: readonly string[]
  /**
   * ALLOCATABLE ROOTS (Genesis wombs): free-standing nodes the player can allocate DIRECTLY (no path)
   * and also deallocate (cascading their subtree) — unlike `seedIds`, which are always-on and never
   * removable. Not added to the allocation by default; the player chooses which to take.
   */
  rootIds?: readonly string[]
  /** Load + draw the atlas-tree icon sheet (atlas nodes carry .dds icon paths). */
  atlasIcons?: boolean
  /** Load + draw the Genesis-tree icon sheet (same render path as atlasIcons, different sheet). */
  genesisIcons?: boolean
  /** Draw the authentic Breach node FRAME art around each Genesis node (per allocation state). Two ring
   *  styles — `small` (regular nodes) + `fancy` (notables). Values are dds-path keys into the Genesis
   *  icon sheet (see GENESIS_FRAME_PATHS). */
  genesisFrames?: { small: GenesisFrameStates; fancy: GenesisFrameStates }
  /** The Genesis Womb socket art (egg + square item-slot hole), per allocation state — drawn for the
   *  uncropped Womb start nodes. dds-path keys into the Genesis icon sheet (see GENESIS_WOMB_PATHS). */
  genesisWomb?: { normal: string; canallocate: string; active: string }
  /** The Genesis background facade placement (an AtlasBgPanel — world cx/cy + size/sizeY + alpha) — its
   *  image is loaded internally. Data-driven (see genesisFacade); the _workbench/dev/calib/ tool is an emergency fallback. */
  genesisBg?: AtlasBgPanel
  /** Per-subtree background panels (+ facade) to draw behind the atlas tree (loads the art when set). */
  bgPanels?: readonly AtlasBgPanel[]
  /** Draw the central class/ascendancy art + ring behind the character tree (loads the art when set). */
  centralArt?: boolean
  /** Replace a node's tooltip with custom HTML (a full itc-card string). Return null to fall back to the
   *  default tooltip. Used by Genesis to show the Wombgift crafting reference on the 5 womb keystones. */
  tooltipOverride?: (node: TreeNode) => string | null
}

// Allocation caps. The NODES badge always shows used / MAX-AT-LEVEL-100 (the most points a character
// can ever have), so a legal build never reads over-cap. PASSIVE_CAP = 99 (from levels at L100) + 24
// (all quest rewards) = 123. ASCENDANCY_CAP = 8 (all ascension trials). WEAPON_SET_CAP = the weapon-set
// passive points available PER weapon set; weapon-set points come OUT OF the main pool but are also
// tracked per-set (their own X/24 badge).
export const PASSIVE_CAP = 123
export const ASCENDANCY_CAP = 8
export const WEAPON_SET_CAP = 24

/** Main-tree passive POINTS used. Weapon-set passives are PART of the main pool but SHARE point slots
 *  between the two sets — one specialised point holds a Set-I node AND a Set-II node — so the cost is
 *  `shared + max(ws1, ws2)`, not `shared + ws1 + ws2`. Verified vs PoB (92 + max(24,23) = 116). */
export function mainPointsUsed(shared: number, ws1: number, ws2: number): number {
  return shared + Math.max(ws1, ws2)
}
/** Main-pool budget = the level-100 max (PASSIVE_CAP) plus any grantedPassivePoints an allocated node
 *  grants. The badge always shows the level-100 max as the denominator (not the current-level budget),
 *  so used <= available holds for every legal build regardless of the character's level. */
export function availablePoints(granted: number): number {
  return PASSIVE_CAP + granted
}

const FIT_PADDING_RATIO = 0.06 // cvenzin INITIAL_FIT_PADDING
const SEARCH_MAX_ZOOM = 2.5 // cvenzin search camera cap
const HISTORY_CAP = 100 // user-edit undo depth; oldest snapshots fall off
const MAX_DPR = 2 // cap the canvas backing store on hi-DPI (Addendum §G — bound per-frame fill cost)

const KIND_LABEL: Record<NodeKind, string> = copy.tree.kindLabel as Record<NodeKind, string>
// itc-card tiering for a bare tree node (a socketed jewel tiers by rarity via poeTierVars()). `vars` is
// the inline --itc-tier hue + rgb; `cls` is the fork's rarity class that keeps the name AA-readable
// on the dark card face (only the dim unique-orange needs the brighter .itc-r-unique treatment).
// Colour as information: unique-orange = keystone, accent = notable, grey = small, info-blue = socket.
const ACCENT_TIER = { vars: '--itc-tier: var(--accent); --itc-tier-rgb: var(--accent-rgb);', cls: '' }
const KIND_TIER: Record<NodeKind, { vars: string; cls: string }> = {
  small: { vars: poeTierVars('normal'), cls: '' },
  notable: ACCENT_TIER,
  keystone: { vars: poeTierVars('unique'), cls: 'itc-r-unique' },
  mastery: ACCENT_TIER,
  jewel: { vars: '--itc-tier: var(--status-info); --itc-tier-rgb: var(--status-info-rgb);', cls: '' },
  ascStart: ACCENT_TIER,
  classStart: ACCENT_TIER,
}

export function mountTree(container: HTMLElement, opts: MountTreeOptions = {}): TreeView {
  const graph = opts.graph ?? loadGraph()
  const viewerOnly = opts.viewerOnly === true

  // Phase 4 — allocation-legality context for USER TOGGLES ONLY (interact.ts stays graph-agnostic;
  // it reads only these small derived maps). The maps are immutable view of the graph, so this is
  // built once. mcParentOf is the reverse of mcGroups: a node's own mcParent group key (the parent
  // node id). setBuild deliberately does NOT pass this — PoB is the source of truth and an imported
  // node must never be stripped by a gate (getMissing already tolerates unknown ids).
  const rootSet = new Set((opts.rootIds ?? []).filter((id) => graph.nodeById.has(id)))
  const gateContext: GateContext = {
    unlockGates: graph.unlockGates,
    gateDependents: graph.gateDependents,
    mcGroups: graph.mcGroups,
    mcParentOf: (id) => graph.nodeById.get(id)?.mcParent ?? null,
    roots: rootSet, // Genesis wombs: allocatable + deallocatable free roots (empty for atlas/character)
  }

  const wrapper = document.createElement('div')
  wrapper.className = 'tree-view'
  wrapper.innerHTML = `<canvas class="tree-canvas" role="img"></canvas><div class="tree-tip" role="tooltip" hidden></div>`
  container.appendChild(wrapper)
  const canvas = wrapper.querySelector<HTMLCanvasElement>('.tree-canvas')!
  canvas.setAttribute('aria-label', opts.ariaLabel ?? 'Passive skill tree') // role=img alt text (per tree)
  const tip = wrapper.querySelector<HTMLDivElement>('.tree-tip')!
  const ctx = canvas.getContext('2d') // null in jsdom — the view degrades to logic-only
  // Interactive-tooltip bookkeeping: which node the tip is showing (for choice clicks) + a forgiving
  // hide delay so the cursor can travel from the node into an interactive (choice) tooltip without it
  // closing mid-cross. Generous on purpose — the only cost of a long delay is the tip lingering a beat
  // after you leave; the timer re-arms on every move, so it only fires if the cursor PAUSES in the gap.
  let tipNodeId: string | null = null
  let tipHideTimer: ReturnType<typeof setTimeout> | null = null
  // PINNED mode (touch): touch has no hover, so a tap on a chooser opens its option picker as a
  // sticky popover that stays until an option/Remove/Close is tapped or the user taps outside it.
  let tipPinned = false
  const TIP_HIDE_DELAY_MS = 450
  const cancelTipHide = (): void => {
    if (tipHideTimer !== null) {
      clearTimeout(tipHideTimer)
      tipHideTimer = null
    }
  }
  const hideTip = (): void => {
    cancelTipHide()
    tip.hidden = true
    tip.classList.remove('is-interactive', 'is-pinned')
    tipNodeId = null
    tipPinned = false
  }
  // Keep an interactive tooltip open while the cursor is inside it; a click on a numbered option
  // row picks that bonus for the mastery the tooltip is showing. The Close/Remove rows only exist in
  // the PINNED (touch) picker — they give touch the dismiss + deallocate that tap-to-open replaced.
  tip.addEventListener('pointerenter', () => {
    if (!tipPinned) cancelTipHide() // a hover bridge only matters for the non-pinned (mouse) tip
  })
  tip.addEventListener('pointerleave', () => {
    if (!tipPinned) hideTip()
  })
  tip.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement
    if (t.closest('[data-tip-close]')) return hideTip()
    if (t.closest('[data-tip-remove]')) {
      if (tipNodeId !== null) toggle(tipNodeId) // deallocate the chooser (pruneChoices drops its pick)
      return hideTip()
    }
    const btn = t.closest<HTMLElement>('[data-choice]')
    if (!btn || tipNodeId === null) return
    pickMasteryChoice(tipNodeId, Number(btn.dataset.choice))
  })
  // Tap anywhere OUTSIDE a pinned picker closes it (touch's click-away — alongside the Close button and
  // Escape). Capture-phase + no preventDefault so a pan that starts on the canvas still pans; it just
  // also dismisses the picker. No-op unless pinned. (Re-tapping the node simply re-opens the picker —
  // it sits at the node's bottom-right and never covers it, so the tap reaches the canvas.)
  const onDocPointerDown = (ev: PointerEvent): void => {
    if (tipPinned && !(ev.target instanceof Node && tip.contains(ev.target))) hideTip()
  }
  document.addEventListener('pointerdown', onDocPointerDown, true)

  // ── mutable view state ─────────────────────────────────────────────────────────────────
  let size: Size = { width: 0, height: 0 }
  let dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
  let vp: Viewport | null = null
  let minZoom = 0.01
  let allocated = new Set<string>()
  // Atlas "Select a bonus" masteries: node id -> chosen option index (into node.choices). Picked
  // from the interactive tooltip; serialised alongside the allocation. Invariant: a choice only
  // exists for a CURRENTLY-allocated node — deallocating the mastery (or orphaning it in a cascade)
  // drops its pick, so re-allocating starts unchosen. Enforced by pruneChoices() after every edit.
  let masteryChoice = new Map<string, number>()
  let weaponSet1 = new Set<string>()
  let weaponSet2 = new Set<string>()
  let jewelSockets: ReadonlyMap<string, JewelInfo> = new Map()
  // Generic attribute-of-choice node id -> the attribute PoB recorded for it (tooltip label only).
  let attributeChoices: ReadonlyMap<string, string> = new Map()
  // Phase 2C/3C tooltip layer — per-affected-node context derived from the socketed radius jewels,
  // by EXACT geometry (the same distance test + first-socket-wins precedence the renderer and the
  // converter use; one source of truth = the JewelInfo data). conquerorVersionByNode names the
  // faction conquering a node (drives the one-art-per-faction simplification, NOT seed-RNG art);
  // timeLostSwapByNode holds a Time-Lost Diamond's stated deterministic attribute swap. Rebuilt on
  // each setBuild; empty when no conqueror / Time-Lost radius jewel is socketed.
  let conquerorVersionByNode: ReadonlyMap<string, string> = new Map()
  let timeLostSwapByNode: ReadonlyMap<string, { from: string; to: string }> = new Map()
  let animating = false // continuous redraw while spinning radius rings are present
  // User-edit history. Snapshots are the immutable previous `allocated` sets (every change
  // replaces the set, never mutates it), so storing references is safe and copy-free.
  let undoStack: Array<Set<string>> = []
  let redoStack: Array<Set<string>> = []
  let missing: string[] = []
  let ascendancyId: string | null = null
  let classIndex: number | null = null
  let ascDelta: { dx: number; dy: number } | null = null
  let hovered: string | null = null
  let searchMatches = new Set<string>()
  let spatial: SpatialIndex = buildSpatialIndex([])
  let bgVisible = true
  let destroyed = false
  let rafPending = false
  const subscribers = new Set<(a: ReadonlySet<string>) => void>()

  // Token-driven palette, read once at mount and re-read on a theme switch (gold ↔ silver) so the
  // already-mounted Canvas2D tree recolours in place — resolvePalette pulls the new CSS custom
  // properties; each draw() reads the current `palette` binding. (DOM/CSS chrome recolours itself.)
  let palette: Palette = resolvePalette(wrapper)
  const onThemeChange = (): void => {
    palette = resolvePalette(wrapper)
    invalidate()
  }
  window.addEventListener('poe2:themechange', onThemeChange)
  const onSpritesReady = (): void => invalidate()
  const sprites: SpriteSheets = loadSprites(onSpritesReady)
  // One icon-sheet slot for the renderer: the atlas sheet or the Genesis sheet (mutually exclusive).
  const atlasIcons: AtlasIconSheet | null = opts.atlasIcons
    ? loadAtlasIcons()
    : opts.genesisIcons
      ? loadGenesisIcons()
      : null
  const atlasBg: AtlasBgSheet | null = opts.bgPanels?.length ? loadAtlasBg() : null
  const passiveBg: PassiveBgSheet | null = opts.centralArt ? loadPassiveBg() : null
  const mastery: MasterySheet | null = opts.centralArt ? loadPassiveMastery() : null
  const jewelSheet: JewelSheet | null = opts.centralArt ? loadJewelRadius() : null

  // ── derived state helpers ──────────────────────────────────────────────────────────────
  function displayPoints(): SpatialPoint[] {
    const pts: SpatialPoint[] = []
    for (const node of graph.nodeById.values()) {
      if (node.kind === 'mastery') continue // PoE2 leftovers — pure decoration, never shown
      if (node.ascendancyId) {
        if (node.ascendancyId !== ascendancyId || !ascDelta) continue // foreign cluster hidden
        pts.push({ id: node.id, x: node.x + ascDelta.dx, y: node.y + ascDelta.dy })
      } else {
        pts.push({ id: node.id, x: node.x, y: node.y })
      }
    }
    return pts
  }

  function rebuildSpatial(): void {
    spatial = buildSpatialIndex(displayPoints())
  }
  rebuildSpatial()

  // Rebuild the per-node conqueror/Time-Lost maps from the socketed radius jewels. Geometry mirrors
  // the renderer exactly: half = ring.diameter / 2, squared-distance test, first matching socket
  // wins; only small/notable/keystone are conquered (masteries/jewels/starts keep their own art).
  function rebuildJewelNodeMaps(): void {
    const versions = new Map<string, string>()
    const swaps = new Map<string, { from: string; to: string }>()
    // one source of truth for the radius geometry (tree/jewelRadius.ts); version + swap are tracked
    // independently so a node can take its faction from one socket and a Time-Lost swap from another.
    const versionDiscs = collectRadii(
      jewelSockets,
      (id) => graph.nodeById.get(id),
      (info) => info.version ?? null,
    )
    const swapDiscs = collectRadii(
      jewelSockets,
      (id) => graph.nodeById.get(id),
      (info) => info.swap ?? null,
    )
    if (versionDiscs.length || swapDiscs.length) {
      for (const node of graph.nodeById.values()) {
        if (node.kind !== 'small' && node.kind !== 'notable' && node.kind !== 'keystone') continue
        const v = firstRadiusAt(versionDiscs, node.x, node.y)
        if (v) versions.set(node.id, v)
        const sw = firstRadiusAt(swapDiscs, node.x, node.y)
        if (sw) swaps.set(node.id, sw)
      }
    }
    conquerorVersionByNode = versions
    timeLostSwapByNode = swaps
  }

  function seedIds(): Set<string> {
    const seeds = new Set<string>()
    for (const id of opts.seedIds ?? []) {
      if (graph.nodeById.has(id)) seeds.add(id)
    }
    if (classIndex !== null) {
      const start = graph.classStartByIndex.get(classIndex)
      if (start) seeds.add(start)
    }
    if (ascendancyId) {
      const asc = graph.ascendancies.get(ascendancyId)
      if (asc?.startNodeId) seeds.add(asc.startNodeId)
    }
    return seeds
  }

  function notify(userEdit: boolean): void {
    for (const fn of subscribers) fn(allocated)
    if (userEdit && opts.onChange) opts.onChange(allocated)
  }

  // ── render loop: draw only when invalidated ────────────────────────────────────────────
  function draw(): void {
    rafPending = false
    if (destroyed || !ctx || !vp || size.width === 0 || size.height === 0) return
    renderScene(ctx, {
      graph,
      vp,
      size,
      dpr,
      allocated,
      weaponSet1,
      weaponSet2,
      hovered,
      searchMatches,
      ascendancyId,
      classIndex,
      ascDelta,
      spatial,
      sprites,
      atlasIcons,
      genesisFrames: opts.genesisFrames,
      genesisWomb: opts.genesisWomb,
      genesisBg: bgVisible && opts.genesisBg ? { img: loadGenesisBg(), panel: opts.genesisBg } : null,
      atlasBg,
      bgPanels: bgVisible ? opts.bgPanels : undefined,
      passiveBg,
      mastery,
      jewels: jewelSheet,
      jewelSockets,
      time: animating ? performance.now() : 0,
      showCentralArt: opts.centralArt === true && bgVisible,
      palette,
    })
    // keep spinning the radius rings: re-schedule while a radius jewel is present + the art is shown
    if (animating) {
      rafPending = true
      requestAnimationFrame(draw)
    }
  }
  function invalidate(): void {
    if (rafPending || destroyed) return
    rafPending = true
    requestAnimationFrame(draw)
  }
  // The radius rings spin, so the tree must redraw continuously while one is present + the bg art is
  // shown — otherwise it stays on the dirty-flag loop (zero idle CPU). Toggling it on kicks the loop.
  function updateAnimating(): void {
    // Radius rings spin whenever a radius jewel is socketed — NOT gated on the bg-art toggle (the rings
    // are functional info; render.ts draws them regardless of `showCentralArt`). Respect
    // prefers-reduced-motion: a CSS media query can't stop an imperative rAF loop, so honour it here —
    // the ring is still drawn, just held static (Addendum §G: reduced-motion → one frame, don't schedule).
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    const next = opts.centralArt === true && !reduced && [...jewelSockets.values()].some((j) => j.ring)
    if (next === animating) return
    animating = next
    if (animating) invalidate()
  }

  // ── sizing (DPR-aware backing store; refit clamp on resize) ────────────────────────────
  function fitViewport(): Viewport {
    const margin = FIT_PADDING_RATIO * Math.min(size.width, size.height)
    return fitToBounds(graph.mainBounds, size, margin)
  }
  function updateSize(): void {
    const rect = wrapper.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    size = { width: rect.width, height: rect.height }
    dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    const fitted = fitViewport()
    minZoom = fitted.zoom
    if (!vp) vp = fitted
    else if (vp.zoom < minZoom) vp = { ...vp, zoom: minZoom }
    invalidate()
  }
  updateSize()
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateSize) : null
  ro?.observe(wrapper)

  // ── tooltip ────────────────────────────────────────────────────────────────────────────
  // Rendered with the library's itc-card (vendored in components.subset.css); .tree-tip is just
  // the positioning shell. A socketed jewel shows the item card (rarity-tiered, radius sub-line,
  // mod rows, corrupted stamp); a bare node shows name + kind sub-line + stat rows.
  const modRows = (stats: readonly string[]): string =>
    stats.map((s) => `<div class="itc-mod">${escapeHtml(s)}</div>`).join('')

  /** Position the tip with its TOP-LEFT at the node's BOTTOM-RIGHT — the tooltip drops down-right of
   *  the node (no cursor gap, a stable gapless target). Flips above/left only as a last resort when it
   *  would overflow the canvas. Used for interactive choice tooltips + the pinned touch picker. */
  function anchorTipToNode(node: TreeNode): void {
    const v = vp ?? { x: 0, y: 0, zoom: minZoom }
    const { sx, sy } = worldToScreen(v, size, node.x, node.y)
    const rPx = (NODE_WORLD_RADIUS[node.kind] ?? NODE_WORLD_RADIUS.small) * v.zoom
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    let left = sx + rPx // node's bottom-right corner = tip's top-left
    // Horizontal: flip to the node's LEFT only if a right-edge node would otherwise cover itself.
    // Vertical: ALWAYS drop DOWN-right (never flip above — that read as "top-right" for low nodes);
    // a node near the bottom just clamps upward enough to stay on-screen, still right of the node.
    if (left + w > size.width - 8) left = sx - rPx - w
    left = Math.max(8, Math.min(left, size.width - w - 8))
    const top = Math.max(8, Math.min(sy + rPx, size.height - h - 8))
    tip.style.left = `${left}px`
    tip.style.top = `${top}px`
  }

  function showTooltip(node: TreeNode): void {
    // FREEZE: if the tip is already showing this node, keep it exactly where it is — do NOT rebuild
    // its markup or re-anchor it to the moving cursor. onHover fires on every mousemove, so without
    // this the tooltip chased the cursor and its option rows rebuilt each pixel, making a choice
    // node's buttons impossible to aim at. Frozen, it's a stable surface the cursor can travel into.
    // Re-entering the node also cancels any pending hide so it never closes from under the pointer.
    if (tipNodeId === node.id && !tip.hidden) {
      cancelTipHide()
      return
    }
    let html: string
    const override = opts.tooltipOverride?.(node) ?? null
    const jewel = override === null && node.kind === 'jewel' ? jewelSockets.get(node.id) : undefined
    if (override !== null) {
      html = override // e.g. Genesis womb → the Wombgift crafting reference card
    } else if (jewel) {
      const rarity = jewel.rarity ?? ''
      const header =
        `<span class="itc-name">${escapeHtml(jewel.name)}</span>` +
        (jewel.baseType ? `<span class="itc-base">${escapeHtml(jewel.baseType)}</span>` : '') +
        (jewel.radius ? `<span class="itc-subline">${copy.tree.radius(escapeHtml(jewel.radius))}</span>` : '')
      const mods = modRows(jewel.stats)
      const rk = rarityKey(rarity)
      html =
        `<div class="itc-card itc-card--featured itc-r-${rk}" role="group" ` +
        `aria-label="${escapeHtml(jewel.name)}" style="${poeTierVars(rk)}">` +
        `<div class="itc-header">${header}</div>` +
        (mods ? `<div class="itc-body">${mods}</div>` : '') +
        (jewel.corrupted ? `<div class="itc-stamp itc-stamp--preview">${copy.tree.corrupted}</div>` : '') +
        `</div>`
    } else {
      const t = KIND_TIER[node.kind]
      // Phase 3C — class/ascendancy override: a node's GGG-rewritten name/stats for THIS selection
      // (e.g. Witch's "Spell Damage" → "Spell and Minion Damage"). The override only rewrites
      // name/icon/stats — kind, grantedSkill, flavour and mc-group membership stay on the base node.
      const resolved = resolveNode(graph, node, classIndex, ascendancyId)
      // NEVER fall back to the internal exportId ("AtlasGenericStart") — GGG leaves some atlas
      // nodes (tree starts) unnamed on purpose; an empty title is correct, the raw id is not.
      const name = resolved.name || node.name || ''
      // Phase 2C — a Time-Lost Diamond conquering this node states a deterministic attribute swap
      // (e.g. Strength → Dexterity); apply that exact, text-sourced substitution to the stat lines.
      const swap = timeLostSwapByNode.get(node.id)
      const stats = swap ? resolved.stats.map((s) => applySwap(s, swap)) : resolved.stats
      // Mutually-exclusive "choose one" group. Two cases share the same option list (one source of
      // truth = graph.mcGroups): an OPTION child (node.mcParent set) lists its siblings, while the
      // group PARENT (node.isMultipleChoice — id IS the group key) has 0 stats and otherwise renders
      // near-blank, so its card lists the options it chooses between.
      const isMcParent = node.isMultipleChoice === true
      const groupKey = isMcParent ? node.id : node.mcParent
      const groupOptions = groupKey ? (graph.mcGroups.get(groupKey) ?? []) : []
      const optionNames = (ids: readonly string[]): string[] =>
        ids.map((id) => graph.nodeById.get(id)?.name ?? '').filter(Boolean)
      // For an option child: the OTHER options (excludes self). For the parent: every option.
      const alts = isMcParent ? optionNames(groupOptions) : optionNames(groupOptions.filter((id) => id !== node.id))
      // Total options in the group (parent counts every option; a child counts itself + the others).
      const optionCount = isMcParent ? alts.length : alts.length + 1
      const sub = [KIND_LABEL[node.kind]]
      if (optionCount > 1) sub.push(copy.tree.oneOf(optionCount))
      if (allocated.has(node.id)) sub.push(copy.tree.allocated)
      let body = modRows(stats)
      // Phase 5A — attribute-of-choice tag. The generic Str/Dex/Int small (isGenericAttribute) lets
      // the player pick which attribute it grants in game. When PoB's export recorded the player's
      // pick (spec <AttributeOverride>), name it exactly; otherwise show the bare "of choice" label.
      if (node.isGenericAttribute) {
        const chosen = attributeChoices.get(node.id)
        body += `<div class="itc-mod itc-mod--bonus" data-tag="attr-choice">${
          chosen ? copy.tree.attrChoiceSet(escapeHtml(chosen)) : copy.tree.attrChoice
        }</div>`
      }
      // Phase 5A — fixed attribute grant tag. The "+N to … Attributes" line is already printed by the
      // stats above (do NOT re-print the number) — this is just a labelled marker that it is a grant.
      if (node.grantedStrength || node.grantedDexterity || node.grantedIntelligence) {
        const which = [
          node.grantedStrength ? 'Strength' : '',
          node.grantedDexterity ? 'Dexterity' : '',
          node.grantedIntelligence ? 'Intelligence' : '',
        ].filter(Boolean)
        body += `<div class="itc-mod itc-mod--bonus" data-tag="attr-grant">${copy.tree.grantsAttr(escapeHtml(which.join(' / ')))}</div>`
      }
      // Phase 5B — Weapon Master conversion cue (node 8272). It converts passive points into weapon-set
      // points (its own stat line states the count); flag the budget impact so the conversion is clear.
      // weapon-set points are a separate pool we don't tally, so this is a label only, not a count.
      if (node.weaponPassivePointsGranted) {
        body += `<div class="itc-mod itc-mod--bonus" data-tag="weapon-points">${copy.tree.convertsToWeaponPoints}</div>`
      }
      // Weapon-set membership — exact, from the spec's per-set node lists (same classifier the
      // renderer tints with, so the label always matches the node's colour). A node in BOTH sets is
      // shared (no callout); only a set-specific node is annotated.
      const wsTint = weaponSetTint(node.id, weaponSet1, weaponSet2)
      if (wsTint !== 'none') {
        body += `<div class="itc-mod itc-mod--bonus" data-tag="weapon-set">${copy.tree.weaponSetOnly(wsTint === 'ws1' ? '1' : '2')}</div>`
      }
      if (node.grantedSkill) {
        body += `<div class="itc-mod itc-mod--bonus" data-tag="grants">${copy.tree.grantsSkill(escapeHtml(node.grantedSkill.name))}</div>`
        if (node.grantedSkill.desc) body += `<div class="itc-desc">${escapeHtml(node.grantedSkill.desc)}</div>`
      }
      if (alts.length) {
        // Parent card: "Choose one of: A · B" (it has no stats of its own). Option child: "… also: …"
        const label = isMcParent ? copy.tree.chooseOneOf : copy.tree.chooseOneAlso
        body += `<div class="itc-desc">${copy.tree.chooseOne(escapeHtml(label), alts.map(escapeHtml).join(' · '))}</div>`
      }
      // Phase 5A — gate lock cue. An UNSATISFIED unlock prerequisite is shown honestly: a single
      // prereq states the one node; a multi-prereq lists them joined by " / " (its AND-vs-OR operator
      // is absent from GGG's data — see interact.ts — so we never imply "all" or "any").
      const gate = node.unlockConstraint
      if (gate && !gate.nodes.every((pid) => allocated.has(pid))) {
        const prereqs = gate.nodes.map((pid) => graph.nodeById.get(pid)?.name ?? '').filter(Boolean)
        if (prereqs.length) {
          body += `<div class="itc-desc" data-tag="locked">${copy.tree.locked(prereqs.map(escapeHtml).join(' / '))}</div>`
        }
      }
      // Timeless-jewel context — honest labels, never presented as the seeded per-node art GGG picks.
      const version = conquerorVersionByNode.get(node.id)
      if (version) {
        body += `<div class="itc-desc" data-tag="conqueror">${copy.tree.conqueredBy(escapeHtml(version))}</div>`
      }
      if (swap) {
        body += `<div class="itc-desc" data-tag="timelost">${copy.tree.timeLost(escapeHtml(swap.from), escapeHtml(swap.to))}</div>`
      }
      // Atlas "Select a bonus" mastery: its choose-one options as numbered, CLICKABLE rows (the
      // tooltip turns interactive). Clicking one allocates the mastery with that bonus; the pick
      // rides the share link. Mirrors the in-game panel (numbered list, reallocatable any time).
      if (node.choices?.length) {
        const chosen = masteryChoice.get(node.id)
        body += `<div class="itc-desc" data-tag="choose">${copy.tree.selectBonus}</div>`
        body += `<div class="itc-choices">`
        node.choices.forEach((c, i) => {
          const on = chosen === i
          // Show the option's sourced label, then its effect as detail. Some options carry only an
          // internal stat with no in-game text (map_wisps_*, dummy_display_*) — the label stands alone.
          const detail = c.stats.map(escapeHtml).join('; ')
          const txt = c.name ? `<b>${escapeHtml(c.name)}</b>${detail ? ` — ${detail}` : ''}` : detail
          body +=
            `<button type="button" class="itc-choice${on ? ' is-on' : ''}" data-choice="${i}" aria-pressed="${on}">` +
            `<span class="itc-choice-n">${i + 1}</span>` +
            `<span class="itc-choice-txt">${txt}</span></button>`
        })
        body += `</div>`
        // PINNED (touch) only: Close + (when allocated) Remove — touch's tap-to-open replaced the
        // tap-to-toggle, so these restore "dismiss" and "deallocate". Hover (mouse) never shows them.
        if (tipPinned) {
          body += `<div class="itc-tip-actions">`
          if (allocated.has(node.id)) {
            body += `<button type="button" class="itc-tip-act itc-tip-act--remove" data-tip-remove>${copy.tree.removeNode}</button>`
          }
          body += `<button type="button" class="itc-tip-act" data-tip-close>${copy.tree.close}</button></div>`
        }
      }
      if (node.flavour?.length) body += `<p class="itc-flavour">${node.flavour.map(escapeHtml).join('<br>')}</p>`
      html =
        `<div class="itc-card${t.cls ? ` ${t.cls}` : ''}" role="group" aria-label="${escapeHtml(name || sub[0] || '')}" ` +
        `style="${t.vars}">` +
        `<div class="itc-header">` +
        (name ? `<span class="itc-name">${escapeHtml(name)}</span>` : '') + // unnamed tree-start: kind only
        `<span class="itc-subline">${escapeHtml(sub.join(' · '))}</span></div>` +
        (body ? `<div class="itc-body">${body}</div>` : '') +
        `</div>`
    }
    tip.innerHTML = html
    tip.hidden = false
    cancelTipHide()
    tipNodeId = node.id
    // A node with choices (or the pinned touch picker) makes the tooltip clickable (pointer-events
    // on); plain nodes stay click-through so they never swallow a canvas hover/tap.
    tip.classList.toggle('is-interactive', tipPinned || (!viewerOnly && !!node.choices?.length))
    tip.classList.toggle('is-pinned', tipPinned)
    // EVERY tooltip anchors to the NODE (top-left at the node's bottom-right) rather than following the
    // cursor — a stable, predictable position the cursor can travel into (and the choice picker can be
    // clicked) without the tip jittering or chasing the pointer.
    anchorTipToNode(node)
  }

  // Drop any mastery pick whose node is no longer allocated (deallocated directly or orphaned by a
  // cascade). Returns true if anything changed. Keeps masteryChoice ⊆ allocated at all times.
  function pruneChoices(): boolean {
    let changed = false
    for (const id of [...masteryChoice.keys()]) {
      if (!allocated.has(id)) {
        masteryChoice.delete(id)
        changed = true
      }
    }
    return changed
  }

  // Pick one bonus for a "Select a bonus" atlas mastery: allocate the mastery if it isn't yet
  // (auto-path, like a tap), then record the chosen option index. The pick rides the share link.
  function pickMasteryChoice(id: string, idx: number): void {
    if (viewerOnly) return
    const node = graph.nodeById.get(id)
    // Number(dataset.choice) can yield NaN for a malformed attribute; NaN slips past the < / >=
    // bounds checks (both compare false), so guard it explicitly before it lands in masteryChoice.
    if (!Number.isInteger(idx)) return
    if (!node?.choices || idx < 0 || idx >= node.choices.length) return
    if (!allocated.has(id)) {
      const next = allocateNode(
        graph.navAdjacency,
        allocated,
        seedIds(),
        id,
        blockedNodeIds(graph, classIndex, ascendancyId),
        gateContext,
      )
      if (!next) return // unreachable — can't take this mastery (so can't pick its bonus) yet
      undoStack.push(allocated)
      if (undoStack.length > HISTORY_CAP) undoStack.shift()
      redoStack = []
      allocated = next
    }
    masteryChoice.set(id, idx)
    invalidate()
    notify(true)
    if (tipPinned && tipNodeId === id) {
      // pinned (touch) picker: rebuild so the selection AND the now-available "Remove node" row show
      tipNodeId = null // bypass the freeze guard so showTooltip actually re-renders
      showTooltip(node)
    } else {
      // mouse hover tip: reflect the new selection in place (rebuilding would drop the open tooltip)
      for (const b of tip.querySelectorAll<HTMLElement>('[data-choice]')) {
        const on = Number(b.dataset.choice) === idx
        b.classList.toggle('is-on', on)
        b.setAttribute('aria-pressed', String(on))
      }
    }
  }

  /** Touch entry point: tap a chooser node to open its option picker as a pinned popover (touch has no
   *  hover). Dismiss via the Close button, a tap outside, or Escape. Reuses showTooltip's choices markup. */
  function openPinnedPicker(node: TreeNode): void {
    if (viewerOnly || !node.choices?.length) return
    hideTip() // clear any prior tip + its freeze state
    tipPinned = true
    showTooltip(node) // builds the interactive picker (incl. Close/Remove), anchored to the node
  }

  // ── interactions (user edits — the only writers of the undo/redo history) ─────────────────
  function toggle(id: string): void {
    if (viewerOnly) return // read-only view (e.g. the default atlas mount)
    const node = graph.nodeById.get(id)
    if (!node || node.kind === 'classStart' || node.kind === 'mastery') return
    // Clicking a tree-start root resets the whole tree back to the seeds (clears every allocation).
    if (node.atlasRoot) {
      const reset = seedIds()
      if (!sameSet(reset, allocated) || masteryChoice.size > 0) {
        undoStack.push(allocated)
        if (undoStack.length > HISTORY_CAP) undoStack.shift()
        redoStack = []
        allocated = reset
        masteryChoice.clear() // a full reset clears the mastery bonus picks too
        invalidate()
        notify(true)
      }
      return
    }
    const blocked = blockedNodeIds(graph, classIndex, ascendancyId)
    const seeds = seedIds()
    const prev = allocated
    if (allocated.has(id)) {
      allocated = deallocateNode(graph.navAdjacency, allocated, seeds, id, blocked, gateContext)
    } else {
      const next = allocateNode(graph.navAdjacency, allocated, seeds, id, blocked, gateContext)
      if (!next) return // unreachable, or its single-prereq gate is unsatisfied — null no-op
      allocated = next
    }
    // Record one undo entry per genuine change. We compare CONTENTS, not just size: a no-op
    // (deallocating a seed root) leaves the set identical, but a choose-one SWAP can be size-neutral
    // (one sibling out, the target in) yet is a real edit — a size-only test would silently drop it
    // from the history. `prev` snapshots the whole set, so the single entry restores even a big
    // gate/orphan cascade in one undo.
    if (!sameSet(allocated, prev)) {
      undoStack.push(prev)
      if (undoStack.length > HISTORY_CAP) undoStack.shift()
      redoStack = []
    }
    pruneChoices() // a deallocate (or its orphan cascade) drops those masteries' picks
    invalidate()
    notify(true)
  }

  function undo(): boolean {
    const prev = undoStack.pop()
    if (!prev) return false
    redoStack.push(allocated)
    allocated = prev
    pruneChoices() // keep picks ⊆ allocated after stepping back
    invalidate()
    notify(true) // user action — fires opts.onChange like any edit
    return true
  }

  function redo(): boolean {
    const next = redoStack.pop()
    if (!next) return false
    undoStack.push(allocated)
    allocated = next
    pruneChoices()
    invalidate()
    notify(true)
    return true
  }

  const detach = attachInteractions(canvas, {
    getViewport: () => vp ?? { x: 0, y: 0, zoom: minZoom },
    setViewport: (next) => {
      vp = { ...next, zoom: Math.min(MAX_ZOOM, Math.max(minZoom, next.zoom)) }
      invalidate()
    },
    getMinZoom: () => minZoom,
    getSize: () => size,
    nodeAtWorld: (wx, wy) => {
      const z = vp?.zoom ?? minZoom
      const radius = Math.min(150, Math.max(45, 12 / z))
      return nodeAt(spatial, wx, wy, radius)
    },
    onHover: (id) => {
      if (id !== hovered) {
        hovered = id
        canvas.style.cursor = id ? 'pointer' : 'grab'
        invalidate()
      }
      if (tipPinned) return // a pinned touch picker owns the tip — hover never disturbs it
      const node = id ? graph.nodeById.get(id) : undefined
      if (node && !node.decorative && !node.atlasRoot) showTooltip(node)
      else if (tip.classList.contains('is-interactive')) {
        // leaving the node but the tooltip is clickable — give the cursor time to reach it
        cancelTipHide()
        tipHideTimer = setTimeout(hideTip, TIP_HIDE_DELAY_MS)
      } else hideTip() // no node, a decorative filler icon, or an (unnamed) tree-start root
    },
    onToggle: (id, ev) => {
      // Touch has no hover, so a touch tap on a chooser OPENS its picker (you then tap an option)
      // instead of immediately allocating; mouse/pen clicks and taps on plain nodes toggle as before.
      const node = graph.nodeById.get(id)
      if (!viewerOnly && ev.pointerType === 'touch' && node?.choices?.length) openPinnedPicker(node)
      else toggle(id)
    },
  })

  // Undo/redo shortcuts scoped to the canvas WRAPPER only — the page has text inputs whose
  // native Ctrl+Z a document-level binding would hijack. tabindex makes the wrapper focusable
  // (clicking the canvas focuses it, so the shortcuts work right after an edit).
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && tipPinned) {
      ev.preventDefault()
      hideTip() // close a pinned (touch) picker
      return
    }
    if (!ev.ctrlKey || ev.altKey) return
    const key = ev.key.toLowerCase()
    if (key === 'z' && !ev.shiftKey) {
      ev.preventDefault()
      undo()
    } else if (key === 'y' || (key === 'z' && ev.shiftKey)) {
      ev.preventDefault()
      redo()
    }
  }
  if (!viewerOnly) {
    wrapper.tabIndex = 0
    wrapper.addEventListener('keydown', onKeyDown)
  }

  // ── public surface ─────────────────────────────────────────────────────────────────────
  const view: TreeView = {
    setBuild(b) {
      const next = new Set<string>()
      const miss: string[] = []
      for (const rawId of b.allocated) {
        const id = String(rawId)
        if (graph.nodeById.has(id)) next.add(id)
        else miss.push(id) // tolerated: counted + exposed via getMissing(), never thrown
      }
      allocated = next
      missing = miss
      // mastery picks: keep only valid entries — node ALLOCATED, has choices, index in range
      masteryChoice = new Map(
        [...(b.masteryChoices ?? [])].filter(([id, i]) => {
          const n = graph.nodeById.get(id)
          return next.has(id) && n?.choices != null && i >= 0 && i < n.choices.length
        }),
      )
      weaponSet1 = toIdSet(b.weaponSet1)
      weaponSet2 = toIdSet(b.weaponSet2)
      jewelSockets = b.jewels ?? new Map()
      attributeChoices = b.attributeChoices ?? new Map()
      rebuildJewelNodeMaps()
      updateAnimating()
      // External source of truth changed — past user edits no longer apply to it.
      undoStack = []
      redoStack = []
      ascendancyId = b.ascendancyId && graph.ascendancies.has(b.ascendancyId) ? b.ascendancyId : null
      classIndex =
        b.classIndex ?? (ascendancyId ? graph.ascendancies.get(ascendancyId)!.classIdx : inferClassIndex(graph, next))
      ascDelta = ascendancyId ? ascendancyOverlayDelta(graph, ascendancyId) : null
      rebuildSpatial()
      invalidate()
      notify(false)
    },
    getAllocated: () => allocated,
    getMasteryChoices: () => masteryChoice,
    getCounts() {
      let asc = 0
      let granted = 0
      let shared = 0 // main nodes that apply to BOTH weapon sets (or are specialised to neither)
      let ws1 = 0 // main nodes specialised to weapon set I only
      let ws2 = 0 // main nodes specialised to weapon set II only
      for (const id of allocated) {
        const node = graph.nodeById.get(id)
        if (!node) continue
        // grantedPassivePoints raises the MAIN budget (a granter is never a start/free node).
        if (node.grantedPassivePoints) granted += node.grantedPassivePoints
        if (node.kind === 'classStart' || node.kind === 'ascStart') continue // start nodes are free
        if (node.isFree) continue // IsFree nodes (e.g. the Sacred Unity asc notable) cost no point
        if (node.ascendancyId) {
          asc++
          continue
        }
        const in1 = weaponSet1.has(id)
        const in2 = weaponSet2.has(id)
        if (in1 && !in2) ws1++
        else if (in2 && !in1) ws2++
        else shared++
      }
      const main = mainPointsUsed(shared, ws1, ws2)
      const available = availablePoints(granted)
      return { main, asc, available, over: main > available, ws1, ws2 }
    },
    getAscendancyId: () => ascendancyId,
    toggle,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    focusSearch(q) {
      const needle = q.trim().toLowerCase()
      searchMatches = new Set<string>()
      if (needle) {
        for (const id of spatial.points.keys()) {
          const node = graph.nodeById.get(id)
          if (!node || node.kind === 'classStart') continue
          // Phase 3C — search the RESOLVED name/stats so class/ascendancy-specific text (and the
          // Time-Lost swap substitution) is findable, exactly as the tooltip displays it.
          const resolved = resolveNode(graph, node, classIndex, ascendancyId)
          const swap = timeLostSwapByNode.get(id)
          const stats = swap ? resolved.stats.map((s) => applySwap(s, swap)) : resolved.stats
          const hit =
            resolved.name.toLowerCase().includes(needle) || stats.some((s) => s.toLowerCase().includes(needle))
          if (hit) searchMatches.add(id)
        }
        if (searchMatches.size > 0 && size.width > 0) {
          const box = matchBounds(spatial, searchMatches)
          const fitted = fitToBounds(box, size, 80)
          vp = { ...fitted, zoom: Math.max(minZoom, Math.min(SEARCH_MAX_ZOOM, fitted.zoom)) }
        }
      }
      invalidate()
    },
    fit() {
      if (size.width === 0) return
      vp = fitViewport()
      minZoom = vp.zoom
      invalidate()
    },
    redraw: () => invalidate(),
    setBgVisible(visible) {
      bgVisible = visible
      updateAnimating()
      invalidate()
    },
    getMissing: () => missing,
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    destroy() {
      destroyed = true
      detach()
      wrapper.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('poe2:themechange', onThemeChange)
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      ro?.disconnect()
      unloadSprites(onSpritesReady)
      subscribers.clear()
      wrapper.remove()
    },
  }
  return view
}

/** Normalize an optional iterable of ids into a Set (ids defensively stringified). */
function toIdSet(ids: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>()
  for (const id of ids ?? []) out.add(String(id))
  return out
}

/** Same-membership test for two id sets — a real edit changes contents, not necessarily size. */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/** Fallback class inference: the class start adjacent to (or inside) the allocated set. */
function inferClassIndex(graph: TreeGraph, allocated: ReadonlySet<string>): number | null {
  for (const startId of graph.classStartIds) {
    const node = graph.nodeById.get(startId)!
    const touches = allocated.has(startId) || (graph.navAdjacency.get(startId) ?? []).some((nb) => allocated.has(nb))
    if (touches && node.classStartIndex && node.classStartIndex.length > 0) return node.classStartIndex[0]!
  }
  return null
}

/** Escape a string for safe literal use inside a RegExp (the swap sides are jewel-text-sourced). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Apply a Time-Lost Diamond's deterministic attribute swap to one stat line: replace whole-word,
 * case-insensitive occurrences of `swap.from` with `swap.to` (e.g. "Strength" → "Dexterity"). This
 * is the EXACT transform the jewel's own text states — not a guess — so it is applied verbatim; a
 * line not mentioning the swapped attribute is returned unchanged.
 */
function applySwap(line: string, swap: { from: string; to: string }): string {
  if (!swap.from) return line
  const re = new RegExp(`\\b${escapeRegExp(swap.from)}\\b`, 'gi')
  // Replace via a function so any `$` sequences in swap.to (e.g. `$&`, `$1`) are inserted
  // literally rather than interpreted by String.replace as backreferences.
  return line.replace(re, () => swap.to)
}

function matchBounds(spatial: SpatialIndex, ids: ReadonlySet<string>): WorldRect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of ids) {
    const p = spatial.points.get(id)
    if (!p) continue
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  // pad so a single match still frames sensibly
  return { minX: minX - 300, minY: minY - 300, maxX: maxX + 300, maxY: maxY + 300 }
}

// ── toolbar fragment (integrator renders + wires it next to the mounted view) ───────────────
export function renderTreeToolbar(): string {
  return (
    `<div class="ttb" role="group" aria-label="Tree controls">` +
    `<input class="in-input ttb-search" type="search" placeholder="${copy.tree.searchPlaceholder}" aria-label="Search passive nodes" />` +
    `<button class="ix-btn ttb-fit" type="button" title="${copy.tree.fitTitle}">${copy.tree.fit}</button>` +
    `<span class="ttb-count" title="${copy.tree.countTitle}">` +
    `<b>0/${PASSIVE_CAP}</b><span>${copy.tree.nodes}</span><span class="ttb-count-asc" hidden></span><span class="ttb-count-ws" title="${copy.tree.countWsTitle}" hidden></span>` +
    `</span>` +
    `<label class="ttb-bg" title="${copy.tree.artTitle}"><input type="checkbox" class="ttb-bg-input" aria-label="Background art" checked> ${copy.tree.artLabel}</label>` +
    `</div>`
  )
}

/** Bind a rendered toolbar fragment under `root` to a mounted TreeView. Returns a cleanup fn. */
export function wireTreeToolbar(root: ParentNode, view: TreeView): () => void {
  const search = root.querySelector<HTMLInputElement>('.ttb-search')
  const fitBtn = root.querySelector<HTMLButtonElement>('.ttb-fit')
  const countEl = root.querySelector<HTMLElement>('.ttb-count b')
  const ascEl = root.querySelector<HTMLElement>('.ttb-count-asc')
  const wsEl = root.querySelector<HTMLElement>('.ttb-count-ws')
  const bgInput = root.querySelector<HTMLInputElement>('.ttb-bg-input')

  // Background-art (central class/ascendancy disc + ring) visibility — persisted across visits.
  const BG_KEY = 'poe2.charBgVisible'
  const bgPref = (): boolean => {
    try {
      return localStorage.getItem(BG_KEY) !== '0'
    } catch {
      return true
    }
  }
  if (bgInput) {
    bgInput.checked = bgPref()
    view.setBgVisible(bgPref())
  }
  const onBg = (): void => {
    const on = bgInput?.checked ?? true
    try {
      localStorage.setItem(BG_KEY, on ? '1' : '0')
    } catch {
      /* private mode — applies for this session only */
    }
    view.setBgVisible(on)
  }
  bgInput?.addEventListener('change', onBg)

  let timer: ReturnType<typeof setTimeout> | null = null
  const onInput = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => view.focusSearch(search?.value ?? ''), 150)
  }
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Enter') return
    if (timer) clearTimeout(timer)
    view.focusSearch(search?.value ?? '')
  }
  const onFit = (): void => view.fit()

  search?.addEventListener('input', onInput)
  search?.addEventListener('keydown', onKey)
  fitBtn?.addEventListener('click', onFit)
  const updateState = (): void => {
    const { main, asc, available, over, ws1, ws2 } = view.getCounts()
    if (countEl) {
      // Real main-pool budget: (level-1) + quest points (or the level-100 cap) + granted points.
      countEl.textContent = `${main}/${available}`
      countEl.classList.toggle('ttb-over', over)
    }
    if (ascEl) {
      const selected = view.getAscendancyId() !== null
      ascEl.hidden = !selected
      ascEl.textContent = selected ? copy.tree.countAsc(asc, ASCENDANCY_CAP) : ''
      ascEl.classList.toggle('ttb-over', asc > ASCENDANCY_CAP)
    }
    if (wsEl) {
      // Per-weapon-set points: Set I and Set II, each against the per-set cap (X/24). Shown only when
      // the build specialises any. Over-flag if either set somehow exceeds its cap.
      const hasWs = ws1 > 0 || ws2 > 0
      wsEl.hidden = !hasWs
      wsEl.textContent = hasWs ? copy.tree.countWs(ws1, ws2, WEAPON_SET_CAP) : ''
      wsEl.classList.toggle('ttb-over', ws1 > WEAPON_SET_CAP || ws2 > WEAPON_SET_CAP)
    }
  }
  updateState() // wiring may happen after setBuild — show current state
  const unsubscribe = view.subscribe(updateState)

  return () => {
    if (timer) clearTimeout(timer)
    search?.removeEventListener('input', onInput)
    search?.removeEventListener('keydown', onKey)
    fitBtn?.removeEventListener('click', onFit)
    bgInput?.removeEventListener('change', onBg)
    unsubscribe()
  }
}
