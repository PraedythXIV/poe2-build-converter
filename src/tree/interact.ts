// B1 — tree interactions. Two halves:
//   1. Pure allocation logic (multi-source BFS auto-path + cascade deallocation) — ported
//      from poe2-tools/poe2-build-planner `src/tree/allocation.ts` (MIT License, Copyright
//      (c) 2026 theofbonin — see THIRD-PARTY-NOTICES.md), generalized from a single class
//      start to a seed SET so the selected ascendancy start is a free root as well.
//   2. DOM pointer wiring: drag-pan, wheel zoom to cursor, hover, and tap-to-toggle with
//      drag suppression. The mount (index.ts) supplies state through callbacks.

import type { Viewport, Size } from './viewport'
import { screenToWorld } from './viewport'

export type Adjacency = ReadonlyMap<string, readonly string[]>

/**
 * Gate + multiple-choice context for allocation legality (Phase 4). Passed in by the caller so
 * this module stays pure — it never imports the graph, only reads the small derived maps. Every
 * field is optional; omit the whole object (or leave fields out) and allocation degrades to the
 * Phase-0 behaviour: pure connectivity, no gate enforcement, no choose-one swap.
 *
 * Two distinct gate signals, by design (see allocateNode):
 * - SINGLE-prerequisite gates are a KNOWN rule (the node unlocks iff its one prereq is allocated)
 *   → hard-enforced here. 197 of the 200 vendored gates are single-prereq.
 * - MULTI-prerequisite gates (3 vendored) do NOT state their AND-vs-OR operator anywhere in GGG's
 *   data → they are NOT hard-enforced (a fabricated operator would be an approximate rule, which
 *   this app never ships). They are surfaced in the tooltip instead and allowed through.
 */
export interface GateContext {
  /** gated node id → its prerequisite gate (mirrors graph.unlockGates). */
  unlockGates?: ReadonlyMap<string, { nodes: readonly string[]; ascendancy?: string }>
  /** prereq node id → the gated node ids it unlocks (mirrors graph.gateDependents) — O(1) cascade. */
  gateDependents?: ReadonlyMap<string, readonly string[]>
  /** mcParent group key → its "choose one" option node ids (mirrors graph.mcGroups). */
  mcGroups?: ReadonlyMap<string, readonly string[]>
  /** node id → its mcParent group key (the reverse of mcGroups; null/undefined when not an option). */
  mcParentOf?: (nodeId: string) => string | null | undefined
  /** ALLOCATABLE ROOTS (Genesis wombs): free-standing nodes you can allocate DIRECTLY (no path) and
   *  also DEALLOCATE — unlike `seeds` (always-on, never removable). When a root is removed, its
   *  now-disconnected subtree cascades away. Empty for the atlas/character trees (seeds-only). */
  roots?: ReadonlySet<string>
}

const EMPTY_GATE_CONTEXT: GateContext = {}

/**
 * Is `nodeId`'s SINGLE-prerequisite gate satisfied by `allocated`?
 *
 * Returns true when the node has no gate OR a multi-prereq gate (multi-prereq is deliberately not
 * enforced — its AND/OR operator is unknown, see GateContext). A single-prereq gate is satisfied
 * iff that one prereq is in `allocated`. This is the only gate rule allocation hard-enforces.
 */
function singlePrereqSatisfied(ctx: GateContext, allocated: ReadonlySet<string>, nodeId: string): boolean {
  const gate = ctx.unlockGates?.get(nodeId)
  if (!gate || gate.nodes.length !== 1) return true // ungated, or multi-prereq (permissive by design)
  return allocated.has(gate.nodes[0]!)
}

// ── pure allocation logic ────────────────────────────────────────────────────────────────────

/* jscpd:ignore-start — shortestPathFromAny and the cascade flood-fill below share ONLY the
   canonical BFS queue skeleton (queue/head/visited); their bodies differ fundamentally
   (prev-map path reconstruction with early return vs remaining-filtered keep-set collection).
   A shared walker-with-callbacks would obscure two clear hot-path algorithms — kept separate. */

/**
 * Shortest path (by edge count) from any node in `sources` to `target`, inclusive of the
 * source endpoint and the target. Nodes in `blocked` are never traversed; a blocked target
 * is unreachable. Returns null when unreachable.
 */
