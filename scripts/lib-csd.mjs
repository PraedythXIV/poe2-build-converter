// Shared stat-description (.csd) engine — the single source of truth for turning the
// game's numeric stat ids + values into exact English text. Extracted from
// build-atlas-graph.mjs so build-atlas-masters.mjs (and any future stat consumer)
// resolve identically rather than forking the parser.
//
// The .csd DSL (UTF-16LE) is a sequence of blocks:
//   description
//   <tab> <idCount> <statId>...
//   <tab> <variantCount>
//   <tab><tab> <cond per id> "text with {0} placeholders" [handlers...]
//   <tab> lang "German"            <- repeated per language; we keep only the default block
// Conditions per value: `#` any, `N` exact, `!N` not-equal, `min|max` range with # open.
// Only the constructs the real files use are implemented; anything else returns null so
// the caller falls back to a raw "stat_id = value" line — text is never silently wrong.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** `[Tag]` -> `Tag`, `[Tag|Display Text]` -> `Display Text`. */
function stripMarkup(text) {
  return text.replace(/\[([^\]|]+)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]+)\]/g, '$1')
}

export function parseCsd(text) {
  const lines = text.split(/\r?\n/)
  const byStatId = new Map()
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim() !== 'description' && !lines[i].trim().startsWith('description ')) {
      i++
      continue
    }
    i++
    const idLine = lines[i]?.trim().match(/^(\d+)\s+(.+)$/)
    if (!idLine) continue
    const ids = idLine[2].split(/\s+/).slice(0, Number(idLine[1]))
    i++
    const variantCount = Number(lines[i]?.trim())
    if (!Number.isInteger(variantCount)) continue
    i++
    const variants = []
    for (let v = 0; v < variantCount && i < lines.length; v++, i++) {
      const m = lines[i].match(/^\s*(.*?)\s*"(.*)"\s*(.*)$/)
      if (!m) continue
      variants.push({ conds: m[1].length ? m[1].split(/\s+/) : [], text: m[2], handlers: m[3].trim() })
    }
    const entry = { ids, variants }
    for (const id of ids) {
      if (!byStatId.has(id)) byStatId.set(id, entry)
    }
    while (i < lines.length && !lines[i].trim().startsWith('description')) i++
  }
  return byStatId
}

function condMatches(cond, value) {
  if (cond === '#') return true
  if (/^-?\d+$/.test(cond)) return value === Number(cond)
  if (cond.startsWith('!')) return value !== Number(cond.slice(1))
  const range = cond.match(/^(#|-?\d+)\|(#|-?\d+)$/)
  if (!range) return false
  if (range[1] !== '#' && value < Number(range[1])) return false
  if (range[2] !== '#' && value > Number(range[2])) return false
  return true
}

/** Format one description for the given values, or null when an unsupported construct
 *  (unknown handler / no matching variant) would make the output untrustworthy. */
export function formatDescription(entry, values) {
  const variant = entry.variants.find(
    (v) => v.conds.length === values.length && v.conds.every((c, idx) => condMatches(c, values[idx])),
  )
  if (!variant) return null
  const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp
  const round2 = (v) => round(v, 2)
  const SCALERS = {
    negate: (v) => -v,
    divide_by_one_hundred: (v) => v / 100,
    divide_by_one_hundred_0dp: (v) => round(v / 100, 0),
    divide_by_one_hundred_1dp: (v) => round(v / 100, 1),
    divide_by_one_hundred_2dp: (v) => round2(v / 100),
    divide_by_one_hundred_2dp_if_required: (v) => round2(v / 100),
    divide_by_ten_0dp: (v) => round(v / 10, 0),
    divide_by_ten_1dp: (v) => round(v / 10, 1),
    divide_by_ten_1dp_if_required: (v) => round(v / 10, 1),
    milliseconds_to_seconds: (v) => round2(v / 1000),
    milliseconds_to_seconds_2dp_if_required: (v) => round2(v / 1000),
    per_minute_to_per_second: (v) => round2(v / 60),
    per_minute_to_per_second_2dp_if_required: (v) => round2(v / 60),
  }
  const adjusted = [...values]
  const tokens = variant.handlers.length ? variant.handlers.split(/\s+/) : []
  for (let t = 0; t < tokens.length; t++) {
    if (tokens[t] === 'reminderstring') break
    if (tokens[t] === 'canonical_line') continue
    const scale = SCALERS[tokens[t]]
    const idx = Number(tokens[t + 1]) - 1
    if (!scale || !Number.isInteger(idx) || idx < 0 || idx >= adjusted.length) return null
    adjusted[idx] = scale(adjusted[idx])
    t++
  }
  // Placeholders are either explicit ({0}, {1:+d}) or bare ({}, {:+d}); a bare one consumes
  // the next positional value (GGG's shorthand for single-value descriptions).
  let auto = 0
  const text = variant.text.replace(/\{(\d*)(?::([^}]+))?\}/g, (_, nRaw, fmt) => {
    const v = adjusted[nRaw === '' ? auto++ : Number(nRaw)]
    if (v === undefined) return '?'
    if (fmt === '+d') return v > 0 ? `+${v}` : String(v)
    return String(v)
  })
  if (text.includes('{')) return null
  return stripMarkup(text).replace(/\\n/g, '\n')
}

/** Merge the .csd description sources; first file wins per stat id (more-specific wording first). */
export function loadDescriptions(filesDir, csdNames) {
  const descriptions = new Map()
  for (const name of csdNames) {
    const path = join(filesDir, name)
    if (!existsSync(path)) {
      console.warn(`WARN: ${name} missing — its stat ids will fall back to raw "stat_id = value" lines.`)
      continue
    }
    for (const [id, entry] of parseCsd(
      readFileSync(path)
        .toString('utf16le')
        .replace(/^\uFEFF/, ''),
    )) {
      if (!descriptions.has(id)) descriptions.set(id, entry)
    }
  }
  return descriptions
}

/**
 * Resolve a row's Stats (stat-row indices) + positionally-paired values to exact text lines.
 * A single description may cover several of the row's stat ids at once ({0},{1},...).
 * Returns { stats: string[], resolved, fallback } — fallback lines are raw "stat_id = value".
 */
export function resolveStats(statRowIdxs, values, descriptions, statRows) {
  const statIds = (statRowIdxs ?? []).map((idx) => statRows[idx]?.Id ?? `stat_row_${idx}`)
  const stats = []
  const consumed = new Set()
  let resolved = 0
  let fallback = 0
  for (let s = 0; s < statIds.length; s++) {
    if (consumed.has(s)) continue
    const entry = descriptions.get(statIds[s])
    if (entry) {
      const slot = (id) => statIds.findIndex((sid, j) => sid === id && !consumed.has(j))
      const slots = entry.ids.map(slot)
      const text = formatDescription(
        entry,
        slots.map((j) => (j === -1 ? 0 : (values[j] ?? 0))),
      )
      if (text !== null) {
        for (const j of slots) if (j !== -1) consumed.add(j)
        stats.push(text)
        resolved++
        continue
      }
    }
    consumed.add(s)
    stats.push(`${statIds[s]} = ${values[s] ?? 0}`)
    fallback++
  }
  return { stats, resolved, fallback }
}
