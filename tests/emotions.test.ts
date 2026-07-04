// Distilled-Emotion reference — pins the data contracts the planner UI relies on:
// the 13 ingredient emotions, all three spend-paths resolved to clean text (no raw stat ids),
// and the order-sensitive anoint forward/reverse lookups. Correctness of the wording itself is
// gated upstream by scripts/build-emotions.mjs (own pathofexile-dat extraction).

import { describe, it, expect } from 'vitest'
import {
  emotions,
  anoints,
  notables,
  constants,
  emotionByKey,
  anointFor,
  recipesForNotable,
  notableNames,
  craftable,
  isHiddenAnoint,
  hiddenAnointCount,
  JEWEL_COLOURS,
} from '../src/emotions/data'

const RARITIES = new Set(['Diluted', 'Liquid', 'Concentrated', 'Potent'])

describe('emotion ingredients', () => {
  it('has the 13 anoint/waystone emotions in canonical tier order', () => {
    expect(emotions).toHaveLength(13)
    expect(emotions.map((e) => e.key)).toEqual([
      'Ire',
      'Guilt',
      'Greed',
      'Paranoia',
      'Envy',
      'Disgust',
      'Despair',
      'Fear',
      'Suffering',
      'Isolation',
      'Melancholy',
      'Ferocity',
      'Contempt',
    ])
    emotions.forEach((e, i) => expect(e.tier).toBe(i + 1))
    for (const e of emotions) expect(RARITIES.has(e.rarity)).toBe(true)
    // the three Potent emotions are the highest tier
    expect(emotions.filter((e) => e.potent).map((e) => e.key)).toEqual(['Melancholy', 'Ferocity', 'Contempt'])
  })

  it('gives every emotion a waystone Deliriousness% and jewel outcomes (normal + Time-Lost)', () => {
    for (const e of emotions) {
      expect(e.waystone.deliriousPct, e.key).toBeGreaterThan(0)
      expect(e.jewel, `${e.key} normal jewel`).toBeTruthy()
      expect(e.jewelTimeLost, `${e.key} time-lost jewel`).toBeTruthy()
    }
    // Deliriousness climbs with rarity (Diluted Ire lowest, the Potent trio cap at 50%)
    expect(emotionByKey('Ire')!.waystone.deliriousPct).toBe(7)
    expect(emotionByKey('Isolation')!.waystone.deliriousPct).toBe(50)
    for (const k of ['Melancholy', 'Ferocity', 'Contempt']) expect(emotionByKey(k)!.waystone.deliriousPct).toBe(50)
  })

  it('resolves jewel outcome slots to named affixes with stat text', () => {
    const ruby = emotionByKey('Ire')!.jewel!.ruby!
    expect(ruby.p).toMatchObject({ name: 'Armoured' })
    expect(ruby.p!.text).toMatch(/increased Armour/)
    // only the four known jewel colours ever appear
    for (const e of emotions) {
      for (const out of [e.jewel, e.jewelTimeLost]) {
        for (const key of Object.keys(out ?? {})) {
          expect(JEWEL_COLOURS.map((c) => c.key)).toContain(key)
        }
      }
    }
  })
})

describe('amulet anointing (order-sensitive)', () => {
  it('forward lookup respects slot order', () => {
    // same multiset, different order -> different notable (the headline mechanic)
    expect(anointFor(['Ire', 'Ire', 'Ire'])).toBe('Insulated Treads')
    expect(anointFor(['Ire', 'Guilt', 'Ire'])).toBe('Blinding Flash')
    expect(anointFor(['Guilt', 'Ire', 'Ire'])).toBe('Flamekeeper')
    expect(anointFor(['Ire', 'Guilt', 'Ire'])).not.toBe(anointFor(['Guilt', 'Ire', 'Ire']))
  })

  it('returns null for combinations with no anointment', () => {
    expect(anointFor(['Ire', 'Ire', 'Guilt'])).toBeNull() // a known empty/invalid order
  })

  it('reverse lookup returns the exact ordered recipe', () => {
    const recipes = recipesForNotable('Insulated Treads')
    expect(recipes.length).toBeGreaterThan(0)
    for (const r of recipes) {
      expect(r).toHaveLength(3)
      expect(anointFor(r)).toBe('Insulated Treads') // round-trips
    }
  })

  it('every anoint recipe references known emotions and a notable with text', () => {
    for (const a of anoints) {
      expect(a.c).toHaveLength(3)
      for (const k of a.c) expect(emotionByKey(k), k).toBeDefined()
      expect(notables[a.n], a.n).toBeDefined()
    }
  })
})

