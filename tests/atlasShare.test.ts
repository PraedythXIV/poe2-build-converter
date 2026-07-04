// B2 — atlas share codec tests: round-trips, canonical encoding, and decode garbage
// tolerance (decodeAtlasPlan must return null on any structurally invalid input — never
// throw). Format per cvenzin/poe2-skilltree's shareHash (MIT): sorted numeric ids →
// deltas → unsigned LEB128 varints → base64url without padding.

import { describe, it, expect } from 'vitest'
import { encodeAtlasPlan, decodeAtlasPlan, encodeMasteryChoices, decodeMasteryChoices } from '../src/atlas/share'
import { atlasGraph, atlasRootIds } from '../src/atlas/index'

describe('encodeAtlasPlan / decodeAtlasPlan round-trips', () => {
  it('round-trips a plan of real atlas ids', () => {
    const ids = new Set([...atlasRootIds(), '1'])
    const s = encodeAtlasPlan(ids)
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/) // base64url, no padding
    expect(decodeAtlasPlan(s)).toEqual(ids)
  })

  it('round-trips every node id of the vendored atlas graph', () => {
    const all = new Set(Object.keys(atlasGraph.nodes))
    expect(decodeAtlasPlan(encodeAtlasPlan(all))).toEqual(all)
  })

  it('is order- and duplicate-insensitive (canonical for a set)', () => {
    expect(encodeAtlasPlan(['100', '5'])).toBe(encodeAtlasPlan(['5', '100']))
    expect(decodeAtlasPlan(encodeAtlasPlan(['5', '5', '100']))).toEqual(new Set(['5', '100']))
  })

  it('empty set ↔ empty string', () => {
    expect(encodeAtlasPlan([])).toBe('')
    expect(decodeAtlasPlan('')).toEqual(new Set())
  })

  it('encodes deterministically: ids [1, 3] → deltas [1, 2] → bytes 0x01 0x02 → "AQI"', () => {
    expect(encodeAtlasPlan(['3', '1'])).toBe('AQI')
    expect(decodeAtlasPlan('AQI')).toEqual(new Set(['1', '3']))
  })

  it('uses multi-byte varints for large ids and gaps', () => {
    const ids = new Set(['0', '127', '128', '16384', '1000000'])
    const s = encodeAtlasPlan(ids)
    expect(decodeAtlasPlan(s)).toEqual(ids)
  })

  it('rejects non-numeric ids at encode time (caller bug, not user input)', () => {
    expect(() => encodeAtlasPlan(['AtlasRitualNotable16_'])).toThrow(TypeError)
  })
})

describe('decodeAtlasPlan garbage tolerance', () => {
  it('returns null on non-base64url charsets', () => {
    expect(decodeAtlasPlan('###')).toBeNull()
    expect(decodeAtlasPlan('not base64!!')).toBeNull()
    expect(decodeAtlasPlan('AQI=')).toBeNull() // padding is not part of the format
    expect(decodeAtlasPlan('AQ+I')).toBeNull() // '+' is plain base64, not base64url
  })

  it('returns null on impossible base64 lengths', () => {
    expect(decodeAtlasPlan('A')).toBeNull() // length % 4 === 1 never decodes
  })

  it('returns null on a truncated varint (lone continuation byte)', () => {
    expect(decodeAtlasPlan('gA')).toBeNull() // single byte 0x80: continuation, then EOF
    expect(decodeAtlasPlan('AYA')).toBeNull() // 0x01 then dangling 0x80
  })

  it('returns null when the accumulated id overflows the safe-integer space', () => {
    // eight 0xFF continuation bytes then 0x7F — far past Number.MAX_SAFE_INTEGER
    const bytes = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]
    const b64url = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(decodeAtlasPlan(b64url)).toBeNull()
  })

  it('decodes weird-but-structurally-valid input instead of throwing', () => {
    expect(decodeAtlasPlan('AA')).toEqual(new Set(['0'])) // byte 0x00 → id 0
    expect(decodeAtlasPlan('AAA')).toEqual(new Set(['0'])) // delta 0 collapses into the set
  })
})

describe('encodeMasteryChoices / decodeMasteryChoices round-trips', () => {
  it('round-trips a map of node id -> chosen option index', () => {
    const choices = new Map([
      ['100', 0],
      ['5', 2],
      ['16384', 3],
    ])
    const s = encodeMasteryChoices(choices)
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeMasteryChoices(s)).toEqual(choices)
  })

  it('empty map ↔ empty string', () => {
    expect(encodeMasteryChoices(new Map())).toBe('')
    expect(decodeMasteryChoices('')).toEqual(new Map())
  })

  it('is order-insensitive (canonical, sorted by numeric id)', () => {
    const a = encodeMasteryChoices(
      new Map([
        ['5', 1],
        ['100', 2],
      ]),
    )
    const b = encodeMasteryChoices(
      new Map([
        ['100', 2],
        ['5', 1],
      ]),
    )
    expect(a).toBe(b)
  })

  it('drops out-of-byte-range option indices at encode time', () => {
    // index 999 can't fit a byte; the entry is skipped rather than corrupting the stream
    expect(decodeMasteryChoices(encodeMasteryChoices(new Map([['5', 999]])))).toEqual(new Map())
  })

  it('rejects non-numeric ids at encode time (caller bug, not user input)', () => {
    expect(() => encodeMasteryChoices(new Map([['AtlasBiomeSwampNotable4', 0]]))).toThrow(TypeError)
  })

  it('returns null on garbage instead of throwing', () => {
    expect(decodeMasteryChoices('###')).toBeNull()
    expect(decodeMasteryChoices('A')).toBeNull() // impossible base64 length
    expect(decodeMasteryChoices('gA')).toBeNull() // varint with no terminator / missing index byte
  })
})
