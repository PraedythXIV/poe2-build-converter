// Vendored, version-pinned lookup tables (see scripts/fetch-data.mjs).
// These are bundled into the app at build time — NO runtime network access.

import passivesData from '../data/passives.json'
import gemsData from '../data/gems.json'
import uniquesData from '../data/uniques.json'
import provenanceData from '../data/provenance.json'

// Cast away the giant literal types that resolveJsonModule would otherwise infer
// (keeps tsc fast and the call sites clean).
const PASSIVE_NODES = (passivesData as { nodes: Record<string, string> }).nodes
const ASCENDANCIES = (passivesData as {
  ascendancies: Record<string, { name: string; class: string }>
}).ascendancies
const GEMS = gemsData as Record<string, { n: string; t: string }>
/** lowercased name -> canonical display name */
const UNIQUES = uniquesData as Record<string, string>

export const provenance = provenanceData as {
  captured: string
  counts: Record<string, number>
}

/** Numeric passive node id -> PassiveSkills `.build` id string (e.g. "35426" -> "strength89"). */
export function passiveIdForNode(numericNodeId: string): string | undefined {
  return PASSIVE_NODES[numericNodeId]
}

export function ascendancyInfo(id: string): { name: string; class: string } | undefined {
  return ASCENDANCIES[id]
}

export function gemInfo(gemId: string): { n: string; t: string } | undefined {
  return GEMS[gemId]
}

/** Returns the canonical-cased unique name if known, else undefined. */
export function canonicalUnique(name: string): string | undefined {
  return UNIQUES[name.trim().toLowerCase()]
}

export { PASSIVE_NODES, ASCENDANCIES, GEMS, UNIQUES }
