// PoE2 .psg (Passive Skill Graph) binary decoder + ground-truth verifier. Zero deps.
//
// Format ported from PyPoE's psg.py decoder (MIT License, Copyright (c) 2015 Omega_K2 —
// https://github.com/OmegaK2/PyPoE, PyPoE/poe/file/psg.py), then re-derived byte-by-byte
// for PoE2 (patch 4.5.2.1.2) — the PoE1-era layout changed in four places: a graph-type
// byte after the version, the slots-per-orbit table baked into the header, u64 root ids,
// and {target, signedArcOrbit} connection PAIRS instead of bare target ids.
//
// PoE2 layout (all little-endian; parses all 5 shipped .psg files with 0 trailing bytes):
//   u8  version                  (3)
//   u8  graphType                (0 = character/royale, 1 = atlas/map-layout, 2 = league)
//   u8  orbitCount               (10)
//   u8  slotsPerOrbit[orbitCount]   ([1,12,24,24,72,72,72,24,72,144])
//   u32 rootCount; rootCount x u64 rootPassiveId   (class / atlas-subtree start nodes)
//   u32 groupCount; per group:
//     f32 x, f32 y, u32 unk1, u32 unk2, u8 flag, u32 passiveCount; per passive:
//       u32 passiveId    — PassiveSkills.PassiveSkillGraphId (== GGG tree-export node key)
//       u32 radius       — node ORBIT index (0 = group centre), into ORBIT_RADII
//       u32 position     — slot on that orbit (== GGG tree-export orbitIndex)
//       u32 connCount; connCount x { u32 targetPassiveId, i32 arc }
//         arc: 0 or NO_ARC sentinel = straight edge; otherwise |arc| = orbit index into
//         ORBIT_RADII (radius of the circular-arc connector) and the SIGN picks which of
//         the two candidate arc centres is used — see arcCenter().
//
// Ground truth (run `node scripts/decode-psg.mjs --verify`): decoding the character tree
// Metadata/PassiveSkillGraph.psg and re-deriving node x/y via the orbit math below
// reproduces GGG's baked coordinates (src/data/treeGraph.json) for
// 5150/5150 nodes within 1 world unit (worst 0.058 — float32 noise), with 0 orbit/slot
// mismatches, 1733/1733 arc centres within 1 unit and 4335/4335 straight edges agreeing.
//
//   node scripts/decode-psg.mjs [file.psg] [--verify [data.json]] [--json]

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, argValue } from './lib.mjs'

/** Orbit-index -> radius in world units. Index 0 = group centre. FIT-VALIDATED against
 *  GGG's baked coordinates (median per-orbit radius matches to float32 precision);
 *  same numbers as the edge-orbit table baked into the GGG tree export (+1 offset). */
export const ORBIT_RADII = [0, 82, 164, 334, 488, 657, 839, 250, 1076, 1320]

/** i32 sentinel in a connection's arc field meaning "no arc — draw a straight line"
 *  (GGG's own tree export bakes these 143 character-tree edges as straight too). */
export const NO_ARC = 0x7fffffff

const DEFAULT_PSG = join(ROOT, '_workbench', 'data-extract', 'psg', 'Metadata@PassiveSkillGraph.psg')
const DEFAULT_BAKED = join(ROOT, 'src', 'data', 'treeGraph.json')

/**
 * Decode a .psg buffer. Throws on any structural surprise (unknown version, truncated
 * record, trailing bytes) — a format change must fail loud, not produce garbage geometry.
 */
export function decodePsg(buf) {
  const r = new Reader(buf)
  const version = r.u8()
  if (version !== 3) throw new Error(`unsupported .psg version ${version} (expected 3)`)
  const graphType = r.u8()
  const orbitCount = r.u8()
  const slotsPerOrbit = []
  for (let i = 0; i < orbitCount; i++) slotsPerOrbit.push(r.u8())

  const rootCount = r.u32()
  const rootPassives = []
  for (let i = 0; i < rootCount; i++) {
    const id = r.u64()
    if (id > 0xffffffff) throw new Error(`root passive id ${id} exceeds u32 — format change?`)
    rootPassives.push(Number(id))
  }

  const groupCount = r.u32()
  const groups = []
  for (let g = 0; g < groupCount; g++) {
    const x = r.f32()
    const y = r.f32()
    const unk1 = r.u32()
    const unk2 = r.u32()
    const flag = r.u8()
    const passiveCount = r.u32()
    const passives = []
    for (let j = 0; j < passiveCount; j++) {
      const passiveId = r.u32()
      const radius = r.u32()
      const position = r.u32()
      if (radius >= orbitCount) throw new Error(`node ${passiveId}: orbit ${radius} >= orbitCount ${orbitCount}`)
      if (position >= slotsPerOrbit[radius]) {
        throw new Error(`node ${passiveId}: position ${position} >= slots ${slotsPerOrbit[radius]} on orbit ${radius}`)
      }
      const connCount = r.u32()
      const connections = []
      for (let k = 0; k < connCount; k++) {
        connections.push({ target: r.u32(), arc: r.i32() })
      }
      passives.push({ passiveId, radius, position, connections })
    }
    groups.push({ x, y, unk1, unk2, flag, passives })
  }
  if (r.offset !== buf.length) {
    throw new Error(`trailing bytes: parsed ${r.offset} of ${buf.length}`)
  }
  return { version, graphType, slotsPerOrbit, rootPassives, groups }
}

