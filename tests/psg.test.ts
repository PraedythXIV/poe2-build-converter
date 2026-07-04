// B2 — .psg decoder + orbit-math fit + atlasGraph.json shape tests.
//
// Fixtures (all committed, so every test runs in CI):
// - tests/fixtures/AtlasSkillGraph.psg (18 KB): atlas decoder structure tests.
// - tests/fixtures/CharacterSkillGraph.psg (165 KB) vs the committed src/data/treeGraph.json (which
//   carries GGG's baked node positions, x/y/orbit/orbitIndex + arc-centre edges — the exact shape
//   verifyAgainstBaked reads): THE GROUND-TRUTH GATE — our orbit math reproduces >= 99% of
//   character-tree node positions within 1 world unit, which licenses the same math for the atlas
//   (no official atlas export exists). `npm run data:psg-verify` gates identically off live data.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodePsg, flattenNodes, verifyAgainstBaked, arcCenter, ORBIT_RADII, NO_ARC } from '../scripts/decode-psg.mjs'

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'AtlasSkillGraph.psg')
const CHARACTER_PSG = join(process.cwd(), 'tests', 'fixtures', 'CharacterSkillGraph.psg')
const BAKED_TREE = join(process.cwd(), 'src', 'data', 'treeGraph.json')
const ATLAS_GRAPH = join(process.cwd(), 'src', 'data', 'atlasGraph.json')

describe('decodePsg (committed atlas fixture)', () => {
  const decoded = decodePsg(readFileSync(FIXTURE))

  it('parses the PoE2 header (version 3, atlas graph type, baked orbit-slot table)', () => {
    expect(decoded.version).toBe(3)
    expect(decoded.graphType).toBe(1)
    expect(decoded.slotsPerOrbit).toEqual([1, 12, 24, 24, 72, 72, 72, 24, 72, 144])
    expect(decoded.slotsPerOrbit.length).toBe(ORBIT_RADII.length)
  })

  it('reads the 7 atlas sub-tree roots and the full group/node/connection structure', () => {
    expect(decoded.rootPassives).toHaveLength(7) // 4.5.4.1 added the Expedition sub-tree (was 6)
    expect(decoded.groups).toHaveLength(253)
    const nodes = flattenNodes(decoded)
    expect(nodes).toHaveLength(574)
    expect(nodes.reduce((n, p) => n + p.connections.length, 0)).toBe(584)
    // every root and every connection target is a decoded node
    const ids = new Set(nodes.map((n) => n.passiveId))
    for (const root of decoded.rootPassives) expect(ids.has(root)).toBe(true)
    for (const n of nodes) for (const c of n.connections) expect(ids.has(c.target)).toBe(true)
  })

  it('derives finite world positions consistent with each node orbit radius', () => {
    const byGroup = decoded.groups
    for (const n of flattenNodes(decoded)) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
      const g = byGroup[n.groupIndex]!
      expect(Math.hypot(n.x - g.x, n.y - g.y)).toBeCloseTo(ORBIT_RADII[n.radius]!, 6)
    }
  })

  it('rejects truncated input instead of returning partial garbage', () => {
    const buf = readFileSync(FIXTURE)
    expect(() => decodePsg(buf.subarray(0, buf.length - 4))).toThrow()
    expect(() => decodePsg(Buffer.concat([buf, Buffer.from([0])]))).toThrow(/trailing/)
  })
})

describe('arcCenter (fit-validated arc geometry)', () => {
  it('is equidistant from both endpoints at the orbit radius, sign picks the side', () => {
    const [ax, ay, bx, by] = [0, 0, 100, 0]
    for (const arc of [2, -2]) {
      const c = arcCenter(ax, ay, bx, by, arc)!
      expect(Math.hypot(c.x - ax, c.y - ay)).toBeCloseTo(ORBIT_RADII[2]!, 9)
      expect(Math.hypot(c.x - bx, c.y - by)).toBeCloseTo(ORBIT_RADII[2]!, 9)
    }
    // opposite signs -> mirrored centres
    expect(arcCenter(ax, ay, bx, by, 2)!.y).toBeCloseTo(-arcCenter(ax, ay, bx, by, -2)!.y, 9)
  })

  it('returns null for straight edges (0 / NO_ARC sentinel) and impossible chords', () => {
    expect(arcCenter(0, 0, 100, 0, 0)).toBeNull()
    expect(arcCenter(0, 0, 100, 0, NO_ARC)).toBeNull()
    expect(arcCenter(0, 0, 9999, 0, 1)).toBeNull() // chord far beyond 2 * 82
  })
})

