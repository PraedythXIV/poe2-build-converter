import type { PobBuild, BuildSkill, Warning } from './types'
import { gemInfo } from './lookups'

export interface MappedSkills {
  skills: (string | BuildSkill)[]
  skillCount: number
  supportCount: number
}

/**
 * Map PoB socket groups to `.build` skills, matching poe.ninja's authoritative output exactly:
 * each socket group becomes ONE `skills[]` entry whose `id` is the group's FIRST gem, with every
 * other gem listed under `support_skills` VERBATIM — even other active gems (e.g. a Whirling Assault
 * that shares a Hollow Form's socket group is emitted as a "support"). Gem ids pass through unchanged,
 * including the singular/plural "Gem"/"Gems" inconsistency. Auto-generated groups (source="Tree:…" /
 * "Item:…", i.e. tree-/item-GRANTED skills) are skipped — poe.ninja drops them too.
 */
export function mapSkills(pob: PobBuild, warnings: Warning[]): MappedSkills {
  const skills: (string | BuildSkill)[] = []
  let skillCount = 0
  let supportCount = 0
  const unknownGems = new Set<string>()

  for (const group of pob.skillGroups) {
    if (!group.enabled) continue
    if (group.source) continue
    const gems = group.gems.filter((g) => g.enabled && g.gemId)
    const active = gems[0]
    if (!active) continue

    // validate gem ids against the vendored table (don't normalize — just warn)
    for (const g of gems) if (!gemInfo(g.gemId)) unknownGems.add(g.gemId)

    const supportIds = gems.slice(1).map((g) => g.gemId)
    skillCount++
    supportCount += supportIds.length
    if (supportIds.length === 0) skills.push(active.gemId)
    else skills.push({ id: active.gemId, support_skills: supportIds })
  }

  if (unknownGems.size) {
    warnings.push({
      level: 'warn',
      code: 'gem-id-unknown',
      message: `${unknownGems.size} gem id(s) were not in the vendored gem table (may be new/renamed); emitted verbatim. Examples: ${[...unknownGems].slice(0, 6).join(', ')}.`,
    })
  }

  return { skills, skillCount, supportCount }
}
