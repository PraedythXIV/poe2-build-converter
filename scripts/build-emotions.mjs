// Distilled / Liquid Emotion reference data — the three ways a Delirium emotion is spent:
//   • AMULET (anoint)   3 emotions, in order  -> a tree Notable          (BlightCrafting* tables)
//   • JEWEL  (craft)    1 emotion             -> a jewel prefix/suffix    (LiquidEmotionOutcomes)
//   • WAYSTONE (instill)1 emotion             -> Deliriousness% + map mod (BlightCraftingItems.EnchantedMod)
//
//   node scripts/build-emotions.mjs [--patch 4.5.3.1.4] [--refresh]   (npm run data:emotions)
//
// Self-contained: unlike the other build scripts (which read the pinned _workbench/data-extract/tables),
// the emotion tables only exist from patch 0.5 onward, so this script extracts the handful it
// needs at the LIVE patch into _workbench/data-extract/.work/live-*.json (cached; --refresh re-pulls) and
// resolves every id to exact English text via the .csd engine. The pinned core extraction is
// left untouched, so the verified atlas/character row-index joins are unaffected. A sidecar
// live-emotions.meta.json records the patch the cached tables were EXTRACTED at, so _provenance is
// stamped honestly on cached runs (no probe); a cache without the sidecar is re-extracted in full
// (extraction is all-or-nothing so the whole set is from ONE patch).
//
// Output: src/data/emotions.json — { _provenance, emotions[13], anoints[], notables{}, constants }
//   emotions:  the 13 anoint/waystone emotions, each with its waystone effect + jewel outcomes
//              (normal jewel + Time-Lost jewel, the latter from its "Ancient" counterpart row)
//   anoints:   [{ c:[e1,e2,e3], n:"Notable" }]  ordered 3-emotion recipe -> notable (order matters)
//   notables:  { "Notable": ["stat line", ...] }  the anointable notables' wording (deduped)
//   constants: the Deliriousness math, for the waystone explainer

// jscpd:ignore-start — ESM import boilerplate: the two self-contained live-extractor scripts
// share the same toolchain imports by necessity; the shared code lives in lib.mjs / lib-csd.mjs
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SCHEMA_URL, SCHEMA_VERSION } from 'pathofexile-dat-schema'
import { ROOT, argValue, assertFloor, getJson, kb, mustResolve, runMain } from './lib.mjs'
import { probePatchServer } from './patch-version.mjs'
// jscpd:ignore-end
import { loadDescriptions, formatDescription } from './lib-csd.mjs'

const EXTRACT = join(ROOT, '_workbench', 'data-extract')
const WORK = join(EXTRACT, '.work')
const FILES = join(EXTRACT, 'files')
const CLI_BIN = join(ROOT, 'node_modules', 'pathofexile-dat', 'dist', 'cli', 'run.js')
const OUT = join(ROOT, 'src', 'data', 'emotions.json')

const UNSUPPORTED_COLUMN_TYPES = new Set(['u8', 'u64', 'i8', 'i64', 'f64'])
const TABLES = [
  'LiquidEmotionOutcomes',
  'BlightCraftingItems',
  'BlightCraftingRecipes',
  'BlightCraftingResults',
  'Mods',
  'Stats',
  'BaseItemTypes',
  'PassiveSkills',
  'AfflictionConstants',
]
// PassiveSkills stat values live in these columns, positionally paired with the `Stats` array.
const PASSIVE_VALUE_COLS = [
  'Stat1Value',
  'Stat2Value',
  'Stat3Value',
  'Stat4Value',
  'Stat5Value',
  'StatValue6',
  'StatValue7',
]
const JEWEL_COLOURS = [
  ['ruby', 'RubyPrefix', 'RubySuffix'],
  ['sapphire', 'SapphirePrefix', 'SapphireSuffix'],
  ['emerald', 'EmeraldPrefix', 'EmeraldSuffix'],
  ['diamond', 'DiamondPrefix', 'DiamondSuffix'],
]

