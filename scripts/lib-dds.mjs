// Shared DDS decode + atlas pack/encode helpers for the offline icon builders
// (build-item-icons.mjs = uncompressed item art; build-atlas-icons.mjs = BC1 skill icons).
// Single source of truth for the pixel pipeline — plain node, build-time only, never shipped.
//
// Supported DDS formats: DX10 uncompressed (R8G8B8A8 / B8G8R8A8, ±SRGB), DX10 BC1 (DXT1,
// the format the atlas skill icons use), and legacy 32-bit RGB(A). Any other format throws
// (the caller counts it a miss and the icon is simply absent — never wrong/invented art).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, EXTRACT, kb } from './lib.mjs'
import { decodeBC7 } from './bc7.mjs'

const PAD = 1 // 1px lossy-bleed guard between packed tiles

// ── DDS parsing ──────────────────────────────────────────────────────────────
const DXGI_UNCOMPRESSED = {
  28: { name: 'R8G8B8A8_UNORM', order: 'rgba' },
  29: { name: 'R8G8B8A8_UNORM_SRGB', order: 'rgba' },
  87: { name: 'B8G8R8A8_UNORM', order: 'bgra' },
  91: { name: 'B8G8R8A8_UNORM_SRGB', order: 'bgra' },
}
const DXGI_BC1 = new Set([71, 72]) // BC1_UNORM, BC1_UNORM_SRGB (DXT1)
const DXGI_BC7 = new Set([98, 99]) // BC7_UNORM, BC7_UNORM_SRGB (atlas background discs)

/** Expand an RGB565 value into [r,g,b] 0-255 (alpha set by caller). */
function rgb565(v, dst) {
  dst[0] = ((((v >> 11) & 31) * 255) / 31 + 0.5) | 0
  dst[1] = ((((v >> 5) & 63) * 255) / 63 + 0.5) | 0
  dst[2] = (((v & 31) * 255) / 31 + 0.5) | 0
}

/** Decode a BC1 (DXT1) block-compressed surface into a flat RGBA8 buffer. */
function decodeBC1(buf, offset, width, height) {
  const out = Buffer.alloc(width * height * 4)
  const bw = (width + 3) >> 2
  const bh = (height + 3) >> 2
  const c = [
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
  ]
  let p = offset
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const c0 = buf.readUInt16LE(p)
      const c1 = buf.readUInt16LE(p + 2)
      const bits = buf.readUInt32LE(p + 4)
      p += 8
      rgb565(c0, c[0])
      c[0][3] = 255
      rgb565(c1, c[1])
      c[1][3] = 255
      if (c0 > c1) {
        for (let k = 0; k < 3; k++) {
          c[2][k] = ((2 * c[0][k] + c[1][k] + 1) / 3) | 0
          c[3][k] = ((c[0][k] + 2 * c[1][k] + 1) / 3) | 0
        }
        c[2][3] = 255
        c[3][3] = 255
      } else {
        for (let k = 0; k < 3; k++) {
          c[2][k] = (c[0][k] + c[1][k]) >> 1
          c[3][k] = 0
        }
        c[2][3] = 255
        c[3][3] = 0 // 3-colour mode: index 3 is transparent
      }
      for (let i = 0; i < 16; i++) {
        const px = bx * 4 + (i & 3)
        const py = by * 4 + (i >> 2)
        if (px >= width || py >= height) continue
        const sel = c[(bits >> (i * 2)) & 3]
        const o = (py * width + px) * 4
        out[o] = sel[0]
        out[o + 1] = sel[1]
        out[o + 2] = sel[2]
        out[o + 3] = sel[3]
      }
    }
  }
  return out
}

