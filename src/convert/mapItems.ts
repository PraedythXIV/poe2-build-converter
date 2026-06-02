import type { PobBuild, PobItem, BuildInventorySlot, Warning } from './types'
import { canonicalUnique } from './lookups'
import { color, lines } from './markup'

export interface MappedItems {
  inventory_slots: BuildInventorySlot[]
  itemCount: number
  skipped: number
}

/**
 * PoB slot name -> `.build` Inventories id (+ slot_x for grid inventories).
 * Cross-checked against real working exports from poe.ninja and Mobalytics (PoE2 0.5):
 *   - Weapons/offhands span two weapon sets: Weapon1/Offhand1 (set 1), Weapon2/Offhand2 (set 2/swap).
 *   - Flasks are a 2-wide "Flask1" inventory: slot_x 0 = life, 1 = mana.
 *   - Charms are a separate 3-wide "Charm1" inventory: slot_x 0/1/2.
 * (Mobalytics emits `Charm1` x0/x1/x2; an earlier probe showed `Flask1` x2 ALSO lands on the charm
 *  slot, but `Charm1` is the canonical id — use it.) Slots not listed are skipped with a note.
 *
 * FUTURE: PoE2 0.5 has 3 charm slots; up to 6 are expected. PoB only exports slots that exist, so
 * nothing to do until then — when they appear they are most likely `Charm1` x3/x4/x5 (a wider row),
 * not a second slot_y row. Confirm with a slot-probe before mapping.
 */
const SLOT_MAP: Record<string, { id: string; x?: number }> = {
  'Weapon 1': { id: 'Weapon1' },
  'Weapon 2': { id: 'Offhand1' },
  'Weapon 1 Swap': { id: 'Weapon2' },
  'Weapon 2 Swap': { id: 'Offhand2' },
  Helmet: { id: 'Helm1' },
  'Body Armour': { id: 'BodyArmour1' },
  Gloves: { id: 'Gloves1' },
  Boots: { id: 'Boots1' },
  Amulet: { id: 'Amulet1' },
  'Ring 1': { id: 'Ring1' },
  'Ring 2': { id: 'Ring2' },
  Belt: { id: 'Belt1' },
  'Flask 1': { id: 'Flask1', x: 0 },
  'Flask 2': { id: 'Flask1', x: 1 },
  'Charm 1': { id: 'Charm1', x: 0 },
  'Charm 2': { id: 'Charm1', x: 1 },
  'Charm 3': { id: 'Charm1', x: 2 },
}

const MAX_MODS = 10

function rareGuidance(item: PobItem): string {
  const head = item.baseType || item.name
  const shownMods = item.mods.slice(0, MAX_MODS)
  const more = item.mods.length > shownMods.length ? `… (+${item.mods.length - shownMods.length} more)` : ''
  return lines(
    color('silver', `${titleCase(item.rarity)} — ${head}`),
    item.name && item.name !== head ? color('grey', item.name) : '',
    '',
    shownMods.length ? color('grey', shownMods.join('\n')) : '',
    more ? color('grey', more) : '',
  )
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s
}

export function mapItems(pob: PobBuild, warnings: Warning[]): MappedItems {
  const inventory_slots: BuildInventorySlot[] = []
  let itemCount = 0
  let skipped = 0
  const unmapped = new Set<string>()
  const uncanonicalUniques: string[] = []

  for (const slot of pob.slots) {
    if (!slot.itemId || slot.itemId === '0') continue
    const mapped = SLOT_MAP[slot.name]
    if (!mapped) {
      unmapped.add(slot.name)
      skipped++
      continue
    }
    const item = pob.items.get(slot.itemId)
    if (!item) {
      skipped++
      continue
    }

    const entry: BuildInventorySlot = { inventory_id: mapped.id }
    if (mapped.x !== undefined) entry.slot_x = mapped.x
    // Level range the item applies, mirroring Mobalytics: [usable-from, max]. PoB gives us the
    // item's level requirement; the upper bound is the level cap (100).
    entry.level_interval = [item.levelReq, 100]
    const rarity = item.rarity.toUpperCase()

    if (rarity === 'UNIQUE' || rarity === 'RELIC') {
      const canon = canonicalUnique(item.name)
      entry.unique_name = canon ?? item.name
      if (!canon) uncanonicalUniques.push(item.name)
      if (item.baseType) entry.additional_text = color('unique', item.name) + '\n' + color('grey', item.baseType)
    } else {
      entry.additional_text = rareGuidance(item)
    }

    inventory_slots.push(entry)
    itemCount++
  }

  if (unmapped.size) {
    warnings.push({
      level: 'info',
      code: 'slot-unmapped',
      message: `Skipped ${unmapped.size} slot(s) with no Build Planner equivalent (weapon-swap / extra slots): ${[...unmapped].join(', ')}.`,
    })
  }
  if (uncanonicalUniques.length) {
    warnings.push({
      level: 'warn',
      code: 'unique-name-unverified',
      message: `${uncanonicalUniques.length} unique name(s) weren't found in the vendored uniques table; emitted as-is and may not match the in-game Words table. Examples: ${uncanonicalUniques.slice(0, 5).join(', ')}.`,
    })
  }

  return { inventory_slots, itemCount, skipped }
}