export function shortestPathFromAny(
  adjacency: Adjacency,
  sources: ReadonlySet<string>,
  target: string,
  blocked: ReadonlySet<string> = new Set(),
): string[] | null {
  if (blocked.has(target)) return null
  if (sources.has(target)) return [target]
  const prev = new Map<string, string>()
  const visited = new Set<string>(sources)
  const queue: string[] = [...sources]
  let head = 0
  while (head < queue.length) {
    const cur = queue[head++]!
    for (const nb of adjacency.get(cur) ?? []) {
      if (visited.has(nb) || blocked.has(nb)) continue
      visited.add(nb)
      prev.set(nb, cur)
      if (nb === target) {
        const path: string[] = []
        let c: string | undefined = target
        while (c !== undefined && !sources.has(c)) {
          path.push(c)
          c = prev.get(c)
        }
        if (c !== undefined) path.push(c)
        return path.reverse()
      }
      queue.push(nb)
    }
  }
  return null
}

/** BFS path-sources: the allocated set, the always-on seeds, AND the allocatable roots (Genesis
 *  wombs). Including unallocated roots is what makes auto-path work the intuitive way — clicking any
 *  subtree node paths from that subtree's womb and allocates the womb along the path, instead of
 *  forcing the player to allocate the womb by hand first. (Atlas/character pass no roots → unchanged:
 *  pathing still starts only from the allocated set + class/ascendancy seeds.) */
function sourcesOf(
  allocated: ReadonlySet<string>,
  seeds: ReadonlySet<string>,
  roots?: ReadonlySet<string>,
): Set<string> {
  const s = new Set<string>(allocated)
  for (const seed of seeds) s.add(seed)
  if (roots) for (const r of roots) s.add(r)
  return s
}

/**
 * Allocate `target` by adding the shortest connecting path from the existing allocation
 * (PoB-style auto-path). Returns the new set, or null when `target` is unreachable.
 * `seeds` (class start / selected ascendancy start) are free roots: paths may start there,
 * and a seed on the path is added to the allocation like any other node.
 *
 * `ctx` adds two legality rules on top of pure connectivity (omit it for the Phase-0 behaviour):
 *
 * - GATE (hard): reject (return null) when the target — or any node the auto-path would also
 *   allocate — carries a SINGLE-prerequisite unlock gate that the resulting set does not satisfy.
 *   Single-prereq is GGG's known rule. MULTI-prereq gates are intentionally NOT rejected here:
 *   their AND/OR operator is absent from the data, and fabricating one would ship an approximate
 *   rule — so they pass and the tooltip labels them (see GateContext).
 *
 * - CHOOSE-ONE (swap): when the target is one option of an mcParent "choose one" group whose other
 *   option is already allocated, deallocate that sibling first, then allocate the target — the
 *   verified in-game in-place swap for multiple-choice nodes. The sibling is removed via the same
 *   orphan cascade as deallocateNode so nothing downstream of it lingers disconnected.
 */
export function allocateNode(
  adjacency: Adjacency,
  allocated: ReadonlySet<string>,
  seeds: ReadonlySet<string>,
  target: string,
  blocked: ReadonlySet<string> = new Set(),
  ctx: GateContext = EMPTY_GATE_CONTEXT,
): Set<string> | null {
  if (allocated.has(target)) return new Set(allocated)

  // CHOOSE-ONE: swap out an already-allocated sibling from the same mcParent group before pathing.
  // Deallocate (with cascade) so the path may then re-route, and the new set has no stale branch.
  let base: ReadonlySet<string> = allocated
  const group = ctx.mcParentOf?.(target)
  if (group) {
    const siblings = ctx.mcGroups?.get(group) ?? []
    for (const sib of siblings) {
      if (sib !== target && base.has(sib)) {
        base = deallocateNode(adjacency, base, seeds, sib, blocked, ctx)
      }
    }
  }

  // A free-standing ROOT (Genesis womb): allocatable DIRECTLY, no connecting path required. From an
  // allocated root, ordinary nodes then path normally (the allocated set is the BFS source).
  if (ctx.roots?.has(target)) {
    const next = new Set(base)
    next.add(target)
    return singlePrereqSatisfied(ctx, next, target) ? next : null
  }

  const sources = sourcesOf(base, seeds, ctx.roots)
  if (sources.size === 0) return null
  const path = shortestPathFromAny(adjacency, sources, target, blocked)
  if (!path) return null
  const next = new Set(base)
  for (const id of path) next.add(id)

  // GATE (hard, single-prereq only): the target and every freshly auto-allocated node on the path
  // must have its single-prereq gate satisfied by the resulting set. Multi-prereq gates pass.
  for (const id of path) {
    if (!singlePrereqSatisfied(ctx, next, id)) return null
  }

  return next
}

