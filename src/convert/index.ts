// Public entry point: PoB2 code/XML -> .build conversion result.

import type { ConvertResult, ConvertStats, Warning } from './types'
import { decodePobCode, DecodeError } from './decode'
import { parsePob, ParseError } from './parsePob'
import { mapPassives } from './mapPassives'
import { mapSkills } from './mapSkills'
import { mapItems } from './mapItems'
import { assembleBuild, serialize, validateBuild } from './emit'
import { ascendancyInfo } from './lookups'

export { DecodeError, ParseError }
export type { ConvertResult, Warning } from './types'
export { summarize, summarizeSafe } from './summarize'
export type { BuildSummary, SummaryItem, SummarySkill } from './summarize'

export interface ConvertOptions {
  /** Override the generated build name. */
  name?: string
}

/**
 * Convert a Path of Building 2 export code (or raw decoded XML) into a PoE2 `.build` object,
 * its serialized JSON, diagnostics, and stats. Throws DecodeError/ParseError on fatal input issues.
 */
export function convert(input: string, opts: ConvertOptions = {}): ConvertResult {
  if (!input || !input.trim()) {
    throw new DecodeError('Nothing to convert — paste a Path of Building 2 code or upload an XML file.')
  }

  const xml = decodePobCode(input)
  const pob = parsePob(xml)

  const warnings: Warning[] = []
  const { passives, skipped: passivesSkipped } = mapPassives(pob, warnings)
  const { skills, skillCount, supportCount } = mapSkills(pob, warnings)
  const { inventory_slots, itemCount, skipped: itemsSkipped } = mapItems(pob, warnings)

  const buildName = opts.name ? opts.name : undefined
  const build = assembleBuild(pob, { passives, skills, inventory_slots, ...(buildName ? { name: buildName } : {}) })
  validateBuild(build, warnings)

  const json = serialize(build)

  const ascId = pob.spec.ascendancyInternalId
  const stats: ConvertStats = {
    className: pob.className,
    ascendancy: (ascId && ascendancyInfo(ascId)?.name) || pob.ascendClassName || null,
    level: pob.level,
    passiveCount: passives.length,
    passivesSkipped,
    skillCount,
    supportCount,
    itemCount,
    itemsSkipped,
    treeVersion: pob.spec.treeVersion,
  }

  return { build, json, warnings, stats }
}
