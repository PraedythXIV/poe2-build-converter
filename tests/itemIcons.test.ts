import { describe, it, expect } from 'vitest'
import { iconForBase, itemIconsAtlas, itemIconsAtlasUrl, itemIconsProvenance } from '../src/items/icons'
import type { IconRect } from '../src/items/icons'
import itemIcons from '../src/data/itemIcons.json'

// Known-real bases, verified against the patch 4.5.2.1.2 BaseItemTypes extraction
// (see scripts/build-item-icons.mjs): a belt, a flask, a charm, a weapon, a jewel.
const KNOWN_BASES = ['Heavy Belt', 'Ultimate Life Flask', 'Thawing Charm', 'Spiked Club', 'Ruby']

function isValidRect(r: IconRect): boolean {
  return (
    Number.isInteger(r.x) &&
    Number.isInteger(r.y) &&
    Number.isInteger(r.w) &&
    Number.isInteger(r.h) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.w > 0 &&
    r.h > 0 &&
    r.x + r.w <= itemIconsAtlas.w &&
    r.y + r.h <= itemIconsAtlas.h
  )
}

describe('iconForBase', () => {
  it('resolves known equippable bases to in-bounds tile rects', () => {
    for (const name of KNOWN_BASES) {
      const rect = iconForBase(name)
      expect(rect, name).not.toBeNull()
      expect(isValidRect(rect!), `${name} -> ${JSON.stringify(rect)}`).toBe(true)
      // atlas scheme: every tile is exactly tileH tall
      expect(rect!.h).toBe(itemIconsAtlas.tileH)
    }
  })

  it('is case-insensitive and tolerant of surrounding/duplicated whitespace', () => {
    const canonical = iconForBase('Heavy Belt')
    expect(iconForBase('heavy belt')).toEqual(canonical)
    expect(iconForBase('  HEAVY   BELT  ')).toEqual(canonical)
  })

  it('returns null for unknown input — no art rather than wrong art', () => {
    expect(iconForBase('Definitely Not A Base')).toBeNull()
    expect(iconForBase('')).toBeNull()
    expect(iconForBase('   ')).toBeNull()
    // out-of-scope classes are absent by design (currency is not equippable)
    expect(iconForBase('Exalted Orb')).toBeNull()
  })

  it('uniques are NOT mapped by their unique name (only base names resolve)', () => {
    // "Kaom's Primacy" is a real unique (src/data/uniques.json) — its art is not vendored.
    expect(iconForBase("Kaom's Primacy")).toBeNull()
  })
})

describe('itemIcons.json shape', () => {
  const { _provenance, _atlas, ...rects } = itemIcons as unknown as Record<string, IconRect> & {
    _provenance: { patch: string; captured: string; counts: { bases: number; artFiles: number } }
    _atlas: { w: number; h: number; tileH: number }
  }

  it('carries provenance (exact patch + capture date) and atlas metadata', () => {
    expect(_provenance.patch).toMatch(/^\d+(\.\d+)+$/)
    expect(_provenance.captured).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(_provenance.counts.bases).toBe(Object.keys(rects).length)
    expect(_atlas.w).toBeGreaterThan(0)
    expect(_atlas.h).toBeGreaterThan(0)
    expect(_atlas.tileH).toBeGreaterThan(0)
    expect(itemIconsProvenance.patch).toBe(_provenance.patch)
  })

  it('every key is a normalized base name and every rect is in-bounds', () => {
    const entries = Object.entries(rects)
    expect(entries.length).toBeGreaterThan(1000) // ~1.7k equippable bases at 4.5.2.1.2
    for (const [key, rect] of entries) {
      expect(key, key).toBe(key.trim().replace(/\s+/g, ' ').toLowerCase())
      expect(isValidRect(rect), `${key} -> ${JSON.stringify(rect)}`).toBe(true)
    }
  })

  it('exports a bundled atlas asset URL (zero network at runtime)', () => {
    expect(itemIconsAtlasUrl).toMatch(/icons\.webp/)
  })
})