/**
 * Remove `target` plus every allocated node no longer connected to a seed root through the
 * remaining allocation (cascade — the allocated set stays connected to the class start).
 * Removing a seed itself is a no-op.
 *
 * `ctx` adds a second cascade on top of the connectivity one: any node whose SINGLE-prerequisite
 * gate is no longer satisfied once `target` is gone is also stripped — an unsatisfied single-prereq
 * gate is treated like a severed edge (same flood spirit). gateDependents gives the O(1) reverse
 * lookup (prereq → the ids it gates). Multi-prereq gates are never stripped (they are not enforced,
 * by design — see GateContext). The strip is iterated to a fixpoint so a chain of gated-on-gated
 * nodes unwinds fully. Omit `ctx` for the Phase-0 connectivity-only behaviour.
 */
export function deallocateNode(
  adjacency: Adjacency,
  allocated: ReadonlySet<string>,
  seeds: ReadonlySet<string>,
  target: string,
  blocked: ReadonlySet<string> = new Set(),
  ctx: GateContext = EMPTY_GATE_CONTEXT,
): Set<string> {
  if (seeds.has(target) || !allocated.has(target)) return new Set(allocated)
  const remaining = new Set(allocated)
  remaining.delete(target)

  // Gate cascade: removing a node can unsatisfy the single-prereq gates of its dependents, whose
  // removal can in turn unsatisfy further dependents — iterate to a fixpoint. Seeds are never
  // stripped (a gate prereq that is a free root cannot be removed anyway).
  if (ctx.gateDependents && ctx.unlockGates) {
    const worklist: string[] = [target]
    while (worklist.length > 0) {
      const gone = worklist.pop()!
      for (const dep of ctx.gateDependents.get(gone) ?? []) {
        if (!remaining.has(dep) || seeds.has(dep)) continue
        if (singlePrereqSatisfied(ctx, remaining, dep)) continue // still satisfied — keep it
        remaining.delete(dep)
        worklist.push(dep) // its own dependents may now be unsatisfied too
      }
    }
  }

  // Flood from the free roots across remaining nodes; anything unreached is orphaned. Free roots =
  // the always-on `seeds` PLUS any allocatable `roots` (Genesis wombs) still in the set — so removing
  // a womb leaves its subtree unreachable (it cascades away), but other allocated wombs keep theirs.
  const floodRoots = new Set<string>()
  const keep = new Set<string>()
  for (const s of seeds)
    if (remaining.has(s)) {
      floodRoots.add(s)
      keep.add(s)
    }
  if (ctx.roots)
    for (const r of ctx.roots)
      if (remaining.has(r)) {
        floodRoots.add(r)
        keep.add(r)
      }
  const visited = new Set<string>(floodRoots)
  const queue: string[] = [...floodRoots]
  let head = 0
  while (head < queue.length) {
    const cur = queue[head++]!
    for (const nb of adjacency.get(cur) ?? []) {
      if (visited.has(nb) || blocked.has(nb) || !remaining.has(nb)) continue
      visited.add(nb)
      keep.add(nb)
      queue.push(nb)
    }
  }
  return keep
}
/* jscpd:ignore-end */

// ── pointer / wheel wiring ───────────────────────────────────────────────────────────────────

export const MAX_ZOOM = 6
const DRAG_THRESHOLD_PX = 5
const TAP_MAX_MS = 400
const WHEEL_SENSITIVITY = 0.0015

