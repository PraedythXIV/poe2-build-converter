import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTierLookup, lookupTier, normalizeModLine, tierPatternCount } from '../src/items/tiers'
import { annotateModLine, domainForItem, renderItemDetails } from '../src/items/detailsPanel'
import { summarize } from '../src/convert/summarize'
import type { SummaryItem } from '../src/convert/summarize'
import { emptySummaryItem } from './helpers/pobBuild'
import modTiers from '../src/data/modTiers.json'

const XML = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')

describe('normalizeModLine', () => {
  it('replaces signed/decimal numbers with # and lowercases', () => {
    expect(normalizeModLine('+92 to maximum Life')).toBe('# to maximum life')
    expect(normalizeModLine('-1 Prefix Modifier allowed')).toBe('# prefix modifier allowed')
    expect(normalizeModLine('+4.96% to Critical Hit Chance')).toBe('#% to critical hit chance')
    expect(normalizeModLine('2.8 Life Regeneration per second')).toBe('# life regeneration per second')
  })

  it('collapses "X to Y" rolls into "# to #"', () => {
    expect(normalizeModLine('Adds 25 to 51 Physical Damage')).toBe('adds # to # physical damage')
  })

  it('strips trailing source flags like (rune)', () => {
    expect(normalizeModLine('+5% to all Elemental Resistances (rune)')).toBe('#% to all elemental resistances')
    expect(normalizeModLine('18% increased Physical Damage (rune)')).toBe('#% increased physical damage')
  })

  it('collapses whitespace', () => {
    expect(normalizeModLine('  +10   to  Strength ')).toBe('# to strength')
  })
})

describe('lookupTier (inline fixture)', () => {
  // weakest-first, t = count .. 1 — T1 is the strongest tier (PoE2 in-game convention since
  // patch 0.2.0, matching the PoE1 convention + the trade site; see src/items/tiers.ts). Shape v2: one ladder
  // per domain (g/f/j) under each pattern.
  const lookup = createTierLookup({
    '# to maximum life': {
      g: [
        { t: 3, min: 10, max: 19, ilvl: 1 },
        { t: 2, min: 20, max: 29, ilvl: 6 },
        { t: 1, min: 30, max: 39, ilvl: 16 },
      ],
      f: [
        { t: 2, min: 40, max: 69, ilvl: 1 },
        { t: 1, min: 70, max: 100, ilvl: 30 },
      ],
    },
    'instant recovery': { f: [{ t: 1, min: 1, max: 1, ilvl: 40 }] },
  })

  it('selects the tier whose roll range contains the value (domain defaults to gear)', () => {
    expect(lookup('+25 to maximum Life')).toEqual({ tier: 2, count: 3, min: 20, max: 29, ilvl: 6, approx: false })
    expect(lookup('+39 to maximum Life')).toMatchObject({ tier: 1, approx: false })
  })

  it('resolves the same pattern against each domain own ladder', () => {
    // 45 is outside the gear ladder (approx) but an exact flask T2 — the two domains must
    // never bleed into each other (HOLE 1: a flask line silently tiered against gear)
    expect(lookup('+45 to maximum Life')).toMatchObject({ approx: true })
    expect(lookup('+45 to maximum Life', 'flask')).toEqual({
      tier: 2,
      count: 2,
      min: 40,
      max: 69,
      ilvl: 1,
      approx: false,
    })
    expect(lookup('+25 to maximum Life', 'flask')).toMatchObject({ tier: 2, approx: true }) // below flask range
  })

  it('returns null when the pattern has no ladder for the queried domain (no fallback)', () => {
    expect(lookup('+25 to maximum Life', 'jewel')).toBeNull() // pattern exists, jewel ladder does not
    expect(lookup('Instant Recovery')).toBeNull() // flask-only pattern, default gear domain
    expect(lookup('Instant Recovery', 'jewel')).toBeNull()
  })

  it('flags out-of-range values as the nearest tier with approx: true', () => {
    expect(lookup('+55 to maximum Life')).toMatchObject({ tier: 1, min: 30, max: 39, approx: true })
    expect(lookup('+2 to maximum Life')).toMatchObject({ tier: 3, approx: true })
  })

  it('matches numberless lines only for single-tier families (no guessing)', () => {
    expect(lookup('Instant Recovery', 'flask')).toMatchObject({ tier: 1, count: 1, approx: false })
    expect(lookup('to maximum Life')).toBeNull() // numberless multi-tier: ambiguous -> null
  })

  it('returns null for unknown lines', () => {
    expect(lookup('Totally made-up mod line')).toBeNull()
  })
})

