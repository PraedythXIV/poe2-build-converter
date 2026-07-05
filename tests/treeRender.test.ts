// B1 — DRAW-PATH coverage for the Canvas2D passive-tree renderer (src/tree/render.ts) and the
// requestAnimationFrame-gated draw loop in src/tree/index.ts. jsdom returns null from
// getContext('2d') AND ships no Path2D / setPointerCapture / createImageBitmap, and never fires
// <img> onload — so the whole render path is dead code under a plain mount (0% coverage). This
// file installs the minimum stubs to let it EXECUTE against no-op sinks, flushes the rAF so draw()
// actually runs, then drives every re-render trigger (initial draw, zoom, pan, search, hover,
// weapon-set tints, jewel radius rings, allocated-vs-idle styling, and the sprite/atlas/bg/genesis
// image-draw branches) and asserts the observable results (view state, toolbar counts, tooltip DOM)
// — the point is to run the pixels-less draw code and prove each redraw completes without throwing.
//
// Enabler: tests/helpers/canvas2d.ts (installCanvas2d) makes getContext('2d') return a Proxy sink.
// The image singletons in render.ts are process-shared: the FIRST mount here builds them while the
// synchronous Image stub is active, so their .loaded flags flip and the sprite/icon draw branches run.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installRenderHarness, type RenderHarness } from './helpers/renderHarness'
import { buildGraph, mountTree, renderTreeToolbar, wireTreeToolbar } from '../src/tree/index'
import type { MountTreeOptions, TreeView } from '../src/tree/index'
import type { RawTreeGraph, TreeGraph } from '../src/tree/graph'
import { loadGraph } from '../src/tree/graph'
import type { JewelInfo } from '../src/tree/render'
import { fitToBounds, worldToScreen } from '../src/tree/viewport'
import { mountAtlasTree, atlasGraph } from '../src/atlas/index'
import { parsePob } from '../src/convert/parsePob'

const SAMPLE_XML = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')
const SIZE = { width: 900, height: 600 }
const FIT_MARGIN = 0.06 * Math.min(SIZE.width, SIZE.height) // FIT_PADDING_RATIO * min(w,h) — mirrors index.ts

// Real vendored genesis icon-sheet keys (the render branches only fire when node.icon / frame key is
// a real entry in genesisIcons.json). Mirrors GENESIS_WOMB_PATHS / GENESIS_FRAME_PATHS in genesis/index.ts.
const BREACH = 'art/textures/interface/2d/2dart/uiimages/ingame/breachleague/'
const WOMB = {
  normal: `${BREACH}breachtreeinventoryslot1x1.dds`,
  canallocate: `${BREACH}breachtreeinventoryslot1x1canallocate.dds`,
  active: `${BREACH}breachtreeinventoryslot1x1active.dds`,
}
const FRAME = (kind: '' | 'fancy'): { normal: string; canallocate: string; active: string } => ({
  normal: `${BREACH}breachtree${kind}passiveskillscreenpassiveframenormal.dds`,
  canallocate: `${BREACH}breachtree${kind}passiveskillscreenpassiveframecanallocate.dds`,
  active: `${BREACH}breachtree${kind}passiveskillscreenpassiveframeactive.dds`,
})
const KEEPERS_NODE = 'Art/2DArt/SkillIcons/passives/KeepersCurrencyNode.dds'
const KEEPERS_NOTABLE = 'Art/2DArt/SkillIcons/passives/KeepersCurrencyNotable.dds'

// ── stub harness ─────────────────────────────────────────────────────────────────────────────
// The rAF-gated Canvas2D draw path needs jsdom scaffolding (no-op 2D ctx + Path2D shim, a manual rAF
// queue, a sized getBoundingClientRect, and a synchronous Image so render.ts's icon/sprite singletons
// load and their drawImage branches run) — see tests/helpers/renderHarness.ts. flush() runs the queued
// frames; any throw in draw()/renderScene propagates and fails the test, which is exactly the "each
// redraw completes without throwing" assertion.
let harness: RenderHarness

beforeEach(() => {
  harness = installRenderHarness({ width: SIZE.width, height: SIZE.height, image: true })
})

