// B1 — pure-logic tests for the interactive tree (no canvas in jsdom): graph build +
// blocking, BFS auto-path, cascade deallocation, viewport math, spatial hash, the
// fixture-coverage sanity check against the real vendored treeGraph.json, plus
// mount-level behaviour (weapon-set tints, allocation caps badge, undo/redo history,
// seedIds-based allocation for rootless graphs like the atlas).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadGraph, buildGraph, blockedNodeIds, ascendancyOverlayDelta } from '../src/tree/graph'
import type { RawTreeGraph } from '../src/tree/graph'
import { worldToScreen, screenToWorld, fitToBounds, visibleWorldRect } from '../src/tree/viewport'
import { buildSpatialIndex, queryRect, nodeAt } from '../src/tree/spatial'
import { shortestPathFromAny, allocateNode, deallocateNode } from '../src/tree/interact'
import { weaponSetTint, edgeWeaponSetTint, resolvePalette, CONQUEROR_BY_VERSION } from '../src/tree/render'
import { rawNode, testClassFrame, mainChainNodes, type SynRawNode } from './helpers/graphs'
import conquerorTreeVersionsJson from '../src/data/conquerorTreeVersions.json'
import { mountTree, renderTreeToolbar, wireTreeToolbar, PASSIVE_CAP, ASCENDANCY_CAP } from '../src/tree/index'
import type { MountTreeOptions, TreeView } from '../src/tree/index'
import { mountAtlasTree, atlasGraph, atlasRootIds } from '../src/atlas/index'
import { parsePob } from '../src/convert/parsePob'

const SAMPLE_XML = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')

// Small synthetic graph for allocation tests:
//
//        a - b - c
//       /         \
//      S           T      (S-d-T is the short route; S-a-b-c-T the long one)
//       \         /
//        d ------
function syntheticAdjacency(): Map<string, string[]> {
  const edges: Array<[string, string]> = [
    ['S', 'a'],
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'T'],
    ['S', 'd'],
    ['d', 'T'],
  ]
  const adj = new Map<string, string[]>()
  for (const [x, y] of edges) {
    adj.set(x, [...(adj.get(x) ?? []), y])
    adj.set(y, [...(adj.get(y) ?? []), x])
  }
  return adj
}

describe('tree graph (real vendored data)', () => {
  const graph = loadGraph()

  it('builds undirected adjacency from the edges array', () => {
    // node 4 ("Shock Chance") connects to 11578 and 48833 in the export
    const nb = graph.adjacency.get('4') ?? []
    expect(nb).toContain('11578')
    expect(nb).toContain('48833')
    // symmetric
    expect(graph.adjacency.get('11578')).toContain('4')
    // every edge endpoint resolved (the synthetic root and its edges were pruned upstream)
    for (const e of graph.edges) {
      expect(graph.nodeById.has(e.a)).toBe(true)
      expect(graph.nodeById.has(e.b)).toBe(true)
    }
  })

  it('exposes the 6 class starts under all 12 class indices', () => {
    expect(graph.classStartIds.size).toBe(6)
    expect(graph.classStartByIndex.get(10)).toBe('44683') // Monk shares the Shadow start
    expect(graph.classStartByIndex.get(4)).toBe('44683')
    expect(graph.classStartByIndex.get(1)).toBe('54447') // Witch
  })

  it('keeps masteries and main↔ascendancy bridges out of the navigation adjacency', () => {
    for (const node of graph.nodeById.values()) {
      if (node.kind === 'mastery') expect(graph.navAdjacency.has(node.id)).toBe(false)
    }
    // a class start never reaches ascendancy nodes directly in nav (bridge edges removed)
    for (const startId of graph.classStartIds) {
      for (const nb of graph.navAdjacency.get(startId) ?? []) {
        expect(graph.nodeById.get(nb)!.ascendancyId).toBeNull()
      }
    }
  })

  it('blocks foreign class starts and foreign-ascendancy clusters', () => {
    const blocked = blockedNodeIds(graph, 10, 'Monk1') // Monk / Martial Artist
    expect(blocked.has('44683')).toBe(false) // own start stays traversable
    expect(blocked.has('47175')).toBe(true) // Marauder start blocked
    expect(blocked.has('54447')).toBe(true) // Witch start blocked
    const monk1 = graph.ascendancies.get('Monk1')!
    for (const id of monk1.nodeIds) expect(blocked.has(id)).toBe(false)
    const witch1 = graph.ascendancies.get('Witch1')!
    for (const id of witch1.nodeIds) expect(blocked.has(id)).toBe(true)
  })

  it('flags hideConnection edges as hidden (render-skip), keeping them pathable', () => {
    const hidden = graph.edges.filter((e) => e.hidden)
    expect(hidden.length).toBeGreaterThan(0)
    for (const e of hidden) {
      const a = graph.nodeById.get(e.a)!
      const b = graph.nodeById.get(e.b)!
      expect(a.hideConnection || b.hideConnection).toBe(true)
    }
  })

  it('computes the ascendancy overlay so the start node lands at (-offsetX, -offsetY)', () => {
    const delta = ascendancyOverlayDelta(graph, 'Monk1')!
    const asc = graph.ascendancies.get('Monk1')!
    const start = graph.nodeById.get(asc.startNodeId!)!
    expect(start.x + delta.dx).toBeCloseTo(-asc.offsetX, 5)
    expect(start.y + delta.dy).toBeCloseTo(-asc.offsetY, 5)
  })
})

