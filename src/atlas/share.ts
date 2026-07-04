// B2 — atlas plan share codec: a compact, URL-safe string for an allocated atlas-node set.
//
// Format reference: the shareHash codec in cvenzin/poe2-skilltree (MIT License, © 2026
// cvenzin — see THIRD-PARTY-NOTICES.md): numeric node ids sorted ascending → delta
// encoding → unsigned LEB128 varints → base64url without padding. Reimplemented from the
// format description; no code copied.
//
// decodeAtlasPlan is garbage-tolerant by contract: any structurally invalid input (bad
// charset, broken base64, truncated varint, unsafe magnitude) returns null — never throws.
// It does NOT validate ids against the atlas graph; the codec stays pure.

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/
const NUMERIC_ID_RE = /^\d+$/

/** Read one unsigned LEB128 varint from `bytes` at index `i`. Returns the decoded value and the next
 *  index, or null if the stream ends mid-varint. The shared inner loop of both decoders (one source). */
function readVarint(bytes: number[], i: number): { value: number; next: number } | null {
  let value = 0
  let factor = 1
  while (i < bytes.length) {
    const byte = bytes[i]!
    i++
    value += (byte & 0x7f) * factor
    factor *= 128
    if ((byte & 0x80) === 0) return { value, next: i }
  }
  return null // stream ended mid-varint
}

/**
 * Encode atlas node ids (numeric strings — the atlasGraph.json key space) into a share
 * string. Duplicates collapse and order is irrelevant: the output is canonical for a set.
 * Throws TypeError on a non-numeric id — that is a caller bug, not user input.
 */
export function encodeAtlasPlan(ids: Iterable<string>): string {
  const unique = new Set<number>()
  for (const id of ids) {
    if (!NUMERIC_ID_RE.test(id)) throw new TypeError(`encodeAtlasPlan: non-numeric node id "${id}"`)
    const n = Number(id)
    if (!Number.isSafeInteger(n)) throw new TypeError(`encodeAtlasPlan: node id "${id}" exceeds the safe-integer range`)
    unique.add(n)
  }
  const sorted = [...unique].sort((a, b) => a - b)
  const bytes: number[] = []
  let prev = 0
  for (const value of sorted) {
    pushVarint(bytes, value - prev) // first value is its own delta from 0
    prev = value
  }
  return toBase64Url(bytes)
}

/**
 * Decode a share string back into the id set. Returns null on garbage (never throws);
 * the empty string decodes to the empty set (its exact encode round-trip).
 */
export function decodeAtlasPlan(s: string): Set<string> | null {
  const bytes = decodeShareBytes(s)
  if (bytes === null) return null
  const out = new Set<string>()
  return walkDeltaIds(bytes, (id, i) => (out.add(id), i)) ? out : null
}

/**
 * Walk a delta-encoded LEB128 id stream (the shared skeleton of both decoders): calls `onId` with
 * each decoded id and the cursor just past its varint; `onId` returns the next cursor (letting the
 * mastery decoder consume its option byte) or null on structural garbage. False = invalid stream.
 * (Dedupe refactor while green: MOVED VERBATIM from the identical walks in decodeAtlasPlan and
 * decodeMasteryChoices below.)
 */
function walkDeltaIds(bytes: number[], onId: (id: string, i: number) => number | null): boolean {
  let acc = 0
  let i = 0
  while (i < bytes.length) {
    const v = readVarint(bytes, i)
    if (v === null) return false // stream ended mid-varint
    i = v.next
    acc += v.value
    if (!Number.isSafeInteger(acc)) return false // overflowed the id space — garbage
    const next = onId(String(acc), i)
    if (next === null) return false
    i = next
  }
  return true
}

/**
 * Encode atlas mastery bonus picks (node id -> chosen option index) into a share string. Each
 * entry is the delta-encoded numeric node id (LEB128 varint) followed by one byte for the option
 * index (0..255). Sorted by id so the output is canonical. Out-of-range or non-integer option indices are dropped; ids
 * must be numeric (the atlasGraph key space) — a non-numeric id is a caller bug, like encodeAtlasPlan.
 */
export function encodeMasteryChoices(choices: ReadonlyMap<string, number>): string {
  const entries: Array<[number, number]> = []
  for (const [id, idx] of choices) {
    if (!NUMERIC_ID_RE.test(id)) throw new TypeError(`encodeMasteryChoices: non-numeric node id "${id}"`)
    const n = Number(id)
    if (!Number.isSafeInteger(n))
      throw new TypeError(`encodeMasteryChoices: node id "${id}" exceeds the safe-integer range`)
    if (Number.isInteger(idx) && idx >= 0 && idx <= 255) entries.push([n, idx])
  }
  entries.sort((a, b) => a[0] - b[0])
  const bytes: number[] = []
  let prev = 0
  for (const [id, idx] of entries) {
    pushVarint(bytes, id - prev) // delta from the previous id
    prev = id
    bytes.push(idx)
  }
  return toBase64Url(bytes)
}

/** Decode a mastery-pick share string back into the map. Garbage-tolerant: returns null on any
 *  structurally invalid input (never throws); the empty string decodes to the empty map. */
export function decodeMasteryChoices(s: string): Map<string, number> | null {
  const bytes = decodeShareBytes(s)
  if (bytes === null) return null
  const out = new Map<string, number>()
  const ok = walkDeltaIds(bytes, (id, i) => {
    if (i >= bytes.length) return null // missing the option-index byte
    out.set(id, bytes[i]!)
    return i + 1
  })
  return ok ? out : null
}

/** Append `value` (unsigned integer) as little-endian base-128 LEB128 bytes. */
function pushVarint(bytes: number[], value: number): void {
  let v = value
  while (v >= 128) {
    bytes.push((v % 128) | 0x80)
    v = Math.floor(v / 128)
  }
  bytes.push(v)
}

/** Raw bytes → base64url without padding. Shared with the masters codec (one source). */
export function toBase64Url(bytes: readonly number[]): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url → raw bytes, or null on a malformed stream (never throws). Shared codec helper. */
function fromBase64Url(s: string): number[] | null {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  let bin: string
  try {
    bin = atob(padded)
  } catch {
    return null
  }
  const bytes: number[] = []
  for (let i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i))
  return bytes
}

/** Validate + decode a base64url share string to bytes, or null on any malformed input (never throws).
 *  The shared preamble of every decoder here and in mastersShare — one source of truth. */
export function decodeShareBytes(s: string): number[] | null {
  if (typeof s !== 'string' || !BASE64URL_RE.test(s)) return null
  if (s.length % 4 === 1) return null // no valid base64 stream has this remainder
  return fromBase64Url(s)
}
