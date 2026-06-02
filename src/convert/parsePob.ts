// Parse a Path of Building 2 XML document into our typed PobBuild model.
// Uses the platform DOMParser (browser native; jsdom in tests — happy-dom can't parse XML).

import type { PobBuild, PobSpec, PobGem, PobSkillGroup, PobItem, PobSlot, PobSocket } from './types'

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

// ── item body text ───────────────────────────────────────────────────────────
// A header/property line is one of PoB's known "Label: value" lines, or a standalone flag.
// We use an explicit allowlist (not a generic "word + colon" test) so a real mod that happens to be
// colon-labelled — e.g. "Grants Skill: …" — is kept as a mod rather than silently dropped.
const ITEM_LABEL_RE =
  /^(Rarity|Item Level|Quality|Sockets|Rune|Soul Core|LevelReq|Requires|Requirements|Unique ID|Item Class|Prefix|Suffix|Note|Selected Variant|Has Variants|Variant|Catalyst|Catalyst Quality|Talisman Tier|Stack Size|Spirit|Charm Slots|Radius|Limited to|League|Source|Energy Shield|Evasion Rating|Evasion|Armour|Armor|Ward)\s*:/i
const ITEM_FLAG_RE = /^(Corrupted|Mirrored|Split|Unidentified|Identified|Fractured|Synthesised|Veiled|Foil|Eldritch)\b/i
function isItemHeaderLine(line: string): boolean {
  return ITEM_LABEL_RE.test(line) || ITEM_FLAG_RE.test(line)
}

/** Strip leading {tag}{tag} mod prefixes PoB stores (e.g. "{crafted}{rune}+5..."). */
function stripModPrefix(line: string): string {
  return line.replace(/^(\{[^}]*\})+/, '').trim()
}

function parseItemText(id: string, raw: string): PobItem {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  let rarity = 'NORMAL'
  let name = ''
  let baseType = ''
  const mods: string[] = []
  let implicitsLeft = 0

  // Level requirement (drives level_interval). PoB writes "LevelReq: N".
  let levelReq = 1
  for (const l of lines) {
    const m = l.match(/^LevelReq:\s*(\d+)/i) ?? l.match(/^Requires:?\s*Level\s*(\d+)/i)
    if (m) {
      levelReq = Number(m[1])
      break
    }
  }

  let cursor = 0
  // Rarity line
  if (lines[0]?.toUpperCase().startsWith('RARITY:')) {
    rarity = lines[0].slice(lines[0].indexOf(':') + 1).trim().toUpperCase()
    cursor = 1
  }
  // Name / base lines (the next non-header lines before stats start)
  const nameLines: string[] = []
  while (cursor < lines.length && !isItemHeaderLine(lines[cursor]!) && nameLines.length < 2) {
    nameLines.push(lines[cursor]!)
    cursor++
  }
  if (rarity === 'MAGIC' || rarity === 'NORMAL') {
    name = nameLines.join(' ')
    baseType = nameLines.length > 1 ? nameLines[1]! : ''
  } else {
    name = nameLines[0] ?? ''
    baseType = nameLines[1] ?? ''
  }

  // Remaining lines: headers + mods. Track "Implicits: N" to skip implicit mods.
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor]!
    const implicitMatch = line.match(/^Implicits:\s*(\d+)/i)
    if (implicitMatch) {
      implicitsLeft = Number(implicitMatch[1])
      continue
    }
    // consume exactly the counted implicit lines FIRST, regardless of how they look — an implicit
    // such as "Grants Skill: …" must still decrement the counter, not be skipped as a header.
    if (implicitsLeft > 0) {
      implicitsLeft--
      continue
    }
    if (isItemHeaderLine(line)) continue
    const mod = stripModPrefix(line)
    if (mod) mods.push(mod)
  }

  return { id, rarity, name, baseType, mods, levelReq, raw }
}