describe('allocation BFS (synthetic graph)', () => {
  const adj = syntheticAdjacency()

  it('auto-paths to a non-adjacent node along the shortest route', () => {
    const next = allocateNode(adj, new Set(), new Set(['S']), 'T')!
    expect(next).toEqual(new Set(['S', 'd', 'T'])) // 2 hops via d, not 4 via a-b-c
  })

  it('is multi-source: paths from the closest allocated node', () => {
    const allocated = new Set(['S', 'a', 'b'])
    const next = allocateNode(adj, allocated, new Set(['S']), 'T')!
    // from b the route b-c-T (2 new) beats S-d-T only by tie — both add 2 nodes; accept either
    expect(next.has('T')).toBe(true)
    expect(next.size).toBe(allocated.size + 2)
  })

  it('respects blocked nodes', () => {
    const path = shortestPathFromAny(adj, new Set(['S']), 'T', new Set(['d']))
    expect(path).toEqual(['S', 'a', 'b', 'c', 'T'])
    expect(shortestPathFromAny(adj, new Set(['S']), 'T', new Set(['d', 'b']))).toBeNull()
  })

  it('returns null for unreachable targets instead of mutating', () => {
    const allocated = new Set(['S'])
    expect(allocateNode(adj, allocated, new Set(['S']), 'zzz')).toBeNull()
    expect(allocated).toEqual(new Set(['S']))
  })

  it('cascade deallocation drops orphaned nodes, keeping the set seed-connected', () => {
    // full loop: removing d keeps T reachable via c — only d goes
    const loop = new Set(['S', 'a', 'b', 'c', 'T', 'd'])
    expect(deallocateNode(adj, loop, new Set(['S']), 'd')).toEqual(new Set(['S', 'a', 'b', 'c', 'T']))
    // chain S-a-b-c: removing b orphans c
    const chain = new Set(['S', 'a', 'b', 'c'])
    expect(deallocateNode(adj, chain, new Set(['S']), 'b')).toEqual(new Set(['S', 'a']))
  })

  it('never deallocates a seed root', () => {
    const allocated = new Set(['S', 'd', 'T'])
    expect(deallocateNode(adj, allocated, new Set(['S']), 'S')).toEqual(allocated)
  })
})

