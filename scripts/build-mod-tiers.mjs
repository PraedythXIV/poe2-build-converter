// Offline builder: PoE2 equipment affix tiers -> src/data/modTiers.json
//
//   node scripts/build-mod-tiers.mjs [--no-coverage]
//
// Inputs (_workbench/data-extract/ is gitignored — re-run `node scripts/extract-tables.mjs` if missing):
//   _workbench/data-extract/tables/Mods.json, Stats.json   (Stats is in the extractor's optional pass)
//   _workbench/data-extract/files/Data@StatDescriptions@stat_descriptions.csd  (UTF-16LE, PoE1-style DSL)
//
// Output: src/data/modTiers.json (shape v2, per-domain) —
//   { "_provenance": {...}, "<normalized pattern>": { g?: Tier[], f?: Tier[], j?: Tier[] } }
//   pattern = the affix's translated English line(s), numbers replaced by "#", lowercased
//             (multi-line hybrid mods join their lines with " / ")
//   g/f/j   = the ladder per item domain: g = gear (Mods.Domain 1), f = flasks & charms (2),
//             j = jewels (11). Cross-domain pattern collisions are NOT resolved away — each
//             domain keeps its own ladder so a flask line is never tier-matched against gear.
//   Tier    = { t, min, max, ilvl, more? } — array sorted weakest -> strongest (t = n .. 1)
//
// Facts this build relies on (verified against the patch 4.5.2.1.2 export, 2026-06-12):
// - Mods.Domain (enum int): 1 = equipment, 2 = flasks & charms, 11 = jewels. Everything else
//   (monster/area/map/heist/...) is not carriable by a PoB2 item and is pruned.
// - Mods.GenerationType: 1 = prefix, 2 = suffix. 3 (unique/implicit rolls) and 5 (corruption)
//   are pruned — they are not tiered affixes.
// - Interval columns (StatNValue) export as [min, max]; Stat1..6 are bare row indices into Stats.
// - TIER NUMBERING: T1 = strongest (highest spawn Level, then highest roll). PoE2 originally
//   shipped ascending tiers in EA 0.1.x, but patch 0.2.0 aligned the in-game display with the
//   PoE1 community convention (T1 = best), which the in-game display and the trade site now use.
//   Cite: https://www.mmojugg.com/news/understanding-item-tiers-in-poe2.html ("Since Patch
//   0.2.0 ... 'Tier 1' always represents the highest/best possible roll").

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, kb, readExtractJson, runMain } from './lib.mjs'

const EXTRACT = join(ROOT, '_workbench', 'data-extract')
const CSD = join(EXTRACT, 'files', 'Data@StatDescriptions@stat_descriptions.csd')
const OUT = join(ROOT, 'src', 'data', 'modTiers.json')

// Domains a PoB2 item can carry; each gets its own ladder key in the output (no priority).
const KEEP_DOMAINS = [1, 2, 11]
const DOMAIN_KEY = { 1: 'g', 2: 'f', 11: 'j' } // gear / flasks & charms / jewels
const GEN_PREFIX = 1
const GEN_SUFFIX = 2

