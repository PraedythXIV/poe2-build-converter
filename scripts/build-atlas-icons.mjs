// Offline builder: ATLAS passive-tree node icons -> packed atlas + lookup table.
//
//   node scripts/build-atlas-icons.mjs [--tile 128] [--quality 80] [--atlas-w 2048]
//
// Inputs (_workbench/data-extract/ is gitignored — re-run `node scripts/extract-tables.mjs` if missing):
//   src/data/atlasGraph.json         the atlas graph (each node carries its .dds icon path)
//   _workbench/data-extract/.work/.cache/       pathofexile-dat CDN bundle cache (.dds fetched cache-first)
//
// Outputs:
//   src/assets/tree/atlas-icons.webp  one packed atlas of square node icons
//   src/data/atlasIcons.json          { "<dds path>": {x,y,w,h}, _atlas, _provenance }
//
// The atlas skill icons are DX10/BC1 (DXT1) block-compressed (verified against the live data)
// — decodeDds in lib-dds.mjs handles BC1. Any icon that fails
// to decode is logged and simply absent (the renderer keeps its dot/ring fallback — never
// invented art). Art © Grinding Gear Games; not affiliated.

// jscpd:ignore-start — ESM import boilerplate: each module MUST declare its own imports/paths;
// the shared code itself lives in lib.mjs / lib-dds.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, EXTRACT_CACHE as CACHE, argValue, kb, logDone, readExtractJson, runMain } from './lib.mjs'
import { createDdsLoader, resizeRgba, packAtlas, decodeEach, forceOpaque, writeWebpAtlas } from './lib-dds.mjs'

const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'atlasIcons.json')
// jscpd:ignore-end

const TILE = Number(argValue('--tile') ?? 128) // native icons run 64-232px; 128 captures the /4k/ siblings (88/176) and stays crisp at high zoom
const QUALITY = Number(argValue('--quality') ?? 80)
const ATLAS_W = Number(argValue('--atlas-w') ?? 2048)

async function main() {
  const t0 = Date.now()
  const meta = readExtractJson('extract-meta.json')
  const atlasGraph = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'atlasGraph.json'), 'utf8'))

  const distinct = [
    ...new Set(
      Object.values(atlasGraph.nodes)
        .map((n) => n.icon)
        .filter(Boolean),
    ),
  ]
  console.log(`Distinct atlas node icons: ${distinct.length} — fetching + decoding (BC1)...`)

  const loader = await createDdsLoader(CACHE, meta.poe2Patch)
  // opaque square illustrations (forceOpaque: no see-through in the round frame), fixed TILE
  const { decoded, misses } = await decodeEach(
    loader,
    distinct,
    (img, dds) => ({
      key: dds,
      w: TILE,
      h: TILE,
      pixels: resizeRgba(forceOpaque(img.rgba), img.width, img.height, TILE, TILE),
    }),
    'those nodes keep the dot fallback:',
  )
  const tiles = [...decoded.values()]

  const atlas = packAtlas(tiles, TILE, ATLAS_W)
  const webp = await writeWebpAtlas(atlas, QUALITY, OUT_ASSETS, 'atlas-icons.webp')

  const table = {}
  for (const key of [...atlas.rects.keys()].sort()) table[key] = atlas.rects.get(key)
  const out = {
    _provenance: {
      source: 'GGG PoE2 game data via pathofexile-dat (PassiveSkills.Icon_DDSFile, BC1/DXT1 art)',
      patch: meta.poe2Patch,
      captured: new Date().toISOString().slice(0, 10),
      counts: { icons: tiles.length, decodeMisses: misses.length },
      note: 'Atlas icon art © Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    _atlas: { w: atlas.width, h: atlas.height, tile: TILE },
    ...table,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(
    `\nWrote src/assets/tree/atlas-icons.webp  ${atlas.width}x${atlas.height}  ${kb(webp.length)} (tile=${TILE}, q=${QUALITY})`,
  )
  console.log(`Wrote src/data/atlasIcons.json          ${tiles.length} icons  ${kb(JSON.stringify(out).length)}`)
  logDone(t0)
}

runMain('build-atlas-icons', main)
