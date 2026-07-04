// Offline builder: PASSIVE-tree MASTERY EFFECT art (the cluster "glow" patterns). Two states:
//   inactive (dim, always shown) + active (bright, shown once a connected notable is allocated).
// Source = GGG's poe2-skilltree-export `mastery-effect-disabled` + `mastery-effect-active` sheets
// (same canonical source as the tree graph). We repack only the distinct frames the live tree uses,
// plus a node-id -> effect map so the renderer needs no graph changes.
//
//   node scripts/build-passive-masteries.mjs [--ref <tag|sha>] [--tile 256] [--quality 86]
//
// Outputs:
//   src/assets/tree/passive-mastery.webp   packed atlas of distinct {active, inactive} effect frames
//   src/data/passiveMastery.json           { active:{<base>:{x,y,w,h,ww,wh}}, inactive:{…}, byNode:{<id>:<base>}, _atlas }

// jscpd:ignore-start — ESM import boilerplate: each module MUST declare its own imports/paths;
// the shared code itself lives in lib.mjs / lib-dds.mjs
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, DEFAULT_TREE_REF, argValue, getJson, fetchBytes, treeRawUrl, kb, logDone, runMain } from './lib.mjs'
import { makeWebpDecoder, cropRgba, resizeRgba, packAtlas, writeWebpAtlas } from './lib-dds.mjs'

const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'passiveMastery.json')
const TILE = Number(argValue('--tile') ?? 256) // >= native (~244px) — full res
const QUALITY = Number(argValue('--quality') ?? 86)
const ATLAS_W = Number(argValue('--atlas-w') ?? 2048)
const base = (p) =>
  p
    .split('/')
    .pop()
    .replace(/\.png$/i, '')
// jscpd:ignore-end

const STATES = [
  { state: 'active', atlas: 'mastery-effect-active', prefix: 'masteryEffectActive' },
  { state: 'inactive', atlas: 'mastery-effect-disabled', prefix: 'masteryEffectInactive' },
]

async function main() {
  const t0 = Date.now()
  const ref = argValue('--ref') ?? DEFAULT_TREE_REF
  console.log(`Fetching tree data.json @ ${ref}...`)
  const data = await getJson(treeRawUrl(ref, 'data.json'))

  const byNode = {}
  const pathByBase = new Map()
  for (const [id, n] of Object.entries(data.nodes)) {
    if (!n.isMastery || !n.activeEffectImage || n.ascendancyId) continue
    const b = base(n.activeEffectImage)
    byNode[id] = b
    if (!pathByBase.has(b)) pathByBase.set(b, n.activeEffectImage)
  }
  console.log(`  ${Object.keys(byNode).length} masteries, ${pathByBase.size} distinct effects`)

  const decode = await makeWebpDecoder()
  const tiles = []
  const native = new Map() // "<state>:<base>" -> {ww,wh}
  for (const { state, atlas, prefix } of STATES) {
    const meta = await getJson(treeRawUrl(ref, `assets/${atlas}.json`))
    const scale = Number.parseFloat(meta.meta.scale) || 1
    const sheet = await decode(await fetchBytes(treeRawUrl(ref, `assets/${atlas}.webp`)))
    let n = 0
    for (const [b, path] of pathByBase) {
      const f = meta.frames[`${prefix}:${path}`]?.frame
      if (!f) continue
      const w = Math.max(1, Math.round((f.w / f.h) * TILE))
      const cropped = cropRgba(sheet.rgba, sheet.width, sheet.height, f.x, f.y, f.w, f.h)
      const key = `${state}:${b}`
      tiles.push({ key, w, h: TILE, pixels: resizeRgba(cropped, f.w, f.h, w, TILE) })
      native.set(key, { ww: Math.round(f.w / scale), wh: Math.round(f.h / scale) })
      n++
    }
    console.log(`  ${atlas}: ${sheet.width}x${sheet.height} -> ${n} frames`)
  }

  const atlas = packAtlas(tiles, TILE, ATLAS_W)
  const webp = await writeWebpAtlas(atlas, QUALITY, OUT_ASSETS, 'passive-mastery.webp')

  const active = {}
  const inactive = {}
  for (const key of [...atlas.rects.keys()].sort()) {
    const r = atlas.rects.get(key)
    const [state, b] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    const entry = { x: r.x, y: r.y, w: r.w, h: r.h, ...native.get(key) }
    ;(state === 'active' ? active : inactive)[b] = entry
  }
  // keep byNode consistent: a mastery must have at least an inactive (or active) frame
  for (const [id, b] of Object.entries(byNode)) if (!active[b] && !inactive[b]) delete byNode[id]
  const out = {
    _provenance: {
      source: 'https://github.com/grindinggear/poe2-skilltree-export (assets/mastery-effect-active + -disabled)',
      ref,
      captured: new Date().toISOString().slice(0, 10),
      note: 'Passive mastery effect art © Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    _atlas: { w: atlas.width, h: atlas.height, tile: TILE },
    active,
    inactive,
    byNode,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(`\nWrote src/assets/tree/passive-mastery.webp  ${atlas.width}x${atlas.height}  ${kb(webp.length)}`)
  console.log(
    `Wrote src/data/passiveMastery.json          active=${Object.keys(active).length} inactive=${Object.keys(inactive).length} masteries=${Object.keys(byNode).length}  ${kb(JSON.stringify(out).length)}`,
  )
  logDone(t0)
}

runMain('build-passive-masteries', main)
