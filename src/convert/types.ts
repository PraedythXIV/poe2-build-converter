// Types for the PoB2 -> .build conversion.
//
// Two type families:
//   1. The PARSED Path of Building 2 model — now lives in src/pob/model.ts (the lossless full-fidelity
//      model). Re-exported below so every existing `import … from './types'` keeps resolving unchanged.
//   2. The OUTPUT .build model (GGG Build Planner format — see ARCHITECTURE.md and GGG's docs:
//      https://www.pathofexile.com/developer/docs/game#buildplanner).

// ─────────────────────────────────────────────────────────────────────────────
// 1. Parsed Path of Building 2 model → src/pob/model.ts (re-export shim — one source of truth there)
// ─────────────────────────────────────────────────────────────────────────────

export type * from '../pob/model'

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
  /** Optional source URL — added to the v1 spec between author/description (live GGG docs, 2026-07-04). */
  link?: string
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
