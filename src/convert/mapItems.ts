import type { PobBuild, PobItem, BuildInventorySlot, Warning } from './types'
import { canonicalUnique } from './lookups'
import { copy } from '../copy'
import { splitRunesAndGrants, groupSocketables } from './summarize'
import { color, lines } from './markup'

export interface MappedItems {
  inventory_slots: BuildInventorySlot[]
  itemCount: number
  skipped: number
}

/**
 * PoB slot name -> `.build` Inventories id (+ slot_x for grid inventories).
 * Verified in-game against the `.build` format with probe `.build` files (PoE2 0.5):
 *   - Weapons/offhands span two weapon sets: Weapon1/Offhand1 (set 1), Weapon2/Offhand2 (set 2/swap).
 *   - The belt row is ONE "Flask1" inventory: slot_x 0 = life flask, 1 = mana flask, 2/3/4 = the
 *     three charms. A `Charm1`/`Charm2`/`Charm3` id (and slot_y variants) renders NOTHING in the
 *     Build Planner — only `Flask1` x2+ lands on a charm slot. Some third-party exporters emit a
 *     `Charm1` id, but the game ignores it; an in-game probe confirmed charm 1 = Flask1 x2, charm 2
 *     = Flask1 x3.
 * Slots not listed are skipped with a note.
 *
 * FUTURE: PoE2 0.5 exposes up to 3 charm slots (Flask1 x2/x3/x4). If more appear they most likely
 * continue the same row (Flask1 x5+); confirm with a slot-probe before mapping.
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
  // Charms share the flask row in the Build Planner: x2/x3/x4 (verified in-game; `Charm1` renders nothing).
  'Charm 1': { id: 'Flask1', x: 2 },
  'Charm 2': { id: 'Flask1', x: 3 },
  'Charm 3': { id: 'Flask1', x: 4 },
}

const MAX_MODS = 10

function rareGuidance(item: PobItem): string {
  const head = item.baseType || item.name
  const shownMods = item.mods.slice(0, MAX_MODS)
  const more = item.mods.length > shownMods.length ? `… (+${item.mods.length - shownMods.length} more)` : ''
  return lines(
    color('silver', `${titleCase(item.rarity)} — ${head}`),
    item.name && item.name !== head ? color('grey', item.name) : null,
    '',
    shownMods.length ? color('grey', shownMods.join('\n')) : null,
    more ? color('grey', more) : null,
    ...renderSocketsAndGrants(item),
  )
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s
}

/** "Purity of Ice (Lv 18)" when the export states a level, bare name otherwise. */
function grantLabel(g: { name: string; level: number | null }): string {
  return g.level !== null ? `${g.name} (Lv ${g.level})` : g.name
}

/** The grey "Grants Skill: …" line plus one grey line per socketable group — the shared display
 *  formatting for both the rare guidance text and the unique additional_text (one source of truth). */
function socketLines(split: ReturnType<typeof splitRunesAndGrants>): string[] {
  const out: string[] = []
  if (split.grantedSkills.length) {
    out.push(color('grey', `Grants Skill: ${split.grantedSkills.map(grantLabel).join(', ')}`))
  }
  for (const g of groupSocketables(split.runes)) out.push(color('grey', `${g.label}: ${g.names.join(', ')}`))
  return out
}

/** The grey granted-skill + socketable lines for an item — shared by rare guidance and unique text. */
function renderSocketsAndGrants(item: PobItem): string[] {
  return socketLines(splitRunesAndGrants(item))
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
    // Level range the item applies: [usable-from, max]. PoB gives us the
    // item's level requirement; the upper bound is the level cap (100).
    entry.level_interval = [item.levelReq, 100]
    const rarity = (item.rarity || 'NORMAL').toUpperCase()

    if (rarity === 'UNIQUE' || rarity === 'RELIC') {
      const canon = canonicalUnique(item.name)
      entry.unique_name = canon ?? item.name
      if (!canon) uncanonicalUniques.push(item.name)
      // unique loads from its name; note base + granted skill + any socketed runes
      // (runes don't transfer with the name; a sceptre's skill-socket choice doesn't either)
      const uparts = [color('unique', item.name)]
      if (item.baseType) uparts.push(color('grey', item.baseType))
      uparts.push(...renderSocketsAndGrants(item))
      if (uparts.length > 1) entry.additional_text = uparts.join('\n')
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
      message: copy.warn.slotUnmapped(unmapped.size, [...unmapped].join(', ')),
    })
  }
  if (uncanonicalUniques.length) {
    warnings.push({
      level: 'warn',
      code: 'unique-name-unverified',
      message: copy.warn.uniqueNameUnverified(uncanonicalUniques.length, uncanonicalUniques.slice(0, 5).join(', ')),
    })
  }

  return { inventory_slots, itemCount, skipped }
}
