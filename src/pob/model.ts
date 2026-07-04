// src/pob — the parsed Path of Building 2 model.
//
// The model read out of a PoB2 build XML. It is being grown into a LOSSLESS, full-fidelity superset
// (design: _workbench/Docs/pob-model-design.md). This first cut holds today's interfaces VERBATIM so `convert/`
// can become a pure consumer via a re-export shim in convert/types.ts — zero behaviour change. The
// OUTPUT `.build` types stay in convert/types.ts; new full-fidelity fields land here incrementally.

/** A minion gem's minion context (the minion, its skill, its item set), when present. */
export interface PobGemMinion {
  minion: string | null
  skill: string | null
  itemSet: string | null
}

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
  // ── new (lossless) ──
  variantId: string | null
  count: number | null
  enableGlobal1: boolean | null
  enableGlobal2: boolean | null
  corrupted: boolean | null
  corruptLevel: number | null
  /** PoE2 alt-quality replacement (which stat-set the gem uses). */
  statSetIndex: number | null
  statSetIndexCalcs: number | null
  minion: PobGemMinion | null
  /** Every other `<Gem>` attribute (skillPart*, skillStageCount*, …), verbatim. */
  rawAttrs: RawAttrs
}

export interface PobSkillGroup {
  enabled: boolean
  /** PoB marks the primary active skill of the group. */
  mainActiveSkill: number | null
  /** Non-null for auto-generated groups mirroring a tree-/item-granted skill (e.g. "Item:4:…"). */
  source: string | null
  gems: PobGem[]
  // ── new (lossless) ──
  /** The gear slot this group sits in ("Weapon 1", "Amulet", …), or null. */
  slot: string | null
  label: string | null
  includeInFullDPS: boolean | null
  mainActiveSkillCalcs: number | null
  rawAttrs: RawAttrs
}

export interface PobSocket {
  /** Passive tree node id (a jewel socket node). */
  nodeId: string
  /** PoB item id of the jewel placed in it (0 = empty). */
  itemId: string
}

/** The attribute a generic "attribute of choice" passive was set to in PoB. */
export type AttributeChoice = 'Strength' | 'Dexterity' | 'Intelligence'

/** A chosen mastery effect (which option the player picked on a mastery node). */
export interface PobMasteryEffect {
  nodeId: string
  effectId: string
}

export interface PobSpec {
  treeVersion: string
  /** User title for this tree (e.g. "Levelling"); null when unnamed. Always present (the parser reads
   *  the attribute, which is string|null) — matching the sibling skill/item/config set titles. Specs are
   *  index-addressed in the export (no id). */
  title: string | null
  /** e.g. "Monk1" — already the .build `ascendancy` value. */
  ascendancyInternalId: string | null
  classId: string | null
  /** All allocated passive node ids (numeric, as strings). */
  nodes: string[]
  /** Nodes specific to weapon set 1 / 2 (subset of `nodes`). */
  weaponSet1: string[]
  weaponSet2: string[]
  sockets: PobSocket[]
  /** Generic attribute-of-choice nodes → the exact attribute the player picked, from
   *  `<Overrides><AttributeOverride strNodes/dexNodes/intNodes>`. PoB's own selection (exact,
   *  not inferred); used only to label the node tooltip. Empty when the build set none. */
  attributeChoices: ReadonlyMap<string, AttributeChoice>
  // ── new (lossless) ──
  /** `<Spec ascendClassId>` — the in-data ascendancy class id. */
  ascendClassId: string | null
  /** PoE2 dual-ascendancy second slot (`secondaryAscendClassId`); "nil"→null. */
  secondaryAscendClassId: string | null
  classInternalId: string | null
  /** The `<URL>` child — PoB's canonical compressed tree link, trimmed. */
  url: string | null
  /** `masteryEffects="{node,effect},…"` parsed → the chosen effect per mastery node. */
  masteryEffects: PobMasteryEffect[]
  /** Every `<WeaponSetN nodes>` block (weaponSet1/2 are the first two, mirrored). */
  weaponSets: string[][]
  /** Any other `<Spec>` attribute, verbatim. */
  rawAttrs: RawAttrs
}

export interface GrantedSkill {
  name: string
  level: number | null
}

/** Where a mod came from, parsed from PoB's `{crafted}{fractured}…` line prefixes. */
export type ModSource =
  'enchant' | 'rune' | 'crafted' | 'fractured' | 'desecrated' | 'mutated' | 'unscalable' | 'custom'
