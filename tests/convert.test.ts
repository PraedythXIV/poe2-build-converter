import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflate } from 'pako'
import { convert, convertVariant } from '../src/convert/index'
import { decodePobCode } from '../src/convert/decode'
import { parsePob } from '../src/convert/parsePob'
import type { BuildSkill, PobBuild } from '../src/convert/types'
import { emptyItemSet } from './helpers/pobBuild'

// vitest runs with cwd = project root
const SAMPLE_XML = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')

function toPobCode(xml: string): string {
  const bytes = deflate(xml) // zlib stream, like PoB
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_')
}

describe('convert (sample Monk / Martial Artist build)', () => {
  const result = convert(SAMPLE_XML)

  it('produces valid JSON with a name', () => {
    expect(result.json.length).toBeGreaterThan(100)
    const parsed = JSON.parse(result.json)
    expect(parsed.name).toBeTruthy()
    expect(result.build.name).toContain('Martial Artist')
  })

  it('maps ascendancy verbatim', () => {
    expect(result.build.ascendancy).toBe('Monk1')
    expect(result.stats.treeVersion).toBe('0_5')
  })

  it('reads the spec <AttributeOverride> into exact per-node attribute choices', () => {
    // fixture <AttributeOverride strNodes="…18 ids…" dexNodes="…7 ids…" intNodes="48773"/>
    const spec = parsePob(SAMPLE_XML).spec
    expect(spec.attributeChoices.get('48773')).toBe('Intelligence') // the lone int node
    expect(spec.attributeChoices.get('11672')).toBe('Dexterity')
    expect(spec.attributeChoices.get('39037')).toBe('Strength')
    expect(spec.attributeChoices.size).toBe(18 + 7 + 1) // every chosen node, no overlap
  })

  it('maps every passive node with zero skipped', () => {
    expect(result.build.passives && result.build.passives.length).toBeGreaterThan(100)
    expect(result.stats.passivesSkipped).toBe(0)
    const ids = (result.build.passives ?? []).map((p) => (typeof p === 'string' ? p : p.id))
    expect(ids).toContain('criticals85') // node 61333
    expect(ids).toContain('jewel_slot1979') // node 21984 (a socket)
    expect(ids).toContain('AscendancyMonk1Start') // node 11495
  })

  it('passes skill gem ids through verbatim, preserving Gem/Gems spelling', () => {
    const skillIds = (result.build.skills ?? []).map((s) => (typeof s === 'string' ? s : s.id))
    expect(skillIds).toContain('Metadata/Items/Gems/SkillGemWhirlingAssault')
    // every gem id is a Metadata path
    for (const id of skillIds) expect(id).toMatch(/^Metadata\/Items\/Gems?\//)
    // support_skills present and verbatim (note the SINGULAR "Gem" id is intentional)
    const whirling = (result.build.skills ?? []).find(
      (s): s is BuildSkill => typeof s !== 'string' && s.id === 'Metadata/Items/Gems/SkillGemWhirlingAssault',
    )
    expect(whirling?.support_skills).toContain('Metadata/Items/Gem/SupportGemHeft')
  })

  it('classifies supports by path segment, not includes("SupportGem")', () => {
    // SupportOlrothsConviction is a support whose id is "Support…" but not "SupportGem…";
    // an includes() check would silently drop it.
    const allSupports = (result.build.skills ?? [])
      .flatMap((s) => (typeof s !== 'string' && s.support_skills ? s.support_skills : []))
      .map((x) => (typeof x === 'string' ? x : x.id))
    expect(allSupports).toContain('Metadata/Items/Gems/SupportOlrothsConviction')
  })

  it('emits one skills[] entry per socket group, like poe.ninja (gem[0]=id, rest=supports)', () => {
    // 18 PoB <Skill> groups, 4 auto-generated (source="Tree:…"/"Item:…") are dropped -> 14 groups
    // -> 14 skills entries (multi-active groups are NOT split; the extra active becomes a support).
    expect(result.stats.skillCount).toBe(14)
  })

  it('builds inventory_slots from items (rare guidance + correct inventory_id)', () => {
    const slots = result.build.inventory_slots ?? []
    expect(slots.length).toBeGreaterThan(0)
    const weapon1 = slots.find((s) => s.inventory_id === 'Weapon1')
    expect(weapon1).toBeTruthy()
    // the RARE quarterstaff in Weapon 1 -> guidance text mentioning its base
    expect(weapon1?.additional_text).toContain('Sinister Quarterstaff')
    // level_interval derived from the item's LevelReq (quarterstaff requires 67) up to the cap
    expect(weapon1?.level_interval).toEqual([67, 100])
    for (const s of slots) {
      // only known inventory_id forms are emitted (no `Charm*` — the game ignores it)
      expect(s.inventory_id).toMatch(/^(Weapon|Offhand|Helm|BodyArmour|Gloves|Boots|Amulet|Ring|Belt|Flask)\d$/)
      // every slot carries a [from, 100] level range
      expect(Array.isArray(s.level_interval) && s.level_interval[1]).toBe(100)
    }
  })

  it('maps the whole belt row to one Flask1 inventory: x0/x1 flasks, x2/x3/x4 charms (verified in-game)', () => {
    const slots = result.build.inventory_slots ?? []
    // belt row = one Flask1 inventory: x0 life, x1 mana, x2/x3/x4 the three charms.
    const flask1X = slots
      .filter((s) => s.inventory_id === 'Flask1')
      .map((s) => s.slot_x)
      .sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(flask1X).toEqual([0, 1, 2, 3, 4])
    // `Charm1` is NOT a real Build Planner inventory id — the game ignores it, so we never emit it.
    expect(slots.some((s) => s.inventory_id === 'Charm1')).toBe(false)
    expect(slots.some((s) => s.inventory_id === 'Flask2')).toBe(false) // no bogus id
    // the swap weapon ("Weapon 1 Swap") maps to Weapon2 rather than being skipped
    expect(slots.some((s) => s.inventory_id === 'Weapon2')).toBe(true)
  })

  it('emits no error-level diagnostics', () => {
    const errors = result.warnings.filter((w) => w.level === 'error')
    expect(errors).toEqual([])
  })

  // .build v1 gained an optional root `link` (?string) between author and description
  // (live GGG File Formats docs, verified 2026-07-04) — the natural value is the build's source URL.
  it('emits opts.link as the Build root link field', () => {
    expect(convert(SAMPLE_XML, { link: 'https://pobb.in/AbCd123_' }).build.link).toBe('https://pobb.in/AbCd123_')
  })
})

describe('multi-build: parse carries all axes + convertVariant', () => {
  const active = convert(SAMPLE_XML) // the active build, for parity comparisons

  it('parses every loadout axis with active pointers (single-set fixture)', () => {
    const pob = parsePob(SAMPLE_XML)
    expect(pob.specs).toHaveLength(1)
    expect(pob.activeSpecIndex).toBe(0)
    expect(pob.specs[0]).toBe(pob.spec) // the active spec is the one in the list
    expect(pob.skillSets.map((s) => s.id)).toEqual(['1'])
    expect(pob.activeSkillSetId).toBe('1')
    expect(pob.skillSets[0]!.groups).toBe(pob.skillGroups) // active groups
    expect(pob.itemSets.map((s) => s.id)).toEqual(['1'])
    expect(pob.itemSets[0]!.title).toBe('Default') // <ItemSet title="Default">
    expect(pob.activeItemSetId).toBe('1')
  })

  it('convertVariant on the active tuple matches a plain convert (just the name differs)', () => {
    const pob = parsePob(SAMPLE_XML)
    const v = convertVariant(pob, { specIndex: 0, skillSetId: '1', itemSetId: '1', name: 'Active copy' })
    expect(v.build.passives).toEqual(active.build.passives)
    expect(v.build.skills).toEqual(active.build.skills)
    expect(v.build.inventory_slots).toEqual(active.build.inventory_slots)
    expect(v.build.name).toBe('Active copy')
  })

  it('convertVariant selects the chosen (spec, skill set, item set) tuple', () => {
    const base = parsePob(SAMPLE_XML)
    // synthesize a 2nd entry per axis so selection is observable
    const multi: PobBuild = {
      ...base,
      specs: [base.spec, { ...base.spec, title: 'Levelling', nodes: ['11495'] }], // 1 node vs ~129
      skillSets: [...base.skillSets, { id: '2', title: 'One', groups: base.skillGroups.slice(0, 1) }],
      itemSets: [...base.itemSets, emptyItemSet('2', 'Bare')],
    }
    const full = convertVariant(multi, { specIndex: 0, skillSetId: '1', itemSetId: '1', name: 'full' })
    const lite = convertVariant(multi, { specIndex: 1, skillSetId: '2', itemSetId: '2', name: 'lite' })

    expect(lite.stats.passiveCount).toBeLessThan(full.stats.passiveCount) // alt spec is tiny
    expect(lite.stats.skillCount).toBeLessThanOrEqual(full.stats.skillCount) // alt set ≤ groups
    expect(lite.stats.itemCount).toBe(0) // empty item set
    expect(lite.build.name).toBe('lite')
    // the full variant still equals the active build's tree
    expect(full.build.passives).toEqual(active.build.passives)
  })

  it('convertVariant carries sel.link into every variant .build (same source URL for all files)', () => {
    const pob = parsePob(SAMPLE_XML)
    const v = convertVariant(pob, {
      specIndex: 0,
      skillSetId: '1',
      itemSetId: '1',
      name: 'Linked',
      link: 'https://pobb.in/AbCd123_',
    })
    expect(v.build.link).toBe('https://pobb.in/AbCd123_')
  })
})

describe('decode', () => {
  it('round-trips a PoB2 code (deflate+base64url) back to XML', () => {
    const code = toPobCode(SAMPLE_XML)
    const xml = decodePobCode(code)
    expect(xml).toContain('<PathOfBuilding2>')
    expect(xml).toContain('ascendancyInternalId="Monk1"')
  })

  it('accepts raw XML unchanged', () => {
    expect(decodePobCode(SAMPLE_XML)).toContain('<PathOfBuilding2>')
  })

  it('rejects a PoB1 document with a helpful message', () => {
    expect(() => decodePobCode('<PathOfBuilding><Build/></PathOfBuilding>')).toThrow(/Path of Building 1/)
  })
})