// ── csd value-transform handlers ──────────────────────────────────────────────
// Raw stat values -> displayed values. Only the transforms that appear on equipment stats are
// implemented; a matched variant using anything else fails the family loudly (counted + logged)
// rather than emitting wrong ranges. "_Ndp"/"_if_required" suffixes only affect rounding.
const VALUE_TRANSFORMS = {
  negate: (v) => -v,
  double: (v) => v * 2,
  negate_and_double: (v) => v * -2,
  add_one: (v) => v + 1,
  subtract_one: (v) => v - 1,
  plus_two_hundred: (v) => v + 200,
  times_twenty: (v) => v * 20,
  divide_by_two_0dp: (v) => v / 2,
  divide_by_five: (v) => v / 5,
  divide_by_ten: (v) => v / 10,
  divide_by_fifty: (v) => v / 50,
  divide_by_one_hundred: (v) => v / 100,
  divide_by_one_hundred_and_negate: (v) => -v / 100,
  per_minute_to_per_second: (v) => v / 60,
  milliseconds_to_seconds: (v) => v / 1000,
  deciseconds_to_seconds: (v) => v / 10,
}
/** Resolve a handler token to a transform fn, normalizing rounding-suffix variants. */
function transformFor(name) {
  if (VALUE_TRANSFORMS[name]) return VALUE_TRANSFORMS[name]
  const base = name.replace(/_(\d)dp(_if_required)?$/, '').replace(/_if_required$/, '')
  return VALUE_TRANSFORMS[base]
}
// Display-only markers (no value change) that may trail a variant — safe to ignore.
const IGNORED_MARKERS = new Set(['canonical_line', 'canonical_stat'])
// Markers taking one non-numeric argument.
const ARG_MARKERS = new Set(['reminderstring'])

// ── normalization (MUST stay in lockstep with normalizeModLine in src/items/tiers.ts) ─────────
// The coverage script + tests/itemTiers.test.ts assert every emitted key is a fixed point of the
// runtime normalizer, so any drift between the two copies fails the build checks loudly.
function canonicalize(s) {
  return s
    .replace(/[+-]?\d+(?:\.\d+)?/g, '#') // numbers (signed, decimal) -> #
    .replace(/[+-]#/g, '#') // a sign left in front of a substituted placeholder
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// ── csd subset parser (English blocks only) ───────────────────────────────────
/**
 * Parse stat_descriptions.csd into description entries:
 *   { ids: string[], variants: [{ conds: string[], text: string, handlers: Map<descIdx, fn[]>,
 *                                 unsupported: string[] }] }
 * Only the English block (the unlabelled one before the first `lang`) is read; `no_description`
 * ids are collected so hidden stats can be skipped without failing their family.
 */
function parseCsd(path, log) {
  let txt = readFileSync(path).toString('utf16le')
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1)
  const lines = txt.split(/\r?\n/)

  const entries = []
  const noDescription = new Set()
  let badVariants = 0

  for (let i = 0; i < lines.length; i++) {
    const top = lines[i].trim()
    if (top.startsWith('no_description ')) {
      for (const id of top.split(/\s+/).slice(1)) noDescription.add(id)
      continue
    }
    if (top !== 'description') continue

    // header: "<k> <id1> ... <idk>"
    const hdr = (lines[++i] ?? '').trim().split(/\s+/)
    const k = Number(hdr[0])
    const ids = hdr.slice(1)
    if (!Number.isInteger(k) || ids.length !== k) {
      badVariants++
      continue
    }
    // English variant count + variant lines (lang blocks follow and are skipped by the outer scan)
    const n = Number((lines[++i] ?? '').trim())
    if (!Number.isInteger(n) || n < 0) {
      badVariants++
      continue
    }
    const variants = []
    for (let v = 0; v < n; v++) {
      const parsed = parseVariant((lines[++i] ?? '').trim(), k)
      if (parsed) variants.push(parsed)
      else badVariants++
    }
    if (variants.length) entries.push({ ids, variants })
  }

  // index: stat id -> entries containing it (greedy subset matching uses this)
  const byId = new Map()
  for (const e of entries) {
    for (const id of e.ids) {
      if (!byId.has(id)) byId.set(id, [])
      byId.get(id).push(e)
    }
  }
  log(
    `csd: ${entries.length} descriptions parsed, ${noDescription.size} no_description ids, ${badVariants} unparseable variant lines`,
  )
  return { byId, noDescription }
}

/** One variant line: `<cond x k> "text" [handlers...]`. Returns null if it doesn't scan. */
function parseVariant(line, k) {
  const m = line.match(/^(.*?)"(.*)"(.*)$/)
  if (!m) return null
  const conds = m[1].trim().split(/\s+/).filter(Boolean)
  if (conds.length !== k) return null // e.g. table_only / malformed rows
  const handlers = new Map() // descIdx (0-based) -> transform fns, in order
  const unsupported = []
  const toks = m[3].trim().split(/\s+/).filter(Boolean)
  for (let j = 0; j < toks.length; j++) {
    const name = toks[j]
    if (IGNORED_MARKERS.has(name)) continue
    if (ARG_MARKERS.has(name)) {
      j++ // consume the key argument
      continue
    }
    const arg = Number(toks[j + 1])
    const fn = transformFor(name)
    if (fn && Number.isInteger(arg) && arg >= 1) {
      const idx = arg - 1
      if (!handlers.has(idx)) handlers.set(idx, [])
      handlers.get(idx).push(fn)
      j++
    } else {
      unsupported.push(name)
      if (Number.isFinite(arg)) j++
    }
  }
  return { conds, text: m[2], handlers, unsupported }
}

/** `cond` forms: `#` any, `n` exact, `!n`, `a|b` range with `#` as an open end. */
function condMatches(cond, v) {
  if (cond === '#') return true
  if (cond.startsWith('!')) return v !== Number(cond.slice(1))
  const parts = cond.split('|')
  if (parts.length === 2) {
    const lo = parts[0] === '#' ? -Infinity : Number(parts[0])
    const hi = parts[1] === '#' ? Infinity : Number(parts[1])
    return v >= lo && v <= hi
  }
  return v === Number(cond)
}

/** `[Keyword]` -> `Keyword`, `[Keyword|display]` -> `display`. */
function stripMarkup(text) {
  return text.replace(/\[([^\]|]+)\|([^\]]*)\]/g, '$2').replace(/\[([^\]]+)\]/g, '$1')
}

