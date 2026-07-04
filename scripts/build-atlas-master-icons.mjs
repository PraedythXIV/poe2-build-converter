// Offline builder: ATLAS-MASTER keystone glyphs -> one packed sprite + lookup table.
// The 36 keystones each ship two arts — inactive (KeystoneArt) and active/lit
// (KeystoneArtActive) — so the drawer can show the real lit state on allocation.
//
//   node scripts/build-atlas-master-icons.mjs [--tile 128] [--quality 82] [--atlas-w 2048]
//
// Inputs:
//   src/data/atlasMasters.json   each keystone carries iconDds + iconDdsActive (.dds paths)
//   the live install (or the CDN cache fallback) for the .dds bytes — SAME source as the
//   data build so the patch matches.
//
// Outputs:
//   src/assets/tree/atlas-master-icons.webp   one packed sprite of the glyphs
//   src/data/atlasMasterIcons.json            { "<dds path>": {x,y,w,h}, _atlas, _accents, _provenance }
//
// Format: lib-dds.decodeDds auto-detects BC1 / BC7 / uncompressed and logs the counts; any
// glyph that fails to decode is logged + simply absent (never invented art). Alpha is kept
// (the glyphs sit on OUR frame, not a baked stone tile). Art (c) GGG; not affiliated.
//
// _accents: a DATA-DRIVEN per-master identity hue ("r, g, b"), derived here because no colour
// column exists in AtlasClassPassiveClasses (verified — only _unmapped2=keystone-ids, _unmapped3
// =MaxPoints). Each master's accent is the saturation-weighted
// dominant hue averaged over its 12 ACTIVE (lit) keystone glyphs — the lit glow IS the in-game
// thematic colour — then value-normalised to a legible accent brightness. (The portraits sample
// muddy skin/armour; the lit glyphs cleanly recover Doryani→red / Hilda→blue / Jado→gold.)

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, EXTRACT_CACHE as CACHE, argValue, kb, logDone, runMain } from './lib.mjs'
import { resizeRgba, packAtlas, createInstallOrCdnLoader, decodeEach, writeWebpAtlas } from './lib-dds.mjs'

const INSTALL = process.env.POE2_INSTALL // optional local game install; unset → CDN fallback below
const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'atlasMasterIcons.json')

const TILE = Number(argValue('--tile') ?? 128)
const QUALITY = Number(argValue('--quality') ?? 82)
const ATLAS_W = Number(argValue('--atlas-w') ?? 2048)
const ACCENT_TARGET = 210 // value-normalise the dominant hue to this max channel for a legible accent

// Saturation-weighted dominant-hue accumulator: favours bright, chromatic, opaque pixels and
// drops near-grey (frames / white glow core) so the master's THEMATIC glow colour dominates.
function accumulateHue(rgba, acc) {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a < 60) continue
    const R = rgba[i],
      G = rgba[i + 1],
      B = rgba[i + 2]
    const mx = Math.max(R, G, B),
      mn = Math.min(R, G, B)
    const sat = mx === 0 ? 0 : (mx - mn) / mx
    if (sat < 0.18) continue
    const w = (a / 255) * sat * (mx / 255)
    acc.r += R * w
    acc.g += G * w
    acc.b += B * w
    acc.w += w
  }
}
/** Finalise an accumulator → "r, g, b", value-normalised to ACCENT_TARGET (clamped 1.0–2.4×). */
function finalAccent(acc) {
  if (acc.w === 0) return null
  const raw = [acc.r, acc.g, acc.b].map((v) => v / acc.w)
  const mx = Math.max(...raw)
  const scale = mx === 0 ? 1 : Math.min(2.4, Math.max(1, ACCENT_TARGET / mx))
  return raw.map((v) => Math.min(255, Math.round(v * scale))).join(', ')
}

async function main() {
  const t0 = Date.now()
  const masters = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'atlasMasters.json'), 'utf8'))
  const keystones = masters.masters.flatMap((m) => m.keystones)
  const distinct = [...new Set(keystones.flatMap((k) => [k.iconDds, k.iconDdsActive]).filter(Boolean))]
  console.log(`Distinct master glyph .dds: ${distinct.length} (36 keystones × inactive+active) — decoding...`)

  // Prefer the live install (patch-matched to atlasMasters.json); fall back to the CDN cache.
  const loader = await createInstallOrCdnLoader(INSTALL, CACHE)

  const { decoded, misses } = await decodeEach(
    loader,
    distinct,
    (img, dds) => ({ key: dds, w: TILE, h: TILE, pixels: resizeRgba(img.rgba, img.width, img.height, TILE, TILE) }),
    'those keystones fall back to a generic tile:',
  )
  const tiles = [...decoded.values()]

  // Per-master accent (data-driven identity hue) from the master's lit/active glyph pixels.
  const pixelsByDds = new Map(tiles.map((t) => [t.key, t.pixels]))
  const accents = {}
  for (const m of masters.masters) {
    const acc = { r: 0, g: 0, b: 0, w: 0 }
    for (const k of m.keystones) {
      const px = k.iconDdsActive && pixelsByDds.get(k.iconDdsActive)
      if (px) accumulateHue(px, acc)
    }
    const accent = finalAccent(acc)
    if (accent) accents[m.id] = accent
    else console.warn(`WARN: ${m.id} accent has no chromatic glyph pixels — falls back to neutral grey in the UI.`)
  }
  console.log(
    `Accents: ${Object.entries(accents)
      .map(([id, c]) => `${id}=rgb(${c})`)
      .join('  ')}`,
  )

  const atlas = packAtlas(tiles, TILE, ATLAS_W)
  const webp = await writeWebpAtlas(atlas, QUALITY, OUT_ASSETS, 'atlas-master-icons.webp')

  const table = {}
  for (const key of [...atlas.rects.keys()].sort()) table[key] = atlas.rects.get(key)
  const out = {
    _provenance: {
      source: 'GGG PoE2 game data via pathofexile-dat (AtlasClassPassives.KeystoneArt / KeystoneArtActive)',
      captured: new Date().toISOString().slice(0, 10),
      counts: { glyphs: tiles.length, decodeMisses: misses.length },
      note: 'Atlas-master glyph art © Grinding Gear Games. Not affiliated with or endorsed by GGG.',
      accents:
        'per-master identity hue derived from the lit/active glyph art (no colour column exists); value-normalised for accent legibility.',
    },
    _atlas: { w: atlas.width, h: atlas.height, tile: TILE },
    _accents: accents,
    ...table,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(
    `\nWrote src/assets/tree/atlas-master-icons.webp  ${atlas.width}x${atlas.height}  ${kb(webp.length)} (tile=${TILE}, q=${QUALITY})`,
  )
  console.log(
    `Wrote src/data/atlasMasterIcons.json           ${tiles.length} glyphs  ${kb(JSON.stringify(out).length)}`,
  )
  if (misses.length) console.warn(`  ⚠ ${misses.length} decode miss(es) — review before shipping (no invented art).`)
  logDone(t0)
}

runMain('build-atlas-master-icons', main)