afterEach(() => {
  harness.restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const flush = (rounds = 2): number => harness.flushRaf(rounds)

function mount(opts: MountTreeOptions): { view: TreeView; container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const view = mountTree(container, opts)
  return {
    view,
    container,
    cleanup: () => {
      view.destroy()
      container.remove()
    },
  }
}

const canvasOf = (c: HTMLElement): HTMLCanvasElement => c.querySelector<HTMLCanvasElement>('.tree-canvas')!
const tipOf = (c: HTMLElement): HTMLElement => c.querySelector<HTMLElement>('.tree-tip')!

/** Screen coords of a node at the INITIAL fit viewport (valid before any zoom/pan/search). */
function screenOf(graph: TreeGraph, id: string): { sx: number; sy: number } {
  const node = graph.nodeById.get(id)!
  const vp = fitToBounds(graph.mainBounds, SIZE, FIT_MARGIN)
  return worldToScreen(vp, SIZE, node.x, node.y)
}

const ptr = (el: HTMLElement, type: string, sx: number, sy: number, init: PointerEventInit = {}): void => {
  el.dispatchEvent(new PointerEvent(type, { clientX: sx, clientY: sy, button: 0, bubbles: true, ...init }))
}
const wheel = (el: HTMLElement, deltaY: number, sx = 450, sy = 300): void => {
  el.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX: sx, clientY: sy, bubbles: true, cancelable: true }))
}

// ── a deterministic full-LOD synthetic graph (fit zoom > 0.18 → the sprite/frame render path) ─────
type RawNodeLite = {
  id: string
  name: string
  icon: string
  stats: string[]
  x: number
  y: number
  group: number
  orbit: number
  orbitIndex: number
  [k: string]: unknown
}
function rn(x: number, y: number, extra: Record<string, unknown> = {}): RawNodeLite {
  return { id: 'n', name: 'Node', icon: '', stats: [], x, y, group: 1, orbit: 0, orbitIndex: 0, ...extra }
}
function rawGraph(
  nodes: Record<string, RawNodeLite>,
  edges: Array<{ from: number; to: number; orbitX?: number; orbitY?: number }>,
  classes: unknown[] = [],
): RawTreeGraph {
  return { bounds: { min_x: 0, min_y: 0, max_x: 2000, max_y: 1500 }, classes, nodes, edges } as unknown as RawTreeGraph
}

/** All node kinds + arc edges + a group-centre fallback arc + a TestAsc cluster. Fit zoom ≈ 0.52. */
function fullLodRaw(): RawTreeGraph {
  const nodes: Record<string, RawNodeLite> = {
    '1': rn(200, 750, { name: 'Warrior Start', classStartIndex: [0] }),
    '2': rn(500, 750, { name: 'Vigor', stats: ['+10 to maximum Life'] }),
    '3': rn(1000, 750, {
      name: 'Deadly Focus',
      notable: true,
      stats: ['20% increased Damage'],
      flavour: ['They fought as one.'],
      grantedSkill: { name: 'Spark', desc: 'A crackling bolt.' },
    }),
    '4': rn(1400, 750, {
      name: 'Iron Will',
      keystone: true,
      stats: ['Cannot use Mana'],
      flavour: ['Unbending.'],
      unlockConstraint: { nodes: [7] },
    }),
    '5': rn(1800, 750, { name: 'Jewel Socket', jewel: true }),
    '6': rn(500, 500, { name: 'Attunement', isGenericAttribute: true }),
    '7': rn(500, 1000, { name: 'Might', grantedStrength: 5, grantedDexterity: 5 }),
    '8': rn(900, 500, { name: 'Warmonger', weaponPassivePointsGranted: 6 }),
    '10': rn(1000, 650, { name: 'Arc A' }),
    '11': rn(1100, 750, { name: 'Arc B' }),
    '12': rn(700, 1100, { name: 'Hub', orbit: 0, group: 9 }),
    '13': rn(700, 1000, { name: 'Ring A', group: 9, orbit: 2 }),
    '14': rn(800, 1100, { name: 'Ring B', group: 9, orbit: 2 }),
    '15': rn(1750, 620, { name: 'Jewel Socket', jewel: true }),
    // TestAsc cluster: offset -1500/-1100 overlays the start to display-pos (1500,1100) — inside the
    // view but clear of the main nodes we hover-test (no node collision at hit-test time).
    '90': rn(1200, 1300, { name: 'Asc Start', ascStart: true, ascendancyId: 'TestAsc' }),
    '91': rn(1250, 1300, { name: 'Asc Notable', notable: true, ascendancyId: 'TestAsc', stats: ['asc'] }),
    '92': rn(1300, 1300, { name: 'Asc Small', ascendancyId: 'TestAsc' }),
  }
  const edges = [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 3, to: 4 },
    { from: 4, to: 5 },
    { from: 5, to: 15 },
    { from: 2, to: 6 },
    { from: 6, to: 7 },
    { from: 2, to: 8 },
    { from: 3, to: 10 },
    { from: 10, to: 11, orbitX: 1000, orbitY: 750 }, // export-shipped arc centre → arc edge
    { from: 13, to: 14 }, // same group+orbit>0, no arc centre → group-centre fallback arc
    { from: 1, to: 90 }, // main↔ascendancy bridge
    { from: 90, to: 91 },
    { from: 91, to: 92 },
  ]
  const classes = [
    { idx: 0, name: 'TestClass', ascendancies: [{ id: 'TestAsc', name: 'Test Asc', offsetX: -1500, offsetY: -1100 }] },
  ]
  return rawGraph(nodes, edges, classes)
}

