// ── jewel-socket model — the pure transform from a parsed build to per-socket JewelInfo ──
// Extracted from main.ts (structural refactor — behaviour/output unchanged). Builds the
// `Map<nodeId, JewelInfo>` the tree viewer consumes, including the radius/ring geometry and the
// curated per-faction art. Pure: no DOM, no module state mutated by callers — `computeJewelSockets`
// is a function of the parsed build alone.
import type { PobBuild } from '../convert/types'
import type { ConquerorType } from './render'
import type { JewelInfo, JewelRing } from './render'
import jewelRadiiData from '../data/jewelRadii.json'
import conquerorTreeVersionsData from '../data/conquerorTreeVersions.json'

// Radius jewels: socket node id -> { faction-circle frame, world diameter }. A jewel has a radius
// when its raw text carries a `Radius: <size>` property (our item parser skips that line, so we read
// the item's raw text). The radius SIZE varies (Small … Very Large); the faction only sets the colour.
// Empty for builds with no radius jewels.
// The per-size node-affecting radius comes from GGG's PassiveJewelRadii table (vendored by
// scripts/build-jewel-radii.mjs) — `diameter = 2 × Radius`, in tree-coordinate units. An unknown
// size returns null and we draw NO ring (never invent a radius — see the "nothing approximate" rule).
const JEWEL_RADII = (
  jewelRadiiData as { sizes: Record<string, { radius: number; ringInner: number; ringOuter: number }> }
).sizes
// Normalise a size name to a jewelRadii.json key: lowercase, drop spaces AND hyphens so both the
// disc `Radius: Very Large` line and the ring `… Medium-Large Ring` mod map onto "verylarge"/"mediumlarge".
const normSize = (s: string) => s.toLowerCase().replace(/[\s-]+/g, '')
// Shared normalise + JEWEL_RADII lookup (undefined on miss) — jewelDiameter and jewelRingBand both
// resolve the same per-size entry, only their result transform differs.
const radiiFor = (sizeText: string) => JEWEL_RADII[normSize(sizeText)]
function jewelDiameter(sizeText: string): number | null {
  const r = radiiFor(sizeText)
  return r ? r.radius * 2 : null
}
// A RING (annulus) jewel's affected band → { inner, outer } world DIAMETERS, from PassiveJewelRadii
// RingInner..RingOuter of the named size (stat `local_jewel_variable_ring_radius_value`, e.g.
// "Medium-Large Ring" → MediumLarge 1250..1550). Unknown size ⇒ null (no ring; never a guessed band).
function jewelRingBand(sizeText: string): { innerDiameter: number; outerDiameter: number } | null {
  const r = radiiFor(sizeText)
  return r ? { innerDiameter: r.ringInner * 2, outerDiameter: r.ringOuter * 2 } : null
}
// The two counter-rotating ring frames + the faction tint, matched from the jewel's mod text. The
// match GRANULARITY is the FACTION, not an individual conqueror: PoE2 ships a single generic Timeless
// Jewel (`Metadata/Items/Jewels/JewelTimeless`) + per-faction Timeless Splinters (Karui/Vaal/Maraketh/
// Templar/Eternal) — there are NO PoE1-style named-conqueror bases, and `Mods` carries no "commemorate
// <Conqueror>" implicit (datamine-verified 2026-06-27). So the FACTION NAME is the real PoE2 signal
// (the first alternative in each regex); the per-conqueror aliases (doryani/xibaqua/kaom/…) are PoE1
// lore carried as harmless fallbacks — there is no GGG name→faction table to source them from.
// `version` is the timeless-jewel ConquerorType (faction) the match implies — it drives the per-
// (faction,kind) conqueror node-art override (render.ts). Every `version` is one of GGG's sourced
// AlternateTreeVersions ConquerorTypes (render.ts CONQUEROR_BY_VERSION, derived from
// conquerorTreeVersions.json + pinned by tests/tree.test.ts). The frame art (`<Faction>JewelCircle…`)
// and tint are curated faction art/colour (GGG ships no tint, same as the atlas dots). GENERIC_RING /
// Time-Lost Diamonds name no faction, so they carry no version (neutral ring + tint, no node override).
type Faction = { frames: readonly [string, string]; tint: string; version?: ConquerorType }
const GENERIC_RING: Faction = { frames: ['JewelCircle1', 'JewelCircle1Inverse'], tint: '#6aa0ff' }
// Per-faction CURATED art + colour + match aliases — TS requires an entry for EVERY ConquerorType, so
// a faction GGG adds (caught first by tests/tree.test.ts pinning the union to conquerorTreeVersions.json)
// fails the build HERE until its art is supplied. `frames` are jewel-radius.webp keys (the curated ring
// art chosen per-faction in build-passive-jewels.mjs — GGG ships no faction radius-art table); `tint`
// recolours in-radius nodes (curated, like the atlas dots); `match` is the faction name + PoE1 lore aliases.
const FACTION_ART: Record<ConquerorType, { frames: readonly [string, string]; tint: string; match: RegExp }> = {
  Vaal: { frames: ['VaalJewelCircle1', 'VaalJewelCircle2'], tint: '#d23b3b', match: /vaal|doryani|xibaqua|ahuana/ }, // red
  Karui: { frames: ['KaruiJewelCircle1', 'KaruiJewelCircle2'], tint: '#d07a3a', match: /karui|kaom|rakiata|akoya/ }, // orange
  Maraketh: {
    frames: ['MarakethJewelCircle1', 'MarakethJewelCircle2'],
    tint: '#36c0c0',
    match: /maraketh|asenath|nasima|balbala/,
  }, // teal
  Templar: {
    frames: ['TemplarJewelCircle1', 'TemplarJewelCircle2'],
    tint: '#d9b54a',
    match: /templar|avarius|maxarius|dominus/,
  }, // gold
  Eternal: {
    frames: ['EternalEmpireJewelCircle1', 'EternalEmpireJewelCircle2'],
    tint: '#8a6fd0',
    match: /eternal|venarius|cadiro|caspiro/,
  }, // violet
  Kalguuran: { frames: ['KalguurJewelCircle1', 'KalguurJewelCircle2'], tint: '#b6864a', match: /kalguur|gulai/ }, // bronze
  Abyss: {
    frames: ['AbyssJewelCircle1', 'AbyssJewelCircle1Inverse'],
    tint: '#3fae5a',
    match: /abyssal|amanamu|kurgal|tecrod|ulaman/,
  }, // green
}
// The faction SET is DATA-DRIVEN: built by iterating GGG's sourced AlternateTreeVersions
// (conquerorTreeVersions.json — the same table render.ts derives CONQUEROR_BY_VERSION from), skipping
// the un-conquered 'None' base, and attaching each faction's curated art. A faction the data adds but
// FACTION_ART hasn't covered yet is simply skipped (its jewels fall back to GENERIC_RING) rather than
// shipping wrong art — and tree.test.ts flags the gap.
const JEWEL_FACTIONS: ReadonlyArray<[RegExp, Faction]> = (
  conquerorTreeVersionsData as unknown as { versions: { ConquerorType: string }[] }
).versions
  .map((v) => v.ConquerorType)
  .filter((f): f is ConquerorType => f !== 'None' && Object.prototype.hasOwnProperty.call(FACTION_ART, f))
  .map((version) => [
    FACTION_ART[version].match,
    { frames: FACTION_ART[version].frames, tint: FACTION_ART[version].tint, version },
  ])
