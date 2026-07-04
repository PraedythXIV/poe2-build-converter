// Shared psg-graph builder helpers. The atlas (build-atlas-graph.mjs) and genesis
// (build-genesis-graph.mjs) builders decode different .psg files but share the placement
// dedup, the Id-sibling choose-one detection, the edge emission and the bounds math
// verbatim — one home so the two pipelines can never drift.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { arcCenter } from './decode-psg.mjs'
import { loadDescriptions, resolveStats } from './lib-csd.mjs'

export const round1 = (v) => Math.round(v * 10) / 10

/** The shared builder preamble: PassiveSkills/Stats tables + extract meta + the PassiveSkillGraphId
 *  join map + .csd stat text + the placement-deduped psg nodes. (Dedupe refactor while green: the
 *  identical openings of build-atlas-graph.mjs and build-genesis-graph.mjs.) */
export function readGraphInputs(extract, csdFiles, psgNodes) {
  const passiveRows = JSON.parse(readFileSync(join(extract, 'tables', 'PassiveSkills.json'), 'utf8'))
  const statRows = JSON.parse(readFileSync(join(extract, 'tables', 'Stats.json'), 'utf8'))
  const meta = JSON.parse(readFileSync(join(extract, 'extract-meta.json'), 'utf8'))
  const byGraphId = new Map(passiveRows.map((r) => [r.PassiveSkillGraphId, r]))
  const descriptions = loadDescriptions(join(extract, 'files'), csdFiles)
  const chosen = choosePlacements(psgNodes)
  return { passiveRows, statRows, meta, byGraphId, descriptions, chosen }
}

/** Stat1..5Value + StatValue6/7 in the positional order PassiveSkills pairs with row.Stats. */
export const statValues = (row) => [
  row.Stat1Value,
  row.Stat2Value,
  row.Stat3Value,
  row.Stat4Value,
  row.Stat5Value,
  row.StatValue6,
  row.StatValue7,
]

/**
 * Keep, per passive id, the psg placement closest to its connected neighbours — a psg may place
 * the same passive twice (4.5.2.1.2 atlas: 26306 "Dark Bloodlines" in two adjacent groups, one
 * copy unconnected); the copy nearest its neighbours is the one the edges draw to.
 */
export function choosePlacements(psgNodes) {
  const placements = new Map()
  for (const pn of psgNodes) {
    const list = placements.get(pn.passiveId)
    if (list) list.push(pn)
    else placements.set(pn.passiveId, [pn])
  }
  const neighborsOf = (id) => {
    const out = []
    for (const pn of psgNodes) {
      for (const c of pn.connections) {
        if (c.target === id) out.push(pn)
        if (pn.passiveId === id) out.push(placements.get(c.target)[0])
      }
    }
    return out
  }
  const chosen = new Map()
  for (const [id, list] of placements) {
    let pick = list[0]
    if (list.length > 1) {
      const neighbors = neighborsOf(id)
      const score = (pn) => neighbors.reduce((s, nb) => s + Math.hypot(nb.x - pn.x, nb.y - pn.y), 0)
      for (const pn of list.slice(1)) if (score(pn) < score(pick)) pick = pn
      console.warn(
        `WARN: passive ${id} placed ${list.length}x in the psg — keeping the copy nearest its ${neighbors.length} neighbour(s)`,
      )
    }
    chosen.set(id, pick)
  }
  return chosen
}

/**
 * Choose-one options for a node: sibling PassiveSkills rows (<baseId> + a/b/c…) the psg geometry
 * never places. Detected by the Id convention — NOT the prompt wording, which varies. Each option
 * resolves to exact text (internal stats with no .csd description are dropped; an option still
 * stands on its sourced name). Returns the choices array — attach when >= 2 (a genuine pick).
 */
export function detectChoices(row, passiveRows, descriptions, statRows) {
  const base = row.Id.replace(/_+$/, '') // strip ALL trailing underscores (e.g. AtlasAbyssNotable14__)
  return passiveRows
    .filter(
      (r) =>
        r.Id !== row.Id &&
        r.Id.startsWith(base) &&
        /^[a-z]_?$/.test(r.Id.slice(base.length)) &&
        r.Name &&
        !/\[DNT\]/.test(r.Name),
    )
    .map((r) => {
      const { stats: ostats } = resolveStats(r.Stats, statValues(r), descriptions, statRows)
      // Short label = the option name minus the parent prefix ("On the Wind: Speed" -> "Speed").
      const label = row.Name && r.Name.startsWith(`${row.Name}: `) ? r.Name.slice(row.Name.length + 2) : r.Name
      return { name: label, stats: ostats.filter((s) => !/^[a-z][\w+%]*\s*=/.test(s)) }
    })
    .filter((c) => c.stats.length || c.name) // keep options with resolvable text OR a real label
}

/**
 * Undirected edges with arc centres re-derived from the fit-validated sign convention.
 * `skip(id)` drops edges touching removed nodes (genesis StartNodes); default keeps all.
 */
export function buildEdges(chosen, skip = () => false) {
  const edges = []
  const seen = new Set()
  for (const pn of chosen.values()) {
    if (skip(pn.passiveId)) continue
    for (const c of pn.connections) {
      if (skip(c.target)) continue
      const target = chosen.get(c.target)
      if (!target) throw new Error(`connection ${pn.passiveId} -> ${c.target}: unknown target node`)
      const undirected = pn.passiveId < c.target ? `${pn.passiveId}>${c.target}` : `${c.target}>${pn.passiveId}`
      if (seen.has(undirected)) continue
      seen.add(undirected)
      const edge = { from: pn.passiveId, to: c.target }
      const center = arcCenter(pn.x, pn.y, target.x, target.y, c.arc)
      if (center) {
        edge.orbitX = round1(center.x)
        edge.orbitY = round1(center.y)
      }
      edges.push(edge)
    }
  }
  return edges
}

/** The shared psg-graph provenance + bounds/classes skeleton. (Dedupe refactor while green:
 *  MOVED VERBATIM from the identical `graph = { _provenance…, bounds…, classes: [] }` openings of
 *  build-atlas-graph.mjs and build-genesis-graph.mjs — only the .psg path interpolation differs,
 *  now the `psgPath` parameter. The check:dedupe gate flagged the twin.) */
export function psgGraphHeader(psgPath, patch, { minX, minY, maxX, maxY }) {
  return {
    _provenance: {
      source: `own pathofexile-dat extraction — ${psgPath} + PassiveSkills/Stats tables @ ${patch}`,
      captured: new Date().toISOString().slice(0, 10),
      note: 'Geometry decoded via scripts/decode-psg.mjs (orbit math fit-validated against the official character-tree export). Game data (c) Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    bounds: { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY },
    classes: [],
  }
}

/** Graph bounds + the non-finite-position fail-loud check. */
export function computeBounds(nodes) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const n of Object.values(nodes)) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) throw new Error(`node ${n.id}: non-finite position`)
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x > maxX) maxX = n.x
    if (n.y > maxY) maxY = n.y
  }
  return { minX, minY, maxX, maxY }
}