/** A radius (annulus) jewel + a plain jewel — exercises rings, conqueror tint/icon override, and the
 *  unique-art / base-art / gem-dot art priority ladder. */
function jewelSockets(): Map<string, JewelInfo> {
  return new Map<string, JewelInfo>([
    [
      '5',
      {
        name: 'Grand Spectrum', // a REAL unique key in uniqueIcons.json → the unique-art draw branch
        baseType: 'Time-Lost Emerald',
        rarity: 'UNIQUE',
        corrupted: true,
        radius: 'Large',
        stats: ['+10 to a Random Attribute', 'Nearby Passives are Conquered by the Vaal'],
        ring: {
          frameA: 'JewelCircle1',
          frameB: 'JewelCircle1Inverse',
          diameter: 2400,
          innerDiameter: 1200,
          tint: '#c0392b',
        },
        version: 'Vaal',
        swap: { from: 'Strength', to: 'Dexterity' },
      },
    ],
    ['15', { name: 'Cobalt Jewel', baseType: 'Emerald', rarity: 'RARE', stats: ['+5% increased Attack Speed'] }],
    // neither a known unique NOR a resolvable base → the last-resort "gem dot" art branch.
    ['13', { name: 'Mystery Jewel', baseType: 'Not A Real Base', rarity: 'MAGIC', stats: ['+1 to nothing'] }],
  ])
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('render.ts draw path — dots LOD (real character tree at fit) + hover', () => {
  it('draws idle/allocated/weapon-set dots and re-renders on hover of an allocated node', () => {
    const graph = loadGraph()
    const ids = parsePob(SAMPLE_XML).spec.nodes
    const { view, container, cleanup } = mount({}) // real character tree
    // weapon-set slices out of the allocated set → idle + alloc + ws1 + ws2 dot paths all populate.
    view.setBuild({ allocated: ids, classIndex: 0, weaponSet1: ids.slice(0, 4), weaponSet2: ids.slice(4, 8) })
    expect(flush()).toBeGreaterThan(0) // draw() actually ran (real render.ts executed)
    expect(view.getAllocated().size).toBe(ids.length)
    const counts = view.getCounts()
    expect(counts.main).toBeGreaterThan(0)
    // set-1-only and set-2-only both populate (start/free nodes are excluded, so not the full slice).
    expect(counts.ws1).toBeGreaterThan(0)
    expect(counts.ws2).toBeGreaterThan(0)

    // hover an allocated node → hovered dot branch + tooltip. Fit zoom (~0.02) keeps every node on
    // screen, so the fit-derived screen coords are exact. Pick a node the spatial index actually holds
    // (masteries + foreign-ascendancy nodes are excluded from the displayed points).
    const target = ids.find((id) => {
      const n = graph.nodeById.get(id)
      return !!n && !!n.name && !n.ascendancyId && n.kind !== 'mastery'
    })!
    const { sx, sy } = screenOf(graph, target)
    ptr(canvasOf(container), 'pointermove', sx, sy)
    flush()
    expect(canvasOf(container).style.cursor).toBe('pointer')
    expect(tipOf(container).hidden).toBe(false)
    expect(tipOf(container).innerHTML).toContain('itc-card')
    cleanup()
  })
})

describe('render.ts draw path — sprites/full LOD, central art, mastery glows, search, bg toggle', () => {
  it('zooms into the sprite LOD and re-renders on search + background-art toggle', () => {
    const ids = parsePob(SAMPLE_XML).spec.nodes
    // centralArt loads the passive-bg disc/ring + mastery-glow + jewel sheets. classIndex 2 has a
    // real classFrame0 entry, so the central disc actually draws.
    const { view, container, cleanup } = mount({ centralArt: true })
    view.setBuild({ allocated: ids, classIndex: 2 })
    flush()

    // toolbar is an observable surface: the count badge reflects getCounts().
    const bar = document.createElement('div')
    bar.innerHTML = renderTreeToolbar()
    document.body.appendChild(bar)
    const unwire = wireTreeToolbar(bar, view)
    const counts = view.getCounts()
    expect(bar.querySelector<HTMLElement>('.ttb-count b')!.textContent).toBe(`${counts.main}/${counts.available}`)

    // zoom in past the icon/full LOD threshold (0.18): two wheels lift ~0.02 → ~0.8.
    wheel(canvasOf(container), -1200)
    wheel(canvasOf(container), -1200)
    expect(flush()).toBeGreaterThan(0) // full-LOD sprite + frame draw path executed

    // search re-frames the camera on the matches and draws the highlight rings.
    view.focusSearch('Fast Acting Toxins')
    flush()
    view.focusSearch('') // clearing removes the highlight (another redraw)
    flush()

    // background-art toggle flips showCentralArt → both branches of the central-art draw.
    const bgInput = bar.querySelector<HTMLInputElement>('.ttb-bg-input')!
    bgInput.checked = false
    bgInput.dispatchEvent(new Event('change'))
    flush()
    bgInput.checked = true
    bgInput.dispatchEvent(new Event('change'))
    flush()

    view.redraw()
    expect(flush()).toBeGreaterThan(0)
    unwire()
    bar.remove()
    cleanup()
  })
})

describe('render.ts draw path — synthetic full LOD: all node kinds, frames, weapon rings, arcs, jewels, conqueror, ascendancy', () => {
  it('renders every node-kind frame, weapon-set rings, radius rings, and the conqueror node-art override', () => {
    const graph = buildGraph(fullLodRaw())
    // centralArt so the jewel-radius sheet loads (rings draw); a socketed radius jewel also turns on
    // the continuous spin loop (animating) — flushing a couple of frames covers the re-schedule.
    const { view, container, cleanup } = mount({ graph, centralArt: true })
    view.setBuild({
      allocated: ['1', '2', '3', '4', '5', '6', '8', '10', '11', '15'],
      classIndex: 0,
      ascendancyId: 'TestAsc', // selects the cluster → ascendancy overlay + asc frames draw
      weaponSet1: ['2', '6'], // set-1-only → ws1 ring + ws1 edge (2-6)
      weaponSet2: ['3'], // set-2-only → ws2 ring
      jewels: jewelSockets(),
      attributeChoices: new Map([['6', 'Strength']]),
    })
    expect(flush()).toBeGreaterThan(0)
    expect(view.getAscendancyId()).toBe('TestAsc')
    expect(view.getCounts().main).toBeGreaterThan(0)

    // hover the notable → tooltip carries the conqueror + time-lost swap cues (from the radius jewel).
    const n3 = screenOf(graph, '3')
    ptr(canvasOf(container), 'pointermove', n3.sx, n3.sy)
    flush()
    const tip = tipOf(container)
    expect(tip.hidden).toBe(false)
    expect(tip.innerHTML).toContain('Deadly Focus')
    expect(tip.querySelector('[data-tag="conqueror"]')).not.toBeNull()

    // hover the keystone with an unmet unlock prerequisite (node 7 not allocated) → locked cue.
    const n4 = screenOf(graph, '4')
    ptr(canvasOf(container), 'pointermove', n4.sx, n4.sy)
    flush()
    expect(tip.querySelector('[data-tag="locked"]')).not.toBeNull()

    // hover the socketed unique jewel → the item card (unique-art node is also drawn on canvas).
    const n5 = screenOf(graph, '5')
    ptr(canvasOf(container), 'pointermove', n5.sx, n5.sy)
    flush()
    expect(tip.innerHTML).toContain('Grand Spectrum')
    expect(tip.innerHTML).toContain('itc-card--featured')
    cleanup()
  })
})

describe('render.ts draw path — atlas tree: real .dds icons, background panels, decorative hubs', () => {
  it('renders atlas icons + subtree background panels and re-renders on allocation edits', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = mountAtlasTree(container, { editable: true })
    view.setBuild({ allocated: [] })
    flush()

    // zoom in so the tree leaves the dots LOD and the atlas-icon / decorative-hub branches run.
    wheel(canvasOf(container), -1400)
    wheel(canvasOf(container), -1400)
    flush()

    // a user allocation edit (toggle a neighbour of a root) schedules a redraw.
    const rootId = Object.keys(atlasGraph.nodes).find((k) => atlasGraph.nodes[k]!.atlasRoot)!
    const root = Number(rootId)
    const edge = atlasGraph.edges.find((e) => e.from === root || e.to === root)!
    const neighbor = String(edge.from === root ? edge.to : edge.from)
    view.toggle(neighbor)
    expect(flush()).toBeGreaterThan(0)
    expect(view.getAllocated().has(rootId)).toBe(true)
    expect(view.getAllocated().has(neighbor)).toBe(true)

    // a "Select a bonus" mastery: hovering it builds the interactive choices tooltip.
    const choiceId = Object.keys(atlasGraph.nodes).find(
      (k) => ((atlasGraph.nodes as Record<string, { choices?: unknown[] }>)[k]!.choices?.length ?? 0) > 0,
    )
    if (choiceId) {
      view.setBuild({ allocated: [rootId, choiceId], masteryChoices: new Map([[choiceId, 0]]) })
      flush()
      expect(view.getMasteryChoices().get(choiceId)).toBe(0)
    }
    view.destroy()
    container.remove()
  })
})

