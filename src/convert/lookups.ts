// Vendored, version-pinned lookup tables (see scripts/fetch-data.mjs).
// These are bundled into the app at build time — NO runtime network access.

import passivesData from '../data/passives.json'
import gemsData from '../data/gems.json'
import uniquesData from '../data/uniques.json'
import provenanceData from '../data/provenance.json'

// Cast away the giant literal types that resolveJsonModule would otherwise infer
// (keeps tsc fast and the call sites clean).
const PASSIVE_NODES = (passivesData as { nodes: Record<string, string> }).nodes
const NODE_META =
  (
    passivesData as {
      nodeMeta?: Record<string, { name: string; kind: string; asc?: number }>
    }
  ).nodeMeta ?? {}
const ASCENDANCIES = (
  passivesData as {
    ascendancies: Record<string, { name: string; class: string }>
  }
).ascendancies
const GEMS = gemsData as Record<string, { n: string; t: string }>
/** lowercased name -> canonical display name */
const UNIQUES = uniquesData as Record<string, string>

export const provenance = provenanceData as {
  captured: string
  /** Live PoE2 patch the datamined tables were extracted from (e.g. "4.5.2.1.2"). */
  poe2Patch: string
  counts: Record<string, number>
  /** GGG non-affiliation disclaimer — the single source for the legal note (also emitted into .build descriptions). */
  note: string
}

/** Numeric passive node id -> PassiveSkills `.build` id string (e.g. "35426" -> "strength89"). */
export function passiveIdForNode(numericNodeId: string): string | undefined {
  return PASSIVE_NODES[numericNodeId]
}

/** Readable name + kind (keystone/notable/mastery, asc=1 for ascendancy) for a NAMED node;
 *  undefined for ordinary small nodes (which the vendored data deliberately leaves unnamed). */
export function passiveMeta(numericNodeId: string): { name: string; kind: string; asc?: number } | undefined {
  return NODE_META[numericNodeId]
}

export function ascendancyInfo(id: string): { name: string; class: string } | undefined {
  return ASCENDANCIES[id]
}

export function gemInfo(gemId: string): { n: string; t: string } | undefined {
  return GEMS[gemId]
}

/** Shared lookup-key normalization (trim + lowercase) for case-insensitive name matching. */
function normalizeLookupKey(name: string): string {
  return name.trim().toLowerCase()
}

let gemNamesLower: Set<string> | null = null
/** True when `name` is a known skill/support gem DISPLAY name (case-insensitive). Used to tell a
 *  sceptre's skill socket (PoB serializes it as "Rune: Purity of Ice") apart from a real rune —
 *  rune/soul-core names never collide with gem names, so the test is exact, not a heuristic. */
export function isGemName(name: string): boolean {
  if (!gemNamesLower) {
    gemNamesLower = new Set(
      Object.values(GEMS)
        .map((g) => normalizeLookupKey(g.n))
        .filter((n) => n.length > 0),
    )
  }
  return gemNamesLower.has(normalizeLookupKey(name))
}

/** Returns the canonical-cased unique name if known, else undefined. */
export function canonicalUnique(name: string): string | undefined {
  return UNIQUES[normalizeLookupKey(name)]
}
