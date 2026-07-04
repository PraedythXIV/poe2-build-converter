// Phase 4 Agent A — pure allocation-legality layer (gates + choose-one swap) over a tiny
// SYNTHETIC adjacency + GateContext (no real tree ids, no DOM). Proves:
//   (a) a SINGLE-prereq gate blocks allocation until its prereq is allocated, then allows it;
//   (b) deallocating the unlocker cascades the gated node back out (gate strip + connectivity);
//   (c) selecting a second choose-one option SWAPS the already-allocated sibling;
//   (d) a MULTI-prereq gate does NOT hard-block (permissive by design — its AND/OR operator is
//       absent from GGG's data, so a fabricated rule would be approximate and never ships).
//
// GateContext is hand-built here exactly as graph.ts derives it (unlockGates / gateDependents /
// mcGroups) plus the node→mcParent reverse lookup the caller supplies. Ids stay synthetic so a
// live-tree refresh never touches this file.

import { describe, it, expect } from 'vitest'
import { allocateNode, deallocateNode } from '../src/tree/interact'
import type { GateContext, Adjacency } from '../src/tree/interact'

// ── synthetic fixtures ───────────────────────────────────────────────────────────────────────

/**
 * Linear adjacency:  S — p — g — h        (S is the free seed root)
 *                          \
 *                           m1   m2        (m1, m2 each adjacent to p — choose-one options)
 *
 * Gates: g is gated behind {p} (single-prereq); h is gated behind {g} (single-prereq, chains off g).
 * Choose-one: m1 and m2 share mcParent "mc" — only one may be allocated.
 * Multi-gate node X is gated behind {p, q} (two prereqs) — exercised in its own fixture below.
 */
function adjacency(edges: Array<[string, string]>): Adjacency {
  const adj = new Map<string, string[]>()
  for (const [a, b] of edges) {
    adj.set(a, [...(adj.get(a) ?? []), b])
    adj.set(b, [...(adj.get(b) ?? []), a])
  }
  return adj
}

function gateCtx(
  gates: Record<string, string[]>, // gated id → prereq ids
  mc: Record<string, string[]> = {}, // mcParent key → option ids
): GateContext {
  const unlockGates = new Map<string, { nodes: string[] }>()
  const gateDependents = new Map<string, string[]>()
  for (const [gated, prereqs] of Object.entries(gates)) {
    unlockGates.set(gated, { nodes: prereqs })
    for (const p of prereqs) {
      const deps = gateDependents.get(p) ?? []
      deps.push(gated)
      gateDependents.set(p, deps)
    }
  }
  const mcGroups = new Map<string, string[]>(Object.entries(mc))
  const parentOf = new Map<string, string>()
  for (const [key, opts] of Object.entries(mc)) for (const o of opts) parentOf.set(o, key)
  return {
    unlockGates,
    gateDependents,
    mcGroups,
    mcParentOf: (id) => parentOf.get(id) ?? null,
  }
}

const SEEDS = new Set(['S'])

// ── (a) single-prereq gate: blocks before the prereq, allocates after ──────────────────────────

describe('single-prereq gate (hard-enforced)', () => {
  // S — p — g ;  g gated behind {p}
  const adj = adjacency([
    ['S', 'p'],
    ['p', 'g'],
  ])
  const ctx = gateCtx({ g: ['p'] })

  it('rejects the gated node when its prereq is not on the resulting path', () => {
    // From just the seed S, the auto-path to g is S-p-g — p IS on the path, so the gate is met.
    // To prove the BLOCK we must reach g without allocating p: give g a back-door edge that skips p.
    const sideAdj = adjacency([
      ['S', 'p'],
      ['p', 'g'],
      ['S', 'g'], // back door: S connects straight to g, bypassing p
    ])
    expect(allocateNode(sideAdj, new Set(['S']), SEEDS, 'g', new Set(), ctx)).toBeNull()
  })

  it('allocates the gated node once its prereq is already allocated', () => {
    const withPrereq = new Set(['S', 'p'])
    const next = allocateNode(adj, withPrereq, SEEDS, 'g', new Set(), ctx)!
    expect(next).toEqual(new Set(['S', 'p', 'g']))
  })

  it('allocates when the auto-path itself sweeps in the prereq (p added on the way to g)', () => {
    // From the bare seed, the only route to g runs through p — gate satisfied by the path itself.
    const next = allocateNode(adj, new Set(['S']), SEEDS, 'g', new Set(), ctx)!
    expect(next).toEqual(new Set(['S', 'p', 'g']))
  })

  it('without a GateContext the gate is not enforced (Phase-0 connectivity only)', () => {
    const sideAdj = adjacency([
      ['S', 'p'],
      ['p', 'g'],
      ['S', 'g'],
    ])
    // no ctx → the back-door allocation succeeds (g reached directly from S)
    expect(allocateNode(sideAdj, new Set(['S']), SEEDS, 'g')).toEqual(new Set(['S', 'g']))
  })
})

// ── (b) deallocating the unlocker cascades the gated node out ───────────────────────────────────

