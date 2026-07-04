// Offline builder: ATLAS per-subtree background panels + main facade -> packed atlas + table.
//
//   node scripts/build-atlas-bg.mjs [--tile 600] [--facade-tile 3840] [--quality 84]
//
// The atlas tree backdrop is NOT per-cluster discs — it's one large carved-stone facade behind
// the main (General) tree, plus one distinct art panel per mechanic subtree (Breach/Abyss/
// Incursion/Ritual/Delirium), each placed over its subtree's node cloud. We use the precursortheme
// set: it maps 1:1 to our atlasGraph subTrees, is complete (incl. Incursion + the facade), and is
// internally consistent. The shape silhouette lives in the ALPHA channel (transparent edges), so
// alpha is preserved (NOT forced opaque).
//
// Source: art/textures/interface/2d/2dart/uiimages/ingame/atlasscreen/precursortheme/*.dds — BC7
// (DXGI 98), decoded by lib-dds.mjs. Fetched cache-first via pathofexile-dat. Art (c) GGG.
//
// Outputs:
//   src/assets/tree/atlas-bg.webp   one packed atlas of the (downscaled) panels + facade
//   src/data/atlasBg.json           { "<key>": {x,y,w,h}, _atlas, _provenance }

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, EXTRACT_CACHE as CACHE, argValue, kb, logDone, readExtractJson, runMain } from './lib.mjs'
import {
  createDdsLoader,
  fetchDds,
  decodeDds,
  resizeRgba,
  packAtlas,
  makeWebpEncoder,
  brighten,
  writeWebpAtlas,
} from './lib-dds.mjs'

const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'atlasBg.json')

const TILE = Number(argValue('--tile') ?? 600) // mechanic-panel height (precursor native = 600 → full res)
const FACADE_TILE = Number(argValue('--facade-tile') ?? 3840) // facade native = 3840 → full res (large file)
const QUALITY = Number(argValue('--quality') ?? 84)
const ATLAS_W = Number(argValue('--atlas-w') ?? 2048)
// the raw textures are darker than the game renders them (the game adds scene lighting) — boost
const BRIGHTEN = Number(argValue('--brighten') ?? 1.45)

// "Opaque" cutoff for the silhouette centroid. The art has a soft outer GLOW (low-alpha halo, heavier at
// the bottom) that biases a fully alpha-weighted centroid ~60px low; the SOLID stone (alpha > this) is the
// shape the eye aligns to. Empirically the solid-mask centroid reproduces the hand-calibrated facade centre
// to ~4px (verified by a threshold sweep), vs ~63px for the alpha-weighted centroid. It's a
// perceptual constant (not art-specific) and the centroid still follows the art across patches.
const ALPHA_SOLID = 96
/** Centroid of the OPAQUE silhouette (pixels with alpha > ALPHA_SOLID), as a FRACTION (0..1) of the texture
 *  — the threshold-robust "visual content centre". atlasPanels() lands this on the main-tree centre so the
 *  facade needs no hand-calibrated offset (only the world SCALE stays a constant). */
function alphaCentroidFrac(rgba, w, h) {
  let sx = 0,
    sy = 0,
    n = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > ALPHA_SOLID) {
        sx += x
        sy += y
        n++
      }
    }
  if (n === 0) return { ax: 0.5, ay: 0.5 }
  return { ax: +(sx / n / w).toFixed(5), ay: +(sy / n / h).toFixed(5) }
}

// brighten comes from lib-dds (shared with genesis-bg + passive-jewels).

// UI asset refs ("Art/2DArt/UIImages/…") in the game tables resolve to a texture DDS under this root —
// verified: AtlasPassiveSkillSubTrees.UI_Background "Art/2DArt/UIImages/InGame/AtlasScreen/PrecursorTheme/
// BreachSubTreeBG" -> .../breachsubtreebg.dds (== the old hardcoded path).
const UI_DDS_ROOT = 'art/textures/interface/2d/'
const uiToDds = (ui) => `${UI_DDS_ROOT}${ui.replace(/^Art\//i, '').toLowerCase()}.dds`
const DIR = `${UI_DDS_ROOT}2dart/uiimages/ingame/atlasscreen/precursortheme`
// the main-tree facade is big on screen → emitted standalone at higher res (own webp). It has no
// AtlasPassiveSkillSubTrees row (it's the general tree), so its path stays explicit.
const FACADE = `${DIR}/atlasmaintreebg.dds`
// NOTE: the per-subtree panel list (PANELS) is DERIVED from the game table inside main() (UI_Background
// -> uiToDds), so a NEW subtree (e.g. Expedition) builds its panel art automatically — nothing hardcoded.

