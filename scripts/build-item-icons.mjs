// Offline builder: equippable item-base art -> packed atlas + lookup table.
//
//   node scripts/build-item-icons.mjs [--tile-h 108] [--quality 75] [--atlas-w 2048]
//
// Inputs (_workbench/data-extract/ is gitignored — re-run `node scripts/extract-tables.mjs` if missing):
//   _workbench/data-extract/tables/BaseItemTypes.json, ItemClasses.json, ItemVisualIdentity.json
//   _workbench/data-extract/.work/.cache/   (the extractor's CDN bundle cache — .dds files are fetched
//                                 through the same pathofexile-dat loader, cache-first)
//
// Outputs:
//   src/assets/items/icons.webp  one packed atlas, every tile scaled to a fixed height
//   src/data/itemIcons.json      { "<base name, lowercased>": {x,y,w,h}, _atlas, _provenance }
//
// Scope: EQUIPPABLE bases only (weapons, armour incl. shields/foci/bucklers, jewellery,
// belts, quivers, flasks, charms, jewels) — filtered via the ItemClasses allowlist below.
// Uniques are NOT mapped: the game's unique->art table is not vendored, so uniques can only
// ever show their base's art (the lookup is by base-type name; callers must label it as such).
//
// Art path chain (verified against patch 4.5.2.1.2, 2026-06-12):
//   BaseItemTypes.ItemVisualIdentity (foreignrow index) -> ItemVisualIdentity.DDSFile
// Every surveyed PoE2 item-art .dds is UNCOMPRESSED (DX10 / R8G8B8A8_UNORM, ~106 px per
// inventory cell), so "decoding" is header parsing + a raw pixel copy — no BCn decompressor
// is needed. Legacy masked-RGB headers and BGRA orders are handled too; any OTHER format
// (e.g. a future BC7 re-encode by GGG) is counted + logged as a miss and the base is simply
// absent from the table — we never ship wrong or invented art.
//
// Atlas scheme: every tile is scaled (premultiplied-alpha box filter) to a fixed height of
// TILE_H px, width follows the source aspect (a 2x3 body armour stays portrait, a 2x1 belt
// stays landscape). Tiles are shelf-packed left-to-right into rows of exactly TILE_H + 1 px
// of padding (lossy-bleed guard) at a fixed atlas width. Rects in itemIcons.json are exact
// pixel boxes. HARD BUDGET: the encoded atlas must be <= 2.5 MB — if over, the builder
// retries at lower quality, then half-height tiles, and finally drops whole item classes
// (largest first, loudly logged). It never silently truncates.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, EXTRACT, EXTRACT_CACHE as CACHE, argValue, kb, logDone, readExtractJson, runMain } from './lib.mjs'
// DDS decode / resize / atlas-pack / webp-encode is the shared pixel pipeline in scripts/lib-dds.mjs
// (single source of truth — also used by build-atlas-icons / build-unique-icons / build-genesis-icons).
// lib-dds's decodeDds handles this script's uncompressed item art identically (and BC1/BC7 besides).
import { makeWebpEncoder, createDdsLoader, decodeAspectTiles, packWithBudgetLadder } from './lib-dds.mjs'

const TABLES = join(EXTRACT, 'tables')
const OUT_ASSETS = join(ROOT, 'src', 'assets', 'items')
const OUT_JSON = join(ROOT, 'src', 'data', 'itemIcons.json')

const ATLAS_BUDGET = 2.5 * 1024 * 1024 // hard cap from the product rule
const TILE_H = Number(argValue('--tile-h') ?? 108) // native inventory-cell art is ~106-108px (no /4k/ exists) — ship true native
const QUALITY = Number(argValue('--quality') ?? 75)
const ATLAS_W = Number(argValue('--atlas-w') ?? 2048)

// Equippable item classes (ItemClasses.Id strings). PoE2-current classes plus the legacy
// PoE1 weapon classes that still carry PoE2 bases in the table (Claw/Dagger/etc. — they are
// equippable if they exist; classes with 0 bases cost nothing). Deliberately excluded:
// Talisman (socketable league item, not equipment), relics, gems, currency, fishing rods.
const EQUIPPABLE_CLASS_IDS = [
  // flasks & charms
  'LifeFlask',
  'ManaFlask',
  'UtilityFlask',
  // jewellery
  'Amulet',
  'Ring',
  'Belt',
  // armour
  'Gloves',
  'Boots',
  'Body Armour',
  'Helmet',
  'Shield',
  'Focus',
  'Buckler',
  // jewels
  'Jewel',
  // weapons + quivers
  'Claw',
  'Dagger',
  'Wand',
  'One Hand Sword',
  'One Hand Axe',
  'One Hand Mace',
  'Bow',
  'Staff',
  'Two Hand Sword',
  'Two Hand Axe',
  'Two Hand Mace',
  'Sceptre',
  'Warstaff',
  'Spear',
  'Crossbow',
  'Flail',
  'Quiver',
]

function readTable(name) {
  const file = join(TABLES, `${name}.json`)
  if (!existsSync(file)) {
    throw new Error(
      `missing _workbench/data-extract/tables/${name}.json — run \`node scripts/extract-tables.mjs\` first`,
    )
  }
  return JSON.parse(readFileSync(file, 'utf8'))
}

