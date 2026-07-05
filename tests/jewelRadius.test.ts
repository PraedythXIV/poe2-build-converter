// Jewel-radius geometry — disc vs RING (annulus) affected zones.
// A disc jewel affects everything within its radius; a ring jewel (e.g. "Controlled Metamorphosis",
// "Only affects Passives in Medium-Large Ring") affects ONLY the band between an inner and outer
// radius — the inner hole is excluded. This guards the one-source-of-truth in src/tree/jewelRadius.ts
// and that jewelRadii.json still vendors the real PassiveJewelRadii ring bands (no approximate radii).

import { describe, it, expect } from 'vitest'
import { collectRadii, inDisc, firstRadiusAt } from '../src/tree/jewelRadius'
import { computeJewelSockets } from '../src/tree/jewelSockets'
import type { PobBuild } from '../src/convert/types'
import jewelRadii from '../src/data/jewelRadii.json'

const at = (x: number, y: number) => ({ x, y })

describe('disc jewel (solid radius)', () => {
  const discs = collectRadii(
    new Map([['s', { ring: { diameter: 200 } }]]),
    () => at(0, 0),
    () => 'disc',
  )

  it('has no inner hole (rIn2 = 0) and includes the centre', () => {
    expect(discs[0]!.rIn2).toBe(0)
    expect(inDisc(discs[0]!, 0, 0)).toBe(true)
  })

  it('includes points up to the radius and excludes points beyond', () => {
    expect(inDisc(discs[0]!, 50, 0)).toBe(true) // r=50 < 100
    expect(inDisc(discs[0]!, 100, 0)).toBe(true) // on the boundary
    expect(inDisc(discs[0]!, 101, 0)).toBe(false) // just outside
  })
})

describe('ring jewel (annulus — Medium-Large Ring: inner 1250, outer 1550)', () => {
  // world DIAMETERS = 2 × radius
  const discs = collectRadii(
    new Map([['s', { ring: { diameter: 3100, innerDiameter: 2500 } }]]),
    () => at(0, 0),
    () => 'ring',
  )

  it('excludes the inner hole (the socket centre is NOT affected)', () => {
    expect(inDisc(discs[0]!, 0, 0)).toBe(false)
    expect(inDisc(discs[0]!, 1249, 0)).toBe(false) // just inside the inner radius
    expect(firstRadiusAt(discs, 0, 0)).toBe(null)
  })

  it('includes the band between inner and outer radius (inclusive)', () => {
    expect(inDisc(discs[0]!, 1250, 0)).toBe(true) // inner boundary
    expect(inDisc(discs[0]!, 1400, 0)).toBe(true) // mid-band
    expect(inDisc(discs[0]!, 1550, 0)).toBe(true) // outer boundary
    expect(firstRadiusAt(discs, 1400, 0)).toBe('ring')
  })

  it('excludes points beyond the outer radius', () => {
    expect(inDisc(discs[0]!, 1551, 0)).toBe(false)
  })
})

describe('jewelRadii.json vendors the real PassiveJewelRadii ring bands', () => {
  const sizes = (jewelRadii as { sizes: Record<string, { radius: number; ringInner: number; ringOuter: number }> })
    .sizes

  it('Medium-Large ring band is 1250..1550 (the screenshot jewel)', () => {
    expect(sizes.mediumlarge).toMatchObject({ radius: 1225, ringInner: 1250, ringOuter: 1550 })
  })

  it('every size carries a non-degenerate ring band (inner < outer)', () => {
    for (const [k, v] of Object.entries(sizes)) {
      expect(v.ringInner, k).toBeGreaterThan(0)
      expect(v.ringOuter, k).toBeGreaterThan(v.ringInner)
    }
  })
})

// ── computeJewelSockets — socket-model branches not reached by the geometry tests above ──────────
/** A one-socket PobBuild wrapping a single jewel at node '1' (only the fields the transform reads). */
function socketOne(over: {
  name?: string
  baseType?: string
  rarity?: string
  raw: string
  mods?: string[]
}): PobBuild {
  const item = { name: 'J', baseType: 'Cobalt Jewel', rarity: 'MAGIC', mods: [] as string[], ...over }
  return { spec: { sockets: [{ nodeId: '1', itemId: 'j' }] }, items: new Map([['j', item]]) } as unknown as PobBuild
}

describe('computeJewelSockets — radius / rarity / swap edge branches', () => {
  it('a Time-Lost Diamond with a known radius but no swap text carries no swap (L123)', () => {
    const info = computeJewelSockets(
      socketOne({
        baseType: 'Time-Lost Diamond',
        raw: 'Radius: Medium\nTime-Lost Diamond',
        mods: ['+5% increased Attributes'],
      }),
    ).get('1')!
    expect(info.radius).toBe('Medium') // radius recognised → the swap reader runs …
    expect(info.swap).toBeUndefined() // … but no mod names a transform → falls through to undefined
  })

  it('a ring jewel naming an unknown size draws NO ring band (never a guessed radius) (L37)', () => {
    const info = computeJewelSockets(
      socketOne({ raw: 'Radius: Variable\nx', mods: ['Only affects Passives in Gigantic Ring'] }),
    ).get('1')!
    // "Variable" isn't a disc size and "Gigantic" isn't a known ring size → jewelRingBand returns null
    expect(info.ring).toBeUndefined()
  })

  it('an empty rarity string collapses to undefined, not "" (L147 `|| undefined`)', () => {
    const info = computeJewelSockets(socketOne({ rarity: '', raw: 'x', mods: [] })).get('1')!
    expect(info.rarity).toBeUndefined()
  })
})