/**
 * World position of a node on its group's orbit: slots are spread uniformly, slot 0 at
 * 12 o'clock, clockwise (y grows downward). Fit-validated: reproduces every baked
 * character-tree coordinate within 1 world unit.
 */
export function nodePosition(group, passive, slotsPerOrbit) {
  const radius = ORBIT_RADII[passive.radius]
  const angle = (2 * Math.PI * passive.position) / slotsPerOrbit[passive.radius]
  return { x: group.x + radius * Math.sin(angle), y: group.y - radius * Math.cos(angle) }
}

/**
 * Arc centre for a connection drawn as a circular arc of radius ORBIT_RADII[|arc|]
 * between (ax,ay) and (bx,by). Of the two circle centres equidistant from both
 * endpoints, arc > 0 picks the one to the RIGHT of A->B, arc < 0 the one to the LEFT
 * (empirically matched against all 1733 baked arc centres, 837 negative + 894 positive,
 * worst deviation 0.134 world units). Returns null for straight edges (arc 0 / NO_ARC),
 * out-of-table orbits, or a chord longer than the diameter (degenerate — draw straight).
 */
export function arcCenter(ax, ay, bx, by, arc) {
  if (arc === 0 || arc === NO_ARC) return null
  const orbit = Math.abs(arc)
  const r = ORBIT_RADII[orbit]
  if (r === undefined) return null
  const dx = bx - ax
  const dy = by - ay
  const chord = Math.hypot(dx, dy)
  if (chord === 0 || chord > 2 * r + 1) return null
  // d = distance from chord midpoint to centre; clamp for diametral chords (r ~ chord/2).
  const d = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)))
  const side = arc > 0 ? -1 : 1
  return {
    x: (ax + bx) / 2 + (side * d * -dy) / chord,
    y: (ay + by) / 2 + (side * d * dx) / chord,
  }
}

/** Flat node list with derived world positions: [{ passiveId, groupIndex, radius, position, x, y, connections }]. */
export function flattenNodes(decoded) {
  const out = []
  decoded.groups.forEach((group, groupIndex) => {
    for (const p of decoded.groups[groupIndex].passives) {
      const pos = nodePosition(group, p, decoded.slotsPerOrbit)
      out.push({
        passiveId: p.passiveId,
        groupIndex,
        radius: p.radius,
        position: p.position,
        x: pos.x,
        y: pos.y,
        connections: p.connections,
      })
    }
  })
  return out
}

/**
 * THE GROUND-TRUTH GATE — compare a decoded character-tree psg against GGG's baked
 * export (src/data/treeGraph.json shape: nodes keyed by id with x/y/orbit/orbitIndex,
 * top-level edges with optional orbitX/orbitY arc centres).
 */
