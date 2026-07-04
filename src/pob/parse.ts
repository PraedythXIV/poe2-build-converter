// Parse a Path of Building 2 XML document into our typed PobBuild model.
// Uses the platform DOMParser (browser native; jsdom in tests — happy-dom can't parse XML).

import type {
  PobBuild,
  PobSpec,
  PobGem,
  PobSkillGroup,
  PobSkillSet,
  PobItemSet,
  PobItem,
  PobSlot,
  PobSocket,
  AttributeChoice,
  PobMasteryEffect,
  PobGemMinion,
} from './model'
import { attrsOf, rawElement, tri, strOrNull, parseConfigInput } from './raw'
import { parseItemText } from './itemText'

export class ParseError extends Error {}

// ── small DOM helpers (XML tag names are case-sensitive) ─────────────────────
function childrenByTag(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag)
}
function firstChildByTag(el: Element, tag: string): Element | null {
  return childrenByTag(el, tag)[0] ?? null
}
function csv(value: string | null): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
function num(value: string | null): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
/** Read a boolean attribute. `defaultTrue` flips both the default and the comparison so the
 * common PoB idioms collapse to one call: `enabled` defaults true (`!== 'false'`), `active`/
 * `collapsed` default false (`=== 'true'`). */
function boolAttr(el: Element, name: string, defaultTrue = false): boolean {
  const v = el.getAttribute(name) ?? (defaultTrue ? 'true' : 'false')
  return defaultTrue ? v !== 'false' : v === 'true'
}
/** Text content of an optional element: null when absent, otherwise the text (`trim` med to
 * null-if-empty when requested). */
function getElementText(el: Element | null, trim = false): string | null {
  if (!el) return null
  const text = el.textContent ?? ''
  return trim ? text.trim() || null : text
}
/** Type-guard for `.filter()` to drop nulls and narrow the element type. */
function isPresent<T>(x: T | null): x is T {
  return x != null
}

// ── per-entry parsers (one passive spec / skill set / item set) ───────────────
// Each loadout axis carries multiple entries; the active one drives every existing consumer,
// the full lists feed multi-`.build` export. Parse one entry, mapped over by parsePob.
function parseSpec(specEl: Element): PobSpec {
  const ascRaw = specEl.getAttribute('ascendancyInternalId')
  const ws1El = firstChildByTag(specEl, 'WeaponSet1')
  const ws2El = firstChildByTag(specEl, 'WeaponSet2')
  const socketsEl = firstChildByTag(specEl, 'Sockets')
  const sockets: PobSocket[] = socketsEl
    ? childrenByTag(socketsEl, 'Socket').map((s) => ({
        nodeId: s.getAttribute('nodeId') ?? '',
        itemId: s.getAttribute('itemId') ?? '0',
      }))
    : []
  // <Overrides><AttributeOverride strNodes/dexNodes/intNodes> — a generic-attribute passive's id
  // appears in exactly one list, naming the attribute the player chose for it. Read verbatim (PoB's
  // own selection) so the tooltip can show the exact attribute, never an inferred "of choice".
  const overridesEl = firstChildByTag(specEl, 'Overrides')
  const attrEl = overridesEl ? firstChildByTag(overridesEl, 'AttributeOverride') : null
  const attributeChoices = new Map<string, AttributeChoice>()
  if (attrEl) {
    for (const id of csv(attrEl.getAttribute('strNodes'))) attributeChoices.set(id, 'Strength')
    for (const id of csv(attrEl.getAttribute('dexNodes'))) attributeChoices.set(id, 'Dexterity')
    for (const id of csv(attrEl.getAttribute('intNodes'))) attributeChoices.set(id, 'Intelligence')
  }
  const urlEl = firstChildByTag(specEl, 'URL')
  const url = getElementText(urlEl, true)
  const masteryEffects: PobMasteryEffect[] = []
  for (const mm of (specEl.getAttribute('masteryEffects') ?? '').matchAll(/\{(\d+),(\d+)\}/g)) {
    masteryEffects.push({ nodeId: mm[1]!, effectId: mm[2]! })
  }
  const weaponSets = Array.from(specEl.children)
    .filter((c) => /^WeaponSet\d+$/.test(c.tagName))
    .map((c) => csv(c.getAttribute('nodes')))
  return {
    treeVersion: specEl.getAttribute('treeVersion') ?? 'unknown',
    title: specEl.getAttribute('title'),
    ascendancyInternalId: ascRaw && ascRaw !== 'nil' && ascRaw !== '' ? ascRaw : null,
    classId: specEl.getAttribute('classId'),
    nodes: csv(specEl.getAttribute('nodes')),
    weaponSet1: csv(ws1El?.getAttribute('nodes') ?? null),
    weaponSet2: csv(ws2El?.getAttribute('nodes') ?? null),
    sockets,
    attributeChoices,
    ascendClassId: strOrNull(specEl.getAttribute('ascendClassId')),
    secondaryAscendClassId: strOrNull(specEl.getAttribute('secondaryAscendClassId')),
    classInternalId: strOrNull(specEl.getAttribute('classInternalId')),
    url,
    masteryEffects,
    weaponSets,
    rawAttrs: attrsOf(specEl),
  }
}