async function main() {
  const t0 = Date.now()
  const meta = readExtractJson('extract-meta.json')
  // Art is path-keyed (filenames stable across patches), so the .dds can be fetched at any patch
  // whose bundle index is reachable. Default to the pinned extract patch; --patch overrides it
  // (needed once the pinned patch rolls off the CDN — the live patch's bundles carry the same art).
  const patch = argValue('--patch') ?? meta.poe2Patch
  const bases = readTable('BaseItemTypes')
  const classes = readTable('ItemClasses')
  const ivi = readTable('ItemVisualIdentity')

  const classIndexById = new Map(classes.map((c) => [c.Id, c._index]))
  const equippableIdx = new Map() // class _index -> class Id
  for (const id of EQUIPPABLE_CLASS_IDS) {
    const idx = classIndexById.get(id)
    if (idx === undefined) console.warn(`WARN: ItemClasses has no "${id}" — skipped (class renamed?)`)
    else equippableIdx.set(idx, id)
  }

  // base rows in scope -> dds path (name-keyed, first row wins on collisions)
  const byName = new Map() // nameLower -> { name, dds, classId }
  const perClass = new Map() // classId -> count
  let collisions = 0
  let noArt = 0
  for (const row of bases) {
    const classId = equippableIdx.get(row.ItemClass)
    // "[DNT]" = do-not-translate dev/placeholder rows (e.g. "[dnt] engraved cuffs") — never ship them
    // (matches the same guard in fetch-data.mjs's unique-name build).
    if (!classId || !row.Name || /\[dnt\]/i.test(row.Name)) continue
    const vis = row.ItemVisualIdentity != null ? ivi[row.ItemVisualIdentity] : null
    if (!vis?.DDSFile) {
      noArt++
      continue
    }
    const key = row.Name.toLowerCase()
    const prev = byName.get(key)
    if (prev) {
      if (prev.dds !== vis.DDSFile) collisions++
      continue // first (lowest _index) row wins; later same-name rows are alt-art dupes
    }
    byName.set(key, { name: row.Name, dds: vis.DDSFile, classId })
    perClass.set(classId, (perClass.get(classId) ?? 0) + 1)
  }
  console.log(
    `Equippable bases in scope: ${byName.size} (skipped: ${noArt} without art, ${collisions} same-name art collisions kept first row)`,
  )
  console.log(`  per class: ${[...perClass.entries()].map(([c, n]) => `${c}=${n}`).join(', ')}`)

  // fetch + decode each distinct .dds once (same loader + CDN cache as extract-tables)
  const loader = await createDdsLoader(CACHE, patch)

  // aspect-preserving TILE_H-high tiles — the shared decode stage (lib-dds, also unique-icons)
  const { decoded, misses } = await decodeAspectTiles(
    loader,
    byName,
    TILE_H,
    'those bases will be ABSENT from the table:',
  )

  // pack + encode, walking the degradation ladder until the budget holds
  const encodeWebp = await makeWebpEncoder()
  const classArea = new Map() // classId -> px area, for the drop-largest fallback
  for (const b of byName.values()) {
    const tile = decoded.get(b.dds)
    if (tile) classArea.set(b.classId, (classArea.get(b.classId) ?? 0) + tile.w * tile.h)
  }
  // The shared ladder driver (lib-dds, also unique-icons); this script's drop policy on the
  // final rung: drop the LARGEST remaining class outright (loudly) and retry.
  const droppedClasses = []
  const result = await packWithBudgetLadder({
    byName,
    decoded,
    quality: QUALITY,
    baseTileH: TILE_H,
    atlasW: ATLAS_W,
    budget: ATLAS_BUDGET,
    encodeWebp,
    dropOne: (active) => {
      const largest = [...classArea.entries()].sort((a, b) => b[1] - a[1])[0]
      if (!largest) throw new Error('atlas over budget with nothing left to drop')
      const [dropId] = largest
      classArea.delete(dropId)
      droppedClasses.push(dropId)
      console.warn(`WARN: still over ${kb(ATLAS_BUDGET)} — DROPPING class "${dropId}" entirely`)
      return new Map([...active].filter(([, b]) => b.classId !== dropId))
    },
  })
  const activeNames = result.activeNames

  // emit artifacts
  mkdirSync(OUT_ASSETS, { recursive: true })
  writeFileSync(join(OUT_ASSETS, 'icons.webp'), result.webp)

  const table = {}
  let mapped = 0
  const sortedNames = [...activeNames.keys()].sort()
  for (const key of sortedNames) {
    const rect = result.atlas.rects.get(activeNames.get(key).dds)
    if (!rect) continue // art failed to decode — base stays absent, never approximated
    table[key] = rect
    mapped++
  }
  const out = {
    _provenance: {
      source: 'GGG PoE2 game data via pathofexile-dat (BaseItemTypes.ItemVisualIdentity -> ItemVisualIdentity.DDSFile)',
      patch,
      captured: new Date().toISOString().slice(0, 10),
      counts: {
        bases: mapped,
        artFiles: result.atlas.rects.size,
        decodeMisses: misses.length,
        droppedClasses,
      },
      uniques: 'NOT mapped — the unique->art table is not vendored; a unique can only resolve to its base art',
      note: 'Item art © Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    _atlas: { w: result.atlas.width, h: result.atlas.height, tileH: result.tileH },
    ...table,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(
    `\nWrote src/assets/items/icons.webp  ${result.atlas.width}x${result.atlas.height}  ${kb(result.webp.length)} (tileH=${result.tileH}, q=${result.quality})`,
  )
  console.log(
    `Wrote src/data/itemIcons.json      ${mapped} bases -> ${result.atlas.rects.size} tiles  ${kb(JSON.stringify(out).length)}`,
  )
  if (droppedClasses.length) console.warn(`DROPPED classes (budget): ${droppedClasses.join(', ')}`)
  logDone(t0)
}

runMain('build-item-icons', main)
