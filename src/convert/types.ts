// Types for the PoB2 -> .build conversion.
//
// Two type families:
//   1. The PARSED Path of Building 2 model (what we read out of the XML).
//   2. The OUTPUT .build model (GGG Build Planner format — see ARCHITECTURE.md and GGG's docs:
//      https://www.pathofexile.com/developer/docs/game#buildplanner).

// ─────────────────────────────────────────────────────────────────────────────
// 1. Parsed Path of Building 2 model
// ─────────────────────────────────────────────────────────────────────────────

export interface PobGem {
  /** Full GGG Metadata path, e.g. "Metadata/Items/Gems/SkillGemEarthquake". Emitted verbatim. */
  gemId: string
  /** PoB internal skill id, e.g. "WhirlingAssaultPlayer" / "SupportHeftPlayer". */
  skillId: string
  /** Human display name, e.g. "Whirling Assault". */
  nameSpec: string
  level: number
  quality: number
  enabled: boolean
}

export interface PobSkillGroup {
  enabled: boolean
  /** PoB marks the primary active skill of the group. */
  mainActiveSkill: number | null
  /** Non-null for auto-generated groups mirroring a tree-/item-granted skill (e.g. "Item:4:…"). */
  source: string | null
  gems: PobGem[]
}

export interface PobSocket {
  /** Passive tree node id (a jewel socket node). */
  nodeId: string
  /** PoB item id of the jewel placed in it (0 = empty). */
  itemId: string
}

export interface PobSpec {
  treeVersion: string
  /** e.g. "Monk1" — already the .build `ascendancy` value. */
  ascendancyInternalId: string | null
  classId: string | null
  /** All allocated passive node ids (numeric, as strings). */
  nodes: string[]
  /** Nodes specific to weapon set 1 / 2 (subset of `nodes`). */
  weaponSet1: string[]
  weaponSet2: string[]
  sockets: PobSocket[]
}

export interface PobItem {
  id: string
  rarity: string // NORMAL | MAGIC | RARE | UNIQUE | RELIC | ...
  /** Display name line (unique/rare name, or the affixed magic name). */
  name: string
  /** Base type line (uniques/rares); may be "" for magic/normal. */
  baseType: string
  /** Explicit/visible mod lines, prefixes like {crafted}{rune} stripped. */
  mods: string[]
  /** Level requirement to use the item (from PoB's "LevelReq:" line); 1 if none. */
  levelReq: number
  /** Raw item text as PoB stored it, for fallback. */
  raw: string
}

export interface PobSlot {
  /** PoB slot name, e.g. "Weapon 1", "Body Armour", "Ring 2". */
  name: string
  itemId: string
  active: boolean
}

export interface PobBuild {
  className: string | null
  ascendClassName: string | null
  level: number | null
  spec: PobSpec
  skillGroups: PobSkillGroup[]
  items: Map<string, PobItem>
  slots: PobSlot[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Output .build model (GGG Build Planner, v1 experimental)
// ─────────────────────────────────────────────────────────────────────────────

export type LevelInterval = number | [number, number]

export interface BuildPassive {
  id: string
  level_interval?: LevelInterval
  weapon_set?: number
  additional_text?: string
}

export interface BuildSupport {
  id: string
  level_interval?: LevelInterval
  additional_text?: string
}

export interface BuildSkill {
  id: string
  level_interval?: LevelInterval
  additional_text?: string
  support_skills?: (string | BuildSupport)[]
}

export interface BuildInventorySlot {
  inventory_id: string
  slot_x?: number
  slot_y?: number
  level_interval?: LevelInterval
  unique_name?: string
  additional_text?: string
}

export interface Build {
  name: string
  author?: string
  description?: string
  ascendancy?: string
  passives?: (string | BuildPassive)[]
  skills?: (string | BuildSkill)[]
  inventory_slots?: BuildInventorySlot[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion result / diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export type WarnLevel = 'info' | 'warn' | 'error'

export interface Warning {
  level: WarnLevel
  code: string
  message: string
}

export interface ConvertStats {
  className: string | null
  ascendancy: string | null
  level: number | null
  passiveCount: number
  passivesSkipped: number
  skillCount: number
  supportCount: number
  itemCount: number
  itemsSkipped: number
  treeVersion: string
}

export interface ConvertResult {
  build: Build
  json: string
  warnings: Warning[]
  stats: ConvertStats
}
