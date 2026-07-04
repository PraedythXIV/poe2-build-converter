// Lightweight "build contents" summary — runs decode + parse only (no .build emit), so the UI can
// preview WHAT a build contains (its gear, skills, and keystone perks) BEFORE converting. Pure;
// reuses the same vendored lookups as the converter. `summarizeSafe` swallows decode/parse errors
// so the live preview can simply hide itself on incomplete input.

import type { PobBuild, PobGem, PobItem, PobSkillGroup, GrantedSkill, ParsedMod } from './types'
import { decodePobCode } from './decode'
import { parsePob } from './parsePob'
import { ascendancyInfo, canonicalUnique, gemInfo, isGemName, passiveIdForNode, passiveMeta } from './lookups'

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
  /** Socketed rune / soul-core names (skill-socket "Rune:" lines already reclassified out). */
  runes: string[]
  /** Skills the item grants (from "Grants Skill:" implicits and sceptre skill sockets). */
  grantedSkills: GrantedSkill[]
  // ── lossless extras for the enriched card (read-only; from the PoB item body text) ──
  itemLevel: number | null
  quality: number | null
  socketString: string | null
  /** Jewel radius keyword (e.g. "Medium") for radius jewels, else null. */
  radius: string | null
  /** "Limited to" cap (e.g. "1") for items that carry one, else null. */
  limitedTo: string | null
  defences: Record<string, string>
  flags: string[]
  /** Explicit mods WITH their source tags ({crafted}/{fractured}/…) — for per-mod badges. */
  parsedMods: ParsedMod[]
  /** Implicit mod lines (base/enchant/rune/crafted implicits) WITH tags + resolved rolls — the overlay
   *  renders these above the explicits. `mods[]` only carries {rune} implicits, so this is the full set. */
  implicits: ParsedMod[]
  /** Does this survive into the .build? Gear: always. Jewel: only if its socket node resolves. */
  inBuild: boolean
}

/** One gem in a skill group, with the PoB detail flags surfaced as compact markers on the skills panel. */
export interface SummaryGem {
  name: string
  level: number
  quality: number
  /** Corrupted gem (PoB `corrupted="true"`). */
  corrupted: boolean
  /** Socketed count — shown as ×N when > 1. */
  count: number
  /** Minion id this gem summons (PoB `skillMinion`), when a minion gem (else null). NOTE: we deliberately
   *  do NOT surface `variantId` — it's an internal per-gem id that just mirrors the name
   *  ("Hollow Resonance" → "HollowResonance"), so a marker would be redundant noise on every row. */
  minion: string | null
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
  /** Every gem in the group (head first, then supports) with full per-gem detail for the skills panel. */
  gems: SummaryGem[]
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
  /** PoB's exported calc snapshot (PlayerStat block) — empty record when the export carries none. */
  playerStats: Record<string, number>
  /** Raw allocated tree node ids (numeric, as strings) — the id space the tree view uses. */
  specNodes: string[]
  /** PoB's internal ascendancy id (e.g. "Monk1") — what the tree view keys clusters on. */
  ascendancyInternalId: string | null
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
/** PoB detail flags for one gem, verbatim — markers the skills panel shows beside the gem name. */
function toSummaryGem(g: PobGem): SummaryGem {
  return {
    name: gemName(g),
    level: g.level,
    quality: g.quality,
    corrupted: g.corrupted === true,
    count: g.count ?? 1,
    minion: g.minion?.minion ?? null,
  }
}

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
    gems: gems.map(toSummaryGem),
  }
}

/** Split an item's raw "Rune:" lines + grant lines into real runes vs granted skills.
 *  PoB serializes a sceptre's SKILL socket as "Rune: <skill name>" — a rune name that is a known
 *  gem name is that socketed skill, not a rune (exact name match against the vendored gem table).
 *  Deduped by name; when the same skill appears with and without a level (skill socket has none,
 *  the "Grants Skill: Level N" implicit does), the entry that knows its level wins. */
