// Read columns the open-source dat-schema leaves UNNAMED.
//
// The `pathofexile-dat` CLI exports NAMED columns only (scripts/extract-tables.mjs `columnsFor()` drops
// any column with no `name`), so real game data sitting in an unlabelled column never reaches our JSON.
// The unnamed columns ARE in the schema though — typed, just nameless — so their byte offsets are
// computable. This reads a `.datc64` table at that layout via the pathofexile-dat LIBRARY (the same path
// the CLI uses internally) and surfaces the unnamed columns as `_unmapped<i>`, letting us recover the
// VALUE from the live table without ever hardcoding it.
//
// Used for the atlas precursor art→world SCALE (AtlasPassiveSkillSubTrees col [12], an unnamed f32 = 4.5).
// Library: pathofexile-dat (MIT, (c) SnosMe). Reads the CDN bundle cache populated by extract-tables.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SCHEMA_URL } from 'pathofexile-dat-schema'
import { ROOT } from './lib.mjs'

// pathofexile-dat ships as ESM deep paths (no package "exports" for these internals) — import by file URL.
const DIST = pathToFileURL(join(ROOT, 'node_modules', 'pathofexile-dat', 'dist') + '/').href
const imp = (p) => import(DIST + p)

const VALID_FOR_POE2 = 2

/**
 * Build a reader header (name + byte offset + dat type descriptor) per schema column. `nameFor(c, i)`
 * names the unnamed ones (default `_unmapped<i>`; build-atlas-masters passes its overrides table).
 * Returns [{ h, name, type, unmapped }] — `h` is what pathofexile-dat's readColumn consumes.
 * (Dedupe refactor while green: the identical header loops of readDatTable below and
 * build-atlas-masters.mjs's readTable.)
 */
export function buildDatHeaders(sch, datFile, getHeaderLength, nameFor = (c, i) => c.name || `_unmapped${i}`) {
  const headers = []
  let offset = 0
  sch.columns.forEach((c, i) => {
    const int = (unsigned, size) => ({ unsigned, size })
    const integer =
      c.type === 'u16'
        ? int(true, 2)
        : c.type === 'u32'
          ? int(true, 4)
          : c.type === 'i16'
            ? int(false, 2)
            : c.type === 'i32'
              ? int(false, 4)
              : c.type === 'enumrow'
                ? int(false, 4)
                : undefined
    const h = {
      name: nameFor(c, i),
      offset,
      type: {
        array: c.array,
        interval: c.interval,
        integer,
        decimal: c.type === 'f32' ? { size: 4 } : undefined,
        string: c.type === 'string' ? {} : undefined,
        boolean: c.type === 'bool' ? {} : undefined,
        key: c.type === 'row' || c.type === 'foreignrow' ? { foreign: c.type === 'foreignrow' } : undefined,
      },
    }
    headers.push({ h, name: h.name, type: c.type, unmapped: !c.name })
    offset += getHeaderLength(h, datFile)
  })
  return headers
}

/**
 * Read a `Data/Balance/<name>.datc64` table — NAMED + UNNAMED columns — via the library and the dat-schema
 * byte layout. Returns `{ rows, columns }` (columns carry `{ name, type, unmapped }`) or `null` on any
 * failure (missing cache, schema fetch error, renamed file) so callers can fall back gracefully.
 *
 * @param {string} name        table name, e.g. "AtlasPassiveSkillSubTrees"
 * @param {object} opts
 * @param {string} opts.patch    patch version (the CDN cache key, e.g. "4.5.4.1")
 * @param {string} opts.cacheDir CDN bundle cache dir (_workbench/data-extract/.work/.cache)
 * @param {string} [opts.balanceDir="Data/Balance"]
 */
export async function readDatTable(name, { patch, cacheDir, balanceDir = 'Data/Balance' }) {
  try {
    const { readDatFile } = await imp('dat/dat-file.js')
    const { readColumn } = await imp('dat/reader.js')
    const { getHeaderLength } = await imp('dat/header.js')
    const { FileLoader, CdnBundleLoader } = await imp('cli/bundle-loaders.js')

    const schema = await (await fetch(SCHEMA_URL)).json()
    const cands = schema.tables.filter((t) => t.name === name)
    const sch = cands.find((t) => t.validFor & VALID_FOR_POE2) ?? cands[0]
    if (!sch) return null

    const loader = await FileLoader.create(await CdnBundleLoader.create(cacheDir, patch))
    const path = `${balanceDir}/${name}.datc64`
    const buf = (await loader.tryGetFileContents(path)) ?? (await loader.getFileContents(path))
    const datFile = readDatFile('.datc64', buf)

    // Build a header (name + byte offset) per schema column — unnamed ones become `_unmapped<i>`.
    const headers = buildDatHeaders(sch, datFile, getHeaderLength)

    const cols = headers.map((x) => readColumn(x.h, datFile))
    const rows = []
    for (let r = 0; r < datFile.rowCount; r++) {
      const row = {}
      headers.forEach((x, ci) => {
        row[x.name] = cols[ci][r]
      })
      rows.push(row)
    }
    return { rows, columns: headers.map((x) => ({ name: x.name, type: x.type, unmapped: x.unmapped })) }
  } catch (e) {
    console.warn(`  lib-dat: could not read ${name}.datc64 (${e.message}) — caller will fall back`)
    return null
  }
}
