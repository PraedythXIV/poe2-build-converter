// Phase 3 — per-class / per-ascendancy stat overrides + the resolveNode resolver.
// Pure logic over a tiny synthetic RawTreeGraph (no real data, no DOM). Proves buildGraph joins the
// two hops (overridePairs[baseNodeId] → overrideSkillId → skillOverrides[overrideSkillId]), that
// resolveNode applies ASCENDANCY-over-class precedence, skips bases absent from nodeById without
// throwing, treats the empty-`[]` overridePairs shape as no overrides, and is a no-op for null/null.

import { describe, it, expect } from 'vitest'
import { buildGraph, resolveNode } from '../src/tree/graph'
import type { RawTreeGraph, SkillOverride, TreeNode } from '../src/tree/graph'
import { rawNode } from './helpers/graphs'

// Synthetic raw graph (treeGraph.json shape):
// - Node 1 ("Base Damage") is overridden by class 7 (→ skill 900) and by ascendancy "AscX" (→ skill 901).
// - Node 2 ("Plain") pairs to an ABSENT override skill (998) → dropped by the "no second-hop" guard.
// - overridePairs reference base 99, whose node is ABSENT (but its override 900 DOES exist) → the
//   missing-base guard must skip it, never add and never throw.
// - Class 5 ships overridePairs as the empty `[]` array form (GGG's empty shape) → zero overrides.
// - Ascendancy "AscEmpty" also ships `[]`.
function overrideRawGraph(): RawTreeGraph {
  const raw = {
    bounds: { min_x: 0, min_y: 0, max_x: 1000, max_y: 1000 },
    classes: [
      {
        idx: 7,
        name: 'TestClass',
        // baseNodeId → overrideSkillId. Two distinct skip paths are exercised on purpose:
        //   base 2 → 998 : node 2 is real, but 998 has no skillOverrides entry → "no second-hop" skip.
        //   base 99 → 900: override 900 DOES exist, but node 99 does NOT → missing-base skip.
        // Only base 1 (real node + real override) survives, so classMap.size === 1.
        overridePairs: { 1: 900, 2: 998, 99: 900 },
        ascendancies: [
          { id: 'AscX', name: 'Asc X', offsetX: 0, offsetY: 0, overridePairs: { 1: 901 } },
          { id: 'AscEmpty', name: 'Asc Empty', offsetX: 0, offsetY: 0, overridePairs: [] },
        ],
      },
      {
        idx: 5,
        name: 'EmptyClass',
        overridePairs: [], // GGG's empty form — must read as "no overrides", not crash
        ascendancies: [{ id: 'AscY', name: 'Asc Y', offsetX: 0, offsetY: 0, overridePairs: {} }],
      },
    ],
    nodes: {
      '1': rawNode(0, 0, { id: 'base1', name: 'Base Damage', icon: 'base.png', stats: ['10% increased Damage'] }),
      '2': rawNode(100, 0, { id: 'plain2', name: 'Plain', icon: 'plain.png', stats: ['+5 to Life'], orbit: 1 }),
    },
    edges: [{ from: 1, to: 2 }],
    // Keyed by OVERRIDE skill id (the second hop), not the base node id.
    skillOverrides: {
      '900': {
        id: 'class_override',
        skill: 900,
        name: 'Class Damage',
        icon: 'class.png',
        stats: ['Minions deal 10% increased Damage'],
      },
      '901': {
        id: 'asc_override',
        skill: 901,
        name: 'Asc Damage',
        icon: 'asc.png',
        stats: ['Spells deal 10% increased Damage'],
      },
      // 900/901 are the only override entries. 998 (base 2's target) is deliberately ABSENT so the
      // "no second-hop" guard drops base 2; base 99 targets the PRESENT 900, so only its missing NODE
      // stops it — that isolates the two guards from each other.
    },
  }
  // Cast away the literal type, exactly like graph-gates.test.ts / src/convert/lookups.ts do.
  return raw as unknown as RawTreeGraph
}

describe('Phase 3 — skill overrides (synthetic graph)', () => {
  const graph = buildGraph(overrideRawGraph())
  const base1 = graph.nodeById.get('1')!
  const plain2 = graph.nodeById.get('2')!

  it('joins the two hops into overridesByClassIdx (baseNodeId → SkillOverride)', () => {
    const classMap = graph.overridesByClassIdx.get(7)!
    expect(classMap.get('1')).toEqual({
      id: 'class_override',
      skill: 900,
      name: 'Class Damage',
      icon: 'class.png',
      stats: ['Minions deal 10% increased Damage'],
    })
    // base 99 skipped by the missing-base guard, base 2 by the no-second-hop guard — both now
    // load-bearing: break either guard and one of these fails (or buildGraph throws at line 68).
    expect(classMap.has('99')).toBe(false)
    expect(classMap.has('2')).toBe(false)
    expect(classMap.size).toBe(1)
  })

  it('joins the ascendancy hop into overridesByAscId', () => {
    expect(graph.overridesByAscId.get('AscX')!.get('1')!.skill).toBe(901)
  })

  it('normalizes the empty `[]` overridePairs shape to zero overrides (no crash)', () => {
    expect(graph.overridesByClassIdx.get(5)!.size).toBe(0) // class shipped []
    expect(graph.overridesByAscId.get('AscEmpty')!.size).toBe(0) // ascendancy shipped []
    expect(graph.overridesByAscId.get('AscY')!.size).toBe(0) // ascendancy shipped {}
  })

  it('resolveNode — class override applies when only a class is selected', () => {
    const r = resolveNode(graph, base1, 7, null) as SkillOverride
    expect(r.skill).toBe(900)
    expect(r.stats).toEqual(['Minions deal 10% increased Damage'])
  })

  it('resolveNode — ASCENDANCY takes precedence over class for the same base node', () => {
    const r = resolveNode(graph, base1, 7, 'AscX') as SkillOverride
    expect(r.skill).toBe(901) // asc 901 wins over class 900
    expect(r.name).toBe('Asc Damage')
  })

  it('resolveNode — falls back to the class override when the ascendancy has none', () => {
    // AscEmpty has no override for node 1 → the class override still applies
    const r = resolveNode(graph, base1, 7, 'AscEmpty') as SkillOverride
    expect(r.skill).toBe(900)
  })

  it('resolveNode — returns the BASE node when nothing overrides it', () => {
    expect(resolveNode(graph, plain2, 7, 'AscX')).toBe(plain2) // node 2 is never overridden
    // a class with no overrides at all leaves the base untouched
    expect(resolveNode(graph, base1, 5, 'AscY')).toBe(base1)
  })

  it('resolveNode — null/null selection is a no-op (returns the base, never an override)', () => {
    expect(resolveNode(graph, base1, null, null)).toBe(base1)
  })

  it('resolveNode return is assignable as base TreeNode OR SkillOverride (union sanity)', () => {
    const r: TreeNode | SkillOverride = resolveNode(graph, base1, 7, null)
    expect('skill' in r ? r.skill : (r as TreeNode).id).toBe(900)
  })
})
