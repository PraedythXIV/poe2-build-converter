import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflate } from 'pako'
import { convert } from '../src/convert/index'
import { decodePobCode } from '../src/convert/decode'
import type { BuildSkill } from '../src/convert/types'

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
      // only known inventory_id forms are emitted
      expect(s.inventory_id).toMatch(/^(Weapon|Offhand|Helm|BodyArmour|Gloves|Boots|Amulet|Ring|Belt|Flask|Charm)\d$/)
      // every slot carries a [from, 100] level range
      expect(Array.isArray(s.level_interval) && s.level_interval[1]).toBe(100)
    }
  })

  it('maps flasks to Flask1 (x0/x1) and charms to Charm1 (x0/x1/x2), per poe.ninja/Mobalytics', () => {
    const slots = result.build.inventory_slots ?? []
    const flaskX = slots.filter((s) => s.inventory_id === 'Flask1').map((s) => s.slot_x).sort()
    expect(flaskX).toEqual([0, 1]) // life flask x0, mana flask x1
    const charmX = slots.filter((s) => s.inventory_id === 'Charm1').map((s) => s.slot_x).sort()
    expect(charmX).toEqual([0, 1, 2]) // three charms
    expect(slots.some((s) => s.inventory_id === 'Flask2')).toBe(false) // no bogus id
    // the swap weapon ("Weapon 1 Swap") maps to Weapon2 rather than being skipped
    expect(slots.some((s) => s.inventory_id === 'Weapon2')).toBe(true)
  })

  it('emits no error-level diagnostics', () => {
    const errors = result.warnings.filter((w) => w.level === 'error')
    expect(errors).toEqual([])
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