export function splitRunesAndGrants(item: Pick<PobItem, 'runes' | 'grantedSkills'>): {
  runes: string[]
  grantedSkills: GrantedSkill[]
} {
  const runes = item.runes.filter((r) => !isGemName(r))
  const byName = new Map<string, GrantedSkill>()
  for (const g of [
    ...item.grantedSkills,
    ...item.runes.filter((r) => isGemName(r)).map((name) => ({ name, level: null })),
  ]) {
    const key = g.name.toLowerCase()
    const prev = byName.get(key)
    if (!prev || (prev.level === null && g.level !== null)) byName.set(key, g)
  }
  return { runes, grantedSkills: [...byName.values()] }
}

/** Group socketables for display. PoB labels every socketable "Rune:" but PoE2 has distinct
 *  categories; the NAME states which one it is ("Soul Core of X", "X Talisman", "X Rune") —
 *  classification is by that stated name, never guessed. Empty groups are omitted. */
export function groupSocketables(names: string[]): Array<{ label: string; names: string[] }> {
  const runes: string[] = []
  const soulCores: string[] = []
  const talismans: string[] = []
  for (const n of names) {
    if (/^soul core\b/i.test(n)) soulCores.push(n)
    else if (/\btalisman$/i.test(n)) talismans.push(n)
    else runes.push(n)
  }
  return [
    { label: 'Runes', names: runes },
    { label: 'Soul Cores', names: soulCores },
    { label: 'Talismans', names: talismans },
  ].filter((g) => g.names.length > 0)
}

/** Map a PoB item id to a SummaryItem (shared by equipped gear + tree jewels). */
function toSummaryItem(item: PobItem, slot: string, inBuild = true): SummaryItem {
  const rarity = (item.rarity || 'NORMAL').toUpperCase()
  const isUnique = rarity === 'UNIQUE' || rarity === 'RELIC'
  const name = (isUnique ? canonicalUnique(item.name) : undefined) || item.name || item.baseType || '(unknown)'
  const { runes, grantedSkills } = splitRunesAndGrants(item)
  return {
    slot,
    rarity,
    name,
    baseType: item.baseType,
    levelReq: item.levelReq,
    mods: item.mods.slice(),
    runes,
    grantedSkills,
    itemLevel: item.itemLevel,
    quality: item.quality,
    socketString: item.socketString,
    radius: item.radius,
    limitedTo: item.limitedTo,
    // defensively copy so consumers can't mutate the shared PobItem data (matches mods.slice() above)
    defences: { ...item.defences },
    flags: item.flags.slice(),
    parsedMods: item.parsedMods.slice(),
    implicits: item.implicits.slice(),
    inBuild,
  }
}

/** Sort key for an inventory slot, so items read top-to-bottom like the in-game paper-doll. */
function slotRank(name: string): number {
  const n = name.toLowerCase()
  const order = [
    'weapon 1',
    'weapon 2',
    'helmet',
    'body',
    'glove',
    'boot',
    'belt',
    'amulet',
    'ring 1',
    'ring 2',
    'flask',
    'charm',
  ]
  const swapOffset = n.includes('swap') ? order.length : 0
  for (let i = 0; i < order.length; i++) {
    if (n.includes(order[i]!)) return i + swapOffset
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
  const mainGroup = mainGroupIdx >= 0 && mainGroupIdx < pob.skillGroups.length ? pob.skillGroups[mainGroupIdx]! : null
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
  const slotRanks = new Map<string, number>()
  for (const slot of pob.slots) {
    if (!slot.itemId || slot.itemId === '0' || seenItems.has(slot.itemId)) continue
    const item = pob.items.get(slot.itemId)
    if (!item) continue
    seenItems.add(slot.itemId)
    // compute the sort rank once as each item is added, rather than re-scanning the list afterwards
    if (!slotRanks.has(slot.name)) slotRanks.set(slot.name, slotRank(slot.name))
    items.push(toSummaryItem(item, slot.name))
  }
  items.sort((a, b) => slotRanks.get(a.slot)! - slotRanks.get(b.slot)!)
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
    playerStats: { ...pob.playerStats },
    specNodes: pob.spec.nodes.slice(),
    ascendancyInternalId: ascId,
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