describe('viewport math', () => {
  it('fitToBounds centres the bounds and fits the smaller axis', () => {
    const vp = fitToBounds({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, { width: 200, height: 100 }, 0)
    expect(vp.x).toBe(50)
    expect(vp.y).toBe(25)
    expect(vp.zoom).toBe(2)
  })

  it('world↔screen round-trips', () => {
    const vp = { x: 10, y: -20, zoom: 1.5 }
    const size = { width: 800, height: 600 }
    const { sx, sy } = worldToScreen(vp, size, 123.4, -56.7)
    const { wx, wy } = screenToWorld(vp, size, sx, sy)
    expect(wx).toBeCloseTo(123.4, 9)
    expect(wy).toBeCloseTo(-56.7, 9)
  })

  it('visibleWorldRect inverts the zoom', () => {
    const rect = visibleWorldRect({ x: 0, y: 0, zoom: 2 }, { width: 400, height: 200 })
    expect(rect).toEqual({ minX: -100, minY: -50, maxX: 100, maxY: 50 })
  })
})

describe('spatial hash', () => {
  const index = buildSpatialIndex(
    [
      { id: 'p1', x: 0, y: 0 },
      { id: 'p2', x: 100, y: 0 },
      { id: 'p3', x: 5000, y: 5000 },
    ],
    400,
  )

  it('queryRect returns points whose cells intersect', () => {
    const ids = queryRect(index, { minX: -50, minY: -50, maxX: 150, maxY: 50 })
    expect(ids).toContain('p1')
    expect(ids).toContain('p2')
    expect(ids).not.toContain('p3')
  })

  it('nodeAt picks the nearest point within the radius', () => {
    expect(nodeAt(index, 40, 0, 60)).toBe('p1')
    expect(nodeAt(index, 60, 0, 60)).toBe('p2')
    expect(nodeAt(index, 60, 0, 10)).toBeNull()
    // straddles a cell boundary — still found via the rect expansion
    expect(nodeAt(index, 4990, 4990, 50)).toBe('p3')
  })
})

// ── mount-level fixtures (jsdom: canvas 2d context is null — the view runs logic-only) ──────
// rawNode / SynRawNode live in tests/helpers/graphs.ts (shared with overrides.test.ts).

// Synthetic raw graph (treeGraph.json shape):
//
//   [1]──2──3──4      5 (isolated)      90(ascStart)──91──92   (TestAsc cluster)
//    └────────────bridge────────────────90
//
// [1] = class start for class index 0. The 1↔90 bridge edge never enters navAdjacency
// (main↔ascendancy), so the cluster is only reachable through the TestAsc seed.
function syntheticRawGraph(): RawTreeGraph {
  return {
    ...testClassFrame(),
    nodes: {
      ...mainChainNodes(), // [1]──2──3
      '4': rawNode(300, 0),
      '5': rawNode(5000, 5000),
      '90': rawNode(2000, 2000, { ascStart: true, ascendancyId: 'TestAsc' }),
      '91': rawNode(2100, 2000, { notable: true, ascendancyId: 'TestAsc' }),
      '92': rawNode(2200, 2000, { ascendancyId: 'TestAsc' }),
      '93': rawNode(2300, 2000, { ascendancyId: 'TestAsc', isFree: true }), // free asc node (no point)
    },
    edges: [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
      { from: 1, to: 90 }, // bridge
      { from: 90, to: 91 },
      { from: 91, to: 92 },
      { from: 92, to: 93 },
    ],
  }
}

/** Atlas-like graph: chain 1-2-3-4 + isolated 5, no classes, no class starts. */
function rootedRawGraph(): RawTreeGraph {
  return {
    bounds: { min_x: 0, min_y: 0, max_x: 6000, max_y: 6000 },
    classes: [],
    nodes: {
      '1': rawNode(0, 0),
      '2': rawNode(100, 0),
      '3': rawNode(200, 0),
      '4': rawNode(300, 0),
      '5': rawNode(5000, 5000),
    },
    edges: [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
    ],
  }
}

/** Chain of `n` nodes (node 1 = class start) — big enough to exceed PASSIVE_CAP. */
function chainRawGraph(n: number): RawTreeGraph {
  const nodes: Record<string, SynRawNode> = { '1': rawNode(0, 0, { classStartIndex: [0] }) }
  const edges: Array<{ from: number; to: number }> = []
  for (let i = 2; i <= n; i++) {
    nodes[String(i)] = rawNode(i * 100, 0)
    edges.push({ from: i - 1, to: i })
  }
  return { bounds: { min_x: 0, min_y: 0, max_x: n * 100, max_y: 100 }, classes: [], nodes, edges }
}

function mountView(
  raw: RawTreeGraph,
  opts: MountTreeOptions = {},
): { view: TreeView; container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const view = mountTree(container, { graph: buildGraph(raw), ...opts })
  return {
    view,
    container,
    cleanup: () => {
      view.destroy()
      container.remove()
    },
  }
}

describe('weapon-set classification (PoB tints: greenish set 1, reddish set 2)', () => {
  const s1 = new Set(['a', 'b', 'shared', 'shared2'])
  const s2 = new Set(['x', 'y', 'shared', 'shared2'])

  it('tints nodes in exactly one set; both (= shared) and neither stay normal', () => {
    expect(weaponSetTint('a', s1, s2)).toBe('ws1')
    expect(weaponSetTint('x', s1, s2)).toBe('ws2')
    expect(weaponSetTint('shared', s1, s2)).toBe('none')
    expect(weaponSetTint('plain', s1, s2)).toBe('none')
  })

  it('tints edges only when BOTH endpoints sit in the set', () => {
    expect(edgeWeaponSetTint('a', 'b', s1, s2)).toBe('ws1')
    expect(edgeWeaponSetTint('x', 'y', s1, s2)).toBe('ws2')
    expect(edgeWeaponSetTint('a', 'x', s1, s2)).toBe('none') // crosses sets
    expect(edgeWeaponSetTint('a', 'plain', s1, s2)).toBe('none') // leaves the set
    expect(edgeWeaponSetTint('a', 'shared', s1, s2)).toBe('ws1') // continues through a shared node
    expect(edgeWeaponSetTint('shared', 'shared2', s1, s2)).toBe('none') // fully shared segment
  })

  it('resolvePalette exposes the --tree-ws1/--tree-ws2 tokens (hex fallbacks in jsdom)', () => {
    const palette = resolvePalette(document.createElement('div'))
    expect(palette.ws1).toBe('#79c97e')
    expect(palette.ws2).toBe('#d9705c')
  })
})

describe('allocation caps (PASSIVE_CAP / ASCENDANCY_CAP)', () => {
  it('exports the caps from cvenzin’s build store', () => {
    expect(PASSIVE_CAP).toBe(123)
    expect(ASCENDANCY_CAP).toBe(8)
  })

  it('getCounts splits main vs ascendancy points; start nodes are free', () => {
    const { view, cleanup } = mountView(syntheticRawGraph())
    view.setBuild({
      allocated: ['1', '2', '3', '90', '91', '92'], // incl. class start + asc start
      ascendancyId: 'TestAsc',
      classIndex: 0,
    })
    expect(view.getCounts()).toMatchObject({ main: 2, asc: 2 }) // '1' and '90' cost no points
    expect(view.getAscendancyId()).toBe('TestAsc')
    cleanup()
  })

  it('weapon-set passives share point slots: main = shared + max(ws1, ws2)', () => {
    const { view, cleanup } = mountView(syntheticRawGraph())
    view.setBuild({
      allocated: ['1', '2', '3'], // '1' = class start (free); '2','3' = main nodes
      classIndex: 0,
      weaponSet1: ['2'], // set-I-only
      weaponSet2: ['3'], // set-II-only
    })
    // '2' (Set I) and '3' (Set II) overlap into ONE specialised point → main 1, not 2
    expect(view.getCounts()).toMatchObject({ main: 1, ws1: 1, ws2: 1 })
    cleanup()
  })

  it('IsFree nodes cost no point + the budget is always the level-100 max', () => {
    const { view, cleanup } = mountView(syntheticRawGraph())
    // '90' ascStart (free), '91'/'92' asc (1 each), '93' asc but IsFree (0) → asc 2, not 3.
    view.setBuild({ allocated: ['1', '2', '90', '91', '92', '93'], ascendancyId: 'TestAsc', classIndex: 0 })
    const counts = view.getCounts()
    expect(counts.asc).toBe(2) // '93' excluded by IsFree
    expect(counts.main).toBe(1) // only '2' (class start '1' is free)
    expect(counts.available).toBe(PASSIVE_CAP) // level-100 max, never the current-level budget
    cleanup()
  })

  it('toolbar badge shows N/123 and the asc segment only while an ascendancy is selected', () => {
    const { view, cleanup } = mountView(syntheticRawGraph())
    const bar = document.createElement('div')
    bar.innerHTML = renderTreeToolbar()
    view.setBuild({ allocated: ['2', '3', '90', '91', '92'], ascendancyId: 'TestAsc', classIndex: 0 })
    const unwire = wireTreeToolbar(bar, view)

    const countEl = bar.querySelector<HTMLElement>('.ttb-count b')!
    const ascEl = bar.querySelector<HTMLElement>('.ttb-count-asc')!
    expect(countEl.textContent).toBe(`2/${PASSIVE_CAP}`)
    expect(ascEl.hidden).toBe(false)
    expect(ascEl.textContent).toBe(`· 2/${ASCENDANCY_CAP} asc`)
    expect(ascEl.classList.contains('ttb-over')).toBe(false)

    view.setBuild({ allocated: ['2'], classIndex: 0 }) // no ascendancy → segment hides
    expect(countEl.textContent).toBe(`1/${PASSIVE_CAP}`)
    expect(ascEl.hidden).toBe(true)
    unwire()
    cleanup()
  })

  it('flags the main count with the over-cap class past 123 points', () => {
    const { view, cleanup } = mountView(chainRawGraph(130))
    const bar = document.createElement('div')
    bar.innerHTML = renderTreeToolbar()
    const ids = Array.from({ length: 129 }, (_, i) => String(i + 2)) // 2..130
    view.setBuild({ allocated: ids, classIndex: 0 })
    const unwire = wireTreeToolbar(bar, view)

    const countEl = bar.querySelector<HTMLElement>('.ttb-count b')!
    expect(view.getCounts()).toMatchObject({ main: 129, asc: 0 })
    expect(countEl.textContent).toBe(`129/${PASSIVE_CAP}`)
    expect(countEl.classList.contains('ttb-over')).toBe(true)
    unwire()
    cleanup()
  })
})

describe('undo/redo (user-edit history inside the view)', () => {
  it('toggle pushes history; undo/redo walk it and fire onChange', () => {
    const changes: number[] = []
    const { view, cleanup } = mountView(syntheticRawGraph(), { onChange: (a) => changes.push(a.size) })
    view.setBuild({ allocated: [], classIndex: 0 })
    expect(view.canUndo()).toBe(false)
    expect(view.undo()).toBe(false)

    view.toggle('3') // auto-path 1-2-3 from the class-start seed
    expect(view.getAllocated()).toEqual(new Set(['1', '2', '3']))
    expect(view.canUndo()).toBe(true)
    expect(view.canRedo()).toBe(false)

    view.toggle('4')
    expect(view.getAllocated()).toEqual(new Set(['1', '2', '3', '4']))

    expect(view.undo()).toBe(true)
    expect(view.getAllocated()).toEqual(new Set(['1', '2', '3']))
    expect(view.canRedo()).toBe(true)
    expect(view.undo()).toBe(true)
    expect(view.getAllocated()).toEqual(new Set())
    expect(view.canUndo()).toBe(false)
    expect(view.undo()).toBe(false)

    expect(view.redo()).toBe(true)
    expect(view.getAllocated()).toEqual(new Set(['1', '2', '3']))

    // setBuild is NOT a user edit: 2 toggles + 3 successful undo/redo = 5 onChange calls
    expect(changes).toEqual([3, 4, 3, 0, 3])
    cleanup()
  })

  it('a new edit clears the redo stack', () => {
    const { view, cleanup } = mountView(syntheticRawGraph())
    view.setBuild({ allocated: [], classIndex: 0 })
    view.toggle('3')
    view.undo()
    expect(view.canRedo()).toBe(true)
    view.toggle('2')
    expect(view.canRedo()).toBe(false)
    cleanup()
  })

  it('setBuild resets both stacks (the external source of truth changed)', () => {
    const { view, cleanup } = mountView(syntheticRawGraph())
    view.setBuild({ allocated: [], classIndex: 0 })
    view.toggle('3')
    view.toggle('4')
    view.undo()
    expect(view.canUndo()).toBe(true)
    expect(view.canRedo()).toBe(true)
    view.setBuild({ allocated: ['2'], classIndex: 0 })
    expect(view.canUndo()).toBe(false)
    expect(view.canRedo()).toBe(false)
    cleanup()
  })

  it('failed and no-op toggles never pollute the history', () => {
    const { view, cleanup } = mountView(syntheticRawGraph())
    view.setBuild({ allocated: [], classIndex: 0 })
    view.toggle('5') // unreachable — isolated node
    expect(view.getAllocated()).toEqual(new Set())
    expect(view.canUndo()).toBe(false)
    view.toggle('1') // class start — never toggleable
    expect(view.canUndo()).toBe(false)
    cleanup()
  })

  it('binds Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z on the canvas wrapper only', () => {
    const { view, container, cleanup } = mountView(syntheticRawGraph())
    view.setBuild({ allocated: [], classIndex: 0 })
    view.toggle('3')
    const wrapper = container.querySelector<HTMLElement>('.tree-view')!
    expect(wrapper.tabIndex).toBe(0) // focusable, so the shortcut scope can receive keys

    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    expect(view.getAllocated()).toEqual(new Set())
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }))
    expect(view.getAllocated()).toEqual(new Set(['1', '2', '3']))
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true }))
    expect(view.getAllocated()).toEqual(new Set(['1', '2', '3']))

    // not bound on document — a stray Ctrl+Z elsewhere must not touch the tree
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    expect(view.getAllocated()).toEqual(new Set(['1', '2', '3']))
    cleanup()
  })

  it('character-tree toolbar is read-only: omits undo/redo, keeps search/fit/count', () => {
    const { view, cleanup } = mountView(syntheticRawGraph())
    const bar = document.createElement('div')
    bar.innerHTML = renderTreeToolbar()
    view.setBuild({ allocated: [], classIndex: 0 })
    const unwire = wireTreeToolbar(bar, view)

    // the passive tree is a read-only viewer — no allocation-editing controls render
    expect(bar.querySelector('.ttb-undo')).toBeNull()
    expect(bar.querySelector('.ttb-redo')).toBeNull()
    // the display / navigation controls still render and wire
    expect(bar.querySelector('.ttb-search')).not.toBeNull()
    expect(bar.querySelector('.ttb-fit')).not.toBeNull()
    expect(bar.querySelector('.ttb-count b')).not.toBeNull()
    unwire()
    cleanup()
  })
})