/** A mod line with its source tags + roll data. `text` matches the stripped `mods[]` string. */
export interface ParsedMod {
  text: string
  tags: ModSource[]
  isImplicit: boolean
  /** Roll POSITION ∈ [0,1] (string, no precision loss): inline `{range:N}` OR the `<ModRange>` element
   *  the parser resolved onto this line. PoB's value = min + N·(max−min) for each `(min-max)` in `text`. */
  rangeHint: string | null
  /** Inline `{corruptedRange:N}` — a corrupted-value MULTIPLIER, NOT a position (PoB passes it as
   *  applyRange's baseValueScalar; see ItemTools.lua). Kept verbatim; never applied as a roll. */
  corruptedMult: string | null
}
/** A `<ModRange id range/>` child — the roll position PoB stored for a mod (range kept as a string). */
export interface PobModRange {
  id: number
  range: string
}
/** A `<SocketIdURL>` (an item-set jewel-socket link). */
export interface PobSocketIdUrl {
  name: string
  nodeId: string
  itemPbURL: string | null
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
  /** Socketed rune / soul-core names (PoB's "Rune: <name>" lines), e.g. "Soul Core of Citaqualotl".
   *  CAVEAT: PoB also serializes a sceptre's SKILL socket ("Sockets: S") with the "Rune:" label —
   *  downstream consumers reclassify rune names that are known skill-gem names as granted skills. */
  runes: string[]
  /** Skills the item grants ("Grants Skill: Level 18 Purity of Ice" implicit lines).
   *  `level` is null when the export doesn't state one (e.g. an unrolled "(1-20)" template,
   *  or a skill known only from the Rune:-labelled skill socket). */
  grantedSkills: GrantedSkill[]
  /** Raw item text as PoB stored it, for fallback. */
  raw: string
  // ── new (lossless) ──
  /** "Item Level: N" line. */
  itemLevel: number | null
  /** "Quality: N" line. */
  quality: number | null
  uniqueId: string | null
  itemClass: string | null
  /** The "Sockets: …" rune-socket layout string. */
  socketString: string | null
  /** Jewel "Radius: …" / "Limited to: …" lines. */
  radius: string | null
  limitedTo: string | null
  /** Defence lines (Spirit / Energy Shield / Armour / Evasion / Ward / Charm Slots) → value, verbatim. */
  defences: Record<string, string>
  /** Standalone state flags (Corrupted / Mirrored / Fractured / …), verbatim. */
  flags: string[]
  /** The counted implicit lines as parsed mods (incl. the base/enchant ones `mods[]` omits). */
  implicits: ParsedMod[]
  /** Explicit mods WITH their source tags — a superset of `mods[]` (whose strings stay stripped). */
  parsedMods: ParsedMod[]
  /** `<ModRange id range/>` children — PoB's stored roll positions. */
  modRanges: PobModRange[]
  /** `<Item>` attributes other than `id` (variant*, …), verbatim. */
  variantAttrs: RawAttrs
}

export interface PobSlot {
  /** PoB slot name, e.g. "Weapon 1", "Body Armour", "Ring 2". */
  name: string
  itemId: string
  active: boolean
  /** `<Slot itemPbURL>` — a pobb.in/wiki link PoB attached to the slot, if any. */
  itemPbURL: string | null
}

/** One PoB skill set (`<Skills>` is id-addressed). Its `groups` are the same shape as the
 *  active `PobBuild.skillGroups`; multi-`.build` export converts one set per variant. */
export interface PobSkillSet {
  id: string
  /** Optional user title (e.g. "Bossing"); null when unnamed. */
  title: string | null
  groups: PobSkillGroup[]
}

/** One PoB item set (`<Items>` is id-addressed). `slots` map slot names → item ids in the
 *  shared `PobBuild.items` pool; multi-`.build` export converts one set per variant. */
export interface PobItemSet {
  id: string
  title: string | null
  slots: PobSlot[]
  // ── new (lossless) ──
  useSecondWeaponSet: boolean | null
  socketIdUrls: PobSocketIdUrl[]
}

/** One PoB config set (`<Config>` is id-addressed). Its TITLE participates in loadout matching
 *  (export/loadouts.ts); `inputs`/`placeholders` are the calc assumptions PoB exported (verbatim,
 *  surfaced read-only — they explain *under what conditions* PoB's stats hold; never recomputed). */
export interface PobConfigSet {
  id: string
  title: string | null
  inputs: ConfigInput[]
  placeholders: ConfigInput[]
}

