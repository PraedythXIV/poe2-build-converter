// Loadout recovery for multi-`.build` auto-seed.
//
// PoB does NOT store loadouts in its export — it RECOMPUTES them from set TITLES every time, in
// `buildMode:SyncLoadouts()`. This is a faithful TypeScript reimplementation of that algorithm so
// our auto-seed reproduces EXACTLY the loadouts PoB itself shows (exact + sourced, never guessed).
//
// Algorithm reimplemented from Path of Building Community (PoE2 fork), `src/Modules/Build.lua`
// `buildMode:SyncLoadouts()` — MIT License, © Path of Building Community. See THIRD-PARTY-NOTICES.md.
// We reimplement the algorithm (a behavioural fact); no Lua source is copied verbatim.
//
// The rules (verbatim from SyncLoadouts):
//  • An untitled set is treated as titled "Default".
//  • A title may carry a brace key `name {a,b}` (alphanumeric ids, comma-separated). Each id links
//    that set into a loadout across axes; `{1,2}` links it into BOTH loadouts 1 and 2.
//  • TREE specs are the loadout anchors (one candidate loadout per spec; trees have no "single"
//    fan-out). A non-brace spec registers iff a same-TITLED set exists on each of the skill / item /
//    config axes — OR that axis has exactly ONE set (`oneSkill`/`oneItem`/`oneConfig`), which then
//    applies to every loadout. A brace spec registers per link-id under the same condition.
//  • Config participates in the match but is NEVER a `.build` axis, so the resulting variant carries
//    only (specIndex, skillSetId, itemSetId).
//
// Simplification (documented): PoB prefixes a spec title with its tree version when the spec is on a
// non-latest tree (so it won't title-match the item/skill sets). We don't know GGG's global "latest"
// version, so we match on the plain title — exact for the overwhelmingly-common single-tree-version
// build, and at worst PRE-FILLS one extra row in a mixed-version build, which the user reviews and
// can delete before exporting (auto-seed is a pre-fill, not the final word).

import type { PobBuild, PobSpec, PobSkillSet, PobItemSet, PobConfigSet } from '../convert/types'

/** One recovered loadout → one pre-filled variant row. */
export interface Loadout {
  /** The loadout name PoB shows (the tree title, or `name {id}` for a brace key). */
  name: string
  specIndex: number
  skillSetId: string
  itemSetId: string
}

const BRACE = /\{([A-Za-z0-9,]+)\}/ // only alphanumerics + comma allowed inside the braces

/** An untitled set is "Default" (PoB convention). */
function titleOf(title: string | null | undefined): string {
  const t = (title ?? '').trim()
  return t.length ? t : 'Default'
}

/** Parse a `name {a,b}` brace key from a raw title; null when there is no brace. */
function parseBrace(title: string | null | undefined): { name: string; ids: string[] } | null {
  const raw = title ?? ''
  const m = BRACE.exec(raw)
  if (!m) return null
  const ids = m[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (ids.length === 0) return null
  const name = raw.replace(m[0], '').trim()
  return { name: name.length ? name : 'Default', ids }
}

/** Index an id-addressed axis (skills/items) into title→id and linkId→id maps (first match wins). */
function indexAxis(sets: ReadonlyArray<{ id: string; title: string | null }>): {
  byTitle: Map<string, string>
  byLink: Map<string, string>
} {
  const byTitle = new Map<string, string>()
  const byLink = new Map<string, string>()
  for (const s of sets) {
    const brace = parseBrace(s.title)
    if (brace) {
      for (const id of brace.ids) if (!byLink.has(id)) byLink.set(id, s.id)
    } else {
      const t = titleOf(s.title)
      if (!byTitle.has(t)) byTitle.set(t, s.id)
    }
  }
  return { byTitle, byLink }
}

/** Index the config axis — existence only (config is never an export axis). */
function indexConfig(sets: ReadonlyArray<PobConfigSet>): { byTitle: Set<string>; byLink: Set<string> } {
  const byTitle = new Set<string>()
  const byLink = new Set<string>()
  for (const s of sets) {
    const brace = parseBrace(s.title)
    if (brace) for (const id of brace.ids) byLink.add(id)
    else byTitle.add(titleOf(s.title))
  }
  return { byTitle, byLink }
}

/**
 * Recompute the loadouts a PoB export implies (faithful `SyncLoadouts`). Returns one Loadout per
 * loadout PoB would show, in PoB's order (non-brace specs first, then brace links). Empty when the
 * build has no resolvable loadouts (the caller then falls back to a single active-loadout row).
 */
export function computeLoadouts(pob: PobBuild): Loadout[] {
  const specs: readonly PobSpec[] = pob.specs
  const skillSets: readonly PobSkillSet[] = pob.skillSets
  const itemSets: readonly PobItemSet[] = pob.itemSets

  if (skillSets.length === 0 || itemSets.length === 0) return []

  const oneSkill = skillSets.length === 1
  const oneItem = itemSets.length === 1
  // 0-or-1 config = config never blocks. Real PoB exports always carry ≥1 ConfigSet, but a minimal
  // input might parse none — config absence must not suppress otherwise-valid loadouts.
  const oneConfig = pob.configSets.length <= 1

  const skill = indexAxis(skillSets)
  const item = indexAxis(itemSets)
  const config = indexConfig(pob.configSets)

  const loadouts: Loadout[] = []

  // 1) non-brace specs, by full-title equality
  specs.forEach((spec, i) => {
    if (parseBrace(spec.title)) return // brace specs handled below
    const title = titleOf(spec.title)
    const skillOk = oneSkill || skill.byTitle.has(title)
    const itemOk = oneItem || item.byTitle.has(title)
    const configOk = oneConfig || config.byTitle.has(title)
    if (skillOk && itemOk && configOk) {
      loadouts.push({
        name: title,
        specIndex: i,
        skillSetId: oneSkill ? skillSets[0]!.id : skill.byTitle.get(title)!,
        itemSetId: oneItem ? itemSets[0]!.id : item.byTitle.get(title)!,
      })
    }
  })

  // 2) brace specs, by link id
  specs.forEach((spec, i) => {
    const brace = parseBrace(spec.title)
    if (!brace) return
    for (const linkId of brace.ids) {
      const skillOk = oneSkill || skill.byLink.has(linkId)
      const itemOk = oneItem || item.byLink.has(linkId)
      const configOk = oneConfig || config.byLink.has(linkId)
      if (skillOk && itemOk && configOk) {
        loadouts.push({
          name: `${brace.name} {${linkId}}`,
          specIndex: i,
          skillSetId: oneSkill ? skillSets[0]!.id : skill.byLink.get(linkId)!,
          itemSetId: oneItem ? itemSets[0]!.id : item.byLink.get(linkId)!,
        })
      }
    }
  })

  return loadouts
}
