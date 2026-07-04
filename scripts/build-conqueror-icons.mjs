// Offline builder: TIMELESS-JEWEL conqueror passive node icons -> packed atlas + lookup table.
//
//   node scripts/build-conqueror-icons.mjs [--tile 64] [--quality 80] [--atlas-w 1024]
//
// When a Timeless Jewel is socketed, every passive inside its radius is overridden by a
// faction-specific alternate passive whose art is AlternatePassiveSkills.DDSIcon. There are
// only 44 distinct icon files across the 231 alternate passives (8 conquerors), so this is a
// small fixed-tile atlas — modelled on build-atlas-icons.mjs (same BC1/BC7 skill-icon art),
// with a HARD budget + loud degradation ladder borrowed from build-item-icons.mjs.
//
// IMPORTANT (owner's hard rule): this atlas is ONE-art-per-(faction,node-kind) lookup, keyed by
// the DDS path. It is NOT the exact per-node art a Timeless Jewel's seed-RNG resolves (that
// deterministic per-seed selection is Phase 7, out of scope) — callers must not present it as such.
//
// Inputs (gitignored — re-run the datamine if missing):
//   _workbench/data-extract/tables/AlternatePassiveSkills.json   the 231 alternate passives (DDSIcon paths)
//   _workbench/data-extract/.work/.cache/                          pathofexile-dat CDN bundle cache (cache-first)
//   _workbench/data-extract/extract-meta.json                      live patch (loader key + provenance stamp)
//
// Outputs:
//   src/assets/tree/conqueror-icons.webp  one packed atlas of square conqueror node icons
//   src/data/conquerorIcons.json          { "<dds path>": {x,y,w,h}, _atlas, _provenance }
//
// The icons are DX10 BC1/BC7 (same family as the atlas skill icons); decodeDds handles both.
// Any icon that fails to decode is logged and simply ABSENT (the renderer keeps its fallback —
// never invented art). Art © Grinding Gear Games; not affiliated with or endorsed by GGG.

// jscpd:ignore-start — ESM import boilerplate: each module MUST declare its own imports/paths;
// the shared code itself lives in lib.mjs / lib-dds.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, EXTRACT_CACHE as CACHE, argValue, kb, logDone, readExtractJson, runMain } from './lib.mjs'
import { createDdsLoader, resizeRgba, packAtlas, makeWebpEncoder, decodeEach, forceOpaque } from './lib-dds.mjs'

const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'conquerorIcons.json')
// jscpd:ignore-end

const TILE = Number(argValue('--tile') ?? 64) // native icons are 64-232px; 64 is plenty for the tree's conqueror overlay and keeps the 44-tile sheet tiny
const QUALITY = Number(argValue('--quality') ?? 80)
const ATLAS_W = Number(argValue('--atlas-w') ?? 1024)
const ATLAS_BUDGET = 1.5 * 1024 * 1024 // HARD cap (this sheet is small; the ladder/loud-fail guards against a future blow-up)

async function main() {
  const t0 = Date.now()
  const meta = readExtractJson('extract-meta.json')
  const alt = readExtractJson('tables/AlternatePassiveSkills.json')

  // AlternatePassiveSkills.DDSIcon = the faction node art; AlternatePassiveAdditions carries NO
  // DDSIcon (verified — additions reuse the base node art), so the skills table is the only source.
  const distinct = [...new Set(alt.map((r) => r.DDSIcon).filter(Boolean))]
  console.log(`Distinct conqueror node icons: ${distinct.length} — fetching + decoding (cache-first)...`)

  const loader = await createDdsLoader(CACHE, meta.poe2Patch)
  // native-size tiles (resized lazily per ladder rung); opaque square illustrations (forceOpaque)
  const { decoded, misses } = await decodeEach(
    loader,
    distinct,
    (img, dds) => ({ key: dds, w: img.width, h: img.height, pixels: forceOpaque(img.rgba) }),
    'those nodes keep the fallback art:',
  )
  if (!decoded.size) throw new Error('no conqueror icons decoded — refusing to write an empty atlas')

  // pack + encode, walking the degradation ladder until the budget holds (loud, never silent truncation)
  const encodeWebp = await makeWebpEncoder()
  let result = null
  ladder: for (const [tile, quality] of [
    [TILE, QUALITY],
    [TILE, 60],
    [Math.round(TILE / 2), QUALITY],
    [Math.round(TILE / 2), 60],
  ]) {
    const tiles = []
    for (const dds of [...decoded.keys()].sort()) {
      const t = decoded.get(dds)
      tiles.push({ key: dds, w: tile, h: tile, pixels: resizeRgba(t.pixels, t.w, t.h, tile, tile) })
    }
    const atlas = packAtlas(tiles, tile, ATLAS_W)
    const webp = Buffer.from(await encodeWebp(atlas.pixels, atlas.width, atlas.height, quality))
    console.log(`  try tile=${tile} q=${quality}: ${atlas.width}x${atlas.height}, ${kb(webp.length)}`)
    if (webp.length <= ATLAS_BUDGET) {
      result = { atlas, webp, tile, quality }
      break ladder
    }
  }
  if (!result) {
    throw new Error(
      `atlas over budget (${kb(ATLAS_BUDGET)}) at the smallest ladder rung — refusing to ship a truncated/wrong sheet`,
    )
  }

  // emit artifacts
  mkdirSync(OUT_ASSETS, { recursive: true })
  writeFileSync(join(OUT_ASSETS, 'conqueror-icons.webp'), result.webp)

  const table = {}
  for (const key of [...result.atlas.rects.keys()].sort()) table[key] = result.atlas.rects.get(key)
  const out = {
    _provenance: {
      source:
        'GGG PoE2 game data via pathofexile-dat (AlternatePassiveSkills.DDSIcon — Timeless Jewel conqueror node art, BC1/BC7)',
      patch: meta.poe2Patch,
      captured: new Date().toISOString().slice(0, 10),
      counts: { icons: result.atlas.rects.size, distinct: distinct.length, decodeMisses: misses.length },
      note: 'One-art-per-(faction,node-kind) lookup keyed by DDS path — NOT the exact per-seed art a Timeless Jewel resolves (out of scope). Conqueror node art © Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    _atlas: { w: result.atlas.width, h: result.atlas.height, tile: result.tile },
    ...table,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(
    `\nWrote src/assets/tree/conqueror-icons.webp  ${result.atlas.width}x${result.atlas.height}  ${kb(result.webp.length)} (tile=${result.tile}, q=${result.quality})`,
  )
  console.log(
    `Wrote src/data/conquerorIcons.json          ${result.atlas.rects.size} icons  ${kb(JSON.stringify(out).length)}`,
  )
  logDone(t0)
}

runMain('build-conqueror-icons', main)
