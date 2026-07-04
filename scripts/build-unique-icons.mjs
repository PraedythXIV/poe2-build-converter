// Offline builder: UNIQUE-item art (the item's OWN art, not its base) -> packed atlas + lookup.
//
//   node scripts/build-unique-icons.mjs [--tile-h 108] [--quality 75] [--atlas-w 2048]
//
// Inputs (_workbench/data-extract/ is gitignored — re-run `node scripts/extract-tables.mjs` if missing):
//   _workbench/data-extract/tables/Words.json, ItemVisualIdentity.json
//   _workbench/data-extract/tables/UniqueStashLayout.json
//   .dds art: the LOCAL game install (SteamBundleLoader, $POE2_INSTALL) when present — complete +
//     patch-matched + offline; else the extractor's warm CDN cache at _workbench/data-extract/.work/.cache/
//     (also offline; a bundle absent from the cache is a per-file miss, never a hard exit)
//
// Outputs:
//   src/assets/items/unique-icons.webp  one packed atlas, every tile scaled to a fixed height
//   src/data/uniqueIcons.json           { "<unique name, lowercased>": {x,y,w,h}, _atlas, _provenance }
//
// THE UNIQUE->ART JOIN (sanctioned, no scraping — proven against real game data):
//   UniqueStashLayout (449 rows): one row per unique in the stash tab layout.
//     .WordsKey               -> Words[key].Text  = the unique's display name
//     .ItemVisualIdentityKey  -> ItemVisualIdentity[key].DDSFile = the unique's OWN art path
// This is GGG's own first-party stash-layout table, so the icon is the unique's true art
// (NOT its base art — build-item-icons.mjs only ever resolves base art and labels it as such).
// Words / ItemVisualIdentity are row-indexed arrays: the foreign key IS the array index.
//
// Art format: the surveyed unique-jewel art is uncompressed (R8G8B8A8, ~108px) but other uniques
// use BC1/BC7 — lib-dds.mjs's decodeDds handles all three; any OTHER format is counted as a miss
// and that unique is simply ABSENT from the table (never wrong/invented art — the hard rule).
//
// Atlas scheme + budget: identical to build-item-icons.mjs — every tile scaled to TILE_H px
// (premultiplied-alpha box filter), shelf-packed at a fixed atlas width. HARD BUDGET: encoded
// atlas <= 2.5 MB. Over budget walks a LOUD degradation ladder (lower quality -> half-height ->
// drop NON-JEWEL uniques largest-first, jewels prioritised + every drop logged). Never silently
// truncates and never ships wrong art.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, EXTRACT, EXTRACT_CACHE as CACHE, argValue, kb, logDone, readExtractJson, runMain } from './lib.mjs'
import { makeWebpEncoder, createDdsLoader, decodeAspectTiles, packWithBudgetLadder } from './lib-dds.mjs'

const TABLES = join(EXTRACT, 'tables')
const INSTALL = process.env.POE2_INSTALL // optional local game install; unset → CDN fallback below
const OUT_ASSETS = join(ROOT, 'src', 'assets', 'items')
const OUT_JSON = join(ROOT, 'src', 'data', 'uniqueIcons.json')

const ATLAS_BUDGET = 2.5 * 1024 * 1024 // hard cap from the product rule (matches build-item-icons.mjs)
const TILE_H = Number(argValue('--tile-h') ?? 108) // SAME native tile size as the item-icon atlas
const QUALITY = Number(argValue('--quality') ?? 75)
const ATLAS_W = Number(argValue('--atlas-w') ?? 2048)

/** Read a table from the gitignored _workbench/data-extract/tables; fail loudly if missing. */
function readTable(name) {
  const primary = join(TABLES, `${name}.json`)
  if (existsSync(primary)) return JSON.parse(readFileSync(primary, 'utf8'))
  throw new Error(`missing ${name}.json — run \`node scripts/extract-tables.mjs\` first`)
}

/** A unique's art path is a jewel icon if it lives under a Jewels/ art folder. Jewels are the
 *  owner's priority — they are the only uniques shown directly in tree sockets — so if the budget
 *  forces drops, non-jewel uniques go first and jewels are kept as long as possible. */
