import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { groupSocketables, summarize, summarizeBuild, summarizeSafe } from '../src/convert/summarize'
import type { PobBuild } from '../src/convert/types'
import { emptyPobBuild, emptySpec } from './helpers/pobBuild'

const XML = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')

describe('summarize (build contents preview)', () => {
  it('extracts character, main skill, uniques, skills and keystones from the fixture', () => {
    const s = summarize(XML)
    expect(s.className).toBe('Monk')
    expect(s.ascendancy).toBe('Martial Artist') // readable, via ascendancyInfo
    expect(s.level).toBe(96)
    expect(s.mainSkill).toBe('Whirling Assault')

    // EVERY equipped item is listed, rarity-tagged, with the unique resolved to a readable name
    expect(s.items.map((i) => i.name)).toContain("Shavronne's Satchel")
    expect(s.itemCount).toBe(14)
    expect(s.items.length).toBe(14)
    expect(s.uniqueCount).toBeGreaterThan(0)
    const satchel = s.items.find((i) => i.name === "Shavronne's Satchel")
    expect(satchel?.rarity).toBe('UNIQUE')
    expect(satchel?.levelReq).toBe(62) // gear level range is [levelReq, 100]
    expect(satchel?.mods.length ?? 0).toBeGreaterThan(0) // item stats (mods) carried for the expand view
    // tree jewels are extracted as items too
    expect(Array.isArray(s.jewels)).toBe(true)

    expect(s.skills.length).toBeGreaterThan(0)
    expect(s.skills[0]!.isMain).toBe(true)
    expect(s.skills[0]!.main).toBe('Whirling Assault')
    expect(s.skills[0]!.level).toBeGreaterThan(0)
    expect(s.skills[0]!.quality).toBeGreaterThanOrEqual(0)
    expect(s.skills[0]!.supports.length).toBeGreaterThan(0)

    // keystones + notables named via the vendored node meta (not slug-prettified)
    expect(s.keystones).toContain('Chaos Inoculation')
    expect(s.notables.length).toBeGreaterThan(0)
    expect(s.ascNotables.length).toBeGreaterThan(0)
    expect(s.passiveCount).toBe(129)
  })

  it('surfaces per-gem PoB detail (corrupted / count / minion) on skills[].gems', () => {
    const xml =
      `<PathOfBuilding2><Build level="92" className="Monk"/>` +
      `<Tree activeSpec="1"><Spec treeVersion="0_5" nodes=""><URL>x</URL></Spec></Tree>` +
      `<Skills activeSkillSet="1"><SkillSet id="1"><Skill enabled="true" slot="Weapon 1">` +
      `<Gem gemId="G1" skillId="S1" nameSpec="Summon Bear" level="20" quality="5" enabled="true" count="2" corrupted="true" variantId="3" skillMinion="BearCompanion" skillMinionSkill="Maul"/>` +
      `<Gem gemId="G2" skillId="S2" nameSpec="Melee" level="1" quality="0" enabled="true"/>` +
      `</Skill></SkillSet></Skills></PathOfBuilding2>`
    const grp = summarize(xml).skills[0]!
    expect(grp.gems).toHaveLength(2)
    expect(grp.gems[0]).toMatchObject({ corrupted: true, count: 2, minion: 'BearCompanion' })
    expect(grp.gems[1]).toMatchObject({ corrupted: false, count: 1, minion: null })
  })

  it('carries socketed runes / soul-cores and flags their granted stats', () => {
    const s = summarize(XML)
    // at least one equipped item lists a socketed rune / soul-core by name
    const withRunes = s.items.filter((i) => i.runes.length > 0)
    expect(withRunes.length).toBeGreaterThan(0)
    // and the stat those runes grant is kept (a normally-skipped implicit), tagged "(rune)"
    const runeMods = s.items.flatMap((i) => i.mods).filter((m) => /\(rune\)$/.test(m))
    expect(runeMods.length).toBeGreaterThan(0)
    // every equipped item survives into the .build (gear is always ●; only unresolved jewels go ○)
    expect(s.items.every((i) => i.inBuild)).toBe(true)
  })

  // Distinct nodes that share a name (49 mastery names map to >1 node) must NOT collapse — the .build
  // emits one passive per node id, so two "Attack Mastery" nodes are two allocations, not one.
  it('counts same-named perks per allocated node (no dedupe-by-name undercount)', () => {
    // 259 + 1416 = two distinct "Attack Mastery"; 52 = "Zealot's Oath"
    const spec: PobBuild['spec'] = emptySpec({ treeVersion: 'test', nodes: ['259', '1416', '52'] })
    const pob: PobBuild = emptyPobBuild({ className: 'Monk', level: 1, spec, specs: [spec] })
    const s = summarizeBuild(pob)
    expect(s.masteries).toEqual(['Attack Mastery', 'Attack Mastery']) // both kept, not collapsed to one
    expect(s.keystones).toEqual(["Zealot's Oath"])
    expect(s.passiveCount).toBe(3)
  })

  // C1 — stats come from PoB's own exported <PlayerStat> block (a snapshot of PoB's calc), never our math
  it("carries PoB's exported PlayerStat block through to the summary", () => {
    const s = summarize(XML)
    expect(Object.keys(s.playerStats).length).toBeGreaterThan(90) // fixture exports 103 stats
    expect(s.playerStats['TotalDPS']).toBeCloseTo(28142.416291543, 3)
    expect(s.playerStats['Life']).toBeGreaterThan(0)
    expect(s.playerStats['FireResist']).toBeDefined()
    expect(s.playerStats['Spirit']).toBeDefined()
  })

  // Sceptre skill sockets: PoB serializes "Sockets: S" content with the "Rune:" label AND emits a
  // "Grants Skill:" implicit — the skill must surface as a granted skill, never as a rune.
  // Real item text from a user build (Guiding Palm of the Eye, 2026-06-12).
  it('classifies a sceptre-granted skill as Grants, not Runes', () => {
    const xml =
      `<PathOfBuilding2><Build className="Huntress" level="90"/>` +
      `<Tree activeSpec="1"><Spec treeVersion="0_5" nodes="12345"/></Tree>` +
      `<Items activeItemSet="1"><Item id="9">
Rarity: UNIQUE
Guiding Palm of the Eye
Shrine Sceptre
Spirit: 100
Item Level: 82
Quality: 20
Sockets: S
Rune: Purity of Ice
LevelReq: 78
Implicits: 1
Grants Skill: Level 18 Purity of Ice
Gain 25% of Damage as Extra Cold Damage
+27 to Intelligence
Grants effect of Guided Freezing Shrine
Corrupted
</Item><ItemSet id="1"><Slot name="Weapon 2 Swap" itemId="9"/></ItemSet></Items></PathOfBuilding2>`
    const s = summarize(xml)
    const sceptre = s.items.find((i) => i.name === 'Guiding Palm of the Eye')
    expect(sceptre).toBeDefined()
    // deduped (implicit + skill socket) — the entry that knows its level wins
    expect(sceptre!.grantedSkills).toEqual([{ name: 'Purity of Ice', level: 18 }])
    expect(sceptre!.runes).toEqual([]) // a known gem name is never a rune
    // the Grants Skill implicit stays out of the mod list; real explicits survive
    expect(sceptre!.mods).toContain('Gain 25% of Damage as Extra Cold Damage')
    expect(sceptre!.mods.some((m) => /Grants Skill/i.test(m))).toBe(false)
  })

  // control: real runes / soul cores are NOT gem names and must stay classified as runes
  it('keeps real runes as runes (no gem-name collision)', () => {
    const s = summarize(XML)
    const withRunes = s.items.filter((i) => i.runes.length > 0)
    expect(withRunes.length).toBeGreaterThan(0)
    expect(s.items.every((i) => i.runes.every((r) => !/^purity of/i.test(r)))).toBe(true)
  })

  // display split: PoB labels every socketable "Rune:", but the NAME states the category —
  // soul cores and talismans must never render under a "Runes" label
  it('groups socketables by their stated category', () => {
    expect(groupSocketables(['Iron Rune', 'Soul Core of Quipolatl', 'Soul Core of Quipolatl'])).toEqual([
      { label: 'Runes', names: ['Iron Rune'] },
      { label: 'Soul Cores', names: ['Soul Core of Quipolatl', 'Soul Core of Quipolatl'] }, // duplicates kept — two sockets
    ])
    expect(groupSocketables(['Serpent Talisman'])).toEqual([{ label: 'Talismans', names: ['Serpent Talisman'] }])
    expect(groupSocketables([])).toEqual([])
  })

  it('summarizeSafe returns null on empty/invalid input instead of throwing', () => {
    expect(summarizeSafe('')).toBeNull()
    expect(summarizeSafe('   ')).toBeNull()
    expect(summarizeSafe('not a real code')).toBeNull()
  })
})
