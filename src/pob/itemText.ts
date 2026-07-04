// src/pob/itemText.ts — the PoB2 <Item> body-text grammar.
//
// PoB serialises each item as free-text lines: a Rarity line, name/base lines, then property lines
// (Item Level, Quality, Sockets, Item Class, Unique ID, defences, Radius/Limited to), an optional
// "Implicits: N" marker + N implicit lines, then the explicit mod lines (each optionally prefixed with
// {crafted}{fractured}{rune}… source tags). This parses ALL of it LOSSLESSLY. The EXISTING fields —
// rarity / name / baseType / mods / levelReq / runes / grantedSkills / raw — keep their EXACT
// today-values (the regexes are unchanged); the richer fields layer on top.
import type { GrantedSkill, ModSource, ParsedMod, PobItem, PobModRange, RawAttrs } from './model'

// A header/property line is one of PoB's known "Label: value" lines, or a standalone flag. An explicit
// allowlist (not a generic "word + colon" test) so a real mod that happens to be colon-labelled — e.g.
// "Grants Skill: …" — is kept as a mod rather than dropped.
const ITEM_LABEL_RE =
  /^(Rarity|Item Level|Quality|Sockets|Rune|Soul Core|LevelReq|Requires|Requirements|Unique ID|Item Class|Prefix|Suffix|Note|Selected Variant|Has Variants|Variant|Catalyst|Catalyst Quality|Talisman Tier|Stack Size|Spirit|Charm Slots|Radius|Limited to|League|Source|Energy Shield|Evasion Rating|Evasion|Armour|Armor|Ward)\s*:/i
const ITEM_FLAG_RE =
  /^(Corrupted|Mirrored|Split|Unidentified|Identified|Fractured|Synthesised|Veiled|Foil|Eldritch|Historic|Sanctified)\b/i
function isItemHeaderLine(line: string): boolean {
  return ITEM_LABEL_RE.test(line) || ITEM_FLAG_RE.test(line)
}

// Leading `{tag}{tag}…` source-prefix run that opens a mod line (e.g. {crafted}{rune}). Shared by
// parseMod (which decodes the tags) and the grantedSkills pass (which strips them before matching).
const MOD_PREFIX_RE = /^(\{[^}]*\})+/

const MOD_SOURCES = new Set<ModSource>([
  'enchant',
  'rune',
  'crafted',
  'fractured',
  'desecrated',
  'mutated',
  'unscalable',
  'custom',
])

/** Parse a mod line into its `{tag}` source prefixes + visible text + any inline roll hint. `text`
 *  matches the old `stripModPrefix` output exactly (all prefixes stripped; a {rune} tag → trailing
 *  "(rune)"), so `mods[]` (derived from `text`) stays byte-identical to today. */
function parseMod(line: string, isImplicit: boolean): ParsedMod {
  const tags: ModSource[] = []
  let rangeHint: string | null = null
  let corruptedMult: string | null = null
  const pm = line.match(MOD_PREFIX_RE)
  let rest: string
  if (pm) {
    for (const t of pm[0].matchAll(/\{([^}]*)\}/g)) {
      const inner = (t[1] ?? '').trim()
      // {range:N} is the roll POSITION; {corruptedRange:N} is a corrupted-value multiplier — keep them
      // apart (PoB's applyRange treats them as different args). Inline form is rare; <ModRange> is the norm.
      const rm = inner.match(/^(range|corruptedRange):(.+)$/i)
      if (rm) {
        if (rm[1]!.toLowerCase() === 'range') rangeHint = rm[2]!
        else corruptedMult = rm[2]!
      } else if (MOD_SOURCES.has(inner.toLowerCase() as ModSource)) tags.push(inner.toLowerCase() as ModSource)
    }
    rest = line.slice(pm[0].length).trim()
    if (/\{rune\}/i.test(pm[0])) rest = `${rest} (rune)`
  } else {
    rest = line.trim()
  }
  return { text: rest, tags, isImplicit, rangeHint, corruptedMult }
}

/** PoB stores a charm's innate base buff as ONE buffModLine (flask.lua: every `charm.buff` is a single
 *  line; Life/Mana flasks have none). `<ModRange>` ids count buff lines first (ItemsTab:Save reserves
 *  `#buffModLines` slots), so a charm's mod ids are shifted by exactly 1. We detect a charm by its base
 *  (or name, for magic items where the base is fused into the name) and offset accordingly — verified
 *  against a real export (Silver Charm: its lone ranged mod is id 4 for a 3-line [impl,expl,expl] item). */
function buffOffset(baseType: string, name: string): number {
  const probe = baseType || name
  return /\bcharm\b/i.test(probe) ? 1 : 0
}