// ── extraction (cached) ─────────────────────────────────────────────────────────────────────
async function ensureTables(patch) {
  // Always extract the FULL table set in one run: topping up only the missing tables could mix
  // rows from two different patches in the same cache, making the single _provenance patch stamp
  // dishonest. Callers only invoke this when the cache is stale/incomplete or --refresh is passed.
  const need = TABLES
  if (!existsSync(CLI_BIN)) throw new Error('pathofexile-dat is not installed — run `npm install` first')
  console.log(`Fetching dat-schema (latest release)...`)
  const schema = await getJson(SCHEMA_URL)
  if (schema.version !== SCHEMA_VERSION) {
    throw new Error(
      `dat-schema release is v${schema.version} but pathofexile-dat expects v${SCHEMA_VERSION} — update the pathofexile-dat devDependency`,
    )
  }
  const tableConfig = (name) => {
    const cands = schema.tables.filter((t) => t.name === name)
    const t = cands.find((x) => x.validFor & 2) ?? cands[0]
    if (!t) throw new Error(`table "${name}" missing from schema`)
    return {
      name,
      columns: t.columns.filter((c) => c.name && !UNSUPPORTED_COLUMN_TYPES.has(c.type)).map((c) => c.name),
    }
  }
  mkdirSync(WORK, { recursive: true })
  console.log(`Extracting ${need.length} table(s) at patch ${patch}: ${need.join(', ')}`)
  // One CLI run for all needed tables (the 113 MB bundle index is cached in .work/.cache).
  writeFileSync(
    join(WORK, 'config.json'),
    JSON.stringify({ patch, translations: ['English'], files: [], tables: need.map(tableConfig) }, null, 2),
  )
  const res = spawnSync(process.execPath, [CLI_BIN], { cwd: WORK, stdio: 'inherit' })
  if (res.status !== 0) throw new Error('pathofexile-dat extraction failed')
  const td = join(WORK, 'tables', 'English')
  if (!existsSync(td)) throw new Error('extraction produced no tables — check the patch version')
  for (const f of readdirSync(td)) cpSync(join(td, f), join(WORK, `live-${f}`))
}

// ── stat-text resolution ────────────────────────────────────────────────────────────────────
const round2 = (v) => Math.round(v * 100) / 100
/** Merge two formatted strings that differ only in numbers into "(lo-hi)" ranges. */
function mergeRange(lo, hi) {
  if (lo === hi) return lo
  const ln = lo.match(/-?\d+(?:\.\d+)?/g) ?? []
  const hn = hi.match(/-?\d+(?:\.\d+)?/g) ?? []
  let k = 0
  return hi.replace(/-?\d+(?:\.\d+)?/g, (n) => {
    const a = ln[k],
      b = hn[k]
    k++
    return a != null && a !== b ? `(${a}-${b})` : n
  })
}
const clean = (s) => s.replace(/\s*\n\s*/g, ' ').trim()
// A line the .csd engine could not turn into player-facing text: "<snake_case_id> = <num>".
// These are internal/hidden stats (minimap flags, jewel radius bookkeeping) with no in-game
// wording, so we drop them rather than ship a raw id (never fabricate substitute text).
const isRawStat = (s) => /^[a-z][\w+%]* = -?\d/.test(s.trim())

/** The shared .csd matching walk: for each stat id (greedily consuming multi-id descriptions in
 *  the description's own id order), push `onMatch(entry, order)`'s text when it resolves, else the
 *  raw `onRaw(i)` line. One home for the loop resolveMod and resolveNotable both ran verbatim. */
function matchDescriptions(ids, desc, onMatch, onRaw) {
  const out = []
  const consumed = new Set()
  for (let i = 0; i < ids.length; i++) {
    if (consumed.has(i)) continue
    const e = desc.get(ids[i])
    if (e) {
      const order = e.ids.map((id) => ids.findIndex((sid, j) => sid === id && !consumed.has(j)))
      const t = onMatch(e, order)
      if (t != null) {
        for (const j of order) if (j !== -1) consumed.add(j)
        out.push(t)
        continue
      }
    }
    consumed.add(i)
    out.push(onRaw(i))
  }
  return out
}

/** Resolve a Mods row -> { name, text } with lo-hi roll ranges, or null for a null id. */
function resolveMod(idx, mods, stats, desc) {
  if (idx == null) return null
  const m = mods[idx]
  if (!m) return { name: '', text: `?mod#${idx}` }
  const slots = [
    [m.Stat1, m.Stat1Value],
    [m.Stat2, m.Stat2Value],
    [m.Stat3, m.Stat3Value],
    [m.Stat4, m.Stat4Value],
    [m.Stat5, m.Stat5Value],
    [m.Stat6, m.Stat6Value],
  ].filter(([s]) => s != null)
  const ids = slots.map(([s]) => stats[s]?.Id ?? `?stat${s}`)
  const los = slots.map(([, v]) => v?.[0] ?? 0)
  const his = slots.map(([, v]) => v?.[1] ?? 0)
  const out = matchDescriptions(
    ids,
    desc,
    (e, order) => {
      const pick = (arr) => order.map((j) => (j === -1 ? 0 : (arr[j] ?? 0)))
      const tLo = formatDescription(e, pick(los))
      const tHi = formatDescription(e, pick(his))
      return tLo != null && tHi != null ? mergeRange(tLo, tHi) : null
    },
    (i) => `${ids[i]} = ${round2(los[i])}..${round2(his[i])}`,
  )
  const lines = out.filter((l) => !isRawStat(l))
  if (!lines.length) return null // nothing player-facing resolved
  return { name: m.Name || '', text: clean(lines.join(', ')) }
}