describe('hidden (anoint-only) Notables', () => {
  it('flags the off-tree anoint-only Notables (PassiveSkills.IsAnointmentOnly), not regular tree ones', () => {
    expect(hiddenAnointCount).toBe(17)
    expect(isHiddenAnoint('Insulated Treads')).toBe(false) // a normal tree notable
    expect(Object.keys(notables).filter(isHiddenAnoint)).toHaveLength(hiddenAnointCount)
  })

  it("includes Zarokh's Gift — the anoint that grants a Sinister Jewel Socket", () => {
    expect(isHiddenAnoint("Zarokh's Gift")).toBe(true)
    // exact recipe + effect, straight from the datamine (Potent trio, in order)
    expect(anointFor(['Melancholy', 'Ferocity', 'Contempt'])).toBe("Zarokh's Gift")
    expect(notables["Zarokh's Gift"]).toContain('Sinister Jewel Socket')
  })

  it('every hidden anoint is a real notable with text and at least one recipe', () => {
    for (const n of Object.keys(notables).filter(isHiddenAnoint)) {
      expect(notables[n]?.length ?? 0, n).toBeGreaterThan(0)
      expect(recipesForNotable(n).length, n).toBeGreaterThan(0)
    }
  })
})

describe('inventory → craftable', () => {
  it('returns nothing for an empty inventory', () => {
    expect(craftable({})).toEqual([])
    expect(craftable({ Ire: 2 })).toEqual([]) // every recipe needs 3 emotions
  })

  it('limits craft count by the scarcest required emotion', () => {
    // Ire+Ire+Ire -> Insulated Treads needs 3 Ire; 7 Ire -> floor(7/3) = 2 times
    const only = craftable({ Ire: 7 })
    const treads = only.find((x) => x.n === 'Insulated Treads')
    expect(treads).toBeDefined()
    expect(treads!.times).toBe(2)
    expect(treads!.c).toEqual(['Ire', 'Ire', 'Ire'])
    // a recipe needing 2 Ire + 1 Guilt is excluded until a Guilt is owned
    expect(only.some((x) => x.c.includes('Guilt'))).toBe(false)
    const withGuilt = craftable({ Ire: 7, Guilt: 1 })
    expect(withGuilt.some((x) => x.c.includes('Guilt'))).toBe(true)
  })

  it('sorts by craftable count desc, and every row is genuinely craftable', () => {
    const inv = { Ire: 9, Guilt: 3, Greed: 3 }
    const rows = craftable(inv)
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.times).toBeGreaterThanOrEqual(rows[i]!.times)
    for (const r of rows) {
      const need: Record<string, number> = {}
      for (const k of r.c) need[k] = (need[k] ?? 0) + 1
      for (const [k, n] of Object.entries(need))
        expect((inv as Record<string, number>)[k] ?? 0).toBeGreaterThanOrEqual(n)
      expect(r.times).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('resolved text quality', () => {
  it('ships no raw stat-id fallbacks ("snake_case = N") anywhere', () => {
    const raw = /^[a-z][\w+%]* = -?\d/
    const offenders: string[] = []
    for (const [name, lines] of Object.entries(notables)) {
      for (const l of lines) if (raw.test(l)) offenders.push(`${name}: ${l}`)
    }
    for (const e of emotions) {
      for (const out of [e.jewel, e.jewelTimeLost]) {
        for (const c of Object.values(out ?? {})) {
          for (const slot of [c?.p, c?.s]) if (slot && raw.test(slot.text)) offenders.push(`${e.key}: ${slot.text}`)
        }
      }
      if (e.waystone.bonus && raw.test(e.waystone.bonus)) offenders.push(`${e.key} waystone: ${e.waystone.bonus}`)
    }
    expect(offenders).toEqual([])
  })

  it('exposes ~873 anointable notables, each with at least one stat line', () => {
    const names = notableNames()
    expect(names.length).toBeGreaterThan(800)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b))) // sorted
    for (const n of names) expect(notables[n]?.length ?? 0, n).toBeGreaterThan(0)
  })

  it('carries the Deliriousness build-up constants', () => {
    expect(constants.deliriousnessPerRare).toBeGreaterThan(0)
    expect(constants.deliriousnessPerUnique).toBeGreaterThan(0)
  })
})
