// Distilled / Liquid Emotion reference data + lookups (pure, no DOM — unit-tested).
// Three ways a Delirium emotion is spent, all from the vendored src/data/emotions.json
// (own pathofexile-dat extraction; see scripts/build-emotions.mjs):
//   • AMULET   anoint 3 emotions, IN ORDER -> a tree Notable
//   • JEWEL    apply 1 emotion             -> a jewel prefix/suffix (normal or Time-Lost jewel)
//   • WAYSTONE instil 1 emotion            -> Deliriousness% + a map reward modifier

import emotionsJson from '../data/emotions.json'
import iconsJson from '../data/emotionIcons.json'

export type Rarity = 'Diluted' | 'Liquid' | 'Concentrated' | 'Potent'
/** One resolved affix: GGG affix name ("Armoured", "of Deadliness") + exact stat text. */
export interface JewelSlot {
  name: string
  text: string
}
/** Per jewel-colour outcome: prefix (p) and/or suffix (s) the emotion can roll. */
export interface JewelColour {
  p: JewelSlot | null
  s: JewelSlot | null
}
export type JewelColourKey = 'ruby' | 'sapphire' | 'emerald' | 'diamond'
export type JewelOutcomes = Partial<Record<JewelColourKey, JewelColour>>

export interface Emotion {
  /** Short anoint name, e.g. "Ire" — the stable key used in anoint recipes. */
  key: string
  /** 1..13 ingredient tier (also the canonical display order). */
  tier: number
  rarity: Rarity
  potent: boolean
  /** Full base-item name, e.g. "Diluted Liquid Ire". */
  name: string
  /** "Ancient …" Time-Lost counterpart name, or null. */
  ancientName: string | null
  /** Waystone instil effect: how Delirious the map becomes + the reward modifier. */
  waystone: { deliriousPct: number | null; bonus: string | null }
  /** Outcomes on a normal jewel. */
  jewel: JewelOutcomes | null
  /** Outcomes on a Time-Lost jewel (from the "Ancient" emotion). */
  jewelTimeLost: JewelOutcomes | null
  /** Item icon as a webp data URI (null if art was unavailable at build time). */
  icon: string | null
  /** Dominant icon colour as an "r, g, b" triple — the emotion's UI tint. */
  rgb: string
}
interface EmotionIcon {
  src: string
  w: number
  h: number
  rgb: string
}
/** One anoint recipe: an ORDERED triple of emotion keys -> a notable name. */
export interface Anoint {
  c: [string, string, string]
  n: string
}
export interface EmotionsConstants {
  deliriousnessPerRare: number | null
  deliriousnessPerUnique: number | null
  deliriousnessOnMapComplete: number | null
  depthToUnlockSimulacrum: number | null
  simulacrumWaves: number | null
}
/** The emotion as stored in emotions.json — icon + rgb are merged in at load time. */
type RawEmotion = Omit<Emotion, 'icon' | 'rgb'>
interface EmotionsData {
  _provenance: { source: string; captured: string; note: string }
  emotions: RawEmotion[]
  anoints: Anoint[]
  notables: Record<string, string[]>
  /** Names of the "hidden" anoints: off-tree, anoint-only exclusive Notables (IsAnointmentOnly). */
  hiddenAnoints: string[]
  constants: EmotionsConstants
}

const DATA = emotionsJson as unknown as EmotionsData
const ICONS = iconsJson as unknown as Record<string, EmotionIcon>

// Enrich each emotion with its icon + tint colour (build-emotion-icons.mjs); the rarity ramp is
// only a fallback when art is missing, so a chip/pill reads as that emotion's actual liquid hue.
const RARITY_FALLBACK_RGB: Record<Rarity, string> = {
  Diluted: '120, 142, 165',
  Liquid: '150, 122, 205',
  Concentrated: '186, 96, 206',
  Potent: '232, 150, 74',
}
export const emotions: Emotion[] = DATA.emotions.map((e) => ({
  ...e,
  icon: ICONS[e.key]?.src ?? null,
  rgb: ICONS[e.key]?.rgb ?? RARITY_FALLBACK_RGB[e.rarity],
}))
export const anoints: Anoint[] = DATA.anoints
export const notables: Record<string, string[]> = DATA.notables
export const constants: EmotionsConstants = DATA.constants
export const provenance = DATA._provenance