function isJewelArt(dds) {
  return /\/jewels?\//i.test(dds)
}

/** Build a pathofexile-dat FileLoader that is STRICTLY OFFLINE: it reads bundles only from the
 *  warm CDN cache on disk and NEVER touches the network (preserving the project's hard offline
 *  invariant for the build pipeline). A bundle absent from the cache throws a clean per-file miss
 *  — which our decode loop catches and degrades, instead of the upstream CdnBundleLoader's
 *  `process.exit(1)` on a cache miss. We reuse CdnBundleLoader only to load the on-disk index. */
async function createOfflineDdsLoader(cacheDir, patch) {
  const loaders = await import(
    pathToFileURL(join(ROOT, 'node_modules', 'pathofexile-dat', 'dist', 'cli', 'bundle-loaders.js')).href
  )
  const cdn = await loaders.CdnBundleLoader.create(cacheDir, patch)
  // `cdn.cacheDir` is the per-loader cache root; mirror its on-disk name scheme (slash -> '@').
  const onDiskCache = cdn.cacheDir
  cdn.fetchFile = async (name) => {
    const file = join(onDiskCache, name.replace(/\//g, '@'))
    if (!existsSync(file)) {
      throw new Error(`bundle not in offline cache: ${name} (run \`npm run data:extract\` online to warm it)`)
    }
    return readFileSync(file)
  }
  return loaders.FileLoader.create(cdn)
}

async function main() {
  const t0 = Date.now()
  const meta = readExtractJson('extract-meta.json')
  const usl = readTable('UniqueStashLayout')
  const words = readTable('Words')
  const ivi = readTable('ItemVisualIdentity')

  // Join: UniqueStashLayout -> Words.Text (name) + ItemVisualIdentity.DDSFile (own art).
  // Words/IVI are row-indexed arrays; the *Key value is the array index. First row wins on a
  // name collision (renamed / alternate-art rows reuse a name) so the canonical art is stable.
  const byName = new Map() // nameLower -> { name, dds, jewel }
  let noName = 0
  let noArt = 0
  let nameCollisions = 0
  for (const row of usl) {
    const w = words[row.WordsKey]
    const name = w?.Text || w?.Text2
    if (!name) {
      noName++
      continue
    }
    const vis = ivi[row.ItemVisualIdentityKey]
    if (!vis?.DDSFile) {
      noArt++
      continue
    }
    const key = name.toLowerCase()
    const prev = byName.get(key)
    if (prev) {
      if (prev.dds !== vis.DDSFile) nameCollisions++
      continue // first (lowest _index) row wins; later same-name rows are renamed/alt-art dupes
    }
    byName.set(key, { name, dds: vis.DDSFile, jewel: isJewelArt(vis.DDSFile) })
  }
  const jewelCount = [...byName.values()].filter((b) => b.jewel).length
  console.log(
    `Uniques with art: ${byName.size}/${usl.length} (jewels: ${jewelCount}; skipped ` +
      `${noName} without a name, ${noArt} without art, ${nameCollisions} same-name art collisions kept first row)`,
  )

  // decode each distinct .dds once. Prefer the LOCAL game install (complete, patch-matched, offline —
  // the owner's preferred source over the CDN); fall back to the warm offline CDN cache. Either path
  // is offline; a bundle missing from the source is a clean per-file miss (caught + degraded below),
  // never the upstream CdnBundleLoader's process.exit(1).
  const loaders = await import(
    pathToFileURL(join(ROOT, 'node_modules', 'pathofexile-dat', 'dist', 'cli', 'bundle-loaders.js')).href
  )
  let loader
  if (process.env.POE2_OFFLINE) {
    // Opt-in strict-offline build: warm CDN cache only, NO network (a cache miss => that unique is
    // absent, never a hard exit). Preserves the original hard-offline pipeline option.
    loader = await createOfflineDdsLoader(CACHE, meta.poe2Patch)
    console.log('loader: offline CDN cache (POE2_OFFLINE — no network)')
  } else {
    try {
      if (!INSTALL) throw new Error('POE2_INSTALL not set')
      // Preferred: the LOCAL game install — complete, patch-matched, no network (owner's source).
      loader = await loaders.FileLoader.create(new loaders.SteamBundleLoader(INSTALL))
      console.log(`loader: SteamBundleLoader(${INSTALL})`)
    } catch (e) {
      // No install (e.g. the CI auto-updater): fetch from GGG's CDN, warming the cache as it goes.
      // This is the ONLY path that reaches the network; the unique art all exists at a live patch.
      console.warn(`Steam loader unavailable (${e.message}); fetching from GGG CDN`)
      loader = await createDdsLoader(CACHE, meta.poe2Patch)
    }
  }
  // aspect-preserving TILE_H-high tiles — the shared decode stage (lib-dds, also item-icons)
  const { decoded, misses } = await decodeAspectTiles(
    loader,
    byName,
    TILE_H,
    'those uniques will be ABSENT from the table:',
  )

  // The shared ladder driver (lib-dds, also item-icons); this script's drop policy on the final
  // rung removes the largest NON-JEWEL unique first, so jewels survive longest — if only jewels
  // remain and we're still over, fail loud rather than drop one.
  const encodeWebp = await makeWebpEncoder()
  const dropped = [] // names dropped to fit budget (loudly logged)
  const result = await packWithBudgetLadder({
    byName,
    decoded,
    quality: QUALITY,
    baseTileH: TILE_H,
    atlasW: ATLAS_W,
    budget: ATLAS_BUDGET,
    encodeWebp,
    dropOne: (active) => {
      const droppable = [...active.entries()]
        .filter(([, b]) => !b.jewel && decoded.has(b.dds))
        .map(([key, b]) => ({ key, b, area: decoded.get(b.dds).w * decoded.get(b.dds).h }))
        .sort((a, b) => b.area - a.area)
      if (!droppable.length) {
        throw new Error(
          `atlas still over ${kb(ATLAS_BUDGET)} with only jewel uniques left — raise the budget or shrink --tile-h; refusing to drop a jewel`,
        )
      }
      const { key, b } = droppable[0]
      dropped.push(b.name)
      console.warn(`WARN: still over ${kb(ATLAS_BUDGET)} — DROPPING non-jewel unique "${b.name}" (${b.dds})`)
      return new Map([...active].filter(([k]) => k !== key))
    },
  })
  const activeNames = result.activeNames

  // emit artifacts
  mkdirSync(OUT_ASSETS, { recursive: true })
  writeFileSync(join(OUT_ASSETS, 'unique-icons.webp'), result.webp)

  const table = {}
  let mapped = 0
  for (const key of [...activeNames.keys()].sort()) {
    const rect = result.atlas.rects.get(activeNames.get(key).dds)
    if (!rect) continue // art failed to decode — unique stays absent, never approximated
    table[key] = rect
    mapped++
  }
  const out = {
    _provenance: {
      source:
        'GGG PoE2 game data via pathofexile-dat (UniqueStashLayout.WordsKey -> Words.Text; ' +
        'UniqueStashLayout.ItemVisualIdentityKey -> ItemVisualIdentity.DDSFile)',
      patch: meta.poe2Patch,
      captured: new Date().toISOString().slice(0, 10),
      counts: {
        uniques: mapped,
        jewels: [...activeNames.values()].filter((b) => b.jewel).length,
        artFiles: result.atlas.rects.size,
        decodeMisses: misses.length,
        dropped: dropped.length,
      },
      droppedNames: dropped,
      keying: "keyed by the unique item name, lowercased — this is the unique's OWN art, not its base art",
      note: 'Item art © Grinding Gear Games. Not affiliated with or endorsed by Grinding Gear Games.',
    },
    _atlas: { w: result.atlas.width, h: result.atlas.height, tileH: result.tileH },
    ...table,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(
    `\nWrote src/assets/items/unique-icons.webp  ${result.atlas.width}x${result.atlas.height}  ${kb(result.webp.length)} (tileH=${result.tileH}, q=${result.quality})`,
  )
  console.log(
    `Wrote src/data/uniqueIcons.json           ${mapped} uniques -> ${result.atlas.rects.size} tiles  ${kb(JSON.stringify(out).length)}`,
  )
  if (dropped.length) console.warn(`DROPPED uniques (budget): ${dropped.join(', ')}`)
  logDone(t0)
}

runMain('build-unique-icons', main)
