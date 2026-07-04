// Offline builder: CLASS / ASCENDANCY ILLUSTRATIONS -> one packed atlas + lookup table.
// The gating prerequisite for the character-select / build-splash UI (Phase 6).
//
//   node scripts/build-class-art.mjs [--tile 512] [--quality 80] [--atlas-w 4096] [--budget 3.0]
//
// Source = GGG's PoE2 game data (the same datamine of GGG's patch CDN, via pathofexile-dat,
// that feeds every other vendored table/art file). Class + ascendancy portrait paths come
// straight from the canonical tree export (already mirrored into src/data/treeGraph.json as
// classes[].image and ascendancies[].image). Game art © Grinding Gear Games — repacked here,
// downscaled, into a single size-controlled webp so the bundle doesn't
// balloon (each native illustration is 1500x1500 BC7 ~= 3 MB of .dds).
//
// Inputs:
//   src/data/treeGraph.json            classes[].image / .image_offset_x / .image_offset_y,
//                                      classes[].ascendancies[].{id,image}
//   _workbench/data-extract/.work/.cache/         the extractor's CDN bundle cache (cache-first; .png art
//                                      paths are served as .dds — we swap the extension)
//   _workbench/data-extract/extract-meta.json     poe2Patch (for the loader + provenance)
//
// Format note: the export lists .png paths, but the live bundles serve these as DX10 BC7
// (DXGI 98) .dds at 1500x1500 — so the path chain is `<image>.png` -> swap to `.dds` ->
// decodeDds (BC7 is already supported in lib-dds.mjs). No PNG decoder is needed. If a future
// patch ships a format decodeDds can't read, that one illustration is counted a MISS and is
// simply ABSENT from the table — the splash falls back to text, we never ship wrong/fake art.
//
// Outputs:
//   src/assets/tree/class-art.webp     one packed atlas of the (downscaled) illustrations
//   src/data/class-art.json            { _provenance, _atlas, tile, frames, offsets,
//                                        byClass, byAscendancy }
//     frames        : "<image path>" -> {x,y,w,h}  (exact pixel box in the atlas)
//     offsets       : "<image path>" -> {x,y}      (GGG image_offset_x/y, classes only; for
//                                                   the UI to anchor the portrait like in-game)
//     byClass       : "<classIdx>"  -> "<image path>"
//     byAscendancy  : "<ascId>"     -> "<image path>"
//
// HARD ATLAS BUDGET + loud degradation ladder (illustrations are large — never silently
// truncate or drop art quietly): if over budget, drop tile size, then quality; only as a last
// resort drop ascendancy art (loudly, never base-class art). Modelled on build-item-icons.mjs.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ROOT, EXTRACT_CACHE as CACHE, argValue, kb, logDone, readExtractJson, runMain } from './lib.mjs'
import { createDdsLoader, fetchDds, decodeDds, resizeRgba, packAtlas, makeWebpEncoder } from './lib-dds.mjs'

const SELF = fileURLToPath(import.meta.url)
const TREE_GRAPH = join(ROOT, 'src', 'data', 'treeGraph.json')
const OUT_ASSETS = join(ROOT, 'src', 'assets', 'tree')
const OUT_JSON = join(ROOT, 'src', 'data', 'class-art.json')

// Native illustrations are 1500x1500; webp's pixel cap means one atlas can't hold ~31 of them
// at native. TILE caps the per-illustration square (mirrors build-passive-bg's --tile 1024
// rationale); 512 is plenty for a splash portrait and keeps the atlas well inside budget.
const TILE = Number(argValue('--tile') ?? 512)
const QUALITY = Number(argValue('--quality') ?? 80)
const ATLAS_W = Number(argValue('--atlas-w') ?? 4096)
const ATLAS_BUDGET = Number(argValue('--budget') ?? 3.0) * 1024 * 1024 // hard cap, encoded webp bytes

/** Swap a `.png` art path to the `.dds` the bundles actually serve. */
function toDds(p) {
  return p.replace(/\.png$/i, '.dds')
}

// ── isolated fetch+decode worker ─────────────────────────────────────────────
// pathofexile-dat's CdnBundleLoader calls process.exit(1) (NOT a throwable error) the moment
// a bundle 404s on the CDN — which DOES happen here: a couple of illustration bundle hashes
// have rotated off GGG's CDN for the pinned patch (observed: SorceressBaseIllustration,
// ShamanAscendancy -> HTTP 404). To keep one missing illustration from aborting the whole
// build, every fetch+decode runs in a CHILD PROCESS: a hard exit there is a contained MISS
// (that art is simply absent; the splash falls back to text), never a build-killer.
// Worker contract: `node build-class-art.mjs --worker <image> <outRgbaFile> <tile>`
//   -> writes the downscaled RGBA tile to <outRgbaFile> and prints `DIMS <w> <h> <fmt>`.
async function runWorker(image, outFile, tile) {
  const meta = readExtractJson('extract-meta.json')
  const loader = await createDdsLoader(CACHE, meta.poe2Patch)
  const buf = await fetchDds(loader, toDds(image))
  const img = decodeDds(buf, image)
  const scale = Math.min(1, tile / Math.max(img.width, img.height)) // never upscale
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const pixels = resizeRgba(img.rgba, img.width, img.height, w, h)
  writeFileSync(outFile, pixels)
  process.stdout.write(`DIMS ${w} ${h} ${img.fmtName}\n`)
}

