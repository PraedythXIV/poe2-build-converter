// Lightweight "build contents" summary — runs decode + parse only (no .build emit), so the UI can
// preview WHAT a build contains (its gear, skills, and keystone perks) BEFORE converting. Pure;
// reuses the same vendored lookups as the converter. `summarizeSafe` swallows decode/parse errors
// so the live preview can simply hide itself on incomplete input.

import type { PobBuild, PobGem, PobItem, PobSkillGroup } from './types'
import { decodePobCode } from './decode'
import { parsePob } from './parsePob'
import { ascendancyInfo, canonicalUnique, gemInfo, passiveIdForNode, passiveMeta } from './lookups'

export interface SummaryItem {
  /** PoB slot label, e.g. "Weapon 1", "Body Armour" (or "Jewel" for tree jewels). */
  slot: string
  rarity: string // UNIQUE | RELIC | RARE | MAGIC | NORMAL
  name: string
  baseType: string
  /** Level requirement to use the item; the .build level_interval is [levelReq, 100]. */
  levelReq: number
  /** Explicit/visible mod lines (rune & craft prefixes already stripped by the parser). */
  mods: string[]
  /** Socketed rune / soul-core names. */
  runes: string[]
  /** Does this survive into the .build? Gear: always. Jewel: only if its socket node resolves. */
  inBuild: boolean
}

export interface SummarySkill {
  /** Headline active skill (gem display name). */
  main: string
  /** The headline gem's level + quality. */
  level: number
  quality: number
  /** The group's other gems (supports / extra) by name. */
  supports: string[]
  /** True for the build's designated main socket group. */
  isMain: boolean
}

export interface BuildSummary {
  className: string | null
  ascendancy: string | null // readable ascendancy name
  level: number | null
  mainSkill: string | null
  /** Every equipped item (weapons, armour, jewellery, flasks, charms), in inventory order. */
  items: SummaryItem[]
  itemCount: number
  uniqueCount: number
  /** Jewels socketed in the passive tree. */
  jewels: SummaryItem[]
  skills: SummarySkill[]
  /** Allocated keystone passive names. */
  keystones: string[]
  /** Allocated tree notable passive names. */
  notables: string[]
  /** Allocated ascendancy notable names. */
  ascNotables: string[]
  /** Allocated mastery names. */
  masteries: string[]
  passiveCount: number
}

