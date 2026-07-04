// Public entry point: PoB2 code/XML -> .build conversion result.

import type { ConvertResult, ConvertStats, PobBuild, Warning } from './types'
import { decodePobCode, DecodeError } from './decode'
import { parsePob, ParseError } from './parsePob'
import { mapPassives } from './mapPassives'
import { mapSkills } from './mapSkills'
import { mapItems } from './mapItems'
import { assembleBuild, serialize, validateBuild } from './emit'
import { ascendancyInfo } from './lookups'
import { copy } from '../copy'

export { DecodeError, ParseError }
export type { ConvertResult, Warning } from './types'
export { defaultBuildMeta } from './emit'

export interface ConvertOptions {
  /** Override the generated build name. */
  name?: string
  /** Override the generated author. */
  author?: string
  /** Source URL for the .build root `link` field (e.g. the pobb.in page of a link import). */
  link?: string
  /** Override the generated description. */
  description?: string
  /** Replace the allocated tree nodes (numeric ids as strings) — used by the interactive
   *  tree's edits. Weapon-set node lists are intersected with the override so a removed
   *  node also loses its weapon_set tag; added nodes are shared (no weapon set). */
  nodesOverride?: string[]
}

/** Drop the falsy (undefined / empty) entries of a meta-override object so a blank override
 *  never replaces the generated name/author/description (one rule for both convert paths). */
function pickDefined<T extends Record<string, string | undefined>>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const key in obj) if (obj[key]) out[key] = obj[key]
  return out
}

/** Apply a tree-edit node override to a parsed build (single source of truth — the live
 *  preview and convert() must agree on what an edited build contains). */
export function overrideSpecNodes<T extends { spec: PobSpecLike }>(pob: T, nodes: string[]): T {
  const allowed = new Set(nodes)
  const keepAllowed = (set: string[]) => set.filter((n) => allowed.has(n))
  return {
    ...pob,
    spec: {
      ...pob.spec,
      nodes: nodes.slice(),
      weaponSet1: keepAllowed(pob.spec.weaponSet1),
      weaponSet2: keepAllowed(pob.spec.weaponSet2),
    },
  }
}
interface PobSpecLike {
  nodes: string[]
  weaponSet1: string[]
  weaponSet2: string[]
}

/**
 * Convert a Path of Building 2 export code (or raw decoded XML) into a PoE2 `.build` object,
 * its serialized JSON, diagnostics, and stats. Throws DecodeError/ParseError on fatal input issues.
 */
export function convert(input: string, opts: ConvertOptions = {}): ConvertResult {
  if (!input || !input.trim()) {
    throw new DecodeError(copy.warn.nothingToConvert)
  }

  const xml = decodePobCode(input)
  let pob = parsePob(xml)
  if (opts.nodesOverride) pob = overrideSpecNodes(pob, opts.nodesOverride)

  return convertPob(pob, { name: opts.name, author: opts.author, link: opts.link, description: opts.description })
}

/**
 * Convert an already-parsed PobBuild into the `.build` result — the pipeline AFTER decode/parse
 * (map passives/skills/items, assemble, validate, serialize, stats). The shared core that
 * `convert()` calls once it has a parsed model.
 */
export function convertPob(
  pob: PobBuild,
  opts: { name?: string; author?: string; link?: string; description?: string } = {},
): ConvertResult {
  const warnings: Warning[] = []
  const { passives, skipped: passivesSkipped } = mapPassives(pob, warnings)
  const { skills, skillCount, supportCount } = mapSkills(pob, warnings)
  const { inventory_slots, itemCount, skipped: itemsSkipped } = mapItems(pob, warnings)

  const build = assembleBuild(pob, {
    passives,
    skills,
    inventory_slots,
    ...pickDefined({ name: opts.name, author: opts.author, link: opts.link, description: opts.description }),
  })
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

/** A user-named (tree spec, skill set, item set) tuple → one `.build` file (multi-build export). */
export interface VariantSelection {
  /** 0-based index into `pob.specs` (the passive tree). */
  specIndex: number
  /** id of the chosen set in `pob.skillSets`. */
  skillSetId: string
  /** id of the chosen set in `pob.itemSets`. */
  itemSetId: string
  /** the `.build` name for this variant. */
  name: string
  /** optional author / link / description override (global — the same value applied to every variant). */
  author?: string
  link?: string
  description?: string
}

/**
 * Convert ONE chosen (tree spec, skill set, item set) tuple of an already-parsed build into a
 * `.build` — the unit of multi-`.build` export. Swaps the chosen axes into a view of the parsed
 * build and runs the SAME `convertPob` pipeline (one source of truth — a variant is converted
 * exactly like the active build, only with different sets selected). Each selector falls back to
 * the active axis if it doesn't resolve (defensive; the UI always passes ids that exist).
 */
export function convertVariant(pob: PobBuild, sel: VariantSelection): ConvertResult {
  const spec = pob.specs[sel.specIndex] ?? pob.spec
  const skillGroups = pob.skillSets.find((s) => s.id === sel.skillSetId)?.groups ?? pob.skillGroups
  const slots = pob.itemSets.find((s) => s.id === sel.itemSetId)?.slots ?? pob.slots
  // Keep the active-axis pointers in step with the swapped axes so the view stays internally
  // consistent (conversion never reads them, but a future consumer of `view` would otherwise see
  // indices/ids that point at the original active axes rather than the variant's).
  const view: PobBuild = {
    ...pob,
    spec,
    skillGroups,
    slots,
    activeSpecIndex: sel.specIndex,
    activeSkillSetId: sel.skillSetId,
    activeItemSetId: sel.itemSetId,
  }
  const trim = (s?: string) => (s && s.trim()) || undefined
  const result = convertPob(
    view,
    pickDefined({
      name: trim(sel.name),
      author: trim(sel.author),
      link: trim(sel.link),
      description: trim(sel.description),
    }),
  )
  // A PoB can carry specs exported on different tree versions; an old-version spec whose node ids all
  // still resolve would otherwise convert silently against the current tree. Cue the user once per file.
  const versions = new Set(pob.specs.map((s) => s.treeVersion))
  if (versions.size > 1) {
    result.warnings.push({
      level: 'warn',
      code: 'mixed-tree-versions',
      message: copy.warn.mixedTreeVersions(spec.treeVersion, [...versions].join(', ')),
    })
  }
  return result
}