export function verifyAgainstBaked(decoded, baked, tolerance = 1) {
  const nodes = flattenNodes(decoded)
  const report = {
    nodes: { total: nodes.length, matched: 0, missing: 0, orbitMismatch: 0, withinTolerance: 0, worst: 0 },
    arcs: { total: 0, centerWithinTolerance: 0, noBakedCenter: 0, worst: 0 },
    straight: { total: 0, agree: 0 },
    tolerance,
  }
  const pos = new Map()
  for (const n of nodes) {
    pos.set(n.passiveId, n)
    const bn = baked.nodes[String(n.passiveId)]
    if (!bn || typeof bn.x !== 'number') {
      report.nodes.missing++
      continue
    }
    report.nodes.matched++
    if (bn.orbit !== n.radius || bn.orbitIndex !== n.position) report.nodes.orbitMismatch++
    const err = Math.hypot(n.x - bn.x, n.y - bn.y)
    if (err <= tolerance) report.nodes.withinTolerance++
    if (err > report.nodes.worst) report.nodes.worst = err
  }

  const bakedEdges = new Map()
  for (const e of baked.edges) {
    if (e.from === 'root') continue
    bakedEdges.set(`${e.from}>${e.to}`, e)
  }
  for (const n of nodes) {
    for (const c of n.connections) {
      const be = bakedEdges.get(`${n.passiveId}>${c.target}`)
      if (!be) continue // baked export may drop edges; positions are the gate, not edge parity
      const t = pos.get(c.target)
      const center = t ? arcCenter(n.x, n.y, t.x, t.y, c.arc) : null
      if (center === null) {
        report.straight.total++
        if (be.orbitX === undefined) report.straight.agree++
      } else {
        report.arcs.total++
        if (be.orbitX === undefined) {
          report.arcs.noBakedCenter++
          continue
        }
        const err = Math.hypot(center.x - be.orbitX, center.y - be.orbitY)
        if (err <= tolerance) report.arcs.centerWithinTolerance++
        if (err > report.arcs.worst) report.arcs.worst = err
      }
    }
  }
  return report
}

class Reader {
  constructor(buf) {
    this.buf = buf
    this.offset = 0
  }
  u8() {
    const v = this.buf.readUInt8(this.offset)
    this.offset += 1
    return v
  }
  u32() {
    const v = this.buf.readUInt32LE(this.offset)
    this.offset += 4
    return v
  }
  i32() {
    const v = this.buf.readInt32LE(this.offset)
    this.offset += 4
    return v
  }
  u64() {
    const v = this.buf.readBigUInt64LE(this.offset)
    this.offset += 8
    return v
  }
  f32() {
    const v = this.buf.readFloatLE(this.offset)
    this.offset += 4
    return v
  }
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const file = args[0] ?? DEFAULT_PSG
  const decoded = decodePsg(readFileSync(file))
  const nodeCount = decoded.groups.reduce((n, g) => n + g.passives.length, 0)
  const connCount = decoded.groups.reduce((n, g) => n + g.passives.reduce((m, p) => m + p.connections.length, 0), 0)
  console.log(`${file}`)
  console.log(`  version ${decoded.version}, graphType ${decoded.graphType}, slotsPerOrbit [${decoded.slotsPerOrbit}]`)
  console.log(`  roots ${decoded.rootPassives.length} [${decoded.rootPassives}]`)
  console.log(`  groups ${decoded.groups.length}, nodes ${nodeCount}, connections ${connCount}`)

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...decoded, nodes: flattenNodes(decoded) }, null, 1))
  }
  if (process.argv.includes('--verify')) {
    const bakedPath = argValue('--verify') ?? DEFAULT_BAKED
    const baked = JSON.parse(readFileSync(bakedPath, 'utf8'))
    const rep = verifyAgainstBaked(decoded, baked)
    const pct = (n, d) => (d === 0 ? '100.00' : ((100 * n) / d).toFixed(2))
    console.log(`\nGround-truth fit vs ${bakedPath} (tolerance ${rep.tolerance} world unit):`)
    console.log(
      `  node positions : ${rep.nodes.withinTolerance}/${rep.nodes.matched} within tolerance (${pct(rep.nodes.withinTolerance, rep.nodes.matched)}%), worst ${rep.nodes.worst.toFixed(3)}`,
    )
    console.log(
      `  orbit/slot     : ${rep.nodes.matched - rep.nodes.orbitMismatch}/${rep.nodes.matched} exact (${rep.nodes.orbitMismatch} mismatches), ${rep.nodes.missing} psg nodes missing from baked export`,
    )
    console.log(
      `  arc centres    : ${rep.arcs.centerWithinTolerance}/${rep.arcs.total - rep.arcs.noBakedCenter} within tolerance (${pct(rep.arcs.centerWithinTolerance, rep.arcs.total - rep.arcs.noBakedCenter)}%), worst ${rep.arcs.worst.toFixed(3)} (${rep.arcs.noBakedCenter} arcs have no baked centre)`,
    )
    console.log(`  straight edges : ${rep.straight.agree}/${rep.straight.total} agree with baked`)
    const ok = rep.nodes.matched > 0 && rep.nodes.withinTolerance / rep.nodes.matched >= 0.99
    console.log(ok ? '  GATE: PASS (>= 99% within 1 unit)' : '  GATE: FAIL')
    if (!ok) process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