/** A deterministic Time-Lost Diamond attribute swap, read EXACTLY from the jewel's own text
 *  ("…instead grant X" / "X → Y"). Only attached when both sides are nameable — never inferred. */
type JewelSwap = { from: string; to: string }
/** Strip PoB markup from a mod line: a leading {tag} and [tag|Display]/[tag] references. */
function cleanMod(m: string): string {
  return m
    .replace(/^\{[^}]*\}/, '')
    .replace(/\[([^\]|]+)\|([^\]]*)\]/g, '$2')
    .replace(/\[([^\]]+)\]/g, '$1')
    .trim()
}

// ── Time-Lost Diamond swap (exact, text-sourced only) ────────────────────────────────────────────
// The Diamond's per-node attribute swap is seed-and-node specific (its full per-node form is Phase 7
// / deferred). We surface a swap ONLY when the jewel's own (already markup-stripped) mod text states
// a nameable transform — an exact claim. The numeric PassiveJewelTransformations table confirms the
// transform is deterministic but is keyed by stat ids with no in-scope name table, so it is never
// rendered as approximate text. A jewel whose text states no swap simply carries no `swap`.
const SWAP_RE = /\b([A-Za-z][A-Za-z ]+?)\s*(?:→|->|to instead grant|instead grant(?:s)?)\s+([A-Za-z][A-Za-z ]+)\b/i
function readDiamondSwap(baseType: string | undefined, cleanedStats: readonly string[]): JewelSwap | undefined {
  if (!baseType || !/time-?lost diamond/i.test(baseType)) return undefined
  for (const line of cleanedStats) {
    const m = SWAP_RE.exec(line)
    if (m) return { from: (m[1] ?? '').trim(), to: (m[2] ?? '').trim() }
  }
  return undefined
}

