// Offline builder: the 3 ATLAS-MASTER portraits (Doryani / Hilda / Jado character art).
// Unlike the keystone glyphs these are TALL character art, so they are NOT square-packed —
// each decodes to its own aspect-preserving webp the drawer shows beside the keystone grid.
//
//   node scripts/build-atlas-master-portraits.mjs [--quality 84] [--max-h 360]
//
// Inputs:
//   src/data/atlasMasters.json   each master carries `portrait` (a .dds path, MasterNormal)
//   the live install (or the CDN cache fallback) for the .dds bytes — SAME source as the
//   data build so the patch matches.
//
// Outputs:
//   src/assets/tree/atlas-master-<id>.webp   one webp per master (lowercased id)
//   src/data/atlasMasterPortraits.json       { "<id>": { src, w, h }, _provenance }
//
// decodeDds auto-detects BC1/BC7/uncompressed; alpha is kept (the art is a cut-out figure).
// Any portrait that fails to decode is logged + simply absent (never invented art).
// Art © Grinding Gear Games. Not affiliated with or endorsed by GGG.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, EXTRACT_CACHE as CACHE, argValue, kb, logDone, runMain } from './lib.mjs'
import { fetchDds, decodeDds, resizeRgba, makeWebpEncoder, createInstallOrCdnLoader } from './lib-dds.mjs'

const INSTALL = process.env.POE2_INSTALL // optional local game install; unset → CDN fallback below
const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'atlasMasterPortraits.json')

const QUALITY = Number(argValue('--quality') ?? 84)
const MAX_H = Number(argValue('--max-h') ?? 360) // cap the rendered height; width follows aspect

async function main() {
  const t0 = Date.now()
  const masters = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'atlasMasters.json'), 'utf8'))
  const jobs = masters.masters.map((m) => ({ id: m.id, dds: m.portrait })).filter((j) => j.dds)
  if (jobs.length !== masters.masters.length) {
    console.warn(`WARN: ${masters.masters.length - jobs.length} master(s) have no portrait path.`)
  }
  console.log(`Atlas-master portraits: ${jobs.map((j) => j.id).join(', ')} — decoding...`)

  // Prefer the live install (patch-matched to atlasMasters.json); fall back to the CDN cache.
  const loader = await createInstallOrCdnLoader(INSTALL, CACHE)

  const encodeWebp = await makeWebpEncoder()
  mkdirSync(OUT_ASSETS, { recursive: true })

  const table = {}
  const misses = []
  for (const { id, dds } of jobs) {
    try {
      const img = decodeDds(await fetchDds(loader, dds), dds)
      // preserve aspect; only downscale (never upscale past native).
      const scale = Math.min(1, MAX_H / img.height)
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const pixels = scale === 1 ? img.rgba : resizeRgba(img.rgba, img.width, img.height, w, h)
      const webp = Buffer.from(await encodeWebp(pixels, w, h, QUALITY))
      const file = `atlas-master-${id.toLowerCase()}.webp`
      writeFileSync(join(OUT_ASSETS, file), webp)
      table[id] = { src: file, w, h }
      console.log(
        `  ${id.padEnd(8)} ${img.fmtName.padEnd(6)} native ${img.width}x${img.height} → ${w}x${h}  ${kb(webp.length)}`,
      )
    } catch (e) {
      misses.push({ id, dds, reason: e.message })
      console.warn(`  ${id}: FAILED — ${e.message}`)
    }
  }

  const out = {
    _provenance: {
      source: 'GGG PoE2 game data via pathofexile-dat (AtlasClassPassiveClasses.MasterNormal)',
      captured: new Date().toISOString().slice(0, 10),
      counts: { portraits: Object.keys(table).length, decodeMisses: misses.length },
      note: 'Atlas-master portrait art © Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    ...table,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out, null, 2))

  console.log(
    `\nWrote ${Object.keys(table).length} portrait webp → src/assets/tree/  + src/data/atlasMasterPortraits.json`,
  )
  if (misses.length)
    console.warn(`  ⚠ ${misses.length} portrait(s) failed to decode — review before shipping (no invented art).`)
  logDone(t0)
}

runMain('build-atlas-master-portraits', main)