describe('render.ts draw path — genesis render: womb egg socket, Breach node frames, background facade', () => {
  it('draws the uncropped womb art, the per-state Breach frames, and the facade', () => {
    const nodes: Record<string, RawNodeLite> = {
      '1': rn(400, 650, { name: 'Currency Womb', keystone: true, iconUncropped: true, icon: WOMB.normal }),
      '2': rn(700, 700, { name: 'Keeper', icon: KEEPERS_NODE }),
      '3': rn(1000, 750, { name: 'Keeper Notable', notable: true, icon: KEEPERS_NOTABLE }),
    }
    const graph = buildGraph(
      rawGraph(nodes, [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ]),
    )
    const { view, cleanup } = mount({
      graph,
      genesisIcons: true,
      genesisFrames: { small: FRAME(''), fancy: FRAME('fancy') },
      genesisWomb: WOMB,
      genesisBg: { key: 'genesis', cx: 0, cy: 0, size: 2000, sizeY: 1500, alpha: 1 },
      rootIds: ['1'],
      viewerOnly: false,
    })
    // allocate the womb (active egg art) + a neighbour (adjacent node becomes "can-allocate" frame art).
    view.setBuild({ allocated: ['1', '2'] })
    expect(flush()).toBeGreaterThan(0)
    expect(view.getAllocated().size).toBe(2)
    cleanup()
  })
})

