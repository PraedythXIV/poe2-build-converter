// Distilled-Emotion item icons (full native res) + a per-emotion tint colour for the UI pills.
//
//   node scripts/build-emotion-icons.mjs [--quality 82]   (npm run data:emotion-icons)
//
// Inputs (_workbench/data-extract/, from `npm run data:extract`):
//   tables/BaseItemTypes.json + tables/ItemVisualIdentity.json  — the 13 emotion bases -> .dds art
//   .work/.cache/                                               — the CDN bundle cache (.dds fetched cache-first)
//   src/data/emotions.json                                      — canonical emotion key order to join on
//
// Output: src/data/emotionIcons.json — { "<key>": { src: "data:image/webp;base64,…", w, h, rgb },
//   _provenance }. One small full-res webp per emotion (13 total) inlined as a data URI — cheap
// enough to embed directly (no atlas needed), and the `rgb` triple is the icon's dominant liquid
// hue so a chip/pill reads as "that emotion's colour".

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, argValue, kb, readExtractJson, runMain } from './lib.mjs'
import { createDdsLoader, fetchDds, decodeDds, makeWebpEncoder, to4k } from './lib-dds.mjs'
import { probePatchServer } from './patch-version.mjs'

const EXTRACT = join(ROOT, '_workbench', 'data-extract')
const TABLES = join(EXTRACT, 'tables')
const CACHE = join(EXTRACT, '.work', '.cache')
const OUT = join(ROOT, 'src', 'data', 'emotionIcons.json')
const QUALITY = Number(argValue('--quality') ?? 82)

// Canonical metadata-Id order = the same tier order as emotions.json's `emotions[]`.
const ID_ORDER = [
  ...Array.from({ length: 10 }, (_, i) => `Metadata/Items/Currency/DistilledEmotion${i + 1}`),
  ...Array.from({ length: 3 }, (_, i) => `Metadata/Items/Currency/EndgameDistilledEmotion${i + 1}`),
]
/** Dominant liquid hue: saturation-weighted average of opaque pixels (the glass/shadow is dark
 *  and desaturated, so weighting by saturation*alpha lands on the vivid liquid colour). */
function dominantRgb(rgba) {
  let r = 0,
    g = 0,
    b = 0,
    wsum = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a < 40) continue
    const R = rgba[i],
      G = rgba[i + 1],
      B = rgba[i + 2]
    const mx = Math.max(R, G, B)
    const mn = Math.min(R, G, B)
    const sat = mx === 0 ? 0 : (mx - mn) / mx
    const w = (a / 255) * (0.15 + sat) * (mx / 255) // bias to bright, saturated pixels
    r += R * w
    g += G * w
    b += B * w
    wsum += w
  }
  if (wsum === 0) return '150, 150, 150'
  return [r, g, b].map((v) => Math.round(v / wsum)).join(', ')
}

async function main() {
  for (const p of ['BaseItemTypes.json', 'ItemVisualIdentity.json']) {
    if (!existsSync(join(TABLES, p))) throw new Error(`${p} missing — run \`node scripts/extract-tables.mjs\` first`)
  }
  const bit = JSON.parse(readFileSync(join(TABLES, 'BaseItemTypes.json'), 'utf8'))
  const ivi = JSON.parse(readFileSync(join(TABLES, 'ItemVisualIdentity.json'), 'utf8'))
  const keys = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'emotions.json'), 'utf8')).emotions.map((e) => e.key)
  if (keys.length !== ID_ORDER.length)
    throw new Error(`emotions.json has ${keys.length} emotions, expected ${ID_ORDER.length}`)

  const byId = new Map(bit.map((r, i) => [r?.Id, i]))
  const targets = ID_ORDER.map((id, i) => {
    const idx = byId.get(id)
    const dds = idx != null ? ivi[bit[idx].ItemVisualIdentity]?.DDSFile : null
    if (!dds) throw new Error(`no art for ${id}`)
    return { key: keys[i], dds }
  })

  const patch = (await probePatchServer()).patch
  const loader = await createDdsLoader(CACHE, patch)
  const encodeWebp = await makeWebpEncoder()
  const out = {}
  let used4k = 0
  for (const { key, dds } of targets) {
    let buf, usedPath
    try {
      usedPath = to4k(dds)
      buf = await fetchDds(loader, usedPath)
      used4k++
    } catch {
      usedPath = dds
      buf = await fetchDds(loader, dds)
    }
    const img = decodeDds(buf, usedPath)
    const webp = Buffer.from(await encodeWebp(img.rgba, img.width, img.height, QUALITY))
    out[key] = {
      src: `data:image/webp;base64,${webp.toString('base64')}`,
      w: img.width,
      h: img.height,
      rgb: dominantRgb(img.rgba),
    }
    console.log(`  ${key.padEnd(11)} ${img.width}x${img.height} ${kb(webp.length).padStart(7)}  rgb(${out[key].rgb})`)
  }

  const meta = readExtractJson('extract-meta.json')
  const json = {
    _provenance: {
      source: 'GGG PoE2 game art via pathofexile-dat (BaseItemTypes -> ItemVisualIdentity.DDSFile, /4k/ where present)',
      patch: meta.poe2Patch, // the pinned extraction the TABLES come from
      artPatch: patch, // the LIVE patch the .dds bytes were fetched at (cache-first; art is path-keyed/patch-stable)
      captured: new Date().toISOString().slice(0, 10),
      note: 'Item art © Grinding Gear Games. Not affiliated with or endorsed by Grinding Gear Games.',
    },
    ...out,
  }
  const str = JSON.stringify(json)
  writeFileSync(OUT, str)
  console.log(
    `\nsrc/data/emotionIcons.json  ${kb(Buffer.byteLength(str))}  (${Object.keys(out).length} icons, ${used4k} from /4k/)`,
  )
}

runMain('build-emotion-icons', main)
