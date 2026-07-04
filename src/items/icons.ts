// Item art lookup: maps an item to its tile rect in a packed icon atlas, both built offline by
// scripts/build-item-icons.mjs (bases) + scripts/build-unique-icons.mjs (uniques) from our own
// pathofexile-dat extraction — real game art, zero network at runtime.
//
// - BASE art (src/assets/items/icons.webp + itemIcons.json): BaseItemTypes.ItemVisualIdentity ->
//   ItemVisualIdentity.DDSFile. EQUIPPABLE bases only. Used for normal/magic/rare items, whose
//   in-game art IS their base's art.
// - UNIQUE art (src/assets/items/unique-icons.webp + uniqueIcons.json): the unique's OWN art via
//   UniqueStashLayout.WordsKey -> Words.Text (name) + ItemVisualIdentityKey -> DDSFile. Keyed by
//   lowercased unique name. Used for unique/relic items.
//
// Both atlases scale every tile to a fixed height (_atlas.tileH px), width follows source aspect.
//
// Honesty contract: an unknown item returns null/'' — callers render NO art rather than wrong art.
// A unique's BASE art is NEVER shown as the unique's own (we look uniques up in the UNIQUE table
// only); a unique absent from that table (decode miss / budget drop) shows nothing, not base art.

import iconsJson from '../data/itemIcons.json'
import uniqueIconsJson from '../data/uniqueIcons.json'
import atlasUrl from '../assets/items/icons.webp'
import uniqueAtlasUrl from '../assets/items/unique-icons.webp'

/** Exact pixel box of one tile inside an atlas. */
export interface IconRect {
  x: number
  y: number
  w: number
  h: number
}

interface IconTable {
  [nameLower: string]: IconRect
}

interface AtlasMeta {
  w: number
  h: number
  tileH: number
}

// Cast away the giant literal type resolveJsonModule would infer (same pattern as tiers.ts);
// _provenance/_atlas are metadata, every other key is a lowercased name.
const { _provenance, _atlas, ...ICONS } = iconsJson as unknown as IconTable & {
  _provenance: { patch: string; captured: string }
  _atlas: AtlasMeta
}
const {
  _provenance: _uniqueProvenance,
  _atlas: _uniqueAtlas,
  ...UNIQUE_ICONS
} = uniqueIconsJson as unknown as IconTable & {
  _provenance: { patch: string; captured: string }
  _atlas: AtlasMeta
}

/** Vite asset URL of the packed base-art atlas (webp). */
export const itemIconsAtlasUrl: string = atlasUrl

/** Atlas pixel dimensions + the fixed tile height — for background-size/-position math. */
export const itemIconsAtlas: AtlasMeta = _atlas

export const itemIconsProvenance: { patch: string; captured: string } = _provenance

/** Lookup key: trim, collapse inner whitespace, lowercase (table keys are built the same way). */
function normalizeBaseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Normalize the name and read its tile rect from the given table, or null when absent/empty. */
function lookupIcon(name: string, table: IconTable): IconRect | null {
  if (!name) return null
  return table[normalizeBaseName(name)] ?? null
}

/**
 * Tile rect for an equippable base-type name, or null when the base is unknown (out-of-scope
 * class, art that failed to decode, or simply not a base) — null means "show no art".
 */
export function iconForBase(baseType: string): IconRect | null {
  return lookupIcon(baseType, ICONS)
}

/**
 * Tile rect for a UNIQUE/relic item's OWN art (keyed by lowercased unique name), or null when the
 * unique is absent from the vendored table (a decode miss or atlas-budget drop). This is the unique's
 * real in-game art — never its base art.
 */
function iconForUnique(name: string): IconRect | null {
  return lookupIcon(name, UNIQUE_ICONS)
}

/** Inline art <span> for one tile rect inside the given atlas (shared by base + unique rendering). */
function artSpan(rect: IconRect, atlas: AtlasMeta, url: string, displayH: number): string {
  const s = displayH / rect.h
  const px = (n: number): string => `${(n * s).toFixed(1)}px`
  return (
    `<span class="itc-art" aria-hidden="true" style="width:${px(rect.w)};height:${displayH}px;` +
    `background-image:url('${url}');background-size:${px(atlas.w)} ${px(atlas.h)};` +
    `background-position:${px(-rect.x)} ${px(-rect.y)}"></span>`
  )
}

/**
 * Inline art element for an item card header, or '' when no exact art exists.
 * UNIQUE/RELIC: the unique's OWN art (uniqueIcons table); '' only if it's not vendored — NEVER base art.
 * NORMAL/MAGIC/RARE: the base's real in-game art (baseType, then name — normals carry the base as name).
 */
export function itemArtHtml(item: { rarity: string; baseType: string; name: string }, displayH = 34): string {
  const r = item.rarity.toUpperCase()
  if (r === 'UNIQUE' || r === 'RELIC') {
    const rect = iconForUnique(item.name)
    return rect ? artSpan(rect, _uniqueAtlas, uniqueAtlasUrl, displayH) : ''
  }
  const rect = iconForBase(item.baseType) ?? iconForBase(item.name)
  return rect ? artSpan(rect, _atlas, atlasUrl, displayH) : ''
}