// ── main parse ───────────────────────────────────────────────────────────────
export function parsePob(xml: string): PobBuild {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const parserError = doc.querySelector('parsererror')
  if (parserError) throw new ParseError('The build XML could not be parsed (malformed XML).')

  const root = doc.documentElement
  if (!root) throw new ParseError('Empty build document.')
  if (root.tagName === 'PathOfBuilding') {
    throw new ParseError('This is a Path of Building 1 (PoE1) build. This tool only converts Path of Building 2 (PoE2) builds.')
  }
  if (root.tagName !== 'PathOfBuilding2') {
    throw new ParseError(`Unexpected root element <${root.tagName}>. Expected a Path of Building 2 build.`)
  }

  const buildEl = firstChildByTag(root, 'Build')
  const className = buildEl?.getAttribute('className') ?? null
  const ascendClassName = buildEl?.getAttribute('ascendClassName') ?? null
  const level = num(buildEl?.getAttribute('level') ?? null)

  // ── passive spec (active one) ──
  const treeEl = firstChildByTag(root, 'Tree')
  const specs = treeEl ? childrenByTag(treeEl, 'Spec') : []
  const activeSpecIdx = num(treeEl?.getAttribute('activeSpec') ?? null) ?? 1
  const specEl = specs[activeSpecIdx - 1] ?? specs[0] ?? null
  if (!specEl) throw new ParseError('No passive tree specification found in the build.')

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

  const spec: PobSpec = {
    treeVersion: specEl.getAttribute('treeVersion') ?? 'unknown',
    ascendancyInternalId: ascRaw && ascRaw !== 'nil' && ascRaw !== '' ? ascRaw : null,
    classId: specEl.getAttribute('classId'),
    nodes: csv(specEl.getAttribute('nodes')),
    weaponSet1: csv(ws1El?.getAttribute('nodes') ?? null),
    weaponSet2: csv(ws2El?.getAttribute('nodes') ?? null),
    sockets,
  }

  // ── skill groups (active skill set) ──
  const skillsEl = firstChildByTag(root, 'Skills')
  let skillGroups: PobSkillGroup[] = []
  if (skillsEl) {
    const skillSets = childrenByTag(skillsEl, 'SkillSet')
    const activeSetId = skillsEl.getAttribute('activeSkillSet')
    const skillSet =
      skillSets.find((s) => s.getAttribute('id') === activeSetId) ?? skillSets[0] ?? skillsEl
    skillGroups = childrenByTag(skillSet, 'Skill').map((skillEl) => {
      const gems: PobGem[] = childrenByTag(skillEl, 'Gem').map((g) => ({
        gemId: g.getAttribute('gemId') ?? '',
        skillId: g.getAttribute('skillId') ?? '',
        nameSpec: g.getAttribute('nameSpec') ?? '',
        level: num(g.getAttribute('level')) ?? 1,
        quality: num(g.getAttribute('quality')) ?? 0,
        enabled: (g.getAttribute('enabled') ?? 'true') !== 'false',
      }))
      const src = skillEl.getAttribute('source')
      return {
        enabled: (skillEl.getAttribute('enabled') ?? 'true') !== 'false',
        mainActiveSkill: num(skillEl.getAttribute('mainActiveSkill')),
        source: src && src.length ? src : null,
        gems,
      }
    })
  }

  // ── items + active item set slots ──
  const itemsEl = firstChildByTag(root, 'Items')
  const items = new Map<string, PobItem>()
  let slots: PobSlot[] = []
  if (itemsEl) {
    for (const itemEl of childrenByTag(itemsEl, 'Item')) {
      const id = itemEl.getAttribute('id') ?? ''
      // textContent includes the body text; child <ModRange/> are empty.
      const raw = (itemEl.textContent ?? '').trim()
      if (id) items.set(id, parseItemText(id, raw))
    }
    const itemSets = childrenByTag(itemsEl, 'ItemSet')
    const activeItemSetId = itemsEl.getAttribute('activeItemSet')
    const itemSet =
      itemSets.find((s) => s.getAttribute('id') === activeItemSetId) ?? itemSets[0] ?? null
    if (itemSet) {
      slots = childrenByTag(itemSet, 'Slot').map((sl) => ({
        name: sl.getAttribute('name') ?? '',
        itemId: sl.getAttribute('itemId') ?? '0',
        active: (sl.getAttribute('active') ?? 'false') === 'true',
      }))
    }
  }

  return { className, ascendClassName, level, spec, skillGroups, items, slots }
}
