// B1 — pointer/wheel INTERACTION + jewel-socket coverage. Two complementary halves:
//
//   1. `attachInteractions` DIRECTLY, with hand-rolled callbacks — every branch of the drag-pan /
//      wheel-zoom-to-cursor / hover / tap-with-drag-suppression state machine is exercised and its
//      exact viewport math asserted (interact.ts).
//   2. The interaction wiring THROUGH a live `mountTree` (installCanvas2d so the Canvas2D draw path
//      actually runs after a flushed rAF): real pointer/wheel events dispatched at node coordinates,
//      asserting the hit-tested node / hover cursor+tooltip / auto-path allocation / pan offset shift.
//   3. `computeJewelSockets` (jewelSockets.ts): the pure parsed-build → per-socket JewelInfo transform
//      — faction disc, generic disc, annulus ring band, Time-Lost swap, unknown radius, plain jewel —
//      then one of its outputs driven onto the tree so an in-radius node's tooltip names its conqueror.
//
// The canvas2d stub + Path2D/rAF stubs mirror the enabler contract in tests/helpers/canvas2d.ts:
// without them the renderer sees a null ctx (jsdom) and its draw code never runs (0% coverage).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRenderHarness, type RenderHarness } from './helpers/renderHarness'
import { attachInteractions, MAX_ZOOM } from '../src/tree/interact'
import type { InteractCallbacks } from '../src/tree/interact'
import { fitToBounds, worldToScreen } from '../src/tree/viewport'
import type { Viewport } from '../src/tree/viewport'
import { mountTree, buildGraph } from '../src/tree/index'
import type { RawTreeGraph, TreeGraph } from '../src/tree/graph'
import { computeJewelSockets } from '../src/tree/jewelSockets'
import type { PobBuild } from '../src/convert/types'

// ── shared jsdom/canvas plumbing ───────────────────────────────────────────────────────────────
// The Canvas2D draw path needs jsdom scaffolding (no-op 2D ctx + Path2D shim, a manual rAF queue, a
// fixed 800×600 canvas rect so the viewport is set, no-op pointer capture) — see
// tests/helpers/renderHarness.ts. flush() drains the queued rAF callbacks (bounded, since draw() may
// re-queue itself while animating).
let renderHarness: RenderHarness
const mounted: Array<{ destroy(): void }> = []

/** Drain the queued rAF callbacks (up to `n` batches — draw() may re-queue itself while animating). */
const flush = (n = 12): void => {
  renderHarness.flushRaf(n)
}

beforeEach(() => {
  renderHarness = installRenderHarness({ width: 800, height: 600 })
})