/** Map `<Skill>` children (of a `<SkillSet>` or, in older exports, of `<Skills>` directly). */
function parseGemMinion(g: Element): PobGemMinion | null {
  const minion = strOrNull(g.getAttribute('skillMinion') ?? g.getAttribute('skillMinionCalcs'))
  const skill = strOrNull(g.getAttribute('skillMinionSkill') ?? g.getAttribute('skillMinionSkillCalcs'))
  const itemSet = strOrNull(g.getAttribute('skillMinionItemSet') ?? g.getAttribute('skillMinionItemSetCalcs'))
  return minion || skill || itemSet ? { minion, skill, itemSet } : null
}

function parseSkillGroups(parent: Element): PobSkillGroup[] {
  return childrenByTag(parent, 'Skill').map((skillEl) => {
    const gems: PobGem[] = childrenByTag(skillEl, 'Gem').map((g) => ({
      gemId: g.getAttribute('gemId') ?? '',
      skillId: g.getAttribute('skillId') ?? '',
      nameSpec: g.getAttribute('nameSpec') ?? '',
      level: num(g.getAttribute('level')) ?? 1,
      quality: num(g.getAttribute('quality')) ?? 0,
      enabled: boolAttr(g, 'enabled', true),
      variantId: strOrNull(g.getAttribute('variantId')),
      count: num(g.getAttribute('count')),
      enableGlobal1: tri(g.getAttribute('enableGlobal1')),
      enableGlobal2: tri(g.getAttribute('enableGlobal2')),
      corrupted: tri(g.getAttribute('corrupted')),
      corruptLevel: num(g.getAttribute('corruptLevel')),
      statSetIndex: num(g.getAttribute('statSetIndex')),
      statSetIndexCalcs: num(g.getAttribute('statSetIndexCalcs')),
      minion: parseGemMinion(g),
      rawAttrs: attrsOf(g),
    }))
    const src = skillEl.getAttribute('source')
    return {
      enabled: boolAttr(skillEl, 'enabled', true),
      mainActiveSkill: num(skillEl.getAttribute('mainActiveSkill')),
      source: src && src.length ? src : null,
      gems,
      slot: strOrNull(skillEl.getAttribute('slot')),
      label: strOrNull(skillEl.getAttribute('label')),
      includeInFullDPS: tri(skillEl.getAttribute('includeInFullDPS')),
      mainActiveSkillCalcs: num(skillEl.getAttribute('mainActiveSkillCalcs')),
      rawAttrs: attrsOf(skillEl),
    }
  })
}

/** Map an `<ItemSet>`'s `<Slot>` children → slot→item-id refs into the shared `<Item>` pool. */
function parseItemSetSlots(setEl: Element): PobSlot[] {
  return childrenByTag(setEl, 'Slot').map((sl) => ({
    name: sl.getAttribute('name') ?? '',
    itemId: sl.getAttribute('itemId') ?? '0',
    active: boolAttr(sl, 'active'),
    itemPbURL: strOrNull(sl.getAttribute('itemPbURL')),
  }))
}