/** Fetch+decode one illustration in an isolated child. Returns {w,h,pixels} or null on miss. */
function fetchTileIsolated(image, tile, tmpDir) {
  const outFile = join(tmpDir, `${[...image].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}.bin`)
  let stdout
  try {
    stdout = execFileSync('node', [SELF, '--worker', image, outFile, String(tile)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null // worker hard-exited (CDN 404) or threw — contained miss
  }
  const m = /DIMS (\d+) (\d+)/.exec(stdout)
  if (!m || !existsSync(outFile)) return null
  const w = Number(m[1])
  const h = Number(m[2])
  const pixels = readFileSync(outFile)
  if (pixels.length !== w * h * 4) return null
  return { w, h, pixels }
}

async function main() {
  // worker sub-invocation: do the one fetch+decode and exit (its failure is contained upstream)
  if (process.argv[2] === '--worker') {
    await runWorker(process.argv[3], process.argv[4], Number(process.argv[5]))
    return
  }

  const t0 = Date.now()
  if (!existsSync(CACHE)) {
    throw new Error(`missing ${CACHE} — run \`node scripts/extract-tables.mjs\` (or npm run data:extract) first`)
  }
  const meta = readExtractJson('extract-meta.json')
  const tree = JSON.parse(readFileSync(TREE_GRAPH, 'utf8'))

  // Collect every illustration we need from the tree export. byClass uses the class array index
  // (same key space the tree/atlas modules already use); byAscendancy uses the ascendancy id.
  const byClass = {} // classIdx -> image path
  const byAscendancy = {} // ascId -> image path
  const offsets = {} // image path -> {x,y} (classes carry GGG anchor offsets; ascendancies don't)
  const classImages = [] // ordered, base classes first (protected from the drop-ladder)
  const ascImages = []
  for (let idx = 0; idx < (tree.classes ?? []).length; idx++) {
    const c = tree.classes[idx]
    if (c?.image) {
      byClass[idx] = c.image
      classImages.push(c.image)
      offsets[c.image] = { x: c.image_offset_x ?? 0, y: c.image_offset_y ?? 0 }
    }
    for (const a of c?.ascendancies ?? []) {
      if (a?.id && a?.image) {
        byAscendancy[a.id] = a.image
        ascImages.push(a.image)
      }
    }
  }
  const classCount = classImages.length
  const ascCount = ascImages.length
  if (classCount < 6) throw new Error(`only ${classCount} class illustrations found in treeGraph.json`)
  console.log(`Illustrations wanted: ${classCount} class + ${ascCount} ascendancy = ${classCount + ascCount}`)

  // Fetch + decode each DISTINCT image once, each in an isolated child (see runWorker — the
  // loader hard-exits on a CDN 404, so isolation turns a missing bundle into a contained miss).
  const distinct = [...new Set([...classImages, ...ascImages])]
  const decoded = new Map() // image path -> { key, w, h, pixels } scaled to <= TILE
  const misses = [] // image paths that failed to fetch/decode (absent from the table)
  const tmpDir = mkdtempSync(join(tmpdir(), 'poe2-class-art-'))
  console.log(`Fetching + decoding ${distinct.length} distinct .dds (isolated, cache-first)...`)
  try {
    for (const image of distinct) {
      const tile = fetchTileIsolated(image, TILE, tmpDir)
      if (tile) decoded.set(image, { key: image, w: tile.w, h: tile.h, pixels: tile.pixels })
      else misses.push(image)
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  console.log(`Decoded ${decoded.size}/${distinct.length}`)
  if (misses.length) {
    console.warn(
      `WARN: ${misses.length} illustration(s) unreachable/undecodable — ABSENT from the table (UI falls back to text):`,
    )
    for (const m of misses) console.warn(`  ${m}`)
  }

  // Pack + encode, walking the degradation ladder until the encoded webp is within budget.
  // Rungs shrink the tile, then trade quality; the final rung drops ASCENDANCY art (loudly,
  // largest impact last) but NEVER base-class art. The atlas is keyed by image path, so the
  // same illustration shared by two slots is packed once.
  const encodeWebp = await makeWebpEncoder()
  // Build the active set as a Set of image paths; class images are always retained.
  const activeAsc = new Set(ascImages.filter((p) => decoded.has(p)))
  const activeClass = new Set(classImages.filter((p) => decoded.has(p)))
  const droppedAsc = []
  let result = null

  // ladder rungs: [tilePx, quality]; shrink first (sharpest size lever), then quality.
  const rungs = [
    [TILE, QUALITY],
    [Math.round(TILE * 0.75), QUALITY],
    [Math.round(TILE * 0.75), 65],
    [Math.round(TILE * 0.5), QUALITY],
    [Math.round(TILE * 0.5), 60],
  ]
  ladder: for (const [tilePx, quality] of rungs) {
    for (;;) {
      const wantImages = [...activeClass, ...activeAsc]
      const seen = new Set()
      const tiles = []
      for (const image of wantImages) {
        if (seen.has(image)) continue
        seen.add(image)
        const src = decoded.get(image)
        const scale = Math.min(1, tilePx / Math.max(src.w, src.h))
        const w = Math.max(1, Math.round(src.w * scale))
        const h = Math.max(1, Math.round(src.h * scale))
        const pixels = scale === 1 ? src.pixels : resizeRgba(src.pixels, src.w, src.h, w, h)
        tiles.push({ key: image, w, h, pixels })
      }
      // pack as a grid: all tiles are <= tilePx square, shelf-pack at fixed row height = tilePx
      tiles.sort((a, b) => b.w - a.w)
      const atlas = packAtlas(tiles, tilePx, ATLAS_W)
      const webp = Buffer.from(await encodeWebp(atlas.pixels, atlas.width, atlas.height, quality))
      console.log(
        `  try tile=${tilePx} q=${quality}: ${atlas.width}x${atlas.height}, ${tiles.length} tiles, ${kb(webp.length)}`,
      )
      if (webp.length <= ATLAS_BUDGET) {
        result = { atlas, webp, tile: tilePx, quality }
        break ladder
      }
      if (tilePx === rungs[rungs.length - 1][0] && quality === rungs[rungs.length - 1][1]) {
        // last rung still over budget: drop one ascendancy illustration (loudly) and retry.
        // Base-class art is never dropped — every playable class keeps its portrait.
        if (activeAsc.size === 0)
          throw new Error('atlas over budget with only base-class art left — raise --budget or lower --tile')
        const drop = [...activeAsc][activeAsc.size - 1]
        activeAsc.delete(drop)
        droppedAsc.push(drop)
        console.warn(`WARN: still over ${kb(ATLAS_BUDGET)} — DROPPING ascendancy art "${drop}"`)
        continue
      }
      break // next rung
    }
  }
  if (!result) throw new Error('unreachable: degradation ladder exhausted')

  // Emit the atlas + table. frames are keyed by image path; byClass/byAscendancy reference the
  // path, and any image that failed to decode/was dropped is simply absent from frames (callers
  // must treat a missing frame as "no art" and fall back to text — never invent art).
  mkdirSync(OUT_ASSETS, { recursive: true })
  writeFileSync(join(OUT_ASSETS, 'class-art.webp'), result.webp)

  const frames = {}
  for (const key of [...result.atlas.rects.keys()].sort()) frames[key] = result.atlas.rects.get(key)
  const mappedClasses = classImages.filter((p) => frames[p]).length
  const mappedAsc = ascImages.filter((p) => frames[p]).length

  const out = {
    _provenance: {
      source:
        'GGG PoE2 game data via pathofexile-dat (classes[].image / ascendancies[].image from the tree export, served as Art/2DArt/BaseClassIllustrations/*.dds)',
      patch: meta.poe2Patch,
      captured: new Date().toISOString().slice(0, 10),
      counts: {
        classes: mappedClasses,
        ascendancies: mappedAsc,
        artFiles: result.atlas.rects.size,
        decodeMisses: misses.length,
        droppedAscendancies: droppedAsc,
      },
      note: 'Class/ascendancy illustrations © Grinding Gear Games. Not affiliated with or endorsed by Grinding Gear Games.',
    },
    _atlas: { w: result.atlas.width, h: result.atlas.height, tile: result.tile, quality: result.quality },
    tile: result.tile,
    frames,
    offsets,
    byClass,
    byAscendancy,
  }
  writeFileSync(OUT_JSON, JSON.stringify(out))

  console.log(
    `\nWrote src/assets/tree/class-art.webp  ${result.atlas.width}x${result.atlas.height}  ${kb(result.webp.length)} (tile=${result.tile}, q=${result.quality})`,
  )
  console.log(
    `Wrote src/data/class-art.json         ${mappedClasses}/${classCount} classes + ${mappedAsc}/${ascCount} ascendancies -> ${result.atlas.rects.size} tiles  ${kb(JSON.stringify(out).length)}`,
  )
  if (misses.length) console.warn(`MISSES (absent from table): ${misses.length}`)
  if (droppedAsc.length) console.warn(`DROPPED ascendancy art (budget): ${droppedAsc.length}`)
  logDone(t0)
}

runMain('build-class-art', main)