export function parseItemText(id: string, raw: string, modRanges: PobModRange[], variantAttrs: RawAttrs): PobItem {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  let rarity = 'NORMAL'
  // name/baseType are always set by the rarity branch below (never read before) — no dead initialiser
  let name: string
  let baseType: string
  const mods: string[] = []
  const parsedMods: ParsedMod[] = []
  const implicits: ParsedMod[] = []
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

  // socketed rune / soul-core names — PoB writes one "Rune: <name>" line per socketed rune
  // (soul cores are named "Soul Core of …" but still use the "Rune:" label). NOTE: a sceptre's
  // skill socket ("Sockets: S") is ALSO serialized as "Rune: <skill name>" — kept raw here (the
  // parser stays lookup-free); summarize/mapItems reclassify known gem names as granted skills.
  const runes: string[] = []
  for (const l of lines) {
    const rm = l.match(/^(?:Rune|Soul Core):\s*(.+)$/i)
    if (rm) runes.push(rm[1]!.trim())
  }

  // skills the item itself grants — "Grants Skill: Level 18 Purity of Ice". Only a stated single number
  // becomes a level; a "(1-20)" range stays null (we never display a number the item doesn't carry).
  const grantedSkills: GrantedSkill[] = []
  for (const l of lines) {
    const gm = l.replace(MOD_PREFIX_RE, '').match(/^Grants Skill:\s*(?:Level\s+(?:(\d+)|\(\d+[–-]\d+\))\s+)?(.+)$/i)
    if (gm) grantedSkills.push({ name: gm[2]!.trim(), level: gm[1] ? Number(gm[1]) : null })
  }

  // ── new: property / defence / flag passes (read-only enrichment; never touches mods[]) ──
  let itemLevel: number | null = null
  let quality: number | null = null
  let uniqueId: string | null = null
  let itemClass: string | null = null
  let socketString: string | null = null
  let radius: string | null = null
  let limitedTo: string | null = null
  const defences: Record<string, string> = {}
  const flags: string[] = []
  const DEF_RE = /^(Spirit|Energy Shield|Armour|Armor|Evasion Rating|Evasion|Ward|Charm Slots)\s*:\s*(.+)$/i
  for (const l of lines) {
    let m: RegExpMatchArray | null
    if ((m = l.match(/^Item Level:\s*(\d+)/i))) itemLevel = Number(m[1])
    else if ((m = l.match(/^Quality:\s*([+-]?\d+)/i))) quality = Number(m[1])
    else if ((m = l.match(/^Unique ID:\s*(.+)$/i))) uniqueId = m[1]!.trim()
    else if ((m = l.match(/^Item Class:\s*(.+)$/i))) itemClass = m[1]!.trim()
    else if ((m = l.match(/^Sockets:\s*(.+)$/i))) socketString = m[1]!.trim()
    else if ((m = l.match(/^Radius:\s*(.+)$/i))) radius = m[1]!.trim()
    else if ((m = l.match(/^Limited to:\s*(.+)$/i))) limitedTo = m[1]!.trim()
    else if ((m = l.match(DEF_RE))) {
      // DEF_RE accepts both 'Armour' and 'Armor'; canonicalise the US spelling so a single concept
      // never produces two keys (defences['Armour'] always resolves regardless of PoB's casing).
      const defKey = m[1]!.toLowerCase() === 'armor' ? 'Armour' : m[1]!
      defences[defKey] = m[2]!.trim()
    } else if ((m = l.match(ITEM_FLAG_RE))) flags.push(m[1]!)
  }

  let cursor = 0
  if (lines[0]?.toUpperCase().startsWith('RARITY:')) {
    rarity = lines[0]
      .slice(lines[0].indexOf(':') + 1)
      .trim()
      .toUpperCase()
    cursor = 1
  }
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

  // Remaining lines: headers + mods. `mods[]` stays BYTE-IDENTICAL to today (same {rune}-implicit +
  // explicit, stripped, non-empty rule); `parsedMods[]` / `implicits[]` are the new richer views.
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor]!
    const implicitMatch = line.match(/^Implicits:\s*(\d+)/i)
    if (implicitMatch) {
      implicitsLeft = Number(implicitMatch[1])
      continue
    }
    if (implicitsLeft > 0) {
      implicitsLeft--
      const pm = parseMod(line, true)
      implicits.push(pm)
      if (/\{rune\}/i.test(line) && pm.text) mods.push(pm.text) // today: only {rune} implicits enter mods[]
      continue
    }
    if (isItemHeaderLine(line)) continue
    const pm = parseMod(line, false)
    parsedMods.push(pm)
    if (pm.text) mods.push(pm.text)
  }

  // Resolve each <ModRange> roll position onto the mod line it belongs to. PoB (ItemsTab:Save) writes one
  // ModRange per ranged line with a GLOBAL 1-based id over [buff, enchant, rune, implicit, explicit]; our
  // [implicits…, explicits…] sequence is that same order once the (charm-only) buff offset is accounted
  // for. We never overwrite an inline {range:N} (more specific). 100% of items map — nothing skipped.
  const offset = buffOffset(baseType, name)
  const seq = [...implicits, ...parsedMods]
  for (const mr of modRanges) {
    const idx = mr.id - offset - 1
    if (idx >= 0 && idx < seq.length && seq[idx]!.rangeHint == null) seq[idx]!.rangeHint = mr.range
  }

  return {
    id,
    rarity,
    name,
    baseType,
    mods,
    levelReq,
    runes,
    grantedSkills,
    raw,
    itemLevel,
    quality,
    uniqueId,
    itemClass,
    socketString,
    radius,
    limitedTo,
    defences,
    flags,
    implicits,
    parsedMods,
    modRanges,
    variantAttrs,
  }
}