export interface InteractCallbacks {
  getViewport(): Viewport
  setViewport(vp: Viewport): void
  /** Fit-to-screen scale — the lower zoom clamp. */
  getMinZoom(): number
  getSize(): Size
  /** Nearest hit-testable node at a world point, or null. */
  nodeAtWorld(wx: number, wy: number): string | null
  onHover(id: string | null, ev: PointerEvent): void
  /** A clean tap/click on a node. `ev` is forwarded so the mount can branch on pointerType
   *  (touch has no hover, so a touch tap on a chooser opens its picker instead of toggling). */
  onToggle(id: string, ev: PointerEvent): void
}

/** Wire pan / zoom / hover / tap onto the canvas. Returns a detach function. */
export function attachInteractions(canvas: HTMLElement, cb: InteractCallbacks): () => void {
  let dragging = false
  let moved = false
  let downAt = 0
  let downX = 0
  let downY = 0
  let startVp: Viewport | null = null

  // Cache the canvas rect rather than reading getBoundingClientRect() on every pointermove/wheel — that
  // forces a synchronous layout flush at input frequency (Addendum §G "Web performance"). Refresh it on
  // resize / scroll / gesture-start — the only things that move the canvas in viewport coords.
  let rect = canvas.getBoundingClientRect()
  const refreshRect = (): void => {
    rect = canvas.getBoundingClientRect()
  }
  const toLocal = (ev: PointerEvent | WheelEvent): { x: number; y: number } => ({
    x: ev.clientX - rect.left,
    y: ev.clientY - rect.top,
  })

  const onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return
    refreshRect() // a gesture may begin after a layout shift the observers below didn't catch
    canvas.setPointerCapture(ev.pointerId)
    dragging = true
    moved = false
    downAt = performance.now()
    const p = toLocal(ev)
    downX = p.x
    downY = p.y
    startVp = cb.getViewport()
  }

  const onPointerMove = (ev: PointerEvent): void => {
    const p = toLocal(ev)
    if (dragging && startVp) {
      const dx = p.x - downX
      const dy = p.y - downY
      if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) moved = true
      if (moved) {
        cb.setViewport({ x: startVp.x - dx / startVp.zoom, y: startVp.y - dy / startVp.zoom, zoom: startVp.zoom })
        cb.onHover(null, ev)
        return
      }
    }
    const vp = cb.getViewport()
    const { wx, wy } = screenToWorld(vp, cb.getSize(), p.x, p.y)
    cb.onHover(cb.nodeAtWorld(wx, wy), ev)
  }

  const onPointerUp = (ev: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    startVp = null
    if (moved || performance.now() - downAt > TAP_MAX_MS) return // a pan or a dwell, not a tap
    const p = toLocal(ev)
    const vp = cb.getViewport()
    const { wx, wy } = screenToWorld(vp, cb.getSize(), p.x, p.y)
    const id = cb.nodeAtWorld(wx, wy)
    if (id) cb.onToggle(id, ev)
  }

  const onPointerLeave = (ev: PointerEvent): void => {
    if (!dragging) cb.onHover(null, ev)
  }

  const onWheel = (ev: WheelEvent): void => {
    ev.preventDefault()
    const vp = cb.getViewport()
    const size = cb.getSize()
    const p = toLocal(ev)
    const zoom = Math.min(MAX_ZOOM, Math.max(cb.getMinZoom(), vp.zoom * Math.exp(-ev.deltaY * WHEEL_SENSITIVITY)))
    if (zoom === vp.zoom) return
    // Keep the world point under the cursor fixed while zooming.
    const { wx, wy } = screenToWorld(vp, size, p.x, p.y)
    cb.setViewport({
      x: wx - (p.x - size.width / 2) / zoom,
      y: wy - (p.y - size.height / 2) / zoom,
      zoom,
    })
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  // Keep the cached rect fresh without per-input layout reads: the canvas resizing, the page scrolling
  // (capture catches scroll on any ancestor), or the window resizing are the only things that move it.
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refreshRect) : null
  ro?.observe(canvas)
  window.addEventListener('scroll', refreshRect, { passive: true, capture: true })
  window.addEventListener('resize', refreshRect, { passive: true })

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('pointerleave', onPointerLeave)
    canvas.removeEventListener('wheel', onWheel)
    ro?.disconnect()
    window.removeEventListener('scroll', refreshRect, { capture: true })
    window.removeEventListener('resize', refreshRect)
  }
}
