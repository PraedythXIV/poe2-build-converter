// Atlas-masters share codec tests: bitmask round-trips + decode garbage tolerance.
// Each master has 12 keystones and you may pick ANY of them up to a 4-point cap (no per-row
// limit), so the selection is a 12-bit mask packed into 2 bytes/master; the masters[] order →
// consecutive byte pairs → base64url. decodeMasters mirrors atlas/share.ts: malformed input
// returns null, never throws.

import { describe, it, expect } from 'vitest'
import { encodeMasters, decodeMasters } from '../src/atlas/mastersShare'
import mastersData from '../src/data/atlasMasters.json'

const MASTERS = (mastersData as { masters: { id: string; keystones: { id: string; row: number; col: number }[] }[] })
  .masters

/** Build a state record that picks keystone at (row,col) for the given master id. */
const pick = (masterId: string, rc: Array<[number, number]>): string[] => {
  const m = MASTERS.find((x) => x.id === masterId)!
  return rc.map(([row, col]) => m.keystones.find((k) => k.row === row && k.col === col)!.id)
}

describe('encodeMasters / decodeMasters round-trips', () => {
  it('round-trips a real per-master selection', () => {
    const state = {
      [MASTERS[0]!.id]: pick(MASTERS[0]!.id, [
        [1, 2],
        [2, 1],
        [4, 3],
      ]),
      [MASTERS[1]!.id]: pick(MASTERS[1]!.id, [[3, 3]]),
      [MASTERS[2]!.id]: [],
    }
    const s = encodeMasters(state, MASTERS)
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/) // base64url, no padding
    expect(decodeMasters(s, MASTERS)).toEqual(state)
  })

  it('empty selection ↔ empty string', () => {
    const empty = Object.fromEntries(MASTERS.map((m) => [m.id, []]))
    expect(encodeMasters(empty, MASTERS)).toBe('')
    expect(decodeMasters('', MASTERS)).toEqual(empty)
  })

  it('is order-insensitive within a master (canonical for the pick set)', () => {
    const id = MASTERS[0]!.id
    const a = {
      [id]: pick(id, [
        [1, 1],
        [3, 2],
      ]),
      [MASTERS[1]!.id]: [],
      [MASTERS[2]!.id]: [],
    }
    const b = {
      [id]: pick(id, [
        [3, 2],
        [1, 1],
      ]),
      [MASTERS[1]!.id]: [],
      [MASTERS[2]!.id]: [],
    }
    expect(encodeMasters(a, MASTERS)).toBe(encodeMasters(b, MASTERS))
  })

  it('round-trips multiple picks in the same display row (no per-row limit)', () => {
    const id = MASTERS[0]!.id
    // all three keystones of display row 1 — every one must survive the round-trip
    const state = {
      [id]: pick(id, [
        [1, 1],
        [1, 2],
        [1, 3],
      ]),
      [MASTERS[1]!.id]: [],
      [MASTERS[2]!.id]: [],
    }
    expect(decodeMasters(encodeMasters(state, MASTERS), MASTERS)).toEqual(state)
  })

  it('round-trips a fully-allocated plan, including 4 picks clustered in two rows', () => {
    const state = Object.fromEntries(
      MASTERS.map((m) => [
        m.id,
        pick(m.id, [
          [1, 1],
          [1, 2],
          [1, 3],
          [2, 1],
        ]),
      ]),
    )
    expect(decodeMasters(encodeMasters(state, MASTERS), MASTERS)).toEqual(state)
  })
})

describe('decodeMasters garbage tolerance', () => {
  it('returns null on non-base64url charsets', () => {
    expect(decodeMasters('###', MASTERS)).toBeNull()
    expect(decodeMasters('AQI=', MASTERS)).toBeNull() // padding is not part of the format
    expect(decodeMasters('A+', MASTERS)).toBeNull() // '+' is plain base64, not base64url
  })

  it('returns null on impossible base64 lengths', () => {
    expect(decodeMasters('A', MASTERS)).toBeNull() // length % 4 === 1 never decodes
  })

  it('tolerates a short stream (missing masters decode to empty picks)', () => {
    // one byte present (master 0 = col 1 in row 1), the rest absent
    const s = encodeMasters({ [MASTERS[0]!.id]: pick(MASTERS[0]!.id, [[1, 1]]) }, MASTERS)
    const decoded = decodeMasters(s, MASTERS)!
    expect(decoded[MASTERS[1]!.id]).toEqual([])
    expect(decoded[MASTERS[2]!.id]).toEqual([])
  })

  it('ignores mask bits beyond the 12 keystones (never invents a pick)', () => {
    const b64url = (bytes: number[]) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    // master 0 byte-pair = 0x8000 → only bit 15 set, which has no 16th keystone behind it
    const decoded = decodeMasters(b64url([0x00, 0x80]), MASTERS)!
    expect(decoded[MASTERS[0]!.id]).toEqual([])
  })
})