function gemName(g: PobGem): string {
  if (g.nameSpec) return g.nameSpec
  const info = gemInfo(g.gemId)
  if (info?.n) return info.n
  // last resort: prettify the metadata token rather than show a raw path
  const token = g.gemId.split('/').pop() || ''
  const pretty = token
    .replace(/^(Skill|Support)?Gem/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  return pretty || 'Unknown gem'
}

/** A socket group → its emitted skill (the FIRST enabled gem with a gemId, matching mapSkills' choice
 *  of the skills[].id) + the remaining gems as supports. Keeping this in lockstep with the converter
 *  means the unmarked "in the .build" headline names the gem the .build actually stores. */
function summariseGroup(group: PobSkillGroup, isMain: boolean): SummarySkill | null {
  const gems = group.gems.filter((g) => g.enabled !== false && g.gemId)
  if (gems.length === 0) return null
  const head = gems[0]!
  return {
    main: gemName(head),
    level: head.level,
    quality: head.quality,
    supports: gems.slice(1).map(gemName),
    isMain,
  }
}

/** Map a PoB item id to a SummaryItem (shared by equipped gear + tree jewels). */
function toSummaryItem(item: PobItem, slot: string, inBuild = true): SummaryItem {
  const rarity = (item.rarity || 'NORMAL').toUpperCase()
  const isUnique = rarity === 'UNIQUE' || rarity === 'RELIC'
  const name = (isUnique ? canonicalUnique(item.name) : undefined) || item.name || item.baseType || '(unknown)'
  return { slot, rarity, name, baseType: item.baseType, levelReq: item.levelReq, mods: item.mods.slice(), runes: item.runes.slice(), inBuild }
}

/** Sort key for an inventory slot, so items read top-to-bottom like the in-game paper-doll. */
function slotRank(name: string): number {
  const n = name.toLowerCase()
  const order = ['weapon 1', 'weapon 2', 'helmet', 'body', 'glove', 'boot', 'belt', 'amulet', 'ring 1', 'ring 2', 'flask', 'charm']
  for (let i = 0; i < order.length; i++) {
    if (n.includes(order[i]!)) return i + (n.includes('swap') ? order.length : 0)
  }
  return order.length * 2
}

/** Build the contents summary from an already-parsed PoB model. */
export function summarizeBuild(pob: PobBuild): BuildSummary {
  // ── character ──
  const ascId = pob.spec.ascendancyInternalId
  const ascendancy = (ascId && ascendancyInfo(ascId)?.name) || pob.ascendClassName || null

  // ── skills — only real socketed groups (skip tree-/item-granted, as the converter does) ──
  const mainGroupIdx = pob.mainSocketGroup != null ? pob.mainSocketGroup - 1 : -1
  const mainGroup =
    mainGroupIdx >= 0 && mainGroupIdx < pob.skillGroups.length ? pob.skillGroups[mainGroupIdx]! : null
  const skills: SummarySkill[] = []
  pob.skillGroups.forEach((g, i) => {
    if (g.enabled === false || g.source) return
    const s = summariseGroup(g, i === mainGroupIdx)
    if (s) skills.push(s)
  })
  skills.sort((a, b) => Number(b.isMain) - Number(a.isMain))
  // resolve the headline from the actual main group even if it is a skipped (source) group
  const mainSkill = (mainGroup && summariseGroup(mainGroup, true)?.main) || skills[0]?.main || null

  // ── items — every equipped item, in inventory order, de-duped by item id ──
  const items: SummaryItem[] = []
  const seenItems = new Set<string>()
  for (const slot of pob.slots) {
    if (!slot.itemId || slot.itemId === '0' || seenItems.has(slot.itemId)) continue
    const item = pob.items.get(slot.itemId)
    if (!item) continue
    seenItems.add(slot.itemId)
    items.push(toSummaryItem(item, slot.name))
  }
  items.sort((a, b) => slotRank(a.slot) - slotRank(b.slot))
  const uniqueCount = items.filter((i) => i.rarity === 'UNIQUE' || i.rarity === 'RELIC').length

  // ── jewels socketed in the passive tree ──
  const jewels: SummaryItem[] = []
  const seenJewels = new Set<string>()
  for (const sock of pob.spec.sockets) {
    if (!sock.itemId || sock.itemId === '0' || seenJewels.has(sock.itemId)) continue
    const jewel = pob.items.get(sock.itemId)
    if (!jewel) continue
    seenJewels.add(sock.itemId)
    // mapPassives only writes the jewel's node-text if its socket node resolves in the vendored tree;
    // otherwise the jewel is dropped from the .build entirely (→ preview only)
    jewels.push(toSummaryItem(jewel, 'Jewel', !!passiveIdForNode(sock.nodeId)))
  }

  // ── perks — named keystones, notables, ascendancy notables, masteries (via the vendored node meta) ──
  const keystones: string[] = []
  const notables: string[] = []
  const ascNotables: string[] = []
  const masteries: string[] = []
  for (const nodeId of pob.spec.nodes) {
    const meta = passiveMeta(nodeId)
    if (!meta) continue
    if (meta.kind === 'keystone') keystones.push(meta.name)
    else if (meta.kind === 'mastery') masteries.push(meta.name)
    else if (meta.kind === 'notable') (meta.asc ? ascNotables : notables).push(meta.name)
  }
  // sort, but DON'T collapse by name: the .build emits one allocation per node id, and many distinct
  // nodes share a name (49 mastery names map to >1 node, e.g. "Life Mastery" spans 19 nodes). Deduping
  // by name here would undercount. The UI groups repeats into "Name ×N"; counts stay per-node-honest.
  const sortNames = (a: string[]): string[] => [...a].sort((x, y) => x.localeCompare(y))

  return {
    className: pob.className,
    ascendancy,
    level: pob.level,
    mainSkill,
    items,
    itemCount: items.length,
    uniqueCount,
    jewels,
    skills,
    keystones: sortNames(keystones),
    notables: sortNames(notables),
    ascNotables: sortNames(ascNotables),
    masteries: sortNames(masteries),
    passiveCount: pob.spec.nodes.length,
  }
}

/** Decode + parse a PoB2 input and summarise it. Throws DecodeError/ParseError on bad input. */
export function summarize(input: string): BuildSummary {
  return summarizeBuild(parsePob(decodePobCode(input)))
}

/** Live-preview helper: returns null instead of throwing on empty/incomplete input. */
export function summarizeSafe(input: string): BuildSummary | null {
  if (!input || !input.trim()) return null
  try {
    return summarize(input)
  } catch {
    return null
  }
}