describe('gate cascade on deallocation', () => {
  it('strips a gated node when its single prereq is removed', () => {
    // S — p — g, plus an independent edge S — p so removing p does NOT also orphan g by connectivity
    // (g hangs off p only); we prove the GATE strip, not the connectivity strip, by giving g a
    // second seed-connected edge so connectivity alone would keep it.
    const adj = adjacency([
      ['S', 'p'],
      ['p', 'g'],
      ['S', 'g'], // g stays connectivity-reachable from S even after p is gone
    ])
    const ctx = gateCtx({ g: ['p'] })
    const allocated = new Set(['S', 'p', 'g'])
    const after = deallocateNode(adj, allocated, SEEDS, 'p', new Set(), ctx)
    // p removed AND g stripped (its gate is now unsatisfied), even though g is still wired to S.
    expect(after).toEqual(new Set(['S']))
  })

  it('cascades a chain: removing p strips g, and g’s removal strips h', () => {
    // S — p — g — h ;  g gated behind {p}, h gated behind {g}
    const adj = adjacency([
      ['S', 'p'],
      ['p', 'g'],
      ['g', 'h'],
      ['S', 'g'], // keep g/h connectivity-reachable so only the gate cascade can remove them
      ['S', 'h'],
    ])
    const ctx = gateCtx({ g: ['p'], h: ['g'] })
    const allocated = new Set(['S', 'p', 'g', 'h'])
    const after = deallocateNode(adj, allocated, SEEDS, 'p', new Set(), ctx)
    expect(after).toEqual(new Set(['S'])) // p → g → h all unwind
  })

  it('keeps the gated node when an unrelated node is removed (gate still satisfied)', () => {
    const adj = adjacency([
      ['S', 'p'],
      ['p', 'g'],
      ['p', 'z'], // z is a dead-end sibling off p
    ])
    const ctx = gateCtx({ g: ['p'] })
    const allocated = new Set(['S', 'p', 'g', 'z'])
    const after = deallocateNode(adj, allocated, SEEDS, 'z', new Set(), ctx)
    expect(after).toEqual(new Set(['S', 'p', 'g'])) // g's prereq p is intact → g survives
  })

  it('without a GateContext, deallocation is connectivity-only (no gate strip)', () => {
    const adj = adjacency([
      ['S', 'p'],
      ['p', 'g'],
      ['S', 'g'],
    ])
    const allocated = new Set(['S', 'p', 'g'])
    // no ctx → g stays because it is still wired to the seed S; only p is removed
    expect(deallocateNode(adj, allocated, SEEDS, 'p')).toEqual(new Set(['S', 'g']))
  })
})

// ── (c) choose-one: a second option SWAPS the sibling ──────────────────────────────────────────

describe('choose-one swap (multiple-choice nodes)', () => {
  // S — m1 ; S — m2 ; m1 and m2 are the two options of group "mc".
  const adj = adjacency([
    ['S', 'm1'],
    ['S', 'm2'],
  ])
  const ctx = gateCtx({}, { mc: ['m1', 'm2'] })

  it('selecting m2 while m1 is allocated swaps m1 out for m2', () => {
    const allocated = new Set(['S', 'm1'])
    const next = allocateNode(adj, allocated, SEEDS, 'm2', new Set(), ctx)!
    expect(next.has('m2')).toBe(true)
    expect(next.has('m1')).toBe(false) // sibling deallocated
    expect(next).toEqual(new Set(['S', 'm2']))
  })

  it('selecting the first option of an empty group just allocates it (nothing to swap)', () => {
    const next = allocateNode(adj, new Set(['S']), SEEDS, 'm1', new Set(), ctx)!
    expect(next).toEqual(new Set(['S', 'm1']))
  })

  it('re-selecting the already-allocated option is a no-op (no self-swap)', () => {
    const allocated = new Set(['S', 'm1'])
    expect(allocateNode(adj, allocated, SEEDS, 'm1', new Set(), ctx)).toEqual(allocated)
  })

  it('the swapped-out sibling takes its own gated dependents with it', () => {
    // m1 unlocks g1 (g1 gated behind {m1}); choosing m2 swaps m1 out, so g1 must fall too.
    const swapAdj = adjacency([
      ['S', 'm1'],
      ['S', 'm2'],
      ['m1', 'g1'],
      ['S', 'g1'], // g1 stays seed-connected — only the gate strip can remove it
    ])
    const swapCtx = gateCtx({ g1: ['m1'] }, { mc: ['m1', 'm2'] })
    const allocated = new Set(['S', 'm1', 'g1'])
    const next = allocateNode(swapAdj, allocated, SEEDS, 'm2', new Set(), swapCtx)!
    expect(next).toEqual(new Set(['S', 'm2'])) // m1 swapped out, g1 cascaded out, m2 in
  })
})

// ── (d) multi-prereq gate is permissive (NOT hard-blocked) ─────────────────────────────────────

describe('multi-prereq gate (permissive by design — AND/OR operator unknown)', () => {
  // S — x ;  x gated behind {p, q} — neither p nor q is allocated or even on the path.
  const adj = adjacency([['S', 'x']])
  const ctx = gateCtx({ x: ['p', 'q'] })

  it('allows the node even when NONE of its multiple prereqs are allocated', () => {
    const next = allocateNode(adj, new Set(['S']), SEEDS, 'x', new Set(), ctx)!
    expect(next).toEqual(new Set(['S', 'x'])) // permitted — tooltip labels it, allocation does not block
  })

  it('does not strip a multi-prereq node when one of its prereqs is removed', () => {
    // p is allocated and adjacent; removing p must NOT cascade x out (multi-gate is not enforced).
    const adj2 = adjacency([
      ['S', 'p'],
      ['S', 'x'],
    ])
    const allocated = new Set(['S', 'p', 'x'])
    const after = deallocateNode(adj2, allocated, SEEDS, 'p', new Set(), ctx)
    expect(after).toEqual(new Set(['S', 'x'])) // x survives — multi-prereq gate never cascades
  })
})
