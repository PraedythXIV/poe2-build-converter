import type { PobBuild, BuildPassive, Warning } from './types'
import { passiveIdForNode, canonicalUnique } from './lookups'
import { color, lines } from './markup'

export interface MappedPassives {
  passives: (string | BuildPassive)[]
  skipped: number
}

/**
 * Map PoB numeric passive node ids to `.build` PassiveSkills id strings.
 * Tags weapon-set-specific nodes, and annotates jewel sockets with the socketed jewel's name.
 */
export function mapPassives(pob: PobBuild, warnings: Warning[]): MappedPassives {
  const { spec } = pob
  const ws1 = new Set(spec.weaponSet1)
  const ws2 = new Set(spec.weaponSet2)

  // node -> jewel item id, for non-empty sockets
  const jewelByNode = new Map<string, string>()
  for (const s of spec.sockets) {
    if (s.itemId && s.itemId !== '0') jewelByNode.set(s.nodeId, s.itemId)
  }

  const out: (string | BuildPassive)[] = []
  const seen = new Set<string>()
  let skipped = 0
  const unknown: string[] = []

  for (const node of spec.nodes) {
    if (seen.has(node)) continue
    seen.add(node)

    const id = passiveIdForNode(node)
    if (!id) {
      skipped++
      unknown.push(node)
      continue
    }

    // weapon set: specific to 1 or 2 only (nodes in both, or in neither, are shared/base)
    const inWs1 = ws1.has(node)
    const inWs2 = ws2.has(node)
    let weaponSet: number | undefined
    if (inWs1 && !inWs2) weaponSet = 1
    else if (inWs2 && !inWs1) weaponSet = 2

    // jewel annotation
    let additionalText: string | undefined
    const jewelId = jewelByNode.get(node)
    if (jewelId) {
      const jewel = pob.items.get(jewelId)
      if (jewel && jewel.name) {
        const canon = canonicalUnique(jewel.name)
        additionalText = lines(
          color('grey', 'Socketed Jewel:'),
          color(canon ? 'unique' : 'silver', canon ?? jewel.name),
        )
      }
    }

    if (weaponSet === undefined && !additionalText) {
      out.push(id)
    } else {
      const obj: BuildPassive = { id }
      if (weaponSet !== undefined) obj.weapon_set = weaponSet
      if (additionalText) obj.additional_text = additionalText
      out.push(obj)
    }
  }

  if (unknown.length) {
    warnings.push({
      level: 'warn',
      code: 'passive-node-unknown',
      message: `${unknown.length} passive node id(s) were not in the vendored tree (version ${spec.treeVersion}) and were skipped. They may be from a newer/older tree — refresh the data (npm run fetch-data) or check the build's tree version. Examples: ${unknown.slice(0, 8).join(', ')}.`,
    })
  }
  if (spec.weaponSet1.length || spec.weaponSet2.length) {
    warnings.push({
      level: 'info',
      code: 'weapon-set-tagging',
      message: 'This build uses weapon-set passives; weapon_set tagging is best-effort — verify in-game.',
    })
  }

  return { passives: out, skipped }
}