/** Parse a .dds buffer into { width, height, rgba, fmtName } or throw with the format name. */
export function decodeDds(buf, path) {
  if (buf.length < 128 || buf.toString('ascii', 0, 4) !== 'DDS ') throw new Error(`${path}: not a DDS file`)
  const height = buf.readUInt32LE(12)
  const width = buf.readUInt32LE(16)
  const pfFlags = buf.readUInt32LE(80)
  const fourcc = buf.toString('ascii', 84, 88)
  if (pfFlags & 0x4 && fourcc === 'DX10') {
    const dxgi = buf.readUInt32LE(128)
    const offset = 148
    if (DXGI_BC1.has(dxgi)) {
      return { width, height, rgba: decodeBC1(buf, offset, width, height), fmtName: `BC1(${dxgi})` }
    }
    if (DXGI_BC7.has(dxgi)) {
      return { width, height, rgba: decodeBC7(buf, offset, width, height), fmtName: `BC7(${dxgi})` }
    }
    const fmt = DXGI_UNCOMPRESSED[dxgi]
    if (!fmt) throw new Error(`${path}: unsupported DXGI ${dxgi}`)
    return { width, height, rgba: copyUncompressed(buf, offset, width, height, fmt.order), fmtName: fmt.name }
  }
  if (pfFlags & 0x4) throw new Error(`${path}: unsupported FourCC ${fourcc}`)
  if (pfFlags & 0x40 && buf.readUInt32LE(88) === 32) {
    const rMask = buf.readUInt32LE(92)
    const order = rMask === 0xff ? 'rgba' : rMask === 0xff0000 ? 'bgra' : null
    if (!order) throw new Error(`${path}: unsupported legacy masks r=${rMask.toString(16)}`)
    return {
      width,
      height,
      rgba: copyUncompressed(buf, 128, width, height, order),
      fmtName: `legacy ${order.toUpperCase()}32`,
    }
  }
  throw new Error(`${path}: unsupported flags=0x${pfFlags.toString(16)}`)
}

function copyUncompressed(buf, offset, width, height, order) {
  const need = offset + width * height * 4
  if (buf.length < need) throw new Error(`truncated (${buf.length} < ${need})`)
  let rgba = buf.subarray(offset, need) // top mip first; later mips ignored
  if (order === 'bgra') {
    rgba = Buffer.from(rgba)
    for (let i = 0; i < rgba.length; i += 4) {
      const b = rgba[i]
      rgba[i] = rgba[i + 2]
      rgba[i + 2] = b
    }
  }
  return rgba
}

// ── premultiplied-alpha box-filter downscale ─────────────────────────────────
/** Area-average resample of RGBA8 (handles fractional ratios; premultiplies to avoid halos). */
export function resizeRgba(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4)
  const xr = sw / dw
  const yr = sh / dh
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = dy * yr
    const sy1 = Math.min((dy + 1) * yr, sh)
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = dx * xr
      const sx1 = Math.min((dx + 1) * xr, sw)
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        area = 0
      for (let sy = Math.floor(sy0); sy < sy1; sy++) {
        const cy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
        for (let sx = Math.floor(sx0); sx < sx1; sx++) {
          const cx = Math.min(sx + 1, sx1) - Math.max(sx, sx0)
          const w = cx * cy
          const i = (sy * sw + sx) * 4
          const av = src[i + 3] / 255
          r += src[i] * av * w
          g += src[i + 1] * av * w
          b += src[i + 2] * av * w
          a += src[i + 3] * w
          area += w
        }
      }
      const o = (dy * dw + dx) * 4
      const aOut = a / area
      const un = aOut > 0 ? 255 / aOut : 0 // un-premultiply
      dst[o] = Math.min(255, Math.round((r / area) * un))
      dst[o + 1] = Math.min(255, Math.round((g / area) * un))
      dst[o + 2] = Math.min(255, Math.round((b / area) * un))
      dst[o + 3] = Math.round(aOut)
    }
  }
  return dst
}

// ── atlas packing + encoding ─────────────────────────────────────────────────
/** Blit each tile's pixels into a fresh atlas buffer at its packed rect — the tail both packers share. */
function blitTiles(tiles, rects, atlasW, height) {
  const pixels = Buffer.alloc(atlasW * height * 4)
  for (const t of tiles) {
    const r = rects.get(t.key)
    for (let row = 0; row < t.h; row++) {
      t.pixels.copy(pixels, ((r.y + row) * atlasW + r.x) * 4, row * t.w * 4, (row + 1) * t.w * 4)
    }
  }
  return pixels
}

