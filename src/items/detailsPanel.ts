// Enriched item-details card: the gear gallery's #311 itc- tooltip language plus per-mod
// affix-tier chips (T1 = strongest — see src/items/tiers.ts for the convention + cite) sourced
// from the vendored modTiers.json. Honest by design: rune/soul-core granted lines and unique
// rolls are NOT tiered affixes so they get no chip; unmatched lines AND out-of-range (approx)
// matches show the same muted "tier ?" state instead of a guess — nothing approximate is ever
// displayed as a tier. Lookups are per item domain (gear / flask&charm / jewel) so a flask
// line is never tier-matched against a gear ladder.
//
// `renderItemDetails` returns the standalone enriched card; `annotateModLine` returns just a
// compact chip for inline use next to a matched mod line in the existing gear gallery.

import './detailsPanel.css'
import { groupSocketables } from '../convert/summarize'
import type { SummaryItem } from '../convert/summarize'
import type { ParsedMod } from '../convert/types'
import { escapeHtml } from '../ui/escapeHtml'
import { rarityKey, poeTierVars } from '../ui/rarity'
import { lookupTier, type TierDomain, type TierMatch } from './tiers'
import { itemArtHtml } from './icons'
import { RUNE_FLAG_RE } from './runeFlag'
import { copy } from '../copy'

/** Mods-domain bucket for an item, from its PoB slot label. Flasks AND charms share GGG's
 *  Mods.Domain 2 (one 'flask' ladder set in modTiers.json — see the builder's KEEP_DOMAINS);
 *  tree jewels are domain 11; every equipment slot is domain 1 (gear). */
export function domainForItem(item: SummaryItem): TierDomain {
  const slot = item.slot.toLowerCase()
  if (slot.startsWith('flask') || slot.startsWith('charm')) return 'flask'
  if (slot.startsWith('jewel')) return 'jewel'
  return 'gear'
}

/** Compact number — builder values are already rounded to <= 2 decimals. */
const fmt = (n: number): string => String(n)

function chipTitle(m: TierMatch): string {
  return copy.items.chipTitle(m.tier, m.count, fmt(m.min), fmt(m.max), m.ilvl)
}

function chipClasses(m: TierMatch, extra = ''): string {
  let cls = 'idp-chip'
  if (m.tier === 1) cls += ' idp-chip--top'
  return extra ? `${cls} ${extra}` : cls
}

/** Exact tier match for a line, or null. Approx (out-of-range) results are treated the same as
 *  no match — the product rule is "nothing approximate, ever". */
function exactTier(line: string, domain: TierDomain): TierMatch | null {
  const m = lookupTier(line, domain)
  return m && !m.approx ? m : null
}

/**
 * Inline tier chip for a mod line in the existing gear gallery: "T3/9". Returns '' for
 * rune-granted lines (not affixes), for lines with no tier data, and for out-of-range (approx)
 * matches — the gallery stays clean instead of guessing.
 */
export function annotateModLine(line: string, domain: TierDomain = 'gear'): string {
  if (RUNE_FLAG_RE.test(line)) return ''
  const m = exactTier(line, domain)
  if (!m) return ''
  return (
    `<span class="${chipClasses(m, 'idp-chip--inline')}" title="${escapeHtml(chipTitle(m))}">` +
    `<b>T${m.tier}</b><i>/${m.count}</i></span>`
  )
}

/** Full tier chip (tier + roll range + ilvl) for an exact match, else the muted unknown state
 *  (out-of-range values get the same "tier ?" as unknown lines — never a nearest-tier guess). */
function tierChip(line: string, domain: TierDomain): string {
  const m = lookupTier(line, domain)
  if (!m || m.approx) {
    const title = m ? copy.items.tierApprox : copy.items.tierNoData
    return `<span class="idp-chip idp-chip--unknown" title="${title}">${copy.items.tierUnknown}</span>`
  }
  return (
    `<span class="${chipClasses(m)}" title="${escapeHtml(chipTitle(m))}">` +
    `<b>T${m.tier}</b><i>/${m.count}</i>` +
    `<span class="idp-roll">${fmt(m.min)}–${fmt(m.max)}</span>` +
    `<span class="idp-ilvl">${copy.items.ilvlLine(m.ilvl)}</span></span>`
  )
}