async function main() {
  const t0 = Date.now()
  const meta = readExtractJson('extract-meta.json')
  const loader = await createDdsLoader(CACHE, meta.poe2Patch)

  // Per-subtree panel art DERIVED from the game table (one packed panel per subtree, keyed by the
  // lowercased subtree Id to match atlasGraph.subTrees / atlasPanels()). New subtree => new panel, free.
  const subTrees = readExtractJson('tables/AtlasPassiveSkillSubTrees.json')
  const PANELS = Object.fromEntries(subTrees.map((st) => [st.Id.toLowerCase(), uiToDds(st.UI_Background)]))
  console.log(`subtree panels (from AtlasPassiveSkillSubTrees): ${Object.keys(PANELS).join(', ')}`)

  // Native art dimensions per panel — the foundation for resolution-ROBUST sizing. The world `size`
  // used by atlasPanels() (src/atlas/index.ts) is a WORLD quantity, not pixels, so the stored webp
  // resolution never affects alignment; recording native w/h lets the ASPECT (and, later, the scale —
  // atlas roadmap A4) be DERIVED from data instead of hand-calibrated against one decoded resolution.
  const nativeDims = {}
  const tiles = []
  const misses = []
  for (const [key, dds] of Object.entries(PANELS)) {
    try {
      const img = decodeDds(await fetchDds(loader, dds), dds)
      brighten(img.rgba, BRIGHTEN)
      const w = Math.max(1, Math.round((img.width / img.height) * TILE)) // keep aspect + ALPHA
      tiles.push({ key, w, h: TILE, pixels: resizeRgba(img.rgba, img.width, img.height, w, TILE) })
      nativeDims[key] = { w: img.width, h: img.height, ...alphaCentroidFrac(img.rgba, img.width, img.height) }
      console.log(`  ${key}: ${img.width}x${img.height} ${img.fmtName} -> ${w}x${TILE}`)
    } catch (e) {
      misses.push({ key, dds, reason: e.message })
    }
  }
  if (misses.length) {
    console.warn(`WARN: ${misses.length} panel(s) failed:`)
    for (const m of misses) console.warn(`  ${m.key} (${m.dds}): ${m.reason}`)
  }

  const atlas = packAtlas(tiles, TILE, ATLAS_W)
  const encodeWebp = await makeWebpEncoder() // shared with the facade encode below
  const webp = await writeWebpAtlas(atlas, QUALITY, OUT_ASSETS, 'atlas-bg.webp', encodeWebp)

  // the facade is large on screen — emit it standalone at higher res (its own webp)
  try {
    const f = decodeDds(await fetchDds(loader, FACADE), FACADE)
    brighten(f.rgba, BRIGHTEN)
    nativeDims.general = { w: f.width, h: f.height, ...alphaCentroidFrac(f.rgba, f.width, f.height) }
    const fw = Math.max(1, Math.round((f.width / f.height) * FACADE_TILE))
    const fpix = resizeRgba(f.rgba, f.width, f.height, fw, FACADE_TILE)
    const fwebp = Buffer.from(await encodeWebp(fpix, fw, FACADE_TILE, QUALITY))
    writeFileSync(join(OUT_ASSETS, 'atlas-bg-general.webp'), fwebp)
    console.log(`  facade: ${f.width}x${f.height} ${f.fmtName} -> ${fw}x${FACADE_TILE}  ${kb(fwebp.length)}`)
  } catch (e) {
    console.warn(`WARN: facade failed (${FACADE}): ${e.message}`)
  }

  const table = {}
  for (const key of [...atlas.rects.keys()].sort()) table[key] = atlas.rects.get(key)
  const out = {
    _provenance: {
      source: 'GGG PoE2 game data via pathofexile-dat (AtlasScreen precursortheme subtree/facade art, BC7)',
      patch: meta.poe2Patch,
      captured: new Date().toISOString().slice(0, 10),
      counts: { panels: tiles.length, decodeMisses: misses.length },
      note: 'Atlas background art © Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    _atlas: { w: atlas.width, h: atlas.height, tile: TILE },
    _native: nativeDims,
    ...table,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(
    `\nWrote src/assets/tree/atlas-bg.webp  ${atlas.width}x${atlas.height}  ${kb(webp.length)} (tile=${TILE}, q=${QUALITY})`,
  )
  console.log(`Wrote src/data/atlasBg.json          ${tiles.length} panels  ${kb(JSON.stringify(out).length)}`)
  logDone(t0)
}

runMain('build-atlas-bg', main)
