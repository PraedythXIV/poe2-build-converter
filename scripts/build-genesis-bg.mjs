// Offline builder: GENESIS tree background facade -> one standalone webp (mirrors the atlas facade
// in build-atlas-bg.mjs). The Genesis tree backdrop is a single large carved/organic image behind
// the whole tree: art/textures/interface/2d/2dart/uiimages/ingame/breachleague/breachtreepassivebackground.dds
// — a 9960x8728 BC7 (DXGI 98) texture. Decoded by lib-dds.mjs, fetched cache-first at the LIVE patch
// (the pinned 4.5.2.1.2 cache rolled off the breach art; .dds is path-keyed/patch-stable).
//
//   node scripts/build-genesis-bg.mjs [--max-dim 4096] [--quality 84] [--brighten 1.0]   (npm run data:genesis-bg)
//
// Capped at 4096 on the larger dimension by default (owner: "4k tops" — native 9960x8728 OOMs the
// jsquash encoder and the canvas downsamples anyway). The shape/edges live in the ALPHA channel, so alpha
// is preserved (NOT forced opaque). Decoding 87 megapixels needs headroom — run with a big Node heap
// (the npm script sets --max-old-space-size). Output: src/assets/tree/genesis-bg.webp + the native
// dims in src/data/genesisBg.json (the renderer places it over the tree bounds).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, argValue, kb, logDone, runMain } from './lib.mjs'
import { createDdsLoader, fetchDds, decodeDds, resizeRgba, makeWebpEncoder, brighten } from './lib-dds.mjs'
import { probePatchServer } from './patch-version.mjs'

const CACHE_LIVE = join(ROOT, '_workbench', 'data-extract', '.work', '.cache-live')
const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'genesisBg.json')
const BG = 'art/textures/interface/2d/2dart/uiimages/ingame/breachleague/breachtreepassivebackground.dds'

// Owner: "4k tops is fine" — cap the LARGER dimension at 4096 (native 9960x8728 is overkill, OOMs the
// jsquash encoder anyway, and the canvas downsamples to the on-screen size). 9960x8728 -> 4096x3590.
const MAX_DIM = Number(argValue('--max-dim') ?? 4096)
const QUALITY = Number(argValue('--quality') ?? 84)
const BRIGHTEN = Number(argValue('--brighten') ?? 1.0) // raise if the raw texture renders too dark in-app

async function main() {
  const t0 = Date.now()
  const patch = (await probePatchServer()).patch
  console.log(`Fetching + decoding the genesis background (9960x8728 BC7) @ live patch ${patch} — this is large...`)
  const img = decodeDds(await fetchDds(await createDdsLoader(CACHE_LIVE, patch), BG), BG)
  console.log(`  decoded ${img.width}x${img.height} ${img.fmtName} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  brighten(img.rgba, BRIGHTEN)
  let { rgba, width, height } = img
  const scale = Math.min(1, MAX_DIM / Math.max(width, height))
  if (scale < 1) {
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    rgba = resizeRgba(rgba, width, height, w, h)
    width = w
    height = h
    console.log(`  resized to ${width}x${height} (--max-dim ${MAX_DIM})`)
  }

  const webp = Buffer.from(await (await makeWebpEncoder())(rgba, width, height, QUALITY))
  mkdirSync(OUT_ASSETS, { recursive: true })
  writeFileSync(join(OUT_ASSETS, 'genesis-bg.webp'), webp)
  writeFileSync(
    OUT_JSON,
    JSON.stringify({
      _provenance: {
        source: 'GGG PoE2 game data via pathofexile-dat (breachtreepassivebackground.dds, BC7)',
        patch,
        captured: new Date().toISOString().slice(0, 10),
        note: 'Genesis background art (c) Grinding Gear Games. Not affiliated with or endorsed by GGG.',
      },
      w: width,
      h: height,
      native: { w: img.width, h: img.height },
    }),
  )
  console.log(`\nWrote src/assets/tree/genesis-bg.webp  ${width}x${height}  ${kb(webp.length)} (q=${QUALITY})`)
  logDone(t0)
}

runMain('build-genesis-bg', main)
