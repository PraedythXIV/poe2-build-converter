import type { Build, BuildPassive, BuildSkill, BuildInventorySlot, PobBuild, Warning } from './types'
import { ascendancyInfo, provenance } from './lookups'

const DISCLAIMER = "This product isn't affiliated with or endorsed by Grinding Gear Games in any way."

export interface AssembleParts {
  passives: (string | BuildPassive)[]
  skills: (string | BuildSkill)[]
  inventory_slots: BuildInventorySlot[]
  name?: string
}

function defaultName(pob: PobBuild): string {
  const asc = pob.spec.ascendancyInternalId ? ascendancyInfo(pob.spec.ascendancyInternalId) : undefined
  const who = asc?.name || pob.ascendClassName || pob.className || 'Imported Build'
  return pob.level ? `${who} (Lv ${pob.level})` : who
}

export function assembleBuild(pob: PobBuild, parts: AssembleParts): Build {
  const build: Build = {
    name: (parts.name && parts.name.trim()) || defaultName(pob),
    author: 'poe2-build-converter (PoB2 import)',
    description: `Converted from Path of Building 2 (passive tree ${pob.spec.treeVersion}). ${DISCLAIMER}`,
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

/** Lightweight schema sanity-check; appends warnings rather than throwing. */
export function validateBuild(build: Build, warnings: Warning[]): void {
  if (!build.name || !build.name.trim()) {
    warnings.push({ level: 'error', code: 'missing-name', message: 'Build is missing a required `name`.' })
  }
  const idOf = (p: string | BuildPassive) => (typeof p === 'string' ? p : p.id)
  const badPassive = (build.passives ?? []).map(idOf).filter((id) => !PASSIVE_ID_RE.test(id))
  if (badPassive.length) {
    warnings.push({
      level: 'warn',
      code: 'passive-id-format',
      message: `${badPassive.length} passive id(s) have an unexpected format: ${badPassive.slice(0, 5).join(', ')}.`,
    })
  }
  const skillId = (s: string | BuildSkill) => (typeof s === 'string' ? s : s.id)
  const allGemIds = (build.skills ?? []).flatMap((s) => {
    const ids = [skillId(s)]
    if (typeof s !== 'string' && s.support_skills) {
      ids.push(...s.support_skills.map((x) => (typeof x === 'string' ? x : x.id)))
    }
    return ids
  })
  const badGem = allGemIds.filter((id) => !GEM_ID_RE.test(id))
  if (badGem.length) {
    warnings.push({
      level: 'warn',
      code: 'gem-id-format',
      message: `${badGem.length} gem id(s) don't look like a Metadata path: ${badGem.slice(0, 5).join(', ')}.`,
    })
  }
}

export { provenance }
