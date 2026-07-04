// Phase 0 plumbing — the unlock-gate INDEX that buildGraph derives.
// Pure logic over a tiny synthetic RawTreeGraph (no real data, no DOM): proves buildGraph
// populates unlockGates / gateDependents (stringifying the numeric prereq ids) and surfaces
// unlockConstraint on the node. (Gate ENFORCEMENT during allocation is Phase 4 — covered by
// interact-gates.test.ts, inside allocateNode/deallocateNode.)

import { describe, it, expect } from 'vitest'
import { buildGraph } from '../src/tree/graph'
import type { RawTreeGraph } from '../src/tree/graph'

// Synthetic raw graph (treeGraph.json shape). Node 3 is gated behind node 1 AND node 2.
// unlockConstraint.nodes are NUMERIC source ids — buildGraph stringifies them to the id space.
function gatedRawGraph(): RawTreeGraph {
  const raw = {
    bounds: { min_x: 0, min_y: 0, max_x: 1000, max_y: 1000 },
    classes: [],
    nodes: {
      '1': { id: 'a1', name: 'A', icon: '', stats: [], x: 0, y: 0, group: 1, orbit: 0, orbitIndex: 0 },
      '2': { id: 'a2', name: 'B', icon: '', stats: [], x: 100, y: 0, group: 1, orbit: 1, orbitIndex: 0 },
      '3': {
        id: 'a3',
        name: 'Gated',
        icon: '',
        stats: [],
        x: 200,
        y: 0,
        group: 1,
        orbit: 1,
        orbitIndex: 1,
        unlockConstraint: { nodes: [1, 2], ascendancy: 'TestAsc' },
      },
    },
    edges: [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ],
  }
  // Cast away the literal type, exactly like tree.test.ts / src/convert/lookups.ts do.
  return raw as unknown as RawTreeGraph
}

describe('Phase 0 — unlock gates (synthetic graph)', () => {
  const graph = buildGraph(gatedRawGraph())

  it('indexes unlockGates with stringified prereq ids + the ascendancy tag', () => {
    expect(graph.unlockGates.size).toBe(1)
    const gate = graph.unlockGates.get('3')!
    expect(gate.nodes).toEqual(['1', '2']) // numeric source ids stringified to the node id space
    expect(gate.ascendancy).toBe('TestAsc')
    // ungated nodes carry no gate entry
    expect(graph.unlockGates.has('1')).toBe(false)
    expect(graph.unlockGates.has('2')).toBe(false)
  })

  it('mirrors the gate as gateDependents (prereq id → ids it unlocks)', () => {
    expect(graph.gateDependents.get('1')).toEqual(['3'])
    expect(graph.gateDependents.get('2')).toEqual(['3'])
    expect(graph.gateDependents.has('3')).toBe(false)
  })

  it('surfaces unlockConstraint on the TreeNode (numeric prereq ids stringified)', () => {
    const node = graph.nodeById.get('3')!
    expect(node.unlockConstraint).toEqual({ nodes: ['1', '2'], ascendancy: 'TestAsc' })
    expect(graph.nodeById.get('1')!.unlockConstraint).toBeUndefined()
  })
})