describe('seedIds allocation (graphs without class starts, e.g. the atlas)', () => {
  it('seeds BFS from seedIds and refuses nodes unreachable from any root', () => {
    const { view, cleanup } = mountView(rootedRawGraph(), { seedIds: ['1'] })
    view.toggle('3')
    expect(view.getAllocated()).toEqual(new Set(['1', '2', '3']))
    view.toggle('5') // disconnected from every seed — must stay unallocatable
    expect(view.getAllocated()).toEqual(new Set(['1', '2', '3']))
    view.undo()
    expect(view.canUndo()).toBe(false) // only the successful edit was recorded
    cleanup()
  })

  it('deallocating a seed root is a no-op; cascades stay seed-connected', () => {
    const { view, cleanup } = mountView(rootedRawGraph(), { seedIds: ['1'] })
    view.toggle('4') // 1-2-3-4
    view.toggle('1') // seed — refused
    expect(view.getAllocated()).toEqual(new Set(['1', '2', '3', '4']))
    view.toggle('2') // cascade: 3 and 4 orphaned
    expect(view.getAllocated()).toEqual(new Set(['1']))
    cleanup()
  })

  it('mountAtlasTree editable: allocation grows from the 7 atlasRoot seeds', () => {
    const roots = atlasRootIds()
    expect(roots.length).toBe(7) // +Expedition (4.5.4.1)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const changes: number[] = []
    const view = mountAtlasTree(container, { editable: true, onChange: (a) => changes.push(a.size) })

    const root = Number(roots[0]!)
    const edge = atlasGraph.edges.find((e) => e.from === root || e.to === root)!
    const neighbor = String(edge.from === root ? edge.to : edge.from)
    view.toggle(neighbor)
    expect(view.getAllocated()).toEqual(new Set([String(root), neighbor]))
    expect(changes).toEqual([2])
    view.destroy()
    container.remove()
  })

  it('default atlas mount stays viewer-only', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = mountAtlasTree(container)
    const root = Number(atlasRootIds()[0]!)
    const edge = atlasGraph.edges.find((e) => e.from === root || e.to === root)!
    view.toggle(String(edge.from === root ? edge.to : edge.from))
    expect(view.getAllocated().size).toBe(0)
    view.destroy()
    container.remove()
  })

  // a "Select a bonus" mastery node id (carries .choices) + helper to mount an editable atlas
  const choiceNodeId = Object.keys(atlasGraph.nodes).find(
    (k) => ((atlasGraph.nodes as Record<string, { choices?: unknown[] }>)[k]!.choices?.length ?? 0) > 0,
  )!
  const mountEditableAtlas = (): TreeView => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    return mountAtlasTree(container, { editable: true })
  }

  it('a "Select a bonus" mastery node exists with choices in the atlas graph', () => {
    expect(choiceNodeId).toBeTruthy()
  })

  it('mastery pick is DROPPED when the node is deallocated (pick ⊆ allocated)', () => {
    const view = mountEditableAtlas()
    view.setBuild({ allocated: [...atlasRootIds(), choiceNodeId], masteryChoices: new Map([[choiceNodeId, 1]]) })
    expect(view.getMasteryChoices().get(choiceNodeId)).toBe(1)
    view.toggle(choiceNodeId) // deallocate the mastery
    expect(view.getAllocated().has(choiceNodeId)).toBe(false)
    expect(view.getMasteryChoices().has(choiceNodeId)).toBe(false) // the pick must not stay
    view.destroy()
  })

  it('clicking a tree-start root resets allocation AND clears mastery picks', () => {
    const view = mountEditableAtlas()
    view.setBuild({ allocated: [...atlasRootIds(), choiceNodeId], masteryChoices: new Map([[choiceNodeId, 0]]) })
    expect(view.getMasteryChoices().size).toBe(1)
    view.toggle(atlasRootIds()[0]!) // click a start node
    expect(view.getAllocated()).toEqual(new Set(atlasRootIds()))
    expect(view.getMasteryChoices().size).toBe(0)
    view.destroy()
  })

  it('setBuild keeps a pick only when its node is allocated and the index is in range', () => {
    const view = mountEditableAtlas()
    // allocated + in range -> kept
    view.setBuild({ allocated: [...atlasRootIds(), choiceNodeId], masteryChoices: new Map([[choiceNodeId, 0]]) })
    expect([...view.getMasteryChoices()]).toEqual([[choiceNodeId, 0]])
    // out-of-range index -> dropped
    view.setBuild({ allocated: [...atlasRootIds(), choiceNodeId], masteryChoices: new Map([[choiceNodeId, 99]]) })
    expect(view.getMasteryChoices().size).toBe(0)
    // node not allocated -> dropped
    view.setBuild({ allocated: [...atlasRootIds()], masteryChoices: new Map([[choiceNodeId, 0]]) })
    expect(view.getMasteryChoices().size).toBe(0)
    view.destroy()
  })
})

