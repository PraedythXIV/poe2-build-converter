import type { Build, BuildPassive, BuildSkill, BuildInventorySlot, PobBuild, Warning } from './types'
import { ascendancyInfo, provenance } from './lookups'
import { copy } from '../copy'

export interface AssembleParts {
  passives: (string | BuildPassive)[]
  skills: (string | BuildSkill)[]
  inventory_slots: BuildInventorySlot[]
  name?: string
  author?: string
  /** Source URL (e.g. the pobb.in page a link-import came from); no generated fallback. */
  link?: string
  description?: string
}

const DEFAULT_AUTHOR = 'poe2-build-converter (PoB2 import)'

/** Trimmed value, or undefined when blank/absent — so a blank field falls back to the default. */
const trimmed = (s?: string): string | undefined => (s && s.trim()) || undefined

/** Extract the id from a union of a bare id string or an object that carries one. */
const getId = <T extends { id: string }>(x: string | T): string => (typeof x === 'string' ? x : x.id)

function defaultName(pob: PobBuild): string {
  const asc = pob.spec.ascendancyInternalId ? ascendancyInfo(pob.spec.ascendancyInternalId) : undefined
  const who = asc?.name || pob.ascendClassName || pob.className || 'Imported Build'
  return pob.level ? `${who} (Lv ${pob.level})` : who
}

/** The auto-generated build metadata — used both as the convert fallback (blank field) AND as the
 *  Convert-step input placeholders, so the two never drift. */
export function defaultBuildMeta(pob: PobBuild): { name: string; author: string; description: string } {
  return {
    name: defaultName(pob),
    author: DEFAULT_AUTHOR,
    description: `Converted from Path of Building 2 (passive tree ${pob.spec.treeVersion}). ${provenance.note}`,
  }
}

export function assembleBuild(pob: PobBuild, parts: AssembleParts): Build {
  const d = defaultBuildMeta(pob)
  const link = trimmed(parts.link) // optional, no fallback — spec order puts it between author/description
  const build: Build = {
    name: trimmed(parts.name) || d.name,
    author: trimmed(parts.author) || d.author,
    ...(link ? { link } : {}),
    description: trimmed(parts.description) || d.description,
  }
  if (pob.spec.ascendancyInternalId) build.ascendancy = pob.spec.ascendancyInternalId
  if (parts.passives.length) build.passives = parts.passives
  if (parts.skills.length) build.skills = parts.skills
  if (parts.inventory_slots.length) build.inventory_slots = parts.inventory_slots
  return build
}

/** Serialize with 4-space indentation to match GGG's own example file. */
export function serialize(build: Build): string {
  return JSON.stringify(build, null, 4)
}

const PASSIVE_ID_RE = /^[A-Za-z0-9_]+$/
const GEM_ID_RE = /^Metadata\/Items\/Gems?\//

/** Lightweight schema sanity-check; appends warnings rather than throwing.
 *  Builds from `assembleBuild` always carry a non-empty name, so the name guard below is
 *  unreachable on that path — it's kept as defense-in-depth for directly-constructed `Build`s
 *  (this is an exported schema check over the exported `Build` type, not an assemble-only helper). */
export function validateBuild(build: Build, warnings: Warning[]): void {
  if (!build.name || !build.name.trim()) {
    warnings.push({ level: 'error', code: 'missing-name', message: copy.warn.missingName })
  }
  const badPassive = (build.passives ?? []).map(getId).filter((id) => !PASSIVE_ID_RE.test(id))
  if (badPassive.length) {
    warnings.push({
      level: 'warn',
      code: 'passive-id-format',
      message: copy.warn.passiveIdFormat(badPassive.length, badPassive.slice(0, 5).join(', ')),
    })
  }
  const allGemIds = (build.skills ?? []).flatMap((s) => {
    const ids = [getId(s)]
    if (typeof s !== 'string' && s.support_skills) {
      ids.push(...s.support_skills.map(getId))
    }
    return ids
  })
  const badGem = allGemIds.filter((id) => !GEM_ID_RE.test(id))
  if (badGem.length) {
    warnings.push({
      level: 'warn',
      code: 'gem-id-format',
      message: copy.warn.gemIdFormat(badGem.length, badGem.slice(0, 5).join(', ')),
    })
  }
}