/** Shelf-pack fixed-height tiles; returns { width, height, rects: Map<key, rect>, pixels }. */
export function packAtlas(tiles, tileH, atlasW) {
  let x = PAD
  let y = PAD
  const rowH = tileH + PAD
  const rects = new Map()
  for (const t of tiles) {
    if (x + t.w + PAD > atlasW) {
      x = PAD
      y += rowH
    }
    rects.set(t.key, { x, y, w: t.w, h: tileH })
    x += t.w + PAD
  }
  const height = y + rowH
  return { width: atlasW, height, rects, pixels: blitTiles(tiles, rects, atlasW, height) }
}

/** Shelf-pack tiles at their NATIVE (variable w×h) sizes — no downscale. Tiles keep their own w/h
 *  (each rect = native size); rows grow to the tallest tile. Sort by height desc for tighter packing.
 *  Returns { width, height, rects: Map<key,{x,y,w,h}>, pixels }. (vs packAtlas which forces one tile size.) */
export function packAtlasVariable(tiles, atlasW) {
  const sorted = [...tiles].sort((a, b) => b.h - a.h)
  let x = PAD
  let y = PAD
  let rowH = 0
  const rects = new Map()
  for (const t of sorted) {
    if (x + t.w + PAD > atlasW) {
      x = PAD
      y += rowH + PAD
      rowH = 0
    }
    rects.set(t.key, { x, y, w: t.w, h: t.h })
    x += t.w + PAD
    if (t.h > rowH) rowH = t.h
  }
  const height = y + rowH + PAD
  return { width: atlasW, height, rects, pixels: blitTiles(sorted, rects, atlasW, height) }
}

/** Encode a packed atlas to webp and write it to `outDir/filename`; returns the webp Buffer.
 *  Pass a pre-made `encodeWebp` when the script encodes more than one image (the wasm encoder
 *  inits once); the default makes its own. (Dedupe refactor while green: the identical
 *  pack→encode→mkdir→write tails across the packer scripts.) */
export async function writeWebpAtlas(atlas, quality, outDir, filename, encodeWebp = null) {
  const enc = encodeWebp ?? (await makeWebpEncoder())
  const webp = Buffer.from(await enc(atlas.pixels, atlas.width, atlas.height, quality))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, filename), webp)
  return webp
}

export async function makeWebpEncoder() {
  const { init, default: encode } = await import('@jsquash/webp/encode.js')
  const wasm = readFileSync(join(ROOT, 'node_modules', '@jsquash', 'webp', 'codec', 'enc', 'webp_enc_simd.wasm'))
  await init(await WebAssembly.compile(wasm))
  return (pixels, width, height, quality) =>
    encode({ data: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length), width, height }, { quality })
}

/** Decode a .webp buffer to { width, height, rgba:Buffer }. Used to repack sprite sheets from
 *  GGG's poe2-skilltree-export (build-passive-bg.mjs) — the inverse of makeWebpEncoder. */
export async function makeWebpDecoder() {
  const { init, default: decode } = await import('@jsquash/webp/decode.js')
  const wasm = readFileSync(join(ROOT, 'node_modules', '@jsquash', 'webp', 'codec', 'dec', 'webp_dec.wasm'))
  await init(await WebAssembly.compile(wasm))
  return async (buf) => {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const img = await decode(ab)
    return {
      width: img.width,
      height: img.height,
      rgba: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length),
    }
  }
}

/** Crop a sub-rect out of an RGBA buffer into a new tight RGBA buffer. */
export function cropRgba(src, sw, _sh, rx, ry, rw, rh) {
  const dst = Buffer.alloc(rw * rh * 4)
  for (let y = 0; y < rh; y++) {
    const srcStart = ((ry + y) * sw + rx) * 4
    src.copy(dst, y * rw * 4, srcStart, srcStart + rw * 4)
  }
  return dst
}

// ── CDN .dds loader (cache-first via pathofexile-dat, same as extract-tables) ─
export async function createDdsLoader(cacheDir, patch) {
  const loaders = await import(
    pathToFileURL(join(ROOT, 'node_modules', 'pathofexile-dat', 'dist', 'cli', 'bundle-loaders.js')).href
  )
  return loaders.FileLoader.create(await loaders.CdnBundleLoader.create(cacheDir, patch))
}