/** Resolve a PassiveSkills notable -> array of exact stat lines. */
function resolveNotable(row, stats, desc) {
  const ids = (row.Stats ?? []).map((s) => stats[s]?.Id ?? `?stat${s}`)
  const vals = PASSIVE_VALUE_COLS.map((k) => row[k] ?? 0)
  const out = matchDescriptions(
    ids,
    desc,
    (e, order) => {
      const t = formatDescription(
        e,
        order.map((j) => (j === -1 ? 0 : (vals[j] ?? 0))),
      )
      return t != null ? clean(t) : null
    },
    (i) => `${ids[i]} = ${vals[i] ?? 0}`,
  )
  return out.filter((l) => !isRawStat(l))
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const metaPath = join(WORK, 'live-emotions.meta.json')
  const explicitPatch = argValue('--patch')
  // Reuse the cache only when the full table set is present AND its extraction patch is on record
  // (the sidecar) and not contradicted by an explicit --patch — otherwise re-extract everything.
  const allCached = TABLES.every((t) => existsSync(join(WORK, `live-${t}.json`)))
  const cachedMeta =
    !process.argv.includes('--refresh') && allCached && existsSync(metaPath)
      ? JSON.parse(readFileSync(metaPath, 'utf8'))
      : null
  let patch
  if (cachedMeta && (!explicitPatch || explicitPatch === cachedMeta.patch)) {
    patch = cachedMeta.patch // the patch the cached rows were EXTRACTED at (honest provenance, no probe)
    console.log(`Using cached live tables (patch ${patch}) — pass --refresh to re-extract.`)
  } else {
    patch = explicitPatch
    if (!patch) {
      console.log('Probing live PoE2 patch version...')
      patch = (await probePatchServer()).patch
    }
    await ensureTables(patch)
    writeFileSync(metaPath, JSON.stringify({ patch, extractedAt: new Date().toISOString() }))
  }

  const L = (n) => JSON.parse(readFileSync(join(WORK, `live-${n}.json`), 'utf8'))
  const lo = L('LiquidEmotionOutcomes')
  const items = L('BlightCraftingItems')
  const recipes = L('BlightCraftingRecipes')
  const results = L('BlightCraftingResults')
  const mods = L('Mods')
  const stats = L('Stats')
  const bit = L('BaseItemTypes')
  const ps = L('PassiveSkills')
  const consts = L('AfflictionConstants')
  const desc = loadDescriptions(FILES, [
    'Data@StatDescriptions@passive_skill_stat_descriptions.csd',
    'Data@StatDescriptions@stat_descriptions.csd',
    'Data@StatDescriptions@advanced_mod_stat_descriptions.csd',
    'Data@StatDescriptions@atlas_stat_descriptions.csd', // waystone map mods (pack size, rarity, ...)
  ])

  // LiquidEmotionOutcomes row keyed by the emotion's metadata Id (so we can pair an emotion
  // with its "Ancient" Time-Lost counterpart).
  const loByBaseId = new Map()
  for (const row of lo) {
    const id = bit[row.BaseItemType]?.Id
    if (id) loByBaseId.set(id, row)
  }
  const ancientId = (id) =>
    id.includes('Endgame')
      ? id.replace('EndgameDistilledEmotion', 'EndgameDistilledEmotionTimeLost')
      : id.replace('DistilledEmotion', 'DistilledEmotionTimeLost')
  const rarityOf = (name) =>
    /^Potent/.test(name)
      ? 'Potent'
      : /^Concentrated/.test(name)
        ? 'Concentrated'
        : /^Diluted/.test(name)
          ? 'Diluted'
          : 'Liquid'

  const jewelOutcomes = (row) => {
    if (!row) return null
    const out = {}
    for (const [colour, pk, sk] of JEWEL_COLOURS) {
      const p = resolveMod(row[pk], mods, stats, desc)
      const s = resolveMod(row[sk], mods, stats, desc)
      if (p || s) out[colour] = { p, s }
    }
    return out
  }

  // ── the 13 anoint/waystone emotions ──
  const emotions = items.map((it) => {
    const base = bit[it.BaseItemType]
    if (!base) throw new Error(`BlightCraftingItem ${it._index} references unknown base ${it.BaseItemType}`)
    const fullName = base.Name
    const normalRow = loByBaseId.get(base.Id) ?? null
    const tlRow = loByBaseId.get(ancientId(base.Id)) ?? null

    // waystone: EnchantedMod is the InstilledMapDelirium mod (Deliriousness% + a map bonus).
    const ench = resolveMod(it.EnchantedMod, mods, stats, desc)
    let deliriousPct = null
    const bonusLines = []
    for (const line of (ench?.text ?? '').split(', ')) {
      const m = line.match(/(\d+)%\s+Delirious/i)
      if (m) deliriousPct = Number(m[1])
      else if (line.trim()) bonusLines.push(line.trim())
    }
    return {
      key: it.NameShort, // "Ire"
      tier: it.Tier, // 1..13
      rarity: rarityOf(fullName), // Diluted / Liquid / Concentrated / Potent
      potent: rarityOf(fullName) === 'Potent',
      name: fullName, // "Diluted Liquid Ire"
      ancientName: tlRow ? (bit[tlRow.BaseItemType]?.Name ?? null) : null, // "Ancient Diluted Liquid Ire"
      waystone: { deliriousPct, bonus: bonusLines.join('; ') || null },
      jewel: jewelOutcomes(normalRow),
      jewelTimeLost: jewelOutcomes(tlRow),
    }
  })
  // Fail-loud gate (floor = the 2026-07 live value, exactly 13; the header promises emotions[13]):
  // a shrunken BlightCraftingItems extract aborts instead of shipping a truncated emotion list.
  assertFloor(emotions.length, 13, 'emotions')

  // ── anoints: ordered 3-emotion recipe -> notable ──
  // PassiveSkills.IsAnointmentOnly flags the "hidden" anoints: exclusive Notables that do NOT exist on
  // the passive tree and can only be obtained by anointing an amulet. GGG marks them directly, so we just
  // carry the flag through (no heuristics). (The map-mod-only hidden anoints have no BlightCraftingRecipe,
  // so they never appear here — correctly, this view is "what you can anoint from emotions".)
  const notables = {}
  const anoints = []
  const hidden = new Set()
  for (const r of recipes) {
    const res = results[r.BlightCraftingResult]
    if (!res || res.PassiveSkill == null) continue // empty / invalid combination
    const node = ps[res.PassiveSkill]
    if (!node) continue
    const name = node.Name || node.Id
    if (!notables[name]) notables[name] = resolveNotable(node, stats, desc)
    if (node.IsAnointmentOnly) hidden.add(name)
    // mustResolve: an ingredient index that doesn't resolve to an emotion name aborts the build —
    // the old `?? '?'` fallback would have shipped a fabricated claim (no such row exists 2026-07).
    anoints.push({
      c: (r.BlightCraftingItems ?? []).map((i) =>
        mustResolve(items[i]?.NameShort, `anoint ingredient ${i} for "${name}"`),
      ),
      n: name,
    })
  }
  const hiddenAnoints = [...hidden].sort((a, b) => a.localeCompare(b))

  // ── waystone Deliriousness math (context for the explainer) ──
  const constById = Object.fromEntries(consts.map((c) => [c.Id, c.Value]))
  const constants = {
    deliriousnessPerRare: constById.DeliriousnessPerRarePercent ?? null,
    deliriousnessPerUnique: constById.DeliriousnessPerUniquePercent ?? null,
    deliriousnessOnMapComplete: constById.DeliriousnessOnMapCompletePercent ?? null,
    depthToUnlockSimulacrum: constById.DepthToUnlockSimulacrum ?? null,
    simulacrumWaves: constById.SimulacrumWaves ?? null,
  }

  const out = {
    _provenance: {
      source: `own pathofexile-dat extraction — LiquidEmotionOutcomes + BlightCrafting{Items,Recipes,Results} + AfflictionConstants @ ${patch}`,
      captured: new Date().toISOString().slice(0, 10),
      note: 'Game data (c) Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    emotions,
    anoints,
    notables,
    hiddenAnoints, // off-tree, anoint-only exclusive Notables (PassiveSkills.IsAnointmentOnly)
    constants,
  }
  const json = JSON.stringify(out)
  await mkdir(join(ROOT, 'src', 'data'), { recursive: true })
  await writeFile(OUT, json)
  console.log(`\nsrc/data/emotions.json  ${kb(Buffer.byteLength(json))}`)
  console.log(
    `  ${emotions.length} emotions · ${anoints.length} anoint recipes · ${Object.keys(notables).length} notables` +
      ` (${hiddenAnoints.length} hidden / anoint-only)`,
  )
  const withWaystone = emotions.filter((e) => e.waystone.deliriousPct != null).length
  const withJewel = emotions.filter((e) => e.jewel).length
  console.log(
    `  waystone effects: ${withWaystone}/${emotions.length} · jewel outcomes: ${withJewel}/${emotions.length}`,
  )
}

runMain('build-emotions', main)