const TAG_LABEL: Record<string, string> = copy.items.tagLabel
/** PoB's exact roll math — replace each "(min-max)" in a line with min + range*(max-min), at the
 *  range's own decimal precision. Ported from itemLib.applyRange (PathOfBuilding-PoE2). */
function applyRange(line: string, range: number): string {
  return line.replace(
    /([+-]?)\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)/g,
    (_m, sign: string, minS: string, maxS: string) => {
      const min = Number(minS)
      let value = min + range * (Number(maxS) - min)
      if (sign === '-') value = -value
      const prec = Math.max((minS.split('.')[1] ?? '').length, (maxS.split('.')[1] ?? '').length)
      const rounded = Number(value.toFixed(prec))
      return sign === '+' && rounded > 0 ? `+${rounded}` : String(rounded)
    },
  )
}
/** Source-tag badges ({crafted}/{fractured}/…) for a parsed mod ('rune' is shown via styling instead). */
function tagBadges(pm: ParsedMod | undefined): string {
  if (!pm) return ''
  return pm.tags
    .filter((t) => t !== 'rune')
    .map((t) => `<span class="idp-tag idp-tag--${t}">${TAG_LABEL[t] ?? t}</span>`)
    .join('')
}
/** Compact item-meta row: item level, quality, sockets, radius/limit, defences + state flags — verbatim. */
function itemMeta(item: SummaryItem): string {
  const bits: string[] = []
  if (item.itemLevel != null) bits.push(`<span class="idp-meta">${copy.items.metaIlvl} <b>${item.itemLevel}</b></span>`)
  if (item.quality != null && item.quality > 0)
    bits.push(`<span class="idp-meta">${copy.items.metaQuality} <b>${item.quality}%</b></span>`)
  if (item.socketString)
    bits.push(`<span class="idp-meta">${copy.items.metaSockets} <b>${escapeHtml(item.socketString)}</b></span>`)
  if (item.radius) bits.push(`<span class="idp-meta">${copy.items.metaRadius} <b>${escapeHtml(item.radius)}</b></span>`)
  if (item.limitedTo)
    bits.push(`<span class="idp-meta">${copy.items.metaLimitedTo} <b>${escapeHtml(item.limitedTo)}</b></span>`)
  for (const [k, v] of Object.entries(item.defences))
    bits.push(`<span class="idp-meta">${escapeHtml(k)} <b>${escapeHtml(v)}</b></span>`)
  const flagChips = item.flags.map((f) => `<span class="idp-flag">${escapeHtml(f)}</span>`).join('')
  if (bits.length === 0 && flagChips === '') return ''
  return `<div class="idp-meta-row">${bits.join('')}${flagChips}</div>`
}