/** Resolve the jewel's faction (conqueror frames/tint/version) and attach the radius ring + version to
 *  `info`. Geometry — a disc's outer `diameter`, or a ring band's outer+inner — is the only thing that
 *  differs between the two jewel shapes; the faction/frame/version resolution is shared here (one source). */
function attachRing(info: JewelInfo, rawLower: string, geom: { diameter: number; innerDiameter?: number }): void {
  const faction = JEWEL_FACTIONS.find(([re]) => re.test(rawLower))?.[1] ?? GENERIC_RING
  const [frameA, frameB] = faction.frames
  info.ring = { frameA, frameB, diameter: geom.diameter, tint: faction.tint }
  if (geom.innerDiameter != null) info.ring.innerDiameter = geom.innerDiameter
  // conqueror faction (drives the in-radius node-art override); GENERIC_RING has none.
  if (faction.version) info.version = faction.version
}

export function computeJewelSockets(pob: PobBuild): Map<string, JewelInfo> {
  const out = new Map<string, JewelInfo>()
  for (const sock of pob.spec.sockets) {
    if (!sock.itemId || sock.itemId === '0') continue
    const jewel = pob.items.get(sock.itemId)
    if (!jewel) continue
    const info: JewelInfo & { ring?: JewelRing } = {
      name: jewel.name || jewel.baseType || 'Jewel',
      baseType: jewel.baseType || undefined,
      rarity: jewel.rarity || undefined,
      corrupted: /^\s*corrupted\s*$/im.test(jewel.raw),
      stats: jewel.mods.map(cleanMod).filter(Boolean),
    }
    // radius jewel? the size lives on the skipped `Radius: <size>` property line (read from raw)
    const m = /\bRadius:\s*([A-Za-z ]+)/i.exec(jewel.raw)
    if (m) {
      info.radius = (m[1] ?? '').trim()
      const diameter = jewelDiameter(info.radius)
      // Only draw the radius ring + attribute in-radius nodes when the size is a KNOWN game radius.
      // An unrecognised size leaves the jewel in its socket with no ring (never a guessed radius).
      if (diameter != null) {
        attachRing(info, jewel.raw.toLowerCase(), { diameter })
        // Time-Lost Diamond deterministic attribute swap — only when the jewel text names both sides.
        const swap = readDiamondSwap(info.baseType, info.stats)
        if (swap) info.swap = swap
      }
    }
    // Ring (annulus) jewel — e.g. "Controlled Metamorphosis". The Radius: line reads "Variable"; the
    // affected zone is named in a mod ("Only affects Passives in <Size> Ring") and is the RingInner..
    // RingOuter band of that size (stat local_jewel_variable_ring_radius_value). Only when the disc
    // path didn't already claim a known radius; an unknown size leaves no ring (never a guessed band).
    if (!info.ring) {
      const rm = /Only affects Passives in (.+?) Ring\b/i.exec(info.stats.join('\n'))
      const band = rm ? jewelRingBand(rm[1] ?? '') : null
      if (band) {
        attachRing(info, jewel.raw.toLowerCase(), { diameter: band.outerDiameter, innerDiameter: band.innerDiameter })
      }
    }
    out.set(String(sock.nodeId), info)
  }
  return out
}
