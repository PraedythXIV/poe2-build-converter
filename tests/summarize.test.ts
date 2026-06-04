import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarize, summarizeBuild, summarizeSafe } from '../src/convert/summarize'
import type { PobBuild } from '../src/convert/types'

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
    expect((satchel?.mods.length ?? 0)).toBeGreaterThan(0) // item stats (mods) carried for the expand view
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
    const pob: PobBuild = {
      className: 'Monk',
      ascendClassName: null,
      level: 1,
      mainSocketGroup: null,
      spec: {
        treeVersion: 'test',
        ascendancyInternalId: null,
        classId: null,
        nodes: ['259', '1416', '52'], // 259 + 1416 = two distinct "Attack Mastery"; 52 = "Zealot's Oath"
        weaponSet1: [],
        weaponSet2: [],
        sockets: [],
      },
      skillGroups: [],
      items: new Map(),
      slots: [],
    }
    const s = summarizeBuild(pob)
    expect(s.masteries).toEqual(['Attack Mastery', 'Attack Mastery']) // both kept, not collapsed to one
    expect(s.keystones).toEqual(["Zealot's Oath"])
    expect(s.passiveCount).toBe(3)
  })

  it('summarizeSafe returns null on empty/invalid input instead of throwing', () => {
    expect(summarizeSafe('')).toBeNull()
    expect(summarizeSafe('   ')).toBeNull()
    expect(summarizeSafe('not a real code')).toBeNull()
  })
})