// "Hidden" anoints — exclusive Notables that aren't on the passive tree, obtainable only by anointing
// (GGG's PassiveSkills.IsAnointmentOnly). Used to badge/filter them apart from regular tree notables.
const hiddenAnointSet: ReadonlySet<string> = new Set(DATA.hiddenAnoints ?? [])
/** Whether `name` is a hidden (off-tree, anoint-only) Notable. */
export function isHiddenAnoint(name: string): boolean {
  return hiddenAnointSet.has(name)
}
/** How many hidden anoints exist (for the filter label / summary). */
export const hiddenAnointCount = hiddenAnointSet.size

export const JEWEL_COLOURS: ReadonlyArray<{ key: JewelColourKey; label: string }> = [
  { key: 'ruby', label: 'Ruby' },
  { key: 'sapphire', label: 'Sapphire' },
  { key: 'emerald', label: 'Emerald' },
  { key: 'diamond', label: 'Diamond' },
]

const byKey = new Map(emotions.map((e) => [e.key, e]))
/** The emotion with this short key (e.g. "Greed"), or undefined. */
export function emotionByKey(key: string): Emotion | undefined {
  return byKey.get(key)
}

// Forward index: ordered triple "a|b|c" -> notable name (order matters — most multisets
// resolve to different notables per slot order).
const anointByCombo = new Map<string, string>()
// Reverse index: notable name -> every ordered recipe that yields it (usually one).
const recipesByNotable = new Map<string, Array<[string, string, string]>>()
for (const a of anoints) {
  anointByCombo.set(a.c.join('|'), a.n)
  const list = recipesByNotable.get(a.n)
  if (list) list.push(a.c)
  else recipesByNotable.set(a.n, [a.c])
}

/** Notable produced by anointing these three emotion keys in this exact order, or null. */
export function anointFor(c: [string, string, string]): string | null {
  return anointByCombo.get(c.join('|')) ?? null
}
/** Every ordered 3-emotion recipe that anoints the given notable (empty if none). */
export function recipesForNotable(name: string): Array<[string, string, string]> {
  return recipesByNotable.get(name) ?? []
}
/** All anointable notable names, alphabetically. */
export function notableNames(): string[] {
  return Object.keys(notables).sort((a, b) => a.localeCompare(b))
}

export interface Craftable {
  /** Notable name. */
  n: string
  /** The ordered 3-emotion recipe that anoints it. */
  c: [string, string, string]
  /** How many times this recipe can be crafted from the given inventory (>= 1). */
  times: number
}

/** Per-emotion demand of a recipe (a recipe consumes its three emotions as a multiset). */
function demandOf(c: readonly string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const k of c) m.set(k, (m.get(k) ?? 0) + 1)
  return m
}
// The demand multiset is static per recipe, so precompute it once (keyed by recipe identity)
// rather than rebuilding a Map per anoint on every craftable() call.
const demandByAnoint = new Map<Anoint, Map<string, number>>(anoints.map((a) => [a, demandOf(a.c)]))

/**
 * Given an inventory (emotion key -> count owned), every anoint the player can currently make,
 * with how many times each is craftable (limited by the scarcest required emotion). Recipes that
 * need an emotion the player lacks are excluded. Sorted by craftable count desc, then notable name.
 */
export function craftable(inventory: Readonly<Record<string, number>>): Craftable[] {
  const out: Craftable[] = []
  for (const a of anoints) {
    let times = Infinity
    for (const [k, need] of demandByAnoint.get(a)!) {
      times = Math.min(times, Math.floor((inventory[k] ?? 0) / need))
      if (times === 0) break
    }
    if (times >= 1 && Number.isFinite(times)) out.push({ n: a.n, c: a.c, times })
  }
  out.sort((x, y) => y.times - x.times || x.n.localeCompare(y.n))
  return out
}
