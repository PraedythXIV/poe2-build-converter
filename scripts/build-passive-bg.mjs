// Offline builder: PASSIVE-tree CENTRAL ART (class/ascendancy disc + central ring) -> one packed
// atlas + table. Source = GGG's poe2-skilltree-export sprite sheets (same canonical source as the
// tree graph; github.com/grindinggear/poe2-skilltree-export — official GGG data, attribute, no
// ownership claim). We repack only the needed frames, downscaled, into a single size-controlled
// webp so the bundle doesn't balloon (the raw per-class sheets total ~4 MB).
//
//   node scripts/build-passive-bg.mjs [--ref <tag|sha>] [--tile 1024] [--quality 84]
//
// Render recipe (mirrors poe2-skilltree TreeCanvas drawCentralBackdrop/drawMainCircle):
//   - class disc  `class<Name>:Class<n>`  at world (0,0), size = avgClassStartRadius*2  (behind nodes)
//   - ring        `startNode:MainCircleActive` (rotated classAngle-WitchAngle) + `startNode:MainCircle`
//                 at world (0,0), size = avgClassStartRadius*2*1.36  (above nodes)
//   - n = 0 (no ascendancy) else the ascendancy's 1-based index in the class's FULL ascendancy array.
//
// Outputs:
//   src/assets/tree/passive-bg.webp   one packed atlas of the (downscaled) frames
//   src/data/passiveBg.json           { frames, discSize, ringSize, classFrame0, ascFrame, ringRotation, _atlas }

// jscpd:ignore-start — ESM import boilerplate: each module MUST declare its own imports/paths;
// the shared code itself lives in lib.mjs / lib-dds.mjs
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, DEFAULT_TREE_REF, argValue, getJson, fetchBytes, treeRawUrl, kb, logDone, runMain } from './lib.mjs'
import { makeWebpDecoder, cropRgba, resizeRgba, packAtlas, writeWebpAtlas } from './lib-dds.mjs'

const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'passiveBg.json')
const TILE = Number(argValue('--tile') ?? 1024) // class scenes native = 1500² but one atlas can't encode that
// many at native (webp pixel cap); 1024 = full-res for the disc's max on-screen size (~900px). The central
// ring wants more — it's extracted hi-res separately. True native would need per-class atlases.
const QUALITY = Number(argValue('--quality') ?? 84)
const ATLAS_W = Number(argValue('--atlas-w') ?? 4096)
const FRAME_TO_RING = 1.36 // ring overshoots the disc (poe2-skilltree FRAME_TO_RING_RATIO)
// jscpd:ignore-end

async function main() {
  const t0 = Date.now()
  const ref = argValue('--ref') ?? DEFAULT_TREE_REF
  console.log(`Fetching tree data.json @ ${ref}...`)
  const data = await getJson(treeRawUrl(ref, 'data.json'))

  // class-start node position per class index (node.classStartIndex pairs reference the class array idx)
  const startByClass = new Map()
  for (const n of Object.values(data.nodes ?? {})) {
    if (Array.isArray(n.classStartIndex) && typeof n.x === 'number')
      for (const ci of n.classStartIndex) if (!startByClass.has(ci)) startByClass.set(ci, { x: n.x, y: n.y })
  }
  // playable classes = those with ascendancies (same rule as build-tree-graph)
  const playable = []
  for (let idx = 0; idx < (data.classes ?? []).length; idx++) {
    const c = data.classes[idx]
    if (c.ascendancies?.length && startByClass.has(idx)) playable.push({ idx, name: c.name, asc: c.ascendancies })
  }
  if (playable.length < 6) throw new Error(`only ${playable.length} playable classes found`)

  const radii = playable.map((c) => Math.hypot(startByClass.get(c.idx).x, startByClass.get(c.idx).y))
  const avgRadius = radii.reduce((a, b) => a + b, 0) / radii.length
  const discSize = Math.round(avgRadius * 2)
  const ringSize = Math.round(avgRadius * 2 * FRAME_TO_RING)
  const angleOf = (idx) => {
    const p = startByClass.get(idx)
    return Math.atan2(p.y, p.x)
  }
  const witch = playable.find((c) => c.name === 'Witch') ?? playable[0]
  const witchAngle = angleOf(witch.idx)

  const classFrame0 = {} // classIndex -> "class<Name>:Class0"
  const ascFrame = {} // ascendancyId -> "class<Name>:Class<n>" (n = 1-based pos in FULL asc array)
  const ringRotation = {} // classIndex -> radians for MainCircleActive
  for (const c of playable) {
    classFrame0[c.idx] = `class${c.name}:Class0`
    ringRotation[c.idx] = +(angleOf(c.idx) - witchAngle).toFixed(4)
    c.asc.forEach((a, j) => {
      if (a?.id) ascFrame[a.id] = `class${c.name}:Class${j + 1}`
    })
  }

  // collect every frame we need (ring + each class's Class0..N), cropped from its source sheet + downscaled
  const decode = await makeWebpDecoder()
  const tiles = []
  const wanted = [{ atlas: 'group-background', keys: ['startNode:MainCircle', 'startNode:MainCircleActive'] }]
  for (const c of playable) wanted.push({ atlas: `background-${c.name.toLowerCase()}`, keys: null }) // null = all frames

  for (const { atlas, keys } of wanted) {
    const meta = await getJson(treeRawUrl(ref, `assets/${atlas}.json`))
    const sheet = decode(await fetchBytes(treeRawUrl(ref, `assets/${atlas}.webp`)))
    const img = await sheet
    const frameKeys = keys ?? Object.keys(meta.frames)
    for (const key of frameKeys) {
      const f = meta.frames[key]?.frame
      if (!f) {
        console.warn(`  ! ${atlas} missing frame ${key}`)
        continue
      }
      const cropped = cropRgba(img.rgba, img.width, img.height, f.x, f.y, f.w, f.h)
      tiles.push({ key, w: TILE, h: TILE, pixels: resizeRgba(cropped, f.w, f.h, TILE, TILE) })
    }
    console.log(`  ${atlas}: ${img.width}x${img.height} -> ${frameKeys.length} frame(s) @ ${TILE}px`)
  }

  const atlas = packAtlas(tiles, TILE, ATLAS_W)
  const webp = await writeWebpAtlas(atlas, QUALITY, OUT_ASSETS, 'passive-bg.webp')

  const frames = {}
  for (const key of [...atlas.rects.keys()].sort()) frames[key] = atlas.rects.get(key)
  const out = {
    _provenance: {
      source: `https://github.com/grindinggear/poe2-skilltree-export (assets/background-*, group-background)`,
      ref,
      captured: new Date().toISOString().slice(0, 10),
      note: 'Passive-tree central art © Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    _atlas: { w: atlas.width, h: atlas.height, tile: TILE },
    discSize,
    ringSize,
    classFrame0,
    ascFrame,
    ringRotation,
    frames,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(
    `\nWrote src/assets/tree/passive-bg.webp  ${atlas.width}x${atlas.height}  ${kb(webp.length)} (tile=${TILE}, q=${QUALITY})`,
  )
  console.log(`Wrote src/data/passiveBg.json          ${tiles.length} frames  ${kb(JSON.stringify(out).length)}`)
  console.log(`disc=${discSize} ring=${ringSize} (avgRadius=${avgRadius.toFixed(1)}); classes=${playable.length}`)
  logDone(t0)
}

runMain('build-passive-bg', main)
