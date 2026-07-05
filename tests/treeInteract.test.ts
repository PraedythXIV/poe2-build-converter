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
import type { Viewport } from '../src/tree/viewport'
import { mountTree, buildGraph } from '../src/tree/index'
import type { RawTreeGraph } from '../src/tree/graph'
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
