import type { PobBuild, BuildPassive, Warning } from './types'
import { passiveIdForNode, canonicalUnique } from './lookups'
import { color, lines } from './markup'
import { copy } from '../copy'

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
  const missingJewels: string[] = []
  let weaponSetTagged = false

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
      } else {
        missingJewels.push(node) // socket references a jewel item absent from the export
      }
    }

    if (weaponSet === undefined && !additionalText) {
      out.push(id)
    } else {
      const obj: BuildPassive = { id }
      if (weaponSet !== undefined) {
        obj.weapon_set = weaponSet
        weaponSetTagged = true
      }
      if (additionalText) obj.additional_text = additionalText
      out.push(obj)
    }
  }

  // Sinister Jewel Sockets (and any socket on a node the tree didn't allocate) are granted dynamically in
  // game — by uniques like Voices ("Allocates N Sinister Jewel sockets") or the Zarokh's Gift anoint — so
  // their node ids never appear in <Spec nodes>, and the loop above skips them. Without this their jewels
  // are silently dropped from the .build. Emit each such socket's node (when it resolves to a real
  // PassiveSkills id) carrying only the jewel note; in-game the granting unique allocates the socket, so the
  // node is genuinely active. (Never weapon-set-tagged — these sockets aren't weapon-set-specific.)
  let grantedSocketJewels = 0
  for (const [node, jewelId] of jewelByNode) {
    if (seen.has(node)) continue // already emitted via the allocated-node loop
    const id = passiveIdForNode(node)
    if (!id) continue // not a node we can place a jewel on
    seen.add(node)
    const jewel = pob.items.get(jewelId)
    if (!(jewel && jewel.name)) {
      missingJewels.push(node)
      continue
    }
    const canon = canonicalUnique(jewel.name)
    out.push({
      id,
      additional_text: lines(color('grey', 'Socketed Jewel:'), color(canon ? 'unique' : 'silver', canon ?? jewel.name)),
    })
    grantedSocketJewels++
  }

  if (unknown.length) {
    warnings.push({
      level: 'warn',
      code: 'passive-node-unknown',
      message: copy.warn.passiveNodeUnknown(unknown.length, spec.treeVersion, unknown.slice(0, 8).join(', ')),
    })
  }
  if (weaponSetTagged) {
    warnings.push({
      level: 'info',
      code: 'weapon-set-tagging',
      message: copy.warn.weaponSetTagging,
    })
  }
  if (missingJewels.length) {
    warnings.push({
      level: 'info',
      code: 'socket-jewel-missing',
      message: copy.warn.socketJewelMissing(missingJewels.length),
    })
  }
  if (grantedSocketJewels) {
    warnings.push({
      level: 'info',
      code: 'granted-socket-jewels',
      message: copy.warn.grantedSocketJewels(grantedSocketJewels),
    })
  }

  return { passives: out, skipped }
}
