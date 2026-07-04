// Atlas-masters share codec — a tiny bitmask of the planner's master keystone picks.
//
// Each master has 12 keystones and you may allocate ANY of them up to a 4-point cap (no
// per-row limit), so a master's selection is an arbitrary subset of its 12. We encode that as
// a 12-bit mask (bit i = the i-th keystone in array order is picked), packed little-endian into
// 2 bytes per master (the top 4 bits are always 0 on encode and IGNORED on decode — no keystone maps
// to them, so a hand-crafted over-wide mask allocates nothing extra); the masters[] order → consecutive byte pairs → base64url (the same
// alphabet as atlas/share.ts, whose helpers we reuse — one source of truth for the transform).
// Trailing all-zero bytes are trimmed so an empty plan is the canonical empty string; the
// decoder defaults missing bytes to 0, which absorbs both the trim and any short stream.
//
// decodeMasters is garbage-tolerant by contract (mirrors atlas/share.ts): malformed input
// returns null and never throws. It returns the full picked set; the drawer's setState then
// re-applies the 4-point cap, so an over-stuffed hand-made link can't exceed the budget.

import { toBase64Url, decodeShareBytes } from './share'

/** The shape this codec needs from a master — id + its keystones' stable ids (in array order). */
export interface MasterShape {
  id: string
  keystones: Array<{ id: string }>
}

/** Encode the per-master pick state (`{ masterId: keystoneId[] }`) into a share string. */
export function encodeMasters(state: Record<string, string[]>, masters: MasterShape[]): string {
  const bytes: number[] = []
  for (const m of masters) {
    const picked = new Set(state[m.id] ?? [])
    let mask = 0
    m.keystones.forEach((k, i) => {
      if (picked.has(k.id)) mask |= 1 << i
    })
    bytes.push(mask & 0xff, (mask >> 8) & 0xff) // 12 bits → 2 little-endian bytes per master
  }
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop() // canonical empty tail
  return toBase64Url(bytes)
}

/**
 * Decode a share string back into per-master picks (every master present, empty if unset).
 * Returns null on structurally invalid input; never throws.
 */
export function decodeMasters(s: string, masters: MasterShape[]): Record<string, string[]> | null {
  const bytes = decodeShareBytes(s)
  if (bytes === null) return null

  const out: Record<string, string[]> = {}
  for (let mi = 0; mi < masters.length; mi++) {
    const m = masters[mi]!
    const mask = (bytes[mi * 2] ?? 0) | ((bytes[mi * 2 + 1] ?? 0) << 8) // missing bytes → 0
    out[m.id] = m.keystones.filter((_, i) => mask & (1 << i)).map((k) => k.id)
  }
  return out
}
