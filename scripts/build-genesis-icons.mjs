// Offline builder: GENESIS tree node art -> one variable-size packed atlas + lookup table.
// Packs, at FULL /4k/ NATIVE resolution (no downscale — owner wants full res):
//   - the 8 generic "Keepers*" category icons (from each node's PassiveSkills.Icon_DDSFile)
//   - the authentic Breach node FRAME rings, NORMAL (small nodes) + FANCY (notables), per state
//   - the Womb socket egg (the vertical nest + square item-slot hole), per state
// Each tile keeps its native pixels (packAtlasVariable shelf-packs variable w×h). The renderer scales
// each source rect to the on-screen node size, so full-res art is crisp when zoomed in.
//
//   node scripts/build-genesis-icons.mjs [--quality 88]   (npm run data:genesis-icons)
//
// Source: the /4k/ sibling of each path (higher-res); falls back to the base path if absent. Fetched
// cache-first at the LIVE patch (_workbench/data-extract/.work/.cache-live — the pinned 4.5.2.1.2 cache rolled off
// the breach art; .dds is path-keyed/patch-stable). Outputs: src/assets/tree/genesis-icons.webp +
// src/data/genesisIcons.json (rects keyed by the BASE dds path, so node.icon / GENESIS_FRAME_PATHS /
// GENESIS_WOMB_PATHS resolve directly). Art (c) Grinding Gear Games; not affiliated.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, argValue, kb, logDone, runMain } from './lib.mjs'
import {
  createDdsLoader,
  fetchDds,
  decodeDds,
  forceOpaque,
  packAtlasVariable,
  writeWebpAtlas,
  to4k,
} from './lib-dds.mjs'
import { probePatchServer } from './patch-version.mjs'

const CACHE_LIVE = join(ROOT, '_workbench', 'data-extract', '.work', '.cache-live')
const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'genesisIcons.json')

const QUALITY = Number(argValue('--quality') ?? 88)
const ATLAS_W = Number(argValue('--atlas-w') ?? 1024)

const BREACH = 'art/textures/interface/2d/2dart/uiimages/ingame/breachleague/'
// Node frames + Womb egg states packed alongside the Keepers icons. Keys MUST match GENESIS_FRAME_PATHS
// + GENESIS_WOMB_PATHS in src/genesis/index.ts. node.icon already supplies the 8 Keepers icons + the
// NORMAL-state egg + the normal small frame? no — only icons come from node.icon; all frames/egg-states here.
const FRAME = (n) => `${BREACH}breachtreepassiveskillscreenpassiveframe${n}.dds`
const FANCY = (n) => `${BREACH}breachtreefancypassiveskillscreenpassiveframe${n}.dds`
const EGG = (n) => `${BREACH}breachtreeinventoryslot1x1${n}.dds`
const EXTRA_ART = [
  FRAME('normal'),
  FRAME('canallocate'),
  FRAME('active'), // small-node ring frame, per state
  FANCY('normal'),
  FANCY('canallocate'),
  FANCY('active'), // notable ring frame (bigger/ornate), per state
  EGG('canallocate'),
  EGG('active'), // the Womb egg (EGG('') = the normal state comes via node.icon)
]
const KEEP_ALPHA = /passiveframe|inventoryslot/i // ring/socket art that must keep its real transparency

/** Fetch the /4k/ variant if present, else the base path. Returns { buf, usedPath }. */
async function fetchBest(loader, dds) {
  try {
    return { buf: await fetchDds(loader, to4k(dds)), usedPath: to4k(dds) }
  } catch {
    return { buf: await fetchDds(loader, dds), usedPath: dds }
  }
}

async function main() {
  const t0 = Date.now()
  const genesisGraph = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'genesisGraph.json'), 'utf8'))

  const distinct = [
    ...new Set([
      ...Object.values(genesisGraph.nodes)
        .map((n) => n.icon)
        .filter(Boolean),
      ...EXTRA_ART,
    ]),
  ]
  console.log(`Genesis art pieces: ${distinct.length} — fetching /4k/ + decoding at full native res...`)

  const patch = (await probePatchServer()).patch
  const loader = await createDdsLoader(CACHE_LIVE, patch)
  const tiles = []
  const misses = []
  const formatCounts = new Map()
  let used4k = 0
  for (const dds of distinct) {
    try {
      const { buf, usedPath } = await fetchBest(loader, dds)
      if (usedPath !== dds) used4k++
      const img = decodeDds(buf, usedPath)
      formatCounts.set(img.fmtName, (formatCounts.get(img.fmtName) ?? 0) + 1)
      // Keepers icons are opaque squares — force full alpha so the round frame fills with no see-through.
      // The ring FRAMES + Womb egg are transparent-centre art drawn uncropped — keep their real alpha.
      if (!KEEP_ALPHA.test(dds)) forceOpaque(img.rgba)
      tiles.push({ key: dds, w: img.width, h: img.height, pixels: img.rgba }) // NATIVE size, no downscale
    } catch (e) {
      misses.push({ dds, reason: e.message })
    }
  }
  console.log(
    `Decoded ${tiles.length}/${distinct.length} at native (${used4k} from /4k/; formats: ${[...formatCounts.entries()].map(([f, n]) => `${f}=${n}`).join(', ')})`,
  )
  if (misses.length) {
    console.warn(`WARN: ${misses.length} piece(s) failed — those nodes keep the dot fallback:`)
    for (const m of misses) console.warn(`  ${m.dds}: ${m.reason}`)
  }
  if (!tiles.length) throw new Error('no genesis art decoded — refusing to write an empty sheet')

  const atlas = packAtlasVariable(tiles, ATLAS_W)
  const webp = await writeWebpAtlas(atlas, QUALITY, OUT_ASSETS, 'genesis-icons.webp')

  const table = {}
  for (const key of [...atlas.rects.keys()].sort()) table[key] = atlas.rects.get(key)
  const out = {
    _provenance: {
      source: 'GGG PoE2 game data via pathofexile-dat (Keepers icons + Breach frames/egg, /4k/ native)',
      patch,
      captured: new Date().toISOString().slice(0, 10),
      counts: { pieces: tiles.length, from4k: used4k, decodeMisses: misses.length },
      note: 'Genesis art (c) Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    _atlas: { w: atlas.width, h: atlas.height },
    ...table,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(
    `\nWrote src/assets/tree/genesis-icons.webp  ${atlas.width}x${atlas.height}  ${kb(webp.length)} (q=${QUALITY})`,
  )
  console.log(`Wrote src/data/genesisIcons.json          ${tiles.length} pieces  ${kb(JSON.stringify(out).length)}`)
  logDone(t0)
}

runMain('build-genesis-icons', main)