/** One mod row: rune lines keep the bonus styling (no chip — rune effects are not affixes). */
function modRow(mod: string, tiered: boolean, domain: TierDomain, byText: Map<string, ParsedMod>): string {
  // "socketed", not "rune": PoB tags soul-core stats {rune} too — the generic word is the accurate one
  if (RUNE_FLAG_RE.test(mod)) {
    return `<div class="itc-mod itc-mod--bonus" data-tag="socketed">${escapeHtml(mod.replace(RUNE_FLAG_RE, ''))}</div>`
  }
  const pm = byText.get(mod)
  // exact roll: the parser resolved each ranged line's position (a <ModRange> element, or rarely an inline
  // {range:N}) onto pm.rangeHint ∈ [0,1]. Apply PoB's own formula (min + N*(max-min)) to show the REAL
  // value + the roll %. Only for true (min-max) template lines, and never when a corrupted multiplier is
  // present (we don't have PoB's modScalability data to reproduce that exactly) — no guessed value ever.
  let display = mod
  let roll = ''
  if (pm && pm.rangeHint != null && pm.corruptedMult == null && /\(-?\d/.test(mod)) {
    const r = Number(pm.rangeHint)
    if (Number.isFinite(r)) {
      display = applyRange(mod, r)
      const pct = Math.round(r * 100)
      roll = `<span class="idp-rollpct" title="${copy.items.rollPctTitle(pct)}">${pct}%</span>`
    }
  }
  const text = escapeHtml(display)
  const tags = tagBadges(pm)
  if (!tiered && !tags && !roll) return `<div class="itc-mod">${text}</div>`
  // the tier chip looks up the ORIGINAL template line (`mod`), not the applied value
  return `<div class="itc-mod idp-mod"><span class="idp-mod-text">${text}</span>${roll}${tags}${tiered ? tierChip(mod, domain) : ''}</div>`
}

/**
 * Enriched #311 item card for a parsed PoB item: tooltip header/body plus per-mod tier chips.
 * Affix tiers only exist for MAGIC/RARE explicit mods; uniques get an honest note instead.
 */
export function renderItemDetails(item: SummaryItem): string {
  const rk = rarityKey(item.rarity)
  const tiered = rk === 'rare' || rk === 'magic'
  const domain = domainForItem(item)

  const base =
    item.baseType && item.baseType !== item.name ? `<span class="itc-base">${escapeHtml(item.baseType)}</span>` : ''
  const reqs = item.levelReq > 1 ? `<div class="itc-reqs">${copy.items.requiresLevel(item.levelReq)}</div>` : ''
  const byText = new Map(item.parsedMods.map((pm) => [pm.text, pm]))
  const mods = item.mods.map((m) => modRow(m, tiered, domain, byText)).join('')
  // Implicit lines (base/enchant/crafted) — `mods[]` only carries {rune} implicits (which render below with
  // the explicits), so we draw the rest here, above the explicits. Implicits aren't affix-tiered (no chip),
  // but their source tags + resolved rolls still apply via modRow.
  const byTextImpl = new Map(item.implicits.map((pm) => [pm.text, pm]))
  const implRows = item.implicits
    .filter((pm) => !pm.tags.includes('rune') && pm.text)
    .map((pm) => modRow(pm.text, false, domain, byTextImpl))
    .join('')
  const implicits = implRows ? `<div class="idp-implicits">${implRows}</div>` : ''
  const grants = item.grantedSkills.length
    ? `<div class="itc-runes itc-grants"><span>${copy.items.grants}</span>${item.grantedSkills
        .map((g) => escapeHtml(g.level !== null ? copy.items.grantWithLevel(g.name, g.level) : g.name))
        .join(' · ')}</div>`
    : ''
  const runeNames = groupSocketables(item.runes)
    .map((g) => `<div class="itc-runes"><span>${g.label}</span>${g.names.map(escapeHtml).join(' · ')}</div>`)
    .join('')

  // honest footnotes: uniques have fixed ranges (tiers don't apply); a tiered item where no
  // line matched says so once instead of looking authoritative
  let note = ''
  if (rk === 'unique' && item.mods.length) {
    note = `<div class="idp-note">${copy.items.noteUniqueFixed}</div>`
  } else if (tiered && item.mods.length && item.mods.every((m) => RUNE_FLAG_RE.test(m) || !exactTier(m, domain))) {
    note = `<div class="idp-note">${copy.items.noteTiersUnknown}</div>`
  }

  const sep = implicits || mods || grants || runeNames ? '<hr class="itc-sep" aria-hidden="true" />' : ''
  const implSep = implicits && mods ? '<hr class="itc-sep itc-sep--impl" aria-hidden="true" />' : ''
  const stampCls = item.inBuild ? 'itc-stamp' : 'itc-stamp itc-stamp--preview'
  const stampTxt = item.inBuild ? escapeHtml(item.slot) : copy.items.previewStamp(escapeHtml(item.slot))
  const stamp = `<div class="${stampCls}"><span class="bc-tier" aria-hidden="true">${item.inBuild ? '●' : '○'}</span> ${stampTxt}</div>`

  return (
    `<div class="itc-card itc-card--featured idp-card itc-r-${rk}" style="${poeTierVars(rk)}" role="group" aria-label="${escapeHtml(item.slot)}: ${escapeHtml(item.name)}">` +
    `<div class="itc-header">${itemArtHtml(item, 44)}<span class="itc-name">${escapeHtml(item.name)}</span>${base}</div>` +
    `<div class="itc-body">${reqs}${itemMeta(item)}${sep}${implicits}${implSep}${mods}${grants}${runeNames}${note}</div>${stamp}</div>`
  )
}