afterEach(() => {
  for (const v of mounted.splice(0)) v.destroy()
  renderHarness.restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** Dispatch a synthetic pointer/wheel Event carrying the fields the handlers read (clientX/Y, button,
 *  pointerId, deltaY). A plain cancelable Event sidesteps jsdom's missing PointerEvent/WheelEvent
 *  constructors while still honouring preventDefault → defaultPrevented. */
function fire(el: HTMLElement, type: string, x: number, y: number, extra: Record<string, unknown> = {}): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(ev, { clientX: x, clientY: y, button: 0, pointerId: 1, ...extra })
  el.dispatchEvent(ev)
  return ev
}

// ── 1. attachInteractions — direct, exact viewport math ──────────────────────────────────────────
describe('attachInteractions — pointer/wheel state machine', () => {
  /** A canvas wired to recording callbacks. World frame: vp centred at (0,0), zoom 1, 800×600 → screen
   *  centre (400,300) maps to world (0,0). Two hit targets: 'C' near world origin, 'R' near (100,0). */
  function harness(vp: Viewport = { x: 0, y: 0, zoom: 1 }, minZoom = 0.5) {
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const size = { width: 800, height: 600 }
    const state = { vp, minZoom }
    const hovers: Array<string | null> = []
    const toggles: string[] = []
    const setCalls: Viewport[] = []
    const cb: InteractCallbacks = {
      getViewport: () => state.vp,
      setViewport: (v) => {
        state.vp = v
        setCalls.push(v)
      },
      getMinZoom: () => state.minZoom,
      getSize: () => size,
      nodeAtWorld: (wx, wy) => {
        if (Math.hypot(wx, wy) <= 40) return 'C'
        if (Math.hypot(wx - 100, wy) <= 40) return 'R'
        return null
      },
      onHover: (id) => hovers.push(id),
      onToggle: (id) => toggles.push(id),
    }
    const detach = attachInteractions(canvas, cb)
    return { canvas, state, hovers, toggles, setCalls, detach }
  }

  it('hovers the hit-tested node under the cursor (no drag)', () => {
    const h = harness()
    fire(h.canvas, 'pointermove', 400, 300) // world (0,0) → 'C'
    fire(h.canvas, 'pointermove', 500, 300) // world (100,0) → 'R'
    fire(h.canvas, 'pointermove', 400, 500) // world (0,200) → nothing
    expect(h.hovers).toEqual(['C', 'R', null])
    h.detach()
  })

  it('a clean tap (down→up, no move) toggles the node under the cursor', () => {
    const h = harness()
    fire(h.canvas, 'pointerdown', 400, 300)
    fire(h.canvas, 'pointerup', 400, 300)
    expect(h.toggles).toEqual(['C'])
    h.detach()
  })

  it('a sub-threshold jiggle still counts as a tap and hover-tracks along the way', () => {
    const h = harness()
    fire(h.canvas, 'pointerdown', 400, 300)
    fire(h.canvas, 'pointermove', 402, 300) // 2px < 5px threshold → not a pan, hover path runs
    fire(h.canvas, 'pointerup', 402, 300)
    expect(h.hovers).toEqual(['C']) // the below-threshold move hover-tested
    expect(h.toggles).toEqual(['C']) // and the up was still a tap
    expect(h.setCalls).toHaveLength(0) // never panned
    h.detach()
  })

  it('a drag past the threshold pans (x = startX − dx/zoom) and suppresses the tap', () => {
    const h = harness()
    fire(h.canvas, 'pointerdown', 400, 300)
    fire(h.canvas, 'pointermove', 410, 300) // dx=10 (>5) → pan
    fire(h.canvas, 'pointerup', 410, 300)
    expect(h.setCalls).toEqual([{ x: -10, y: 0, zoom: 1 }]) // 0 − 10/1
    expect(h.hovers).toEqual([null]) // pan clears the hover
    expect(h.toggles).toHaveLength(0) // moved → not a tap
    h.detach()
  })

  it('wheel zooms about the cursor, keeping that world point fixed on screen', () => {
    const h = harness()
    const ev = fire(h.canvas, 'wheel', 600, 300, { deltaY: -100 }) // off-centre zoom-in
    expect(ev.defaultPrevented).toBe(true)
    const vp = h.setCalls.at(-1)!
    expect(vp.zoom).toBeCloseTo(Math.exp(0.15), 5) // 1 · e^(100·0.0015)
    // the world point under (600,300) before the zoom must still project to sx≈600 after it
    const sxAfter = 800 / 2 + (200 - vp.x) * vp.zoom // screen width 800; pre-zoom world under cursor = (200,0)
    expect(sxAfter).toBeCloseTo(600, 3)
    h.detach()
  })

  it('wheel at the min-zoom floor is a no-op (zoom unchanged → no setViewport)', () => {
    const h = harness({ x: 0, y: 0, zoom: 0.5 }, 0.5)
    const ev = fire(h.canvas, 'wheel', 400, 300, { deltaY: 100 }) // zoom-out, already clamped at floor
    expect(ev.defaultPrevented).toBe(true) // preventDefault runs before the early-out
    expect(h.setCalls).toHaveLength(0)
    h.detach()
  })

  it('wheel clamps hard to MAX_ZOOM', () => {
    const h = harness({ x: 0, y: 0, zoom: 5.9 }, 0.5)
    fire(h.canvas, 'wheel', 400, 300, { deltaY: -1000 })
    expect(h.setCalls.at(-1)!.zoom).toBe(MAX_ZOOM)
    h.detach()
  })

  it('ignores non-primary buttons: a right-button down never starts a drag', () => {
    const h = harness()
    fire(h.canvas, 'pointerdown', 400, 300, { button: 2 }) // ignored
    fire(h.canvas, 'pointermove', 410, 300) // dragging=false → hover, not pan
    expect(h.setCalls).toHaveLength(0)
    expect(h.hovers).toEqual(['C'])
    h.detach()
  })

  it('a stray pointerup with no active gesture is a no-op', () => {
    const h = harness()
    fire(h.canvas, 'pointerup', 400, 300)
    expect(h.toggles).toHaveLength(0)
    h.detach()
  })

  it('pointerleave clears the hover only when NOT mid-drag', () => {
    const idle = harness()
    fire(idle.canvas, 'pointerleave', 400, 300)
    expect(idle.hovers).toEqual([null])
    idle.detach()

    const dragging = harness()
    fire(dragging.canvas, 'pointerdown', 400, 300)
    fire(dragging.canvas, 'pointerleave', 400, 300) // mid-drag → hover untouched
    expect(dragging.hovers).toHaveLength(0)
    dragging.detach()
  })

  it('a long dwell (> TAP_MAX_MS) is not a tap', () => {
    const nowSpy = vi.spyOn(performance, 'now')
    nowSpy.mockReturnValueOnce(0) // pointerdown timestamp
    nowSpy.mockReturnValue(500) // pointerup — 500ms later, past the 400ms tap window
    const h = harness()
    fire(h.canvas, 'pointerdown', 400, 300)
    fire(h.canvas, 'pointerup', 400, 300)
    expect(h.toggles).toHaveLength(0)
    h.detach()
  })

  it('refreshRect survives a window resize/scroll and detach unwires every listener', () => {
    const h = harness()
    window.dispatchEvent(new Event('resize')) // refreshRect
    window.dispatchEvent(new Event('scroll')) // refreshRect (capture)
    fire(h.canvas, 'pointermove', 400, 300)
    expect(h.hovers).toEqual(['C'])
    h.detach()
    fire(h.canvas, 'pointermove', 500, 300) // detached — nothing recorded
    expect(h.hovers).toEqual(['C'])
  })
})

// ── 2. live mountTree — real events drive the flushed Canvas2D draw ──────────────────────────────
describe('mounted tree — real pointer/wheel events over installCanvas2d', () => {
  const N = (x: number, y: number, name: string, extra: Record<string, unknown> = {}) => ({
    id: 'x' + name,
    name,
    icon: '',
    stats: [],
    x,
    y,
    group: 1,
    orbit: 0,
    orbitIndex: 0,
    ...extra,
  })
  // A 3-node line 1—2—3 (seed = node '1'). mainBounds is 0..200 in x, height collapses to 1, so the
  // fit centres node '2' (100,0) at screen (400,300): a stable, zoom-independent hit target.
  const synthRaw = (): RawTreeGraph =>
    ({
      bounds: { min_x: 0, min_y: 0, max_x: 200, max_y: 0 },
      classes: [],
      nodes: { '1': N(0, 0, 'Alpha'), '2': N(100, 0, 'Beta'), '3': N(200, 0, 'Gamma') },
      edges: [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ],
    }) as unknown as RawTreeGraph

  function mount(opts: Record<string, unknown> = {}) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const changes: number[] = []
    const view = mountTree(container, {
      graph: buildGraph(synthRaw()),
      seedIds: ['1'],
      onChange: (a) => changes.push(a.size),
      ...opts,
    })
    mounted.push(view)
    flush() // run the mount's first draw → renderScene executes against the stub ctx
    const canvas = container.querySelector('canvas') as HTMLCanvasElement
    const tip = container.querySelector('.tree-tip') as HTMLElement
    return { view, container, canvas, tip, changes }
  }

  it('hover hit-tests the node under the cursor → pointer cursor + its tooltip', () => {
    const m = mount()
    fire(m.canvas, 'pointermove', 400, 300) // screen centre → node '2' (Beta)
    expect(m.canvas.style.cursor).toBe('pointer')
    expect(m.tip.hidden).toBe(false)
    expect(m.tip.textContent).toContain('Beta')

    fire(m.canvas, 'pointermove', 400, 560) // empty space (world y ≈ 71 > hit radius)
    expect(m.canvas.style.cursor).toBe('grab')
    expect(m.tip.hidden).toBe(true)
  })

  it('a tap auto-paths the allocation from the seed and fires onChange', () => {
    const m = mount()
    expect(m.view.getAllocated().size).toBe(0)
    fire(m.canvas, 'pointerdown', 400, 300)
    fire(m.canvas, 'pointerup', 400, 300)
    expect(m.view.getAllocated()).toEqual(new Set(['1', '2'])) // seed 1 pulled along the path
    expect(m.changes).toEqual([2])
    flush() // the edit invalidated → redraw runs
  })

  it('a drag pans the viewport (no toggle); re-hit-testing the same point proves the offset moved', () => {
    const m = mount()
    fire(m.canvas, 'pointermove', 400, 300)
    expect(m.tip.textContent).toContain('Beta') // centre = node '2' before the pan

    fire(m.canvas, 'pointerdown', 400, 300)
    fire(m.canvas, 'pointermove', 650, 300) // drag right 250px → pan the world left under the cursor
    fire(m.canvas, 'pointerup', 650, 300)
    expect(m.view.getAllocated().size).toBe(0) // a pan is never a tap
    expect(m.changes).toEqual([])

    fire(m.canvas, 'pointermove', 400, 300) // same screen point now sits over node '1' (Alpha)
    expect(m.tip.textContent).toContain('Alpha')
  })

  it('the wheel handler preventDefaults and rescales without throwing', () => {
    const m = mount()
    const ev = fire(m.canvas, 'wheel', 400, 300, { deltaY: -120 })
    expect(ev.defaultPrevented).toBe(true)
    flush()
    fire(m.canvas, 'pointermove', 400, 300) // still interactive after the zoom
    expect(m.canvas.style.cursor).toBe('pointer')
  })

  it('a socketed radius jewel (from computeJewelSockets) tints in-radius nodes with its conqueror', () => {
    const m = mount()
    const jewels = computeJewelSockets(
      fakePob([{ nodeId: '2', itemId: 'j' }], {
        j: jewelItem({
          name: 'Glorious Vanity',
          baseType: 'Timeless Jewel',
          raw: 'Timeless Jewel\nRadius: Large\nVaal',
        }),
      }),
    )
    m.view.setBuild({ allocated: [], jewels }) // socket a Vaal Large radius at node '2' (100,0)
    flush()
    fire(m.canvas, 'pointermove', 36, 300) // node '1' (Alpha) at world (0,0) → screen x=36, inside the disc
    expect(m.tip.hidden).toBe(false)
    expect(m.tip.textContent).toContain('Vaal') // "Conquered by the Vaal …"
  })

  it('the real vendored character tree renders + wheel-zooms without throwing', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = mountTree(container) // no graph opt → the real loadGraph() tree
    mounted.push(view)
    flush() // draw thousands of real nodes/edges through the stub ctx
    const canvas = container.querySelector('canvas') as HTMLCanvasElement
    const ev = fire(canvas, 'wheel', 400, 300, { deltaY: -120 })
    flush()
    expect(ev.defaultPrevented).toBe(true)
  })

  // ── interactive tooltip / mastery picker / touch clusters over the shared engine ──────────────
  // Fixtures A/B/C live here so they reuse N() + the mount()/fire()/flush() harness above.
  const CHOICES_A = [
    { name: 'Bonus One', stats: ['+1 to STR'] },
    { name: '', stats: ['+2 to DEX'] }, // nameless option → the detail-only choice render (index.ts 650)
  ]
  // Fixture A — EDITABLE choices graph: 1—2—3 line; nodes '2' and '3' each carry a "Select a bonus".
  const choiceRaw = (): RawTreeGraph =>
    ({
      bounds: { min_x: 0, min_y: 0, max_x: 200, max_y: 0 },
      classes: [],
      nodes: {
        '1': N(0, 0, 'Alpha'),
        '2': N(100, 0, 'Beta', { choices: CHOICES_A }),
        '3': N(200, 0, 'Gamma', {
          choices: [
            { name: 'G1', stats: ['+3'] },
            { name: 'G2', stats: ['+4'] },
          ],
        }),
      },
      edges: [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ],
    }) as unknown as RawTreeGraph
  // Fixture A' — the choices node '2' is disconnected from the seed → its auto-path is unreachable.
  const choiceIsolatedRaw = (): RawTreeGraph =>
    ({
      bounds: { min_x: 0, min_y: 0, max_x: 200, max_y: 0 },
      classes: [],
      nodes: {
        '1': N(0, 0, 'Alpha'),
        '2': N(100, 0, 'Island', { choices: CHOICES_A }),
        '3': N(200, 0, 'Gamma'),
      },
      edges: [{ from: 1, to: 3 }],
    }) as unknown as RawTreeGraph
  // Fixture B — EDITABLE choose-one (mcParent) group: options '3'/'4' share parent '5' (isMultipleChoice).
  const mcRaw = (): RawTreeGraph =>
    ({
      bounds: { min_x: 0, min_y: 0, max_x: 200, max_y: 0 },
      classes: [],
      nodes: {
        '1': N(0, 0, 'Seed'),
        '5': N(150, 0, 'The Choice', { isMultipleChoice: true }),
        '3': N(100, 0, 'Opt One', { mcParent: '5' }),
        '4': N(200, 0, 'Opt Two', { mcParent: '5' }),
      },
      edges: [
        { from: 1, to: 3 },
        { from: 1, to: 4 },
      ],
    }) as unknown as RawTreeGraph
  // Fixture C — a class-0 stat override so an INFERRED classIndex (setBuild without one) is observable.
  const overrideRaw = (): RawTreeGraph =>
    ({
      bounds: { min_x: 0, min_y: 0, max_x: 200, max_y: 0 },
      classes: [{ idx: 0, name: 'TestClass', overridePairs: { 3: 900 }, ascendancies: [] }],
      nodes: {
        '1': N(0, 0, 'Start', { classStartIndex: [0] }),
        '2': N(100, 0, 'Mid'),
        '3': N(200, 0, 'BaseName', { stats: ['base stat'] }),
      },
      edges: [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ],
      skillOverrides: {
        '900': { id: 'ov', skill: 900, name: 'ClassZeroOverride', icon: '', stats: ['overridden stat'] },
      },
    }) as unknown as RawTreeGraph
  // Screen coords of a node at the INITIAL fit viewport (valid before any zoom/pan) — mirrors the mount's
  // fitViewport (graph.mainBounds + the 0.06·min(w,h) padding), so a pointermove here hit-tests that node.
  const HIT_SIZE = { width: 800, height: 600 }
  const screenAt = (g: TreeGraph, id: string): { sx: number; sy: number } => {
    const node = g.nodeById.get(id)!
    const vp = fitToBounds(g.mainBounds, HIT_SIZE, 0.06 * Math.min(HIT_SIZE.width, HIT_SIZE.height))
    return worldToScreen(vp, HIT_SIZE, node.x, node.y)
  }
  // ── shared setup helpers (collapse the mount → hover / mount → open-pinned-picker boilerplate) ──
  type Mounted = ReturnType<typeof mount>
  /** Build a fixture graph and mount it. */
  const mountFixture = (
    rawFn: () => RawTreeGraph,
    opts: Record<string, unknown> = {},
  ): { graph: TreeGraph; m: Mounted } => {
    const graph = buildGraph(rawFn())
    return { graph, m: mount({ graph, ...opts }) }
  }
  /** Mount a fixture graph and hover node `id` → its tooltip is showing. Returns the hover coords too. */
  const mountHover = (
    rawFn: () => RawTreeGraph,
    id = '2',
    opts: Record<string, unknown> = {},
  ): { graph: TreeGraph; m: Mounted; sx: number; sy: number } => {
    const { graph, m } = mountFixture(rawFn, opts)
    const { sx, sy } = screenAt(graph, id)
    fire(m.canvas, 'pointermove', sx, sy)
    return { graph, m, sx, sy }
  }
  /** Mount a fixture graph and open the PINNED touch picker on node `id` via a touch tap. */
  const mountPinned = (rawFn: () => RawTreeGraph = choiceRaw, id = '2'): { graph: TreeGraph; m: Mounted } => {
    const { graph, m } = mountFixture(rawFn)
    const { sx, sy } = screenAt(graph, id)
    fire(m.canvas, 'pointerdown', sx, sy, { pointerType: 'touch' })
    fire(m.canvas, 'pointerup', sx, sy, { pointerType: 'touch' })
    return { graph, m }
  }
  /** Click the numbered choice row `idx` in the currently-shown tooltip. */
  const clickChoice = (m: Mounted, idx: number): void => {
    m.tip
      .querySelector<HTMLElement>(`[data-choice="${idx}"]`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  it('clicking a choice row in the interactive tooltip auto-paths the mastery and records the pick', () => {
    const { m } = mountHover(choiceRaw) // hover the "Select a bonus" node → interactive tooltip
    expect(m.tip.hidden).toBe(false)
    expect(m.tip.classList.contains('is-interactive')).toBe(true)
    const btn0 = m.tip.querySelector<HTMLElement>('[data-choice="0"]')!
    expect(btn0).not.toBeNull()
    expect(btn0.textContent).toContain('Bonus One') // named option renders <b>name</b>
    expect(m.tip.querySelector('[data-choice="1"]')!.textContent).toContain('+2 to DEX') // nameless → detail only
    btn0.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(m.view.getAllocated()).toEqual(new Set(['1', '2'])) // auto-pathed from the seed
    expect(m.view.getMasteryChoices().get('2')).toBe(0)
    expect(btn0.getAttribute('aria-pressed')).toBe('true') // mouse-hover in-place reflect (no rebuild)
    expect(m.changes).toEqual([2]) // fired onChange for the user edit
  })

  it('re-picking a bonus on an already-allocated mastery updates the pick without a new undo entry', () => {
    const { m } = mountHover(choiceRaw)
    clickChoice(m, 0)
    clickChoice(m, 1) // second pick: node already allocated → the allocate/undo-push branch is skipped
    expect(m.view.getMasteryChoices().get('2')).toBe(1) // pick swapped in place
    expect(m.view.getAllocated()).toEqual(new Set(['1', '2'])) // no re-allocation
    m.view.undo() // exactly ONE undo entry (from the first pick) → straight back to empty
    expect(m.view.getAllocated().size).toBe(0)
  })

  it('deallocating one mastery drops only its pick, keeping a still-allocated mastery pick', () => {
    const { m } = mountFixture(choiceRaw) // both '2' and '3' carry choices
    m.view.setBuild({
      allocated: ['1', '2', '3'],
      masteryChoices: new Map([
        ['2', 0],
        ['3', 1],
      ]),
    })
    expect(m.view.getMasteryChoices().size).toBe(2)
    m.view.toggle('3') // deallocate '3' → pruneChoices drops '3' (gone) but keeps '2' (still allocated)
    expect(m.view.getAllocated().has('3')).toBe(false)
    expect(m.view.getMasteryChoices().has('3')).toBe(false)
    expect(m.view.getMasteryChoices().get('2')).toBe(0) // survivor kept
  })

  it('a choice click in a viewer-only tree never allocates (pickMasteryChoice viewerOnly guard)', () => {
    const { m } = mountHover(choiceRaw, '2', { viewerOnly: true })
    expect(m.tip.hidden).toBe(false)
    expect(m.tip.classList.contains('is-interactive')).toBe(false) // viewer tip stays click-through
    clickChoice(m, 0)
    expect(m.view.getAllocated().size).toBe(0) // the guard short-circuits before allocating
    expect(m.view.getMasteryChoices().size).toBe(0)
  })

  it('picking a bonus on an UNREACHABLE mastery is a no-op (allocateNode returns null → bail)', () => {
    const { m } = mountHover(choiceIsolatedRaw) // node '2' has no edge to the seed
    clickChoice(m, 0)
    expect(m.view.getAllocated().size).toBe(0) // could not path to it → nothing allocated
    expect(m.view.getMasteryChoices().size).toBe(0) // and no pick recorded
  })

  it('re-hovering the SAME node freezes the tooltip (no markup rebuild)', () => {
    const { m, sx, sy } = mountHover(choiceRaw)
    expect(m.tip.hidden).toBe(false)
    const card = m.tip.firstElementChild as HTMLElement
    card.setAttribute('data-frozen-marker', '1') // survives only if the 2nd showTooltip early-returns
    fire(m.canvas, 'pointermove', sx, sy) // identical hover → freeze branch
    expect((m.tip.firstElementChild as HTMLElement).getAttribute('data-frozen-marker')).toBe('1')
  })

  it('an interactive tooltip arms a hide timer on leave, cancelled by re-entering the tip', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { m } = mountHover(choiceRaw) // hover the choices node → interactive tip
      expect(m.tip.classList.contains('is-interactive')).toBe(true)
      fire(m.canvas, 'pointermove', 400, 560) // leave onto empty space → arms the hide-bridge timer
      expect(m.tip.hidden).toBe(false) // NOT hidden immediately (interactive → forgiving delay)
      m.tip.dispatchEvent(new Event('pointerenter')) // cursor bridged into the tip → cancel the timer
      vi.advanceTimersByTime(1000)
      expect(m.tip.hidden).toBe(false) // timer cancelled → tip stays open
    } finally {
      vi.useRealTimers()
    }
  })

  it('a pointerleave on the tooltip itself hides it (non-pinned mouse tip)', () => {
    const { m } = mountHover(choiceRaw)
    expect(m.tip.hidden).toBe(false)
    m.tip.dispatchEvent(new Event('pointerleave'))
    expect(m.tip.hidden).toBe(true)
  })

  it('a TOUCH tap on a chooser opens a pinned picker (no allocation); Close dismisses it', () => {
    const { m } = mountPinned() // touch tap on a chooser → openPinnedPicker
    expect(m.tip.hidden).toBe(false)
    expect(m.tip.classList.contains('is-pinned')).toBe(true)
    expect(m.tip.querySelector('[data-tip-close]')).not.toBeNull()
    expect(m.tip.querySelector('[data-tip-remove]')).toBeNull() // not allocated yet → no Remove row
    expect(m.view.getAllocated().size).toBe(0) // opening the picker must NOT allocate
    m.tip.querySelector<HTMLElement>('[data-tip-close]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(m.tip.hidden).toBe(true)
  })

  it('picking inside a pinned picker allocates + rebuilds with Remove; Remove deallocates and closes', () => {
    const { m } = mountPinned()
    clickChoice(m, 0)
    expect(m.view.getAllocated()).toEqual(new Set(['1', '2'])) // pick allocates via auto-path
    expect(m.view.getMasteryChoices().get('2')).toBe(0)
    const remove = m.tip.querySelector<HTMLElement>('[data-tip-remove]')
    expect(remove).not.toBeNull() // pinned picker REBUILT now that the node is allocated
    remove!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(m.view.getAllocated().has('2')).toBe(false) // Remove deallocated the chooser
    expect(m.view.getMasteryChoices().has('2')).toBe(false)
    expect(m.tip.hidden).toBe(true)
  })

  it('Escape closes a pinned touch picker', () => {
    const { m } = mountPinned()
    expect(m.tip.classList.contains('is-pinned')).toBe(true)
    const wrapper = m.container.querySelector<HTMLElement>('.tree-view')!
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(m.tip.hidden).toBe(true)
  })

  it('a pointerdown OUTSIDE a pinned picker dismisses it (touch click-away)', () => {
    const { m } = mountPinned()
    expect(m.tip.classList.contains('is-pinned')).toBe(true)
    // a document-captured pointerdown whose target is outside the tip → onDocPointerDown → hideTip
    m.canvas.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(m.tip.hidden).toBe(true)
  })

  it('while a picker is pinned, hovering another node does not disturb it (pinned owns the tip)', () => {
    const { graph, m } = mountPinned()
    expect(m.tip.classList.contains('is-pinned')).toBe(true)
    const p1 = screenAt(graph, '1')
    fire(m.canvas, 'pointermove', p1.sx, p1.sy) // hover node '1' → onHover, but pinned → ignored
    expect(m.tip.classList.contains('is-pinned')).toBe(true) // still the pinned picker
    expect(m.tip.textContent).toContain('Beta') // still node '2's picker, not node '1's (Alpha) tooltip
  })

  it('a choose-one OPTION tooltip lists its siblings and the "one of N" subline', () => {
    const { m } = mountHover(mcRaw, '3') // option child (mcParent '5')
    expect(m.tip.hidden).toBe(false)
    expect(m.tip.textContent).toContain('one of 2') // optionCount subline
    const desc = m.tip.querySelector('.itc-desc')!
    expect(desc.textContent).toContain('— also') // option child uses the "— also" label
    expect(desc.textContent).toContain('Opt Two') // the sibling '4' name, excluding self
    expect(desc.textContent).not.toContain('Opt One') // its own name is NOT in the alts list
  })

  it('a choose-one PARENT tooltip lists every option ("Choose one of: A · B")', () => {
    const { m } = mountHover(mcRaw, '5') // the isMultipleChoice group parent
    const desc = m.tip.querySelector('.itc-desc')!
    expect(desc.textContent).toContain('Choose one of') // parent uses the "of" label
    expect(desc.textContent).toContain('Opt One')
    expect(desc.textContent).toContain('Opt Two') // parent lists ALL options
  })

  it('a choose-one swap is size-neutral yet still recorded as an undoable edit (sameSet by contents)', () => {
    const { m } = mountFixture(mcRaw)
    m.view.toggle('3') // allocate option one → {1,3}
    expect(m.view.getAllocated()).toEqual(new Set(['1', '3']))
    m.view.toggle('4') // choose the sibling → swaps '3' out for '4' — same SIZE, different contents
    expect(m.view.getAllocated()).toEqual(new Set(['1', '4']))
    expect(m.view.canUndo()).toBe(true) // a size-only test would have dropped this from history
    m.view.undo() // one undo restores the pre-swap set
    expect(m.view.getAllocated()).toEqual(new Set(['1', '3']))
  })

  it('a poe2:themechange re-reads the palette and schedules a redraw', () => {
    const m = mount()
    flush() // drain the mount's frames so the rAF queue is empty
    expect(m.container.querySelector('canvas')).not.toBeNull()
    window.dispatchEvent(new Event('poe2:themechange'))
    expect(renderHarness.flushRaf()).toBeGreaterThan(0) // onThemeChange → invalidate() queued a frame
  })

  it('redo() on an empty redo stack returns false', () => {
    const m = mount()
    expect(m.view.redo()).toBe(false)
  })

  it('wires a ResizeObserver on the canvas wrapper when one is available', () => {
    const observed: Element[] = []
    class FakeRO {
      observe(el: Element): void {
        observed.push(el)
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeRO)
    const m = mount()
    // index.ts observes the .tree-view wrapper (interact.ts separately observes the canvas) — the
    // wrapper being observed proves the `typeof ResizeObserver !== 'undefined'` branch ran.
    expect(observed).toContain(m.container.querySelector('.tree-view'))
  })

  it('setBuild without a classIndex INFERS the class from the allocated start (drives overrides)', () => {
    const { graph, m } = mountFixture(overrideRaw)
    m.view.setBuild({ allocated: ['1', '2', '3'] }) // NO classIndex, NO ascendancyId → inferClassIndex → 0
    const { sx, sy } = screenAt(graph, '3')
    fire(m.canvas, 'pointermove', sx, sy)
    // class 0's override for node '3' resolves only if the class was inferred; else the base name shows.
    expect(m.tip.textContent).toContain('ClassZeroOverride')
    expect(m.tip.textContent).not.toContain('BaseName')
  })
})

// ── 3. computeJewelSockets — parsed build → per-socket JewelInfo ─────────────────────────────────
/** Minimal PobItem-ish jewel (only the fields computeJewelSockets reads). */
function jewelItem(p: Partial<{ name: string; baseType: string; rarity: string; raw: string; mods: string[] }> = {}) {
  return {
    name: p.name ?? 'Test Jewel',
    baseType: p.baseType ?? 'Cobalt Jewel',
    rarity: p.rarity ?? 'MAGIC',
    raw: p.raw ?? '',
    mods: p.mods ?? [],
  }
}
/** Minimal PobBuild carrying just the sockets + item pool computeJewelSockets consumes. */
function fakePob(
  sockets: Array<{ nodeId: string; itemId: string }>,
  items: Record<string, ReturnType<typeof jewelItem>>,
): PobBuild {
  return { spec: { sockets }, items: new Map(Object.entries(items)) } as unknown as PobBuild
}

describe('computeJewelSockets — per-socket JewelInfo transform', () => {
  it('reads a FACTION radius disc: exact diameter, faction frames/tint/version, corruption, name', () => {
    const m = computeJewelSockets(
      fakePob([{ nodeId: '42', itemId: 'j' }], {
        j: jewelItem({
          name: 'Glorious Vanity',
          baseType: 'Timeless Jewel',
          raw: 'Rarity: MAGIC\nTimeless Jewel\nRadius: Large\nVaal\nCorrupted',
          mods: ['5% increased Attributes'],
        }),
      }),
    )
    const info = m.get('42')!
    expect(info).toBeDefined()
    expect(info.radius).toBe('Large')
    expect(info.ring).toBeDefined()
    expect(info.ring!.diameter).toBe(2600) // PassiveJewelRadii Large.radius 1300 × 2
    expect(info.ring!.frameA).toBe('VaalJewelCircle1')
    expect(info.ring!.frameB).toBe('VaalJewelCircle2')
    expect(info.ring!.tint).toBe('#d23b3b')
    expect(info.version).toBe('Vaal')
    expect(info.corrupted).toBe(true)
    expect(info.name).toBe('Glorious Vanity')
    expect(info.stats).toEqual(['5% increased Attributes'])
  })

  it('falls back to the GENERIC neutral ring (no version) when no faction is named', () => {
    const m = computeJewelSockets(
      fakePob([{ nodeId: '7', itemId: 'j' }], {
        j: jewelItem({
          baseType: 'Cobalt Jewel',
          raw: 'Radius: Medium\nNeutral wording only',
          mods: ['+10 to maximum Life'],
        }),
      }),
    )
    const info = m.get('7')!
    expect(info.ring!.diameter).toBe(2300) // Medium.radius 1150 × 2
    expect(info.ring!.tint).toBe('#6aa0ff') // GENERIC_RING
    expect(info.ring!.frameA).toBe('JewelCircle1')
    expect(info.ring!.frameB).toBe('JewelCircle1Inverse')
    expect(info.version).toBeUndefined()
  })

  it('resolves a RING (annulus) jewel to the inner+outer band of its named size', () => {
    const m = computeJewelSockets(
      fakePob([{ nodeId: '9', itemId: 'j' }], {
        j: jewelItem({
          baseType: 'Cobalt Jewel',
          raw: 'Radius: Variable\nControlled Metamorphosis',
          mods: ['Only affects Passives in Medium-Large Ring'],
        }),
      }),
    )
    const info = m.get('9')!
    expect(info.ring).toBeDefined()
    expect(info.ring!.diameter).toBe(3100) // MediumLarge.ringOuter 1550 × 2
    expect(info.ring!.innerDiameter).toBe(2500) // MediumLarge.ringInner 1250 × 2
  })

  it('surfaces a Time-Lost Diamond’s exact, text-stated attribute swap', () => {
    const m = computeJewelSockets(
      fakePob([{ nodeId: '5', itemId: 'j' }], {
        j: jewelItem({
          baseType: 'Time-Lost Diamond',
          raw: 'Radius: Medium\nTime-Lost Diamond',
          mods: ['Strength → Dexterity'],
        }),
      }),
    )
    expect(m.get('5')!.swap).toEqual({ from: 'Strength', to: 'Dexterity' })
  })

  it('draws NO ring for an unrecognised radius size (never a guessed radius)', () => {
    const m = computeJewelSockets(
      fakePob([{ nodeId: '3', itemId: 'j' }], { j: jewelItem({ raw: 'Radius: Gigantic\nx' }) }),
    )
    const info = m.get('3')!
    expect(info.radius).toBe('Gigantic')
    expect(info.ring).toBeUndefined()
    expect(info.version).toBeUndefined()
  })

  it('sockets plain jewels (no ring), cleans mod markup, and skips empty/absent items', () => {
    const m = computeJewelSockets(
      fakePob(
        [
          { nodeId: '1', itemId: 'a' },
          { nodeId: '2', itemId: 'b' },
          { nodeId: '3', itemId: '0' }, // empty socket
          { nodeId: '4', itemId: 'ghost' }, // item not in the pool
        ],
        {
          a: jewelItem({
            name: '',
            baseType: 'Cobalt Jewel',
            rarity: 'RARE',
            raw: 'Rarity: RARE\nCobalt Jewel',
            mods: ['{crafted}[Attack|Attack] Speed', '   '],
          }),
          b: jewelItem({ name: '', baseType: '', raw: 'x', mods: [] }),
        },
      ),
    )
    expect(m.has('3')).toBe(false) // itemId '0' → empty
    expect(m.has('4')).toBe(false) // absent from items pool
    const a = m.get('1')!
    expect(a.ring).toBeUndefined()
    expect(a.name).toBe('Cobalt Jewel') // name '' → baseType
    expect(a.rarity).toBe('RARE')
    expect(a.stats).toEqual(['Attack Speed']) // markup stripped, blank line dropped
    expect(m.get('2')!.name).toBe('Jewel') // name '' + baseType '' → literal fallback
  })
})