describe('lookupTier (vendored game data)', () => {
  it('resolves a classic life roll without overclaiming', () => {
    const m = lookupTier('+92 to maximum Life')
    expect(m).not.toBeNull()
    expect(m!.approx).toBe(false)
    expect(m!.count).toBeGreaterThanOrEqual(10) // life has a long ladder
    expect(m!.tier).toBeGreaterThanOrEqual(1)
    expect(m!.tier).toBeLessThanOrEqual(m!.count)
    expect(m!.min).toBeLessThanOrEqual(92)
    expect(m!.max).toBeGreaterThanOrEqual(92)
    expect(m!.ilvl).toBeGreaterThanOrEqual(1)
  })

  it('the top life roll is T1 (strongest), not the highest tier number', () => {
    const top = lookupTier('+214 to maximum Life') // current T1 cap is 200-214 @ ilvl 80
    expect(top).toMatchObject({ tier: 1, approx: false })
    const bottom = lookupTier('+12 to maximum Life')
    expect(bottom!.tier).toBe(bottom!.count)
  })

  it('keeps gear and jewel ladders for the same wording apart (HOLE 1 regression)', () => {
    // "#% increased maximum energy shield": gear rolls 10-50%, jewels roll 2-3%. Under the old
    // single-ladder table a jewel's 14% landed inside gear T7 — a silently wrong exact-looking
    // tier. Per-domain it is exact on gear and out-of-range (approx -> hidden) on a jewel.
    expect(lookupTier('14% increased maximum Energy Shield', 'gear')).toMatchObject({ min: 10, max: 14, approx: false })
    expect(lookupTier('14% increased maximum Energy Shield', 'jewel')).toMatchObject({ approx: true })
    expect(lookupTier('2% increased maximum Energy Shield', 'jewel')).toMatchObject({
      tier: 1,
      count: 1,
      approx: false,
    })
  })

  it('never falls back across domains when a ladder is absent', () => {
    expect(lookupTier('+92 to maximum Life', 'flask')).toBeNull() // life is a gear-only pattern
    expect(lookupTier('+92 to maximum Life', 'jewel')).toBeNull()
  })
})

describe('modTiers.json shape + provenance', () => {
  type Ladder = Array<{ t: number; min: number; max: number; ilvl: number }>
  const table = modTiers as unknown as Record<string, Partial<Record<'g' | 'f' | 'j', Ladder>>>
  const provenance = (modTiers as unknown as { _provenance: Record<string, unknown> })._provenance
  const patterns = Object.keys(table).filter((k) => k !== '_provenance')

  it('carries a provenance header (patch + counts, shape v2) and a useful number of patterns', () => {
    expect(provenance).toBeTruthy()
    expect(String(provenance.patch)).toMatch(/^\d+(\.\d+)+$/)
    expect(provenance.captured).toBeTruthy()
    expect(provenance.counts).toBeTruthy()
    expect(provenance.shape).toBe(2) // per-domain ladders { g?, f?, j? }
    expect(patterns.length).toBeGreaterThanOrEqual(300)
    expect(tierPatternCount).toBe(patterns.length)
  })

  it('every key is a fixed point of normalizeModLine (builder/runtime lockstep)', () => {
    const drifted = patterns.filter((k) => normalizeModLine(k) !== k)
    expect(drifted).toEqual([])
  })

  it('each pattern holds 1+ per-domain ladders, weakest-first with t = count..1, sane ranges and ilvls', () => {
    for (const key of patterns) {
      const ladders = Object.entries(table[key]!)
      expect(ladders.length).toBeGreaterThan(0)
      for (const [dk, tiers] of ladders) {
        expect(['g', 'f', 'j']).toContain(dk)
        expect(tiers!.length).toBeGreaterThan(0)
        tiers!.forEach((entry, i) => {
          expect(entry.t).toBe(tiers!.length - i) // last entry is T1 = strongest
          expect(entry.min).toBeLessThanOrEqual(entry.max)
          expect(entry.ilvl).toBeGreaterThanOrEqual(1)
        })
      }
    }
  })
})

