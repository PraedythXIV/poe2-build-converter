// Passive-point counting — the two formulas behind the tree caps badge.
// Anchored to a real build (poe.ninja "116 / 115" + the GGG game files): weapon-set passives are PART
// of the main pool but SHARE point slots between the two sets, and the badge's denominator is always
// the LEVEL-100 max (so a legal build never reads over-cap, regardless of the character's level).

import { describe, it, expect } from 'vitest'
import { mainPointsUsed, availablePoints, PASSIVE_CAP, ASCENDANCY_CAP, WEAPON_SET_CAP } from '../src/tree/index'

describe('mainPointsUsed — weapon-set point sharing', () => {
  it('a plain build with no weapon-set nodes is just the shared count', () => {
    expect(mainPointsUsed(100, 0, 0)).toBe(100)
  })

  it('weapon-set nodes overlap: cost = shared + max(ws1, ws2), NOT shared + ws1 + ws2', () => {
    // the real build: 92 shared + 24 set-I + 23 set-II → 92 + 24 = 116, not 92+24+23 = 139
    expect(mainPointsUsed(92, 24, 23)).toBe(116)
    expect(mainPointsUsed(92, 23, 24)).toBe(116) // symmetric
    expect(mainPointsUsed(92, 24, 24)).toBe(116) // equal sets still overlap
  })
})

describe('availablePoints — always the level-100 max', () => {
  it('is PASSIVE_CAP (the level-100 max) regardless of character level', () => {
    expect(availablePoints(0)).toBe(PASSIVE_CAP)
  })

  it('grantedPassivePoints raise the budget above the base max', () => {
    expect(availablePoints(2)).toBe(PASSIVE_CAP + 2)
  })

  it('PASSIVE_CAP is 99 (levels at L100) + 24 (all quests) = 123', () => {
    expect(PASSIVE_CAP).toBe(99 + 24)
  })
})

describe('caps', () => {
  it('weapon-set cap is 24 per set; ascendancy cap is 8', () => {
    expect(WEAPON_SET_CAP).toBe(24)
    expect(ASCENDANCY_CAP).toBe(8)
  })
})

describe('the real build reads as poe.ninja + the game files describe it', () => {
  it('116 / 123 (used / level-100 max), never over-cap', () => {
    const main = mainPointsUsed(92, 24, 23)
    const available = availablePoints(0)
    expect(`${main}/${available}`).toBe('116/123')
    expect(main).toBeLessThanOrEqual(available) // left never exceeds right
  })
})