describe('ground-truth gate: character tree (psg) vs the baked treeGraph.json', () => {
  it('reproduces >= 99% of baked node positions within 1 world unit (orbit math fit)', () => {
    const decoded = decodePsg(readFileSync(CHARACTER_PSG))
    const baked = JSON.parse(readFileSync(BAKED_TREE, 'utf8'))
    const rep = verifyAgainstBaked(decoded, baked)

    expect(rep.nodes.matched).toBeGreaterThan(4800)
    // EXACTLY 2 psg nodes lack a treeGraph counterpart (the committed psg fixture runs a hair ahead of
    // the committed tree build) — correct, not decode failures; 2 is the structural minimum as of patch
    // 4.5.4.1.2. The bound sits AT that floor: any increase means a real regression (broken orbit math
    // would orphan hundreds) or genuine patch drift → re-extract the fixture + rebuild treeGraph.json. A
    // future re-sync that drops it to 0/1 still passes. (Measured 2026-06: matched 5150, missing 2.)
    expect(rep.nodes.missing).toBeLessThanOrEqual(2)
    expect(rep.nodes.orbitMismatch).toBe(0)
    // THE GATE (2026-06 fit: 5150/5150 matched within 1u, worst error 0.058)
    expect(rep.nodes.withinTolerance / rep.nodes.matched).toBeGreaterThanOrEqual(0.99)
    // arc centres + straight edges must agree with the baked export too
    const arcsWithBaked = rep.arcs.total - rep.arcs.noBakedCenter
    expect(arcsWithBaked).toBeGreaterThan(1500)
    expect(rep.arcs.centerWithinTolerance / arcsWithBaked).toBeGreaterThanOrEqual(0.99)
    expect(rep.straight.agree).toBe(rep.straight.total)
  })
})

describe.skipIf(!existsSync(ATLAS_GRAPH))('atlasGraph.json (treeGraph-shaped artifact)', () => {
  const graph = JSON.parse(readFileSync(ATLAS_GRAPH, 'utf8'))

  it('has the treeGraph.json top-level shape (+ the atlas-only subTrees placement map)', () => {
    // `subTrees` is an atlas-specific extension the shared renderer ignores (it reads only
    // bounds/classes/nodes/edges) — per-subtree precursor-art placement, data-derived from the game table.
    expect(Object.keys(graph).sort()).toEqual(['_provenance', 'bounds', 'classes', 'edges', 'nodes', 'subTrees'])
    expect(graph.classes).toEqual([])
    for (const k of ['min_x', 'min_y', 'max_x', 'max_y']) expect(typeof graph.bounds[k]).toBe('number')
    for (const v of Object.values(graph.subTrees) as Array<{ dx: unknown; dy: unknown; bg: unknown }>) {
      expect(typeof v.dx).toBe('number')
      expect(typeof v.dy).toBe('number')
      expect(typeof v.bg).toBe('string')
    }
  })

  it('carries render-complete nodes inside bounds, with kind flags and 7 roots', () => {
    const nodes = Object.values(graph.nodes) as Record<string, unknown>[]
    expect(nodes.length).toBeGreaterThanOrEqual(500)
    for (const n of nodes) {
      expect(typeof n.id).toBe('string')
      expect(typeof n.name).toBe('string')
      expect(Array.isArray(n.stats)).toBe(true)
      for (const field of ['x', 'y', 'group', 'orbit', 'orbitIndex'] as const) {
        expect(typeof n[field]).toBe('number')
        expect(Number.isFinite(n[field])).toBe(true)
      }
      expect((n.x as number) >= graph.bounds.min_x && (n.x as number) <= graph.bounds.max_x).toBe(true)
      expect((n.y as number) >= graph.bounds.min_y && (n.y as number) <= graph.bounds.max_y).toBe(true)
    }
    expect(nodes.filter((n) => n.atlasRoot === true)).toHaveLength(7) // +Expedition (4.5.4.1)
    expect(nodes.filter((n) => n.notable === true).length).toBeGreaterThan(100)
    expect(nodes.filter((n) => n.keystone === true).length).toBeGreaterThan(10)
  })

  it('edges reference existing nodes; arc centres are equidistant from both endpoints', () => {
    expect(graph.edges.length).toBeGreaterThanOrEqual(500)
    for (const e of graph.edges) {
      const a = graph.nodes[String(e.from)]
      const b = graph.nodes[String(e.to)]
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      if (e.orbitX !== undefined) {
        const ra = Math.hypot(a.x - e.orbitX, a.y - e.orbitY)
        const rb = Math.hypot(b.x - e.orbitX, b.y - e.orbitY)
        expect(Math.abs(ra - rb)).toBeLessThan(1.5) // rounded to 1 decimal in the artifact
      }
    }
  })

  it('every stat line is human text or an explicit raw fallback — never empty', () => {
    let formatted = 0
    let fallback = 0
    for (const n of Object.values(graph.nodes) as { stats: string[] }[]) {
      for (const s of n.stats) {
        expect(typeof s).toBe('string')
        expect(s.length).toBeGreaterThan(0)
        expect(s.includes('{')).toBe(false) // no unsubstituted placeholders
        if (/^[a-z0-9_+%~here:.-]+ = -?\d+$/i.test(s)) fallback++
        else formatted++
      }
    }
    expect(formatted).toBeGreaterThan(500) // csd formatting actually ran
    expect(fallback).toBeLessThan(10) // known leftovers: ids absent from every shipped .csd
  })
})