/** Placeholder occurrences in display order -> 0-based desc-stat index ({} counts sequentially). */
function placeholderIndices(text) {
  const out = []
  let seq = 0
  for (const m of text.matchAll(/\{(\d*)(?::[^}]*)?\}/g)) {
    out.push(m[1] === '' ? seq : Number(m[1]))
    seq++
  }
  return out
}

// ── translate a mod family's stat set into English pattern lines ──────────────
/**
 * Greedy cover: repeatedly translate the first untranslated stat with the largest description
 * whose id set fits inside the family's remaining stats (this is how multi-stat lines like
 * "Adds # to # Physical Damage" claim both of their ids). Returns
 *   { lines: [{ pattern, slots: [{ statPos, transforms }] }] }  or  { fail: reason }.
 * `reprVals` (one representative raw value per stat) picks the right variant (e.g. the negated
 * "reduced" wording for negative-roll families).
 */
function translateStats(statIds, reprVals, csd) {
  const remaining = new Set(statIds.map((_, i) => i))
  const lines = []
  while (remaining.size) {
    const pos = Math.min(...remaining)
    const id = statIds[pos]
    if (!csd.byId.has(id)) {
      if (csd.noDescription.has(id)) {
        remaining.delete(pos) // deliberately hidden stat — not displayed on items
        continue
      }
      return { fail: `no description for stat "${id}"` }
    }
    // Candidates: any description containing this id. GGG pairs some stats with "context" ids
    // the mod does not carry (e.g. local_physical_damage_+% + local_weapon_no_physical_damage);
    // absent ids evaluate as value 0. Prefer the candidate covering the most of the mod's own
    // stats, then the one with the fewest absent context ids.
    const remIds = new Map([...remaining].map((p) => [statIds[p], p]))
    const fit = csd.byId
      .get(id)
      .map((e) => {
        const matched = e.ids.filter((eid) => remIds.has(eid)).length
        return { e, matched, missing: e.ids.length - matched }
      })
      .sort((a, b) => b.matched - a.matched || a.missing - b.missing)[0].e

    // statPos = family stat position, or null for an absent context id (value 0, range [0,0])
    const statPositions = fit.ids.map((eid) => (remIds.has(eid) ? remIds.get(eid) : null))
    const variant = fit.variants.find((v) =>
      v.conds.every((c, j) => condMatches(c, statPositions[j] == null ? 0 : reprVals[statPositions[j]])),
    )
    if (!variant) return { fail: `no variant matches values for stat "${id}"` }
    if (variant.unsupported.length) {
      return { fail: `unsupported handler(s) ${variant.unsupported.join(',')} on stat "${id}"` }
    }

    const slots = placeholderIndices(variant.text).map((descIdx) => ({
      statPos: statPositions[descIdx],
      transforms: variant.handlers.get(descIdx) ?? [],
    }))
    const pattern = canonicalize(stripMarkup(variant.text).replace(/\{(\d*)(?::[^}]*)?\}/g, '#'))
    lines.push({ pattern, slots })
    for (const eid of fit.ids) {
      if (remIds.has(eid)) remaining.delete(remIds.get(eid))
    }
  }
  if (!lines.length) return { fail: 'all stats hidden' }
  return { lines }
}