export interface PobBuild {
  className: string | null
  ascendClassName: string | null
  level: number | null
  /** 1-based index into `skillGroups` of the build's main socket group (PoB `<Build mainSocketGroup>`). */
  mainSocketGroup: number | null
  /** PoB's own computed stats (`<PlayerStat stat value/>` block) — a snapshot of PoB's last calc
   *  at export time. We display these verbatim; we never compute stats ourselves. */
  playerStats: Record<string, number>
  /** The ACTIVE passive spec (= `specs[activeSpecIndex]`). Every existing consumer reads this. */
  spec: PobSpec
  /** The ACTIVE skill set's groups (= the groups of `skillSets[activeSkillSetId]`). */
  skillGroups: PobSkillGroup[]
  items: Map<string, PobItem>
  /** The ACTIVE item set's slots (= the slots of `itemSets[activeItemSetId]`). */
  slots: PobSlot[]
  // ── all loadout axes (for multi-`.build` export; the active fields above are these, indexed) ──
  /** Every passive spec (index-addressed). `spec` is `specs[activeSpecIndex]`. */
  specs: PobSpec[]
  /** 0-based index of the active spec within `specs`. */
  activeSpecIndex: number
  /** Every skill set (id-addressed). `skillGroups` is the active set's groups. */
  skillSets: PobSkillSet[]
  /** id of the active skill set, or null when the export has none. */
  activeSkillSetId: string | null
  /** Every item set (id-addressed). `slots` is the active set's slots. */
  itemSets: PobItemSet[]
  /** id of the active item set, or null when the export has none. */
  activeItemSetId: string | null
  /** Every config set (id/title + the calc inputs/placeholders). Titles drive loadout matching;
   *  inputs are surfaced read-only. Never exported to a `.build`. */
  configSets: PobConfigSet[]

  // ── NEW (lossless full-fidelity additions; empty/null when the export omits them) ──
  /** `<Build viewMode>` — the editor view PoB was on at export. */
  viewMode: string | null
  targetVersion: string | null
  characterLevelAutoMode: boolean | null
  /** Every PlayerStat in VERBATIM string form (incl. "inf" / 14-digit floats); `playerStats` is the
   *  numeric view (lossy for those). */
  playerStatsRaw: Record<string, string>
  /** `<MinionStat>` snapshot (string form), when present. */
  minionStats: Record<string, string>
  /** `<Buffs curseList combatList buffList>` — the active-buff context PoB assumed. */
  buffs: PobBuffs | null
  /** `<FullDPSSkill>` rows — the skills PoB summed into Full DPS. */
  fullDpsSkills: PobFullDpsSkill[]
  /** `<TimelessData>` attrs, verbatim. */
  timelessData: RawAttrs | null
  /** `<Config activeConfigSet>`. */
  activeConfigSetId: string | null
  /** `<Calcs>` inputs + section collapse-state. */
  calcs: PobCalcs | null
  /** `<Notes>` / `<NotesHTML>` build notes, verbatim (PoB colour codes + newlines preserved). */
  notes: string | null
  notesHtml: string | null
  /** `<TreeView>` zoom/pan + search (cosmetic). */
  treeView: PobTreeView | null
  /** `<Import>` (last-import hashes) + `<Party>` attrs, verbatim. */
  importInfo: RawAttrs | null
  party: RawAttrs | null
  /** `<Skills>` attrs other than activeSkillSet (defaultGemLevel, sortGemsByDPS, …), verbatim. */
  skillsOptions: RawAttrs
  /** `<Items>` attrs other than activeItemSet (useSecondWeaponSet, showStatDifferences), verbatim. */
  itemsOptions: RawAttrs
  /** The document's top-level child order + any unmodelled top-level element — round-trip aid. */
  sectionOrder: string[]
  rawSections: RawElement[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Lossless-passthrough primitives + the new full-fidelity sub-types
// ─────────────────────────────────────────────────────────────────────────────

/** Every attribute of an element, verbatim (the losslessness floor). */
export type RawAttrs = Record<string, string>
/** An element we keep but don't model: tag + attrs + own-text + children, recursively. */
export interface RawElement {
  tag: string
  attrs: RawAttrs
  text: string
  children: RawElement[]
}

export interface PobBuffs {
  curseList: string
  combatList: string
  buffList: string
}
export interface PobFullDpsSkill {
  stat: string
  value: string
  skillPart: string
  source: string
}
export interface PobTreeView {
  searchStr: string
  zoomLevel: string
  zoomX: string
  zoomY: string
  rawAttrs: RawAttrs
}

/** A single `<Config>`/`<Calcs>` `<Input>` (or `<Placeholder>`) value — verbatim, typed by which of
 *  the boolean/number/string attributes PoB wrote. Numbers stay strings (precision / "inf"). */
export type ConfigValue =
  { kind: 'boolean'; value: boolean } | { kind: 'number'; value: string } | { kind: 'string'; value: string }
export interface ConfigInput {
  name: string
  value: ConfigValue
}
export interface PobCalcSection {
  id: string
  subsection: string
  collapsed: boolean
}
export interface PobCalcs {
  inputs: ConfigInput[]
  sections: PobCalcSection[]
}