/** Prefer the live game install (POE2_INSTALL, patch-matched to the vendored data); fall back to
 *  the CDN cache at the extract-meta patch. (Dedupe refactor while green: MOVED VERBATIM from its
 *  two identical copies in build-atlas-master-icons.mjs and build-atlas-master-portraits.mjs.) */
export async function createInstallOrCdnLoader(install, cacheDir) {
  const loaders = await import(
    pathToFileURL(join(ROOT, 'node_modules', 'pathofexile-dat', 'dist', 'cli', 'bundle-loaders.js')).href
  )
  try {
    if (!install) throw new Error('POE2_INSTALL not set')
    const loader = await loaders.FileLoader.create(new loaders.SteamBundleLoader(install))
    console.log(`loader: SteamBundleLoader(${install})`)
    return loader
  } catch (e) {
    console.warn(`Steam loader failed (${e.message}); falling back to CDN cache`)
    const meta = JSON.parse(readFileSync(join(EXTRACT, 'extract-meta.json'), 'utf8'))
    return createDdsLoader(cacheDir, meta.poe2Patch)
  }
}

/** The /4k/ sibling of a game .dds path: insert "4k/" before the filename. NOTE: /4k/ is NOT
 *  always the larger asset (see build-passive-jewels.mjs — the Abyss circles' non-4k path is
 *  bigger) — callers that blindly prefer it must tolerate that. (Dedupe refactor while green:
 *  MOVED VERBATIM from the identical copies in build-emotion-icons.mjs and build-genesis-icons.mjs.) */
export const to4k = (p) => p.replace(/\/([^/]+)$/, '/4k/$1')

/** Force full alpha on opaque square illustrations — BC1 3-colour blocks would otherwise punch
 *  see-through holes the renderer's round frame exposes. (Dedupe refactor while green: MOVED
 *  VERBATIM from the identical loops in build-atlas-icons.mjs and build-conqueror-icons.mjs.) */
export function forceOpaque(rgba) {
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
  return rgba
}

/** Multiply RGB (not alpha) by a factor, clamped — match the in-game brighter rendering.
 *  (Dedupe refactor while green: MOVED VERBATIM from its three identical copies in
 *  build-atlas-bg.mjs, build-genesis-bg.mjs and build-passive-jewels.mjs.) */
export function brighten(rgba, f) {
  if (f === 1) return rgba
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = Math.min(255, rgba[i] * f)
    rgba[i + 1] = Math.min(255, rgba[i + 1] * f)
    rgba[i + 2] = Math.min(255, rgba[i + 2] * f)
  }
  return rgba
}

/** Fetch + decode each distinct .dds once, mapping the image through `mapImg(img, dds)` into the
 *  returned Map; failures are collected + logged with `failNote`, never thrown. (Dedupe refactor
 *  while green: the shared skeleton of the identical decode loops in build-atlas-icons.mjs,
 *  build-conqueror-icons.mjs, build-atlas-master-icons.mjs, build-item-icons.mjs and
 *  build-unique-icons.mjs.) */
export async function decodeEach(loader, ddsList, mapImg, failNote) {
  const decoded = new Map()
  const misses = []
  const formatCounts = new Map()
  for (const dds of ddsList) {
    try {
      const img = decodeDds(await fetchDds(loader, dds), dds)
      formatCounts.set(img.fmtName, (formatCounts.get(img.fmtName) ?? 0) + 1)
      decoded.set(dds, mapImg(img, dds))
    } catch (e) {
      misses.push({ dds, reason: e.message })
    }
  }
  console.log(
    `Decoded ${decoded.size}/${ddsList.length} (formats: ${[...formatCounts.entries()].map(([f, n]) => `${f}=${n}`).join(', ')})`,
  )
  if (misses.length) {
    console.warn(`WARN: ${misses.length} art file(s) failed — ${failNote}`)
    for (const m of misses) console.warn(`  ${m.dds}: ${m.reason}`)
  }
  return { decoded, misses }
}

