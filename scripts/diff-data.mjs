// Data-refresh SAFETY GATE: compare the freshly-rebuilt src/data against a reference snapshot
// (the previous patch's vendored outputs) and classify every change. The point of a re-pin /
// auto-refresh is that a CLEAN or content-only diff is safe to accept, while a STRUCTURAL change
// (shape/keys changed, a count collapses, raw stat-ids appear) is flagged for a human.
//
//   node scripts/diff-data.mjs <referenceDir>     (e.g. ../poe2-pinned-bak-4.5.2.1.2/src-data)
//
// Exit 0 = no structural regressions (content diffs are fine); exit 1 = something to inspect.
// Heuristics, not a schema: it reports row/key counts, added/removed top-level keys, whether the
// JSON SHAPE (sorted key paths, 2 levels deep) changed, and whether raw "<snake_id> = n" stat
// fallbacks newly leaked in. Provenance/patch/date fields are ignored (they always change).

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib.mjs'

const refDir = process.argv[2]
if (!refDir) {
  console.error('usage: node scripts/diff-data.mjs <referenceDir>')
  process.exit(2)
}
const DATA = join(ROOT, 'src', 'data')
const RAW_STAT = /^[a-z][\w+%]*\s*=\s*-?\d/ // a raw, undescribed stat-id fallback leaking to the UI

const stripMeta = (o) => {
  if (Array.isArray(o)) return o
  if (o && typeof o === 'object') {
    const { _provenance, ...rest } = o
    return rest
  }
  return o
}
/** Count "rows": array length, or top-level non-underscore keys for an object map. */
function rowCount(o) {
  if (Array.isArray(o)) return o.length
  if (o && typeof o === 'object') return Object.keys(o).filter((k) => !k.startsWith('_')).length
  return 0
}
/** Set of sorted key-paths up to `depth` levels — a cheap structural fingerprint. */
function shape(o, depth = 2, prefix = '', out = new Set()) {
  if (depth < 0 || !o || typeof o !== 'object') return out
  const keys = Array.isArray(o) ? (o.length ? Object.keys(o[0] ?? {}) : []) : Object.keys(o)
  for (const k of keys) {
    if (k.startsWith('_') || /^\d+$/.test(k)) continue // skip provenance + numeric id keys
    out.add(prefix + k)
    const child = Array.isArray(o) ? o[0]?.[k] : o[k]
    shape(child, depth - 1, prefix + k + '.', out)
  }
  return out
}
function rawStatCount(o) {
  let n = 0
  const walk = (v) => {
    if (typeof v === 'string') {
      if (RAW_STAT.test(v)) n++
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(o)
  return n
}

const files = readdirSync(DATA).filter((f) => f.endsWith('.json'))
let structural = 0
const rows = []
for (const f of files.sort()) {
  const refPath = join(refDir, f)
  if (!existsSync(refPath)) {
    rows.push({ f, verdict: 'NEW FILE', detail: `${rowCount(JSON.parse(readFileSync(join(DATA, f), 'utf8')))} rows` })
    continue
  }
  const cur = JSON.parse(readFileSync(join(DATA, f), 'utf8'))
  const ref = JSON.parse(readFileSync(refPath, 'utf8'))
  const sameBytes = JSON.stringify(stripMeta(cur)) === JSON.stringify(stripMeta(ref))
  if (sameBytes) {
    rows.push({ f, verdict: 'identical', detail: '' })
    continue
  }
  const cShape = shape(stripMeta(cur))
  const rShape = shape(stripMeta(ref))
  const addedKeys = [...cShape].filter((k) => !rShape.has(k))
  const removedKeys = [...rShape].filter((k) => !cShape.has(k))
  const cRows = rowCount(cur)
  const rRows = rowCount(ref)
  const newRaw = rawStatCount(cur) - rawStatCount(ref)
  // STRUCTURAL = shape changed, OR rows collapsed (>10% fewer), OR raw stat-ids newly leaked.
  const collapsed = rRows > 0 && cRows < rRows * 0.9
  const isStructural = addedKeys.length || removedKeys.length || collapsed || newRaw > 0
  if (isStructural) structural++
  rows.push({
    f,
    verdict: isStructural ? '*** STRUCTURAL ***' : 'content-only',
    detail:
      `rows ${rRows}→${cRows}` +
      (addedKeys.length ? ` +keys[${addedKeys.join(',')}]` : '') +
      (removedKeys.length ? ` -keys[${removedKeys.join(',')}]` : '') +
      (collapsed ? ' ROW-COLLAPSE' : '') +
      (newRaw > 0 ? ` +${newRaw}RAW` : ''),
  })
}

console.log(`Comparing src/data against ${refDir}\n`)
for (const r of rows) console.log(`  ${r.verdict.padEnd(20)} ${r.f.padEnd(28)} ${r.detail}`)
const counts = rows.reduce(
  (m, r) => ((m[r.verdict.replace(/\*/g, '').trim()] = (m[r.verdict.replace(/\*/g, '').trim()] || 0) + 1), m),
  {},
)
console.log(`\nSummary: ${JSON.stringify(counts)}`)
console.log(
  structural
    ? `\n⚠ ${structural} file(s) with STRUCTURAL changes — inspect before accepting.`
    : `\n✅ No structural regressions — content-only diffs are safe to accept.`,
)
process.exit(structural ? 1 : 0)