describe('fixture coverage smoke (floor so regressions show)', () => {
  it('exact in-domain matches cover at least 64% of fixture mod lines (measured 66.3%)', () => {
    // counts ONLY what the UI may display: exact matches against the item's own domain ladder
    // (approx/out-of-range results are hidden, cross-domain fallback does not exist)
    const s = summarize(XML)
    let total = 0
    let matched = 0
    for (const item of [...s.items, ...s.jewels]) {
      const domain = domainForItem(item)
      for (const line of item.mods) {
        total++
        const m = lookupTier(line, domain)
        if (m && !m.approx) matched++
      }
    }
    expect(total).toBeGreaterThanOrEqual(60) // fixture carries ~80 mod lines
    expect(matched / total).toBeGreaterThanOrEqual(0.64)
  })
})

describe('detailsPanel rendering', () => {
  const rare: SummaryItem = emptySummaryItem({
    slot: 'Ring 1',
    rarity: 'RARE',
    name: 'Corruption Nail',
    baseType: 'Sapphire Ring',
    levelReq: 12,
    mods: ['+84 to maximum Life', 'Bonded: weird rune effect (rune)', 'Totally made-up mod line'],
  })

  it('renders an itc- card with tier chips for matched mods only', () => {
    const html = renderItemDetails(rare)
    expect(html).toContain('itc-card')
    expect(html).toContain('idp-chip') // matched life mod got a chip
    expect(html).toContain('idp-roll') // …and it's a real MATCH (tier + roll range), not a muted unknown
    expect(html).toContain('idp-chip--unknown') // made-up line says "tier ?" instead of guessing
    expect(html).toContain('data-tag="socketed"') // socketed line keeps bonus styling, never a tier chip
    expect(html).not.toMatch(/rune effect[^<]*<span class="idp-chip/)
  })

  it('applies a resolved roll to a (min-max) mod — shows PoB value + roll %, drops the template', () => {
    const item = emptySummaryItem({
      slot: 'Body Armour',
      rarity: 'RARE',
      name: 'Test Plate',
      baseType: 'Vaal Regalia',
      mods: ['+(80-120) to maximum Life'],
      parsedMods: [
        { text: '+(80-120) to maximum Life', tags: [], isImplicit: false, rangeHint: '0.25', corruptedMult: null },
      ],
    })
    const html = renderItemDetails(item)
    expect(html).toContain('+90 to maximum Life') // 80 + 0.25*(120-80), PoB's own formula
    expect(html).toContain('idp-rollpct')
    expect(html).toContain('25%')
    expect(html).not.toContain('(80-120)') // template replaced by the applied value
  })

  it('never applies a roll when a corrupted multiplier is present (no modScalability data → no guess)', () => {
    const item = emptySummaryItem({
      slot: 'Amulet',
      rarity: 'RARE',
      name: 'Vaal Amulet',
      baseType: 'Gold Amulet',
      mods: ['+(5-10) to Strength'],
      parsedMods: [
        { text: '+(5-10) to Strength', tags: [], isImplicit: false, rangeHint: '0.5', corruptedMult: '0.8' },
      ],
    })
    const html = renderItemDetails(item)
    expect(html).toContain('(5-10)') // template kept verbatim; not applied
    expect(html).not.toContain('idp-rollpct')
  })

  it('renders non-rune implicits above the explicits — a base/crafted implicit is no longer dropped', () => {
    const item = emptySummaryItem({
      slot: 'Ring 1',
      rarity: 'RARE',
      name: 'Test Ring',
      baseType: 'Sapphire Ring',
      mods: ['+50 to maximum Life'],
      parsedMods: [{ text: '+50 to maximum Life', tags: [], isImplicit: false, rangeHint: null, corruptedMult: null }],
      implicits: [
        { text: '+20% to Cold Resistance', tags: ['crafted'], isImplicit: true, rangeHint: null, corruptedMult: null },
      ],
    })
    const html = renderItemDetails(item)
    expect(html).toContain('idp-implicits')
    expect(html).toContain('+20% to Cold Resistance') // the implicit is now shown
    expect(html).toContain('idp-tag--crafted') // with its source tag
  })

  it('does not duplicate a {rune} implicit (it already renders with the explicits)', () => {
    const item = emptySummaryItem({
      slot: 'Body Armour',
      rarity: 'RARE',
      name: 'T',
      baseType: 'Plate',
      mods: ['+40 to maximum Life (rune)'],
      implicits: [
        {
          text: '+40 to maximum Life (rune)',
          tags: ['rune', 'enchant'],
          isImplicit: true,
          rangeHint: null,
          corruptedMult: null,
        },
      ],
    })
    const html = renderItemDetails(item)
    expect(html).not.toContain('idp-implicits') // {rune} implicit is excluded here; it shows via mods[]
  })

  it('gives uniques an honest no-tiers note instead of chips', () => {
    const html = renderItemDetails({ ...rare, rarity: 'UNIQUE', mods: ['+40 to maximum Energy Shield'] })
    expect(html).toContain('idp-note')
    expect(html).not.toContain('idp-chip')
  })

  it('escapes item-supplied text', () => {
    const html = renderItemDetails({ ...rare, name: '<img src=x>', mods: [] })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('annotateModLine returns a compact chip for matched lines and nothing otherwise', () => {
    expect(annotateModLine('+92 to maximum Life')).toContain('idp-chip--inline')
    expect(annotateModLine('Totally made-up mod line')).toBe('')
    expect(annotateModLine('18% increased Physical Damage (rune)')).toBe('') // rune grants are not affixes
  })

  it('approx (out-of-range) matches render NOTHING approximate — no chip, no ~T', () => {
    // +9999 life is out of every stored gear range: the matcher still reports it (approx: true)
    // for API honesty, but no renderer may display it as a tier
    expect(lookupTier('+9999 to maximum Life')).toMatchObject({ approx: true })
    expect(annotateModLine('+9999 to maximum Life')).toBe('')
    const html = renderItemDetails({ ...rare, mods: ['+9999 to maximum Life'] })
    expect(html).toContain('idp-chip--unknown') // same muted "tier ?" state as unmatched lines
    expect(html).not.toContain('~T')
    expect(html).not.toContain('idp-chip--approx')
    expect(html).toContain('idp-note') // all-approx item honestly says tiers are unknown
  })

  it('derives the lookup domain from the item slot (charms share the flask domain)', () => {
    expect(domainForItem(rare)).toBe('gear') // Ring 1
    expect(domainForItem({ ...rare, slot: 'Flask 2' })).toBe('flask')
    expect(domainForItem({ ...rare, slot: 'Charm 3' })).toBe('flask') // Mods.Domain 2 = flasks & charms
    expect(domainForItem({ ...rare, slot: 'Jewel' })).toBe('jewel')
    expect(domainForItem({ ...rare, slot: 'Weapon 1 Swap' })).toBe('gear')
  })

  it('never tier-matches a line against another domain ladder', () => {
    // "+92 to maximum Life" is a gear-only pattern: on a flask item it must show the unknown
    // state, not the gear ladder tier (HOLE 1 regression at the rendering layer)
    expect(annotateModLine('+92 to maximum Life', 'flask')).toBe('')
    const html = renderItemDetails({ ...rare, slot: 'Flask 1', mods: ['+92 to maximum Life'] })
    expect(html).toContain('idp-chip--unknown')
    expect(html).not.toContain('idp-chip--inline')
    expect(html).not.toContain('idp-roll')
  })
})