// ── main parse ───────────────────────────────────────────────────────────────
export function parsePob(xml: string): PobBuild {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const parserError = doc.querySelector('parsererror')
  if (parserError) throw new ParseError('The build XML could not be parsed (malformed XML).')

  const root = doc.documentElement
  if (!root) throw new ParseError('Empty build document.')
  if (root.tagName === 'PathOfBuilding') {
    throw new ParseError(
      'This is a Path of Building 1 (PoE1) build. This tool only converts Path of Building 2 (PoE2) builds.',
    )
  }
  if (root.tagName !== 'PathOfBuilding2') {
    throw new ParseError(`Unexpected root element <${root.tagName}>. Expected a Path of Building 2 build.`)
  }

  const buildEl = firstChildByTag(root, 'Build')
  const className = buildEl?.getAttribute('className') ?? null
  const ascendClassName = buildEl?.getAttribute('ascendClassName') ?? null
  const level = num(buildEl?.getAttribute('level') ?? null)
  const mainSocketGroup = num(buildEl?.getAttribute('mainSocketGroup') ?? null)
  const viewMode = strOrNull(buildEl?.getAttribute('viewMode') ?? null)
  const targetVersion = strOrNull(buildEl?.getAttribute('targetVersion') ?? null)
  const characterLevelAutoMode = tri(buildEl?.getAttribute('characterLevelAutoMode') ?? null)

  // PoB's exported calc snapshot (~100 <PlayerStat stat="TotalDPS" value="…"/> children). Keep BOTH the
  // numeric view (lossy for "inf"/14-digit floats — same as today) and the verbatim string form.
  const playerStats: Record<string, number> = {}
  const playerStatsRaw: Record<string, string> = {}
  const minionStats: Record<string, string> = {}
  if (buildEl) {
    for (const el of childrenByTag(buildEl, 'PlayerStat')) {
      const stat = el.getAttribute('stat')
      if (!stat) continue
      const valueStr = el.getAttribute('value') ?? ''
      playerStatsRaw[stat] = valueStr
      const value = num(valueStr)
      if (value != null) playerStats[stat] = value
    }
    for (const el of childrenByTag(buildEl, 'MinionStat')) {
      const stat = el.getAttribute('stat')
      if (stat) minionStats[stat] = el.getAttribute('value') ?? ''
    }
  }
  // <Buffs> / <FullDPSSkill> / <TimelessData> — read-only context PoB assumed at export.
  const buffsEl = buildEl ? firstChildByTag(buildEl, 'Buffs') : null
  const buffs = buffsEl
    ? {
        curseList: buffsEl.getAttribute('curseList') ?? '',
        combatList: buffsEl.getAttribute('combatList') ?? '',
        buffList: buffsEl.getAttribute('buffList') ?? '',
      }
    : null
  const fullDpsSkills = (buildEl ? childrenByTag(buildEl, 'FullDPSSkill') : []).map((el) => ({
    stat: el.getAttribute('stat') ?? '',
    value: el.getAttribute('value') ?? '',
    skillPart: el.getAttribute('skillPart') ?? '',
    source: el.getAttribute('source') ?? '',
  }))
  const timelessEl = buildEl ? firstChildByTag(buildEl, 'TimelessData') : null
  const timelessData = timelessEl ? attrsOf(timelessEl) : null

  // ── passive specs (ALL; the active one drives every existing consumer) ──
  const treeEl = firstChildByTag(root, 'Tree')
  const specEls = treeEl ? childrenByTag(treeEl, 'Spec') : []
  if (specEls.length === 0) throw new ParseError('No passive tree specification found in the build.')
  const specs = specEls.map(parseSpec)
  // activeSpec is 1-based; clamp into range — an out-of-range value picks the nearest valid spec,
  // never silently spec #0 the way the old `?? specs[0]` fallback did.
  const rawActiveSpec = (num(treeEl?.getAttribute('activeSpec') ?? null) ?? 1) - 1
  const activeSpecIndex = Math.min(Math.max(rawActiveSpec, 0), specs.length - 1)
  const spec = specs[activeSpecIndex]!

  // ── skill sets (ALL) ──
  const skillsEl = firstChildByTag(root, 'Skills')
  const skillSetEls = skillsEl ? childrenByTag(skillsEl, 'SkillSet') : []
  let skillSets: PobSkillSet[]
  if (skillSetEls.length > 0) {
    skillSets = skillSetEls.map((setEl) => ({
      id: setEl.getAttribute('id') ?? '',
      title: setEl.getAttribute('title'),
      groups: parseSkillGroups(setEl),
    }))
  } else if (skillsEl) {
    // older exports list <Skill> children directly under <Skills> with no <SkillSet> wrapper
    skillSets = [
      { id: skillsEl.getAttribute('activeSkillSet') ?? '1', title: null, groups: parseSkillGroups(skillsEl) },
    ]
  } else {
    skillSets = []
  }
  const wantSkillSetId = skillsEl?.getAttribute('activeSkillSet') ?? null
  const activeSkillSet = skillSets.find((s) => s.id === wantSkillSetId) ?? skillSets[0] ?? null
  const skillGroups = activeSkillSet?.groups ?? []

  // ── items (shared pool) + item sets (ALL; each set maps slots into the pool) ──
  const itemsEl = firstChildByTag(root, 'Items')
  const items = new Map<string, PobItem>()
  let itemSets: PobItemSet[] = []
  if (itemsEl) {
    for (const itemEl of childrenByTag(itemsEl, 'Item')) {
      const id = itemEl.getAttribute('id') ?? ''
      // textContent excludes child <ModRange/> (they're empty) → raw stays byte-identical to today.
      const raw = (itemEl.textContent ?? '').trim()
      const modRanges = childrenByTag(itemEl, 'ModRange').map((m) => ({
        id: num(m.getAttribute('id')) ?? 0,
        range: m.getAttribute('range') ?? '',
      }))
      const variantAttrs = attrsOf(itemEl)
      delete variantAttrs.id
      if (id) items.set(id, parseItemText(id, raw, modRanges, variantAttrs))
    }
    itemSets = childrenByTag(itemsEl, 'ItemSet').map((setEl) => ({
      id: setEl.getAttribute('id') ?? '',
      title: setEl.getAttribute('title'),
      slots: parseItemSetSlots(setEl),
      useSecondWeaponSet: tri(setEl.getAttribute('useSecondWeaponSet')),
      socketIdUrls: childrenByTag(setEl, 'SocketIdURL').map((s) => ({
        name: s.getAttribute('name') ?? '',
        nodeId: s.getAttribute('nodeId') ?? '',
        itemPbURL: strOrNull(s.getAttribute('itemPbURL')),
      })),
    }))
  }
  const wantItemSetId = itemsEl?.getAttribute('activeItemSet') ?? null
  const activeItemSet = itemSets.find((s) => s.id === wantItemSetId) ?? itemSets[0] ?? null
  const slots = activeItemSet?.slots ?? []

  // ── config sets (titles drive loadout matching; the calc inputs are surfaced read-only) ──
  const configEl = firstChildByTag(root, 'Config')
  const activeConfigSetId = strOrNull(configEl?.getAttribute('activeConfigSet') ?? null)
  const configSets = configEl
    ? childrenByTag(configEl, 'ConfigSet').map((setEl) => ({
        id: setEl.getAttribute('id') ?? '',
        title: setEl.getAttribute('title'),
        inputs: childrenByTag(setEl, 'Input').map(parseConfigInput).filter(isPresent),
        placeholders: childrenByTag(setEl, 'Placeholder').map(parseConfigInput).filter(isPresent),
      }))
    : []

  // ── notes / calcs / tree-view / import / party — read-only context, null when absent ──
  const notes = getElementText(firstChildByTag(root, 'Notes'))
  const notesHtml = getElementText(firstChildByTag(root, 'NotesHTML'))
  const calcsEl = firstChildByTag(root, 'Calcs')
  const calcs = calcsEl
    ? {
        inputs: childrenByTag(calcsEl, 'Input').map(parseConfigInput).filter(isPresent),
        sections: childrenByTag(calcsEl, 'Section').map((el) => ({
          id: el.getAttribute('id') ?? '',
          subsection: el.getAttribute('subsection') ?? '',
          collapsed: boolAttr(el, 'collapsed'),
        })),
      }
    : null
  const treeViewEl = firstChildByTag(root, 'TreeView')
  const treeView = treeViewEl
    ? {
        searchStr: treeViewEl.getAttribute('searchStr') ?? '',
        zoomLevel: treeViewEl.getAttribute('zoomLevel') ?? '',
        zoomX: treeViewEl.getAttribute('zoomX') ?? '',
        zoomY: treeViewEl.getAttribute('zoomY') ?? '',
        rawAttrs: attrsOf(treeViewEl),
      }
    : null
  const importEl = firstChildByTag(root, 'Import')
  const importInfo = importEl ? attrsOf(importEl) : null
  const partyEl = firstChildByTag(root, 'Party')
  const party = partyEl ? attrsOf(partyEl) : null
  const skillsOptions = skillsEl ? attrsOf(skillsEl) : {}
  const itemsOptions = itemsEl ? attrsOf(itemsEl) : {}
  // top-level child order + any unmodelled top-level element (round-trip aid)
  const KNOWN_SECTIONS = new Set([
    'Build',
    'Import',
    'Tree',
    'Skills',
    'Items',
    'Config',
    'Calcs',
    'Notes',
    'NotesHTML',
    'TreeView',
    'Party',
  ])
  // Single pass over the top-level children: record their order and capture any unmodelled section.
  const sectionOrder: string[] = []
  const rawSections: ReturnType<typeof rawElement>[] = []
  for (const c of root.children) {
    sectionOrder.push(c.tagName)
    if (!KNOWN_SECTIONS.has(c.tagName)) rawSections.push(rawElement(c))
  }

  return {
    className,
    ascendClassName,
    level,
    mainSocketGroup,
    playerStats,
    spec,
    skillGroups,
    items,
    slots,
    specs,
    activeSpecIndex,
    skillSets,
    activeSkillSetId: activeSkillSet?.id ?? null,
    itemSets,
    activeItemSetId: activeItemSet?.id ?? null,
    configSets,
    viewMode,
    targetVersion,
    characterLevelAutoMode,
    playerStatsRaw,
    minionStats,
    buffs,
    fullDpsSkills,
    timelessData,
    activeConfigSetId,
    calcs,
    notes,
    notesHtml,
    treeView,
    importInfo,
    party,
    skillsOptions,
    itemsOptions,
    sectionOrder,
    rawSections,
  }
}