describe('index.ts draw loop — pan, wheel zoom, toggle, fit, subscribe', () => {
  it('pan clears hover + hides the tip; wheel/toggle/fit each schedule a redraw', () => {
    const graph = buildGraph(fullLodRaw())
    const { view, container, cleanup } = mount({ graph })
    view.setBuild({ allocated: ['1', '2', '3'], classIndex: 0 })
    flush()

    const canvas = canvasOf(container)
    const seen: number[] = []
    const unsub = view.subscribe((a) => seen.push(a.size))

    // hover a node → pointer cursor + tooltip.
    const n2 = screenOf(graph, '2')
    ptr(canvas, 'pointermove', n2.sx, n2.sy)
    flush()
    expect(canvas.style.cursor).toBe('pointer')
    expect(tipOf(container).hidden).toBe(false)

    // drag-pan past the threshold → hover cleared (grab cursor) + tip hidden.
    ptr(canvas, 'pointerdown', n2.sx, n2.sy)
    ptr(canvas, 'pointermove', n2.sx + 60, n2.sy + 40)
    expect(canvas.style.cursor).toBe('grab')
    expect(tipOf(container).hidden).toBe(true)
    ptr(canvas, 'pointerup', n2.sx + 60, n2.sy + 40)
    expect(flush()).toBeGreaterThan(0)

    // wheel zoom schedules a redraw.
    wheel(canvas, -600)
    expect(flush()).toBeGreaterThan(0)

    // programmatic toggle auto-paths and redraws; subscribe fired for the allocation change.
    view.toggle('8') // reachable via 2-8 (node 4 carries an unlock gate — deliberately not used here)
    flush()
    expect(view.getAllocated().has('8')).toBe(true)
    expect(seen.length).toBeGreaterThan(0)

    // fit re-frames and redraws.
    view.fit()
    expect(flush()).toBeGreaterThan(0)

    unsub()
    cleanup()
  })
})
