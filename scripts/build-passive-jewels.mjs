// Offline builder: PASSIVE-tree JEWEL-SOCKET radius rings (the coloured circle around a socketed
// radius jewel). In-game it's TWO concentric counter-rotating rings per faction (…1 + …2; the generic
// uses …1 + …1Inverse). Source = GAME BC7 art — the poe2-skilltree-export ships a much lower-res webp
// (281px), which read blurry, so we extract the game textures directly. Each frame is packed at its OWN
// native resolution (capped at MAXTILE) via a variable-size shelf pack — the radius rings draw very large
// on screen, so the genuinely hi-res sources (Abyss/Oracle = 1024², generic /4k/ = 692²) ship full-res
// while the 512-564px historic factions stay native without being wastefully upscaled.
//
// NOTE on GGG's "/4k/" subfolder: it is NOT always the larger asset. For the Abyss circles the non-4k
// path is 1024² while the /4k/ sibling is a 692² screen-fit re-export, so Abyss deliberately uses the
// NON-4k path; the generic JewelCircle1 is the reverse (4k 692² > base 512²). Verified vs patch 4.5.2.1.2.
//
//   node scripts/build-passive-jewels.mjs [--max-tile 1024] [--quality 90] [--brighten 1.0]
//
// Outputs:
//   src/assets/tree/jewel-radius.webp   packed atlas of the ring frames (variable-size shelf pack)
//   src/data/jewelRadius.json           { frames:{<key>:{x,y,w,h}}, _atlas }

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, EXTRACT_CACHE as CACHE, argValue, kb, logDone, readExtractJson, runMain } from './lib.mjs'
import {
  createDdsLoader,
  fetchDds,
  decodeDds,
  resizeRgba,
  brighten,
  packAtlasVariable,
  writeWebpAtlas,
} from './lib-dds.mjs'

const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'jewelRadius.json')
const MAXTILE = Number(argValue('--max-tile') ?? 1024) // cap; each frame ships at min(native, MAXTILE)
const QUALITY = Number(argValue('--quality') ?? 90)
const ATLAS_W = Number(argValue('--atlas-w') ?? 2048)
const BRIGHTEN = Number(argValue('--brighten') ?? 1.0) // rings are already vivid; render alpha dims them

const DIR = 'art/textures/interface/2d/2dart/uiimages/ingame/'
// frame key (used by render/main) -> full game .dds basename. Prefixes vary (most are
// "passiveskillscreen<faction>", but abyss/oracle prefix the faction). Two rings per faction:
// historic factions use …1 + …2; abyss/generic use …1 + …1inverse.
const FRAMES = {
  AbyssJewelCircle1: 'abyss/abysspassiveskillscreenjewelcircle1', // green — the Abyssals (e.g. Undying Hate); non-4k = 1024² (larger than the /4k/ 692² sibling)
  AbyssJewelCircle1Inverse: 'abyss/abysspassiveskillscreenjewelcircle1inverse',
  VaalJewelCircle1: 'passiveskillscreenvaaljewelcircle1',
  VaalJewelCircle2: 'passiveskillscreenvaaljewelcircle2',
  TemplarJewelCircle1: 'passiveskillscreentemplarjewelcircle1',
  TemplarJewelCircle2: 'passiveskillscreentemplarjewelcircle2',
  MarakethJewelCircle1: 'passiveskillscreenmarakethjewelcircle1',
  MarakethJewelCircle2: 'passiveskillscreenmarakethjewelcircle2',
  KaruiJewelCircle1: 'passiveskillscreenkaruijewelcircle1',
  KaruiJewelCircle2: 'passiveskillscreenkaruijewelcircle2',
  KalguurJewelCircle1: 'passiveskillscreenkalguuranjewelcircle1', // in-game spelling: "kalguuran"
  KalguurJewelCircle2: 'passiveskillscreenkalguuranjewelcircle2',
  EternalEmpireJewelCircle1: 'passiveskillscreeneternalempirejewelcircle1',
  EternalEmpireJewelCircle2: 'passiveskillscreeneternalempirejewelcircle2',
  OracleJewelCircle1: 'oraclepassiveskillscreenjewelcircle1', // 1024² native
  OracleJewelCircle2: 'oraclepassiveskillscreenjewelcircle2',
  JewelCircle1: '4k/passiveskillscreenjewelcircle1', // generic — the /4k/ variant (692²) IS larger than the 512² base here
  JewelCircle1Inverse: 'passiveskillscreenjewelcircle1inverse', // 512² (no /4k/ sibling)
}

// brighten + the variable-size shelf packer come from lib-dds (packAtlasVariable — these frames
// are 512-1024px squares of differing sizes, so the uniform-row packAtlas won't do).

async function main() {
  const t0 = Date.now()
  const meta = readExtractJson('extract-meta.json')
  const loader = await createDdsLoader(CACHE, meta.poe2Patch)

  const tiles = []
  const misses = []
  for (const [key, name] of Object.entries(FRAMES)) {
    try {
      const img = decodeDds(await fetchDds(loader, `${DIR}${name}.dds`), name)
      brighten(img.rgba, BRIGHTEN)
      const size = Math.min(MAXTILE, img.width) // square frames; ship at min(native, cap), never upscaled
      tiles.push({ key, w: size, h: size, pixels: resizeRgba(img.rgba, img.width, img.height, size, size) })
      console.log(`  ${key}: ${img.width}x${img.height} ${img.fmtName} -> ${size}`)
    } catch (e) {
      misses.push({ key, reason: e.message })
    }
  }
  if (misses.length) for (const m of misses) console.warn(`  ! ${m.key}: ${m.reason}`)

  const atlas = packAtlasVariable(tiles, ATLAS_W)
  const webp = await writeWebpAtlas(atlas, QUALITY, OUT_ASSETS, 'jewel-radius.webp')

  const frames = {}
  for (const key of [...atlas.rects.keys()].sort()) frames[key] = atlas.rects.get(key)
  const out = {
    _provenance: {
      source: 'GGG PoE2 game data via pathofexile-dat (passiveskillscreen*jewelcircle*, BC7)',
      patch: meta.poe2Patch,
      captured: new Date().toISOString().slice(0, 10),
      note: 'Jewel-radius ring art © Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    _atlas: { w: atlas.width, h: atlas.height, maxTile: MAXTILE },
    frames,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(`\nWrote src/assets/tree/jewel-radius.webp  ${atlas.width}x${atlas.height}  ${kb(webp.length)}`)
  console.log(`Wrote src/data/jewelRadius.json          ${tiles.length} frames  ${kb(JSON.stringify(out).length)}`)
  logDone(t0)
}

runMain('build-passive-jewels', main)
