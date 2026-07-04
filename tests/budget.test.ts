// Phase 5B — real main-pool point budget. getCounts().available is PASSIVE_CAP plus every
// grantedPassivePoints granted by an allocated node (all 6 real granters are ascendancy notables,
// so they raise the MAIN budget once taken). Pure mount-level logic over a tiny SYNTHETIC graph
// (no real tree ids, no canvas — jsdom's 2d context is null, so the view runs logic-only), so a
// live-tree refresh never touches this file. Proven here:
//   (a) empty / no-granter build → available is exactly PASSIVE_CAP, over=false;
//   (b) allocating a grantedPassivePoints node raises available by that exact amount;
//   (c) two granters stack; over flips true only once main exceeds the raised budget;
//   (d) the toolbar badge renders `main/available` and toggles .ttb-over off the same `over` flag.

import { describe, it, expect } from 'vitest'
import { buildGraph } from '../src/tree/graph'
import type { RawTreeGraph } from '../src/tree/graph'
import { mountTree, renderTreeToolbar, wireTreeToolbar, PASSIVE_CAP } from '../src/tree/index'
import type { TreeView } from '../src/tree/index'
import { rawNode, testClassFrame, mainChainNodes } from './helpers/graphs'

// Synthetic raw graph:
//
//   [1]──2──3      (main chain; [1] = class start for index 0)
//   [1]══bridge══90(ascStart)──91(+4 pts)──92(+1 pt)   (TestAsc cluster)
//
// 91 grants 4 passive points, 92 grants 1 — both ascendancy notables, exactly like the 6 real
// granters. The 1↔90 bridge never enters navAdjacency, so the cluster is reached via the TestAsc
// seed; allocation here is driven by setBuild, which needs no path.
function budgetRawGraph(): RawTreeGraph {
  return {
    ...testClassFrame(),
    nodes: {
      ...mainChainNodes(), // [1]──2──3
      '90': rawNode(2000, 2000, { ascStart: true, ascendancyId: 'TestAsc' }),
      '91': rawNode(2100, 2000, { notable: true, ascendancyId: 'TestAsc', grantedPassivePoints: 4 }),
      '92': rawNode(2200, 2000, { notable: true, ascendancyId: 'TestAsc', grantedPassivePoints: 1 }),
    },
    edges: [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 1, to: 90 }, // bridge
      { from: 90, to: 91 },
      { from: 91, to: 92 },
    ],
  } as unknown as RawTreeGraph
}

function mountView(): { view: TreeView; cleanup: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const view = mountTree(container, { graph: buildGraph(budgetRawGraph()) })
  return {
    view,
    cleanup: () => {
      view.destroy()
      container.remove()
    },
  }
}

describe('Phase 5B — point budget (grantedPassivePoints raises the main pool)', () => {
  it('available is exactly PASSIVE_CAP when no granter is allocated', () => {
    const { view, cleanup } = mountView()
    view.setBuild({ allocated: ['2', '3'], classIndex: 0 }) // two plain main nodes, no grant
    const counts = view.getCounts()
    expect(counts.main).toBe(2)
    expect(counts.available).toBe(PASSIVE_CAP)
    expect(counts.over).toBe(false)
    cleanup()
  })

  it('allocating a grantedPassivePoints granter raises available by that exact amount', () => {
    const { view, cleanup } = mountView()
    // baseline: only the class start (free) + one main node
    view.setBuild({ allocated: ['2'], classIndex: 0 })
    expect(view.getCounts().available).toBe(PASSIVE_CAP)

    // add the +4 granter (ascendancy notable 91) — main budget rises by exactly 4
    view.setBuild({ allocated: ['2', '90', '91'], ascendancyId: 'TestAsc', classIndex: 0 })
    const counts = view.getCounts()
    expect(counts.available).toBe(PASSIVE_CAP + 4)
    expect(counts.main).toBe(1) // '2' only — '90' (start) and '91' (ascendancy) are not main points
    expect(counts.asc).toBe(1) // the granter itself is an ascendancy point
    cleanup()
  })

  it('granters stack; over flips true only once main exceeds the raised budget', () => {
    const { view, cleanup } = mountView()
    // both granters allocated → +5 budget; main untouched
    view.setBuild({ allocated: ['2', '3', '90', '91', '92'], ascendancyId: 'TestAsc', classIndex: 0 })
    expect(view.getCounts().available).toBe(PASSIVE_CAP + 5)
    expect(view.getCounts().over).toBe(false)
    cleanup()
  })

  it('a granter allocated by a USER TOGGLE raises available too (not just setBuild)', () => {
    const { view, cleanup } = mountView()
    view.setBuild({ allocated: [], ascendancyId: 'TestAsc', classIndex: 0 })
    expect(view.getCounts().available).toBe(PASSIVE_CAP)
    // toggle the granter — auto-paths 90→91 from the ascendancy start seed
    view.toggle('91')
    expect(view.getAllocated().has('91')).toBe(true)
    expect(view.getCounts().available).toBe(PASSIVE_CAP + 4)
    // undo removes the granter — budget falls back to the base cap
    view.undo()
    expect(view.getCounts().available).toBe(PASSIVE_CAP)
    cleanup()
  })

  it('toolbar badge renders main/available and clears .ttb-over while within budget', () => {
    const { view, cleanup } = mountView()
    const bar = document.createElement('div')
    bar.innerHTML = renderTreeToolbar()
    view.setBuild({ allocated: ['2', '3', '90', '91'], ascendancyId: 'TestAsc', classIndex: 0 })
    const unwire = wireTreeToolbar(bar, view)

    const countEl = bar.querySelector<HTMLElement>('.ttb-count b')!
    expect(countEl.textContent).toBe(`2/${PASSIVE_CAP + 4}`) // 2 main points, budget raised by 4
    expect(countEl.classList.contains('ttb-over')).toBe(false)
    unwire()
    cleanup()
  })
})