/** Decode each distinct art file referenced by a `byName` table into aspect-preserving,
 *  `tileH`-high tiles. Returns { decoded, misses, distinct }. (Dedupe refactor while green: the
 *  identical decode stages of build-item-icons.mjs and build-unique-icons.mjs.) */
export async function decodeAspectTiles(loader, byName, tileH, failNote) {
  const distinctDds = [...new Set([...byName.values()].map((b) => b.dds))]
  console.log(`Distinct art files: ${distinctDds.length} — fetching + decoding...`)
  const { decoded, misses } = await decodeEach(
    loader,
    distinctDds,
    (img, dds) => {
      const w = Math.max(1, Math.round((img.width / img.height) * tileH))
      return { key: dds, w, h: tileH, pixels: resizeRgba(img.rgba, img.width, img.height, w, tileH) }
    },
    failNote,
  )
  return { decoded, misses, distinct: distinctDds.length }
}

/** Walk the atlas degradation ladder (full quality → q60 → half-size → half-size q60) until the
 *  webp fits `budget`; on the last rung, `dropOne(activeNames)` applies the caller's drop policy
 *  (returns the shrunken map, throws when nothing droppable) and the rung retries. (Dedupe
 *  refactor while green: the identical ladder drivers of build-item-icons.mjs and
 *  build-unique-icons.mjs — only their drop policies differ.) */
export async function packWithBudgetLadder({
  byName,
  decoded,
  quality,
  baseTileH,
  atlasW,
  budget,
  encodeWebp,
  dropOne,
}) {
  let activeNames = byName
  for (const [scale, q] of [
    [1, quality],
    [1, 60],
    [0.5, quality],
    [0.5, 60],
  ]) {
    for (;;) {
      const { atlas, webp, tileH } = await packTierAttempt(activeNames, decoded, {
        scale,
        quality: q,
        baseTileH,
        atlasW,
        encodeWebp,
      })
      if (webp.length <= budget) return { atlas, webp, tileH, quality: q, activeNames }
      if (scale === 0.5 && q === 60) {
        activeNames = dropOne(activeNames)
        continue
      }
      break // move to the next ladder rung
    }
  }
  throw new Error('unreachable: degradation ladder exhausted')
}

/** One rung of the atlas budget ladder: rescale tiles to `scale`, shelf-pack, webp-encode at
 *  `quality`. The caller owns the ladder loop + its drop policy. (Dedupe refactor while green:
 *  the identical inner attempt of build-item-icons.mjs and build-unique-icons.mjs.) */
export async function packTierAttempt(activeNames, decoded, { scale, quality, baseTileH, atlasW, encodeWebp }) {
  const tileH = Math.round(baseTileH * scale)
  const tilesByDds = new Map()
  for (const b of activeNames.values()) {
    const t = decoded.get(b.dds)
    if (!t || tilesByDds.has(b.dds)) continue
    tilesByDds.set(
      b.dds,
      scale === 1 ? t : { key: t.key, w: Math.max(1, Math.round(t.w * scale)), h: tileH, pixels: null },
    )
  }
  const tiles = [...tilesByDds.values()].map((t) =>
    t.pixels ? t : { ...t, pixels: resizeRgba(decoded.get(t.key).pixels, decoded.get(t.key).w, baseTileH, t.w, t.h) },
  )
  tiles.sort((a, b) => b.w - a.w) // widest first = densest shelves
  const atlas = packAtlas(tiles, tileH, atlasW)
  const webp = Buffer.from(await encodeWebp(atlas.pixels, atlas.width, atlas.height, quality))
  console.log(
    `  try tileH=${tileH} q=${quality}: ${atlas.width}x${atlas.height}, ${kb(webp.length)} (${tiles.length} tiles)`,
  )
  return { atlas, webp, tileH }
}

/** Fetch a .dds, following the '*<path>' redirect stub the bundles sometimes use. */
export async function fetchDds(loader, path) {
  let buf = Buffer.from(await loader.getFileContents(path))
  if (buf[0] === 0x2a) buf = Buffer.from(await loader.getFileContents(buf.toString('utf8', 1).trim()))
  return buf
}