describe('fixture coverage (pob2-build.xml → spec nodes vs treeGraph.json)', () => {
  it('≥95% of the fixture build’s allocated node ids exist in the vendored graph', () => {
    const pob = parsePob(SAMPLE_XML)
    const graph = loadGraph()
    const ids = pob.spec.nodes
    expect(ids.length).toBe(129)

    const missing = ids.filter((id) => !graph.nodeById.has(id))
    const coverage = (ids.length - missing.length) / ids.length
    // verified 2026-06-12: 129/129 resolve (incl. the class start, the Monk1 ascendancy
    // start, and 0 mastery nodes — the fixture allocates none). Report any regression:
    expect(missing, `missing from treeGraph.json: ${missing.join(', ')}`).toEqual([])
    expect(coverage).toBeGreaterThanOrEqual(0.95)

    // every resolved node has renderable coordinates
    for (const id of ids) {
      const node = graph.nodeById.get(id)
      if (!node) continue
      expect(Number.isFinite(node.x)).toBe(true)
      expect(Number.isFinite(node.y)).toBe(true)
    }
  })
})

describe('conqueror factions are sourced from GGG AlternateTreeVersions (not hand-typed)', () => {
  const sourced = (conquerorTreeVersionsJson as unknown as { versions: { ConquerorType: string }[] }).versions.map(
    (v) => v.ConquerorType,
  )

  it('CONQUEROR_BY_VERSION is derived in row order, index 0 = the un-conquered base tree', () => {
    expect([...CONQUEROR_BY_VERSION]).toEqual(sourced)
    expect(CONQUEROR_BY_VERSION[0]).toBe('None')
  })

  it('the ConquerorType union stays in lockstep with the sourced non-None factions (drift guard)', () => {
    // The hand-typed ConquerorType union (render.ts) + JEWEL_FACTIONS.version values (main.ts) must
    // match GGG's data. If a patch adds / renames / reorders a faction, this fails until the union +
    // its curated jewel art are updated — so the hardcoded copies can never silently diverge.
    expect([...CONQUEROR_BY_VERSION].filter((f) => f !== 'None').sort()).toEqual(
      ['Abyss', 'Eternal', 'Kalguuran', 'Karui', 'Maraketh', 'Templar', 'Vaal'].sort(),
    )
  })
})
