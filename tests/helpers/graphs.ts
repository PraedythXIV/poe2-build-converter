// Shared synthetic-graph primitives for the tree / atlas / override tests. The graphs themselves are
// feature-specific and stay in their own test files; this is just the reusable raw-node shape + factory
// (structurally matching the non-exported RawNode in src/tree/graph.ts).

/** Raw-node literal structurally matching graph.ts's (non-exported) RawNode. */
export interface SynRawNode {
  id: string
  name: string
  icon: string
  stats: string[]
  x: number
  y: number
  group: number
  orbit: number
  orbitIndex: number
  ascendancyId?: string
  notable?: boolean
  ascStart?: boolean
  classStartIndex?: number[]
  isFree?: boolean
  grantedPassivePoints?: number
}

/** Synthetic raw node at (x, y); `extra` overrides the defaults. */
export function rawNode(x: number, y: number, extra: Partial<SynRawNode> = {}): SynRawNode {
  return { id: 'syn', name: 'Syn', icon: '', stats: [], x, y, group: 1, orbit: 0, orbitIndex: 0, ...extra }
}

/** The base main-path chain every synthetic engine graph opens with: the class start [1] plus a
 *  two-node link ([1]──2──3). Spread it, then add the scenario's own nodes. */
export function mainChainNodes(): Record<string, SynRawNode> {
  return {
    '1': rawNode(0, 0, { classStartIndex: [0] }),
    '2': rawNode(100, 0),
    '3': rawNode(200, 0),
  }
}

/** Shared synthetic-graph skeleton: 6000² bounds + one TestClass with one TestAsc ascendancy —
 *  the frame the engine test graphs (tree, budget) build their nodes/edges onto. */
export function testClassFrame(): {
  bounds: { min_x: number; min_y: number; max_x: number; max_y: number }
  classes: {
    idx: number
    name: string
    ascendancies: { id: string; name: string; offsetX: number; offsetY: number }[]
  }[]
} {
  return {
    bounds: { min_x: 0, min_y: 0, max_x: 6000, max_y: 6000 },
    classes: [
      { idx: 0, name: 'TestClass', ascendancies: [{ id: 'TestAsc', name: 'Test Asc', offsetX: 0, offsetY: 0 }] },
    ],
  }
}
