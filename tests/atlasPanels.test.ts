// Atlas background-panel PLACEMENT is data-driven and PATCH-ROBUST. Each precursor subtree panel sits at
// its start node + the game table's IllustrationX/Y (vendored into atlasGraph.subTrees); the facade is
// anchored to the general start node. This test asserts the placement LOGIC (offsets applied, facade
// anchored, one panel per qualifying subtree) by RECOMPUTING the expected centers from the LIVE graph —
// so it does NOT false-fail when a patch moves nodes, reshapes the tree, or adds/removes a subtree (those
// are exactly the things that legitimately change every major patch). It is deliberately NOT a calibration
// pin: the world `size` is a hand-calibrated scalar (atlas roadmap A4) that a major ART REFRAME legitimately
// changes, so it's only sanity-checked (> 0). What this CATCHES is a logic regression — an offset not
// applied, the facade un-anchored, a size gone 0/NaN, or atlasPanels() NOT emitting a panel for a subtree that HAS a start
// node + offset. It does NOT fail when GGG ADDS / REMOVES / REPLACES a subtree or moves nodes — the expected set AND the
// panels both recompute from the LIVE graph (they grow/shrink together). Major patch = major changes is fine.
import { describe, it, expect } from 'vitest'
import { atlasPanels, atlasGraph } from '../src/atlas/index'

describe('atlasPanels — data-driven, patch-robust placement', () => {
  const panels = atlasPanels()
  const byKey = Object.fromEntries(panels.map((p) => [p.key, p]))
  const subStarts = Object.values(atlasGraph.nodes).filter(
    (n) => n.atlasRoot && n.subTree && atlasGraph.subTrees[n.subTree],
  )

  it('emits exactly one facade + one panel per subtree that has a start node AND a table offset', () => {
    expect(panels.filter((p) => p.key !== 'general')).toHaveLength(subStarts.length)
    // every qualifying subtree gets a panel keyed by its lowercased id — generalises to ANY patch's set
    for (const s of subStarts) expect(byKey[s.subTree!.toLowerCase()]).toBeDefined()
    // facade present + ANCHORED to the general start node (relative, not pinned to an absolute coordinate)
    const genStart = Object.values(atlasGraph.nodes).find((n) => n.atlasRoot && !n.subTree)!
    expect(byKey.general).toBeDefined()
    expect(Math.abs(byKey.general!.cx - genStart.x)).toBeLessThan(20) // tracks the general start, whatever it is
    expect(byKey.general!.size).toBeGreaterThan(0) // sane size; the exact scalar is calibrated (A4), not pinned
  })

  it('derives every subtree panel center from data — node position + atlasGraph.subTrees offset', () => {
    for (const p of panels) {
      if (p.key === 'general') continue
      const sub = Object.keys(atlasGraph.subTrees).find((s) => s.toLowerCase() === p.key)!
      const start = Object.values(atlasGraph.nodes).find((n) => n.atlasRoot && n.subTree === sub)!
      const o = atlasGraph.subTrees[sub]!
      expect(p.cx).toBeCloseTo(start.x + o.dx, 1)
      expect(p.cy).toBeCloseTo(start.y + o.dy, 1)
      expect(p.size).toBeGreaterThan(0) // calibrated scalar (A4) — sanity-checked, never pinned
    }
  })
})