const round2 = (v) => Math.round(v * 100) / 100

/** Apply a slot's transform chain to a raw [lo, hi], returning the displayed [min, max]. */
function displayRange(range, transforms) {
  let lo = range[0]
  let hi = range[1]
  for (const fn of transforms) {
    lo = fn(lo)
    hi = fn(hi)
  }
  return lo <= hi ? [round2(lo), round2(hi)] : [round2(hi), round2(lo)]
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  for (const p of [join(EXTRACT, 'tables', 'Mods.json'), join(EXTRACT, 'tables', 'Stats.json'), CSD]) {
    if (!existsSync(p)) throw new Error(`${p} missing — run \`node scripts/extract-tables.mjs\` first`)
  }
  const logLines = []
  const log = (s) => {
    logLines.push(s)
    console.log(s)
  }

  const mods = readExtractJson('tables/Mods.json')
  const stats = readExtractJson('tables/Stats.json')
  const meta = existsSync(join(EXTRACT, 'extract-meta.json')) ? readExtractJson('extract-meta.json') : {}
  const csd = parseCsd(CSD, log)

  // ── filter to spawnable equipment affixes ──
  const pruned = { domain: 0, generationType: 0, zeroWeight: 0, essenceOnly: 0 }
  const kept = []
  for (const m of mods) {
    if (!KEEP_DOMAINS.includes(m.Domain)) {
      pruned.domain++
      continue
    }
    if (m.GenerationType !== GEN_PREFIX && m.GenerationType !== GEN_SUFFIX) {
      pruned.generationType++
      continue
    }
    if (m.IsEssenceOnlyModifier) {
      pruned.essenceOnly++
      continue
    }
    if (!(m.SpawnWeight_Values ?? []).some((w) => w > 0)) {
      pruned.zeroWeight++
      continue
    }
    kept.push(m)
  }
  log(`mods: ${mods.length} total -> ${kept.length} spawnable prefix/suffix rows in domains ${KEEP_DOMAINS.join('/')}`)
  log(
    `  pruned: ${pruned.domain} other-domain, ${pruned.generationType} non-affix generation (unique/implicit/corruption/...), ${pruned.zeroWeight} zero spawn weight, ${pruned.essenceOnly} essence-only`,
  )

  // ── group into tier families ──
  // Same generation type + domain + ModType + stat-id set + mod-Id stem. The stem split keeps
  // parallel ladders apart that share everything else: GGG scales some affixes per item class
  // with distinctly-named row sets (ManaRegeneration1..6 vs ManaRegenerationTwoHand1..6) and
  // ships influence variants under the same ModType (MarksmanInfluenceCriticalHitChance1..3).
  const statId = (rowIdx) => stats[rowIdx]?.Id ?? `?stat${rowIdx}`
  const families = new Map()
  for (const m of kept) {
    const idxs = [m.Stat1, m.Stat2, m.Stat3, m.Stat4, m.Stat5, m.Stat6].filter((s) => s != null)
    if (!idxs.length) continue
    const ids = idxs.map(statId)
    const stem = m.Id.replace(/[_\d]+$/, '')
    const key = `${m.GenerationType}|${m.Domain}|${m.ModType}|${stem}|${[...ids].sort().join(',')}`
    if (!families.has(key)) families.set(key, { domain: m.Domain, stem, statIds: ids, rows: [] })
    families.get(key).rows.push({
      level: m.Level,
      ranges: [m.Stat1Value, m.Stat2Value, m.Stat3Value, m.Stat4Value, m.Stat5Value, m.Stat6Value].slice(
        0,
        idxs.length,
      ),
    })
  }
  log(`families: ${families.size} (ModType + stat set + prefix/suffix + domain + Id stem)`)

  // ── translate ──
  const failures = new Map() // reason -> count
  const fullKeys = [] // family-level candidates (single-line pattern, or joined hybrid key)
  const componentKeys = [] // hybrid per-line candidates (only fill patterns nothing else claims)
  for (const fam of families.values()) {
    // representative raw value per stat (from the strongest row) drives variant choice
    const top = fam.rows.reduce((a, b) => (b.level > a.level ? b : a))
    const reprVals = fam.statIds.map((_, i) => {
      const [lo, hi] = top.ranges[i] ?? [0, 0]
      return Math.abs(hi) >= Math.abs(lo) ? hi : lo
    })
    const tr = translateStats(fam.statIds, reprVals, csd)
    if (tr.fail) {
      failures.set(tr.fail, (failures.get(tr.fail) ?? 0) + 1)
      continue
    }

    // weakest first; t = n .. 1 so T1 = strongest (highest level, then highest roll)
    const rows = [...fam.rows].sort((a, b) => a.level - b.level || (a.ranges[0]?.[0] ?? 0) - (b.ranges[0]?.[0] ?? 0))
    const n = rows.length
    const tiersFor = (slots) =>
      rows.map((row, i) => {
        const ranges = slots.map((s) =>
          displayRange(s.statPos == null ? [0, 0] : (row.ranges[s.statPos] ?? [0, 0]), s.transforms),
        )
        const first = ranges[0] ?? [0, 0]
        const entry = { t: n - i, min: first[0], max: first[1], ilvl: row.level }
        if (ranges.length > 1) entry.more = ranges.slice(1)
        return entry
      })
    const candidate = (pattern, slots) => {
      const tiers = tiersFor(slots)
      return { pattern, tiers, domain: fam.domain, stem: fam.stem, topMax: Math.max(...tiers.map((e) => e.max)) }
    }

    fullKeys.push(
      candidate(
        tr.lines.map((l) => l.pattern).join(' / '),
        tr.lines.flatMap((l) => l.slots),
      ),
    )
    if (tr.lines.length > 1) {
      // a hybrid's individual lines, with that line's own roll ranges — lookupTier sees one
      // PoB line at a time, so these make hybrid lines matchable when unambiguous
      for (const line of tr.lines) componentKeys.push(candidate(line.pattern, line.slots))
    }
  }

  // ── emit with collision resolution ──
  // CROSS-DOMAIN collisions (item vs jewel "physical damage", gear vs flask wording) are NOT
  // resolved: each domain keeps its own ladder under its own key (g/f/j), and the runtime looks
  // up only the querying item's domain — a flask line can never tier-match a gear ladder.
  // WITHIN one domain, same-pattern collisions are genuinely the same item class wording (local
  // weapon vs glove "attack speed", base vs TwoHand mana regen): keep the longer ladder, then
  // the LOWER top roll (the base ladder), then stem for determinism. Class-scaled variants
  // (e.g. ManaRegenerationTwoHand rolls higher than the base ladder) therefore stay out of the
  // table; their out-of-range values come back `approx` at runtime and the UI renders the
  // unknown state instead of a chip — no tier is shown rather than a wrong or guessed one.
  const rank = (c) => [-c.tiers.length, c.topMax]
  const better = (a, b) => {
    const [ra, rb] = [rank(a), rank(b)]
    return rb[0] - ra[0] || rb[1] - ra[1] || a.stem.localeCompare(b.stem)
  }
  const out = {} // pattern -> { g?: candidate, f?: candidate, j?: candidate }
  let collided = 0
  for (const cand of fullKeys) {
    const slot = (out[cand.pattern] ??= {})
    const dk = DOMAIN_KEY[cand.domain]
    const prev = slot[dk]
    if (!prev) {
      slot[dk] = cand
      continue
    }
    collided++
    if (better(prev, cand) < 0) slot[dk] = cand
  }
  let componentsAdded = 0
  for (const cand of componentKeys) {
    const slot = (out[cand.pattern] ??= {})
    const dk = DOMAIN_KEY[cand.domain]
    const prev = slot[dk]
    if (prev && prev.component === undefined) continue // a real family owns this pattern+domain
    if (!prev) componentsAdded++
    if (!prev || better(prev, cand) < 0) slot[dk] = { ...cand, component: true }
  }
  const ladders = Object.values(out).reduce((a, s) => a + Object.keys(s).length, 0)
  const failTotal = [...failures.values()].reduce((a, b) => a + b, 0)
  log(
    `translated: ${Object.keys(out).length} patterns / ${ladders} per-domain ladders (${collided} within-domain collisions, ${componentsAdded} hybrid component lines added, ${failTotal} families untranslatable)`,
  )
  for (const [reason, count] of [...failures].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    log(`    ${count}x ${reason}`)
  }

  // ── write, _provenance first ──
  const json = {
    _provenance: {
      source: 'GGG PoE2 game data via pathofexile-dat (Mods/Stats tables + stat_descriptions.csd)',
      patch: meta.poe2Patch ?? 'unknown',
      captured: new Date().toISOString().slice(0, 10),
      shape: 2, // v2: pattern -> per-domain ladders { g?, f?, j? }; v1 was pattern -> Tier[]
      domains: { g: 'gear (Mods.Domain 1)', f: 'flasks & charms (2)', j: 'jewels (11)' },
      tierConvention:
        'T1 = strongest (PoE2 in-game convention since patch 0.2.0; entries sorted weakest first, t = count..1)',
      counts: {
        patterns: Object.keys(out).length,
        ladders,
        families: families.size,
        untranslatable: failTotal,
        rows: kept.length,
        withinDomainCollisions: collided,
        hybridComponents: componentsAdded,
      },
      note: 'Not affiliated with or endorsed by Grinding Gear Games.',
    },
  }
  for (const key of Object.keys(out).sort()) {
    const entry = {}
    for (const dk of ['g', 'f', 'j']) {
      if (out[key][dk]) entry[dk] = out[key][dk].tiers
    }
    json[key] = entry
  }
  const body = JSON.stringify(json)
  writeFileSync(OUT, body)
  log(`src/data/modTiers.json  ${kb(Buffer.byteLength(body))} (${Object.keys(out).length} patterns)`)
  if (Buffer.byteLength(body) > 400 * 1024) log('WARN: output exceeds the 400 KB budget')

  // ── fixture coverage report (parses tests/fixtures via src/convert + src/items/tiers) ──
  if (!process.argv.includes('--no-coverage')) {
    console.log('\nFixture coverage (vite-node):')
    // relative script path: shell:true (needed for npx on Windows) concatenates args unescaped,
    // and the absolute repo path contains spaces
    const res = spawnSync('npx', ['vite-node', 'scripts/report-tier-coverage.mts'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (res.status !== 0) console.warn('WARN: coverage report failed (build output is still written)')
  }
}

runMain('build-mod-tiers', main)
