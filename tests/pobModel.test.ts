// Unit tests for the lossless src/pob model — the new fields added in Increments A–D, the "nil"/missing
// tri-states, the byte-identical `mods[]` guarantee, and the rawSections forward-compat catch-all.
import { describe, it, expect } from 'vitest'
import { parsePob } from '../src/pob'

// Minimal valid PoB2 doc — a <Tree><Spec> is required (parsePob throws without one). `inner` adds the
// section under test; `specAttrs` extends the <Spec> tag.
function doc(inner: string, specAttrs = ''): string {
  return (
    `<PathOfBuilding2><Build level="92" className="Monk" ascendClassName="Invoker"/>` +
    `<Tree activeSpec="1"><Spec treeVersion="0_5" classId="6" nodes="1,2,3" ${specAttrs}><URL>x</URL></Spec></Tree>` +
    `${inner}</PathOfBuilding2>`
  )
}

describe('pob model — Build-level (Increment A)', () => {
  it('parses Config inputs with their types (boolean/number/string), verbatim', () => {
    const b = parsePob(
      doc(
        `<Config activeConfigSet="2"><ConfigSet id="2" title="Boss">` +
          `<Input name="enemyLevel" number="84"/><Input name="conditionFullLife" boolean="true"/>` +
          `<Input name="custom" string="a&#10;b"/><Placeholder name="ph" number="1"/></ConfigSet></Config>`,
      ),
    )
    expect(b.activeConfigSetId).toBe('2')
    const set = b.configSets.find((c) => c.id === '2')!
    expect(set.title).toBe('Boss')
    const byName = Object.fromEntries(set.inputs.map((i) => [i.name, i.value]))
    expect(byName.enemyLevel).toEqual({ kind: 'number', value: '84' }) // number kept as string (precision)
    expect(byName.conditionFullLife).toEqual({ kind: 'boolean', value: true })
    expect(byName.custom).toEqual({ kind: 'string', value: 'a\nb' }) // newline preserved verbatim
    expect(set.placeholders).toHaveLength(1)
  })

  it('keeps PlayerStats both numeric AND verbatim string (inf / full precision)', () => {
    const b = parsePob(
      `<PathOfBuilding2><Build><PlayerStat stat="TotalDPS" value="123456.789012345"/>` +
        `<PlayerStat stat="X" value="inf"/></Build>` +
        `<Tree activeSpec="1"><Spec treeVersion="0_5" nodes=""/></Tree></PathOfBuilding2>`,
    )
    expect(b.playerStats.TotalDPS).toBeCloseTo(123456.789)
    expect(b.playerStatsRaw.TotalDPS).toBe('123456.789012345') // full precision kept
    expect(b.playerStatsRaw.X).toBe('inf')
    expect(b.playerStats.X).toBeUndefined() // "inf" isn't finite → absent from the numeric view (today's behaviour)
  })

  it('captures Notes verbatim + unknown top-level sections into rawSections (forward-compat)', () => {
    const b = parsePob(doc(`<Notes>Hi ^7there\nline2</Notes><FutureThing foo="1"><Sub/></FutureThing>`))
    expect(b.notes).toContain('Hi ^7there')
    expect(b.notes).toContain('line2')
    const future = b.rawSections.find((r) => r.tag === 'FutureThing')
    expect(future).toBeTruthy()
    expect(future!.attrs.foo).toBe('1')
    expect(future!.children.map((c) => c.tag)).toEqual(['Sub'])
    expect(b.sectionOrder).toContain('Notes')
    expect(b.sectionOrder).toContain('FutureThing')
  })
})

describe('pob model — Spec / Gem (Increments B/C)', () => {
  it('parses spec masteryEffects, URL, ascendClassId; tolerates "nil"', () => {
    const b = parsePob(doc('', 'ascendClassId="2" secondaryAscendClassId="nil" masteryEffects="{123,45},{678,9}"'))
    expect(b.spec.ascendClassId).toBe('2')
    expect(b.spec.secondaryAscendClassId).toBeNull() // "nil" → null
    expect(b.spec.masteryEffects).toEqual([
      { nodeId: '123', effectId: '45' },
      { nodeId: '678', effectId: '9' },
    ])
    expect(b.spec.url).toBe('x')
  })

  it('parses gem variant/count/corruption/statSet/minion + tri-states; existing fields unchanged', () => {
    const b = parsePob(
      doc(
        `<Skills activeSkillSet="1"><SkillSet id="1"><Skill enabled="true" slot="Body Armour">` +
          `<Gem gemId="G" skillId="S" nameSpec="Test" level="20" quality="10" enabled="true" variantId="2" count="3" corrupted="true" enableGlobal1="false" statSetIndex="1" skillMinion="BearCompanion" skillMinionSkill="Maul"/>` +
          `<Gem gemId="G2" skillId="S2" nameSpec="T2" level="1" quality="0" enabled="false" corrupted="nil"/>` +
          `</Skill></SkillSet></Skills>`,
      ),
    )
    const [g1, g2] = b.skillGroups[0]!.gems
    expect(g1!.variantId).toBe('2')
    expect(g1!.count).toBe(3)
    expect(g1!.corrupted).toBe(true)
    expect(g1!.enableGlobal1).toBe(false) // tri-state "false" → false
    expect(g1!.statSetIndex).toBe(1)
    expect(g1!.minion).toEqual({ minion: 'BearCompanion', skill: 'Maul', itemSet: null })
    expect(g2!.corrupted).toBeNull() // "nil" → null
    expect(g2!.minion).toBeNull()
    expect(g1!.level).toBe(20) // existing fields intact
    expect(g2!.enabled).toBe(false)
    expect(b.skillGroups[0]!.slot).toBe('Body Armour') // new group field
  })
})

describe('pob model — Item body text (Increment D)', () => {
  function itemWith(body: string, ranges: Array<[number, string]>): ReturnType<typeof parsePob> {
    const mr = ranges.map(([id, r]) => `<ModRange id="${id}" range="${r}"/>`).join('')
    return parsePob(
      doc(
        `<Items activeItemSet="1"><Item id="1" variant="2">${body}${mr}</Item>` +
          `<ItemSet id="1"><Slot name="Body Armour" itemId="1" itemPbURL="https://pobb.in/x"/></ItemSet></Items>`,
      ),
    )
  }

  it('parses item level/quality/sockets/defences/flags + implicits + per-mod tags + ModRange', () => {
    const body =
      `Rarity: RARE&#10;Doom Shroud&#10;Vaal Regalia&#10;Item Level: 84&#10;Quality: 20&#10;` +
      `Sockets: S S&#10;Energy Shield: 250&#10;Spirit: 30&#10;Implicits: 1&#10;{crafted}+10 to Intelligence&#10;` +
      `{fractured}+50 to maximum Life&#10;+30% increased Energy Shield&#10;Corrupted`
    const it = itemWith(body, [
      [1, '0.50'],
      [2, '0.9'],
    ]).items.get('1')!
    expect(it.itemLevel).toBe(84)
    expect(it.quality).toBe(20)
    expect(it.socketString).toBe('S S')
    expect(it.defences['Energy Shield']).toBe('250')
    expect(it.defences.Spirit).toBe('30')
    expect(it.flags).toContain('Corrupted')
    expect(it.implicits).toHaveLength(1) // the counted {crafted} implicit
    expect(it.implicits[0]!.tags).toContain('crafted')
    const fractured = it.parsedMods.find((m) => m.tags.includes('fractured'))!
    expect(fractured.text).toBe('+50 to maximum Life') // tags stripped from the text
    expect(it.modRanges).toEqual([
      { id: 1, range: '0.50' },
      { id: 2, range: '0.9' },
    ])
    expect(it.variantAttrs.variant).toBe('2') // <Item> attr other than id, verbatim
    expect(it.variantAttrs.id).toBeUndefined()
  })

  it('resolves <ModRange> ids onto the right lines: implicits then explicits, 1-based (gear)', () => {
    const body =
      `Rarity: RARE&#10;Doom Shroud&#10;Vaal Regalia&#10;Item Level: 84&#10;Implicits: 1&#10;` +
      `{crafted}+10 to Intelligence&#10;+(80-120) to maximum Life&#10;+(20-30)% increased Energy Shield`
    const it = itemWith(body, [
      [1, '0.5'], // → implicit[0]
      [2, '0.25'], // → explicit[0]  +(80-120) to maximum Life
      [3, '0.75'], // → explicit[1]  +(20-30)% increased Energy Shield
    ]).items.get('1')!
    expect(it.implicits[0]!.rangeHint).toBe('0.5')
    expect(it.parsedMods[0]!.rangeHint).toBe('0.25')
    expect(it.parsedMods[1]!.rangeHint).toBe('0.75')
  })

  it('offsets <ModRange> ids by the charm base-buff line (verified against a real Silver Charm)', () => {
    // magic charm: the base is fused into the name; PoB reserves id 1 for the innate buff, so the lone
    // ranged mod is id 4 over [buff(1), impl(2), expl(3), expl(4)]. Our [impl,expl,expl] + offset 1 → expl[1].
    const body =
      `Rarity: MAGIC&#10;Floral Silver Charm of the Plentiful&#10;Item Level: 56&#10;Implicits: 1&#10;` +
      `Used when you are affected by a Slow&#10;Recover 39 Life when Used&#10;+(30-50)% increased Charges`
    const it = itemWith(body, [[4, '0.5']]).items.get('1')!
    expect(it.parsedMods[1]!.rangeHint).toBe('0.5') // "+(30-50)% increased Charges"
    expect(it.parsedMods[0]!.rangeHint).toBeNull() // "Recover 39 Life when Used" (id 3, no ModRange)
    expect(it.implicits[0]!.rangeHint).toBeNull() // the trigger implicit (id 2, no ModRange)
  })

  it('keeps {corruptedRange:N} (a multiplier) separate from {range:N} (the position)', () => {
    const body =
      `Rarity: RARE&#10;X&#10;Vaal Regalia&#10;Item Level: 84&#10;` +
      `{range:0.4}+(80-120) to maximum Life&#10;{corruptedRange:0.8}+(5-10) to Strength`
    const it = itemWith(body, []).items.get('1')!
    expect(it.parsedMods[0]!.rangeHint).toBe('0.4')
    expect(it.parsedMods[0]!.corruptedMult).toBeNull()
    expect(it.parsedMods[1]!.rangeHint).toBeNull() // corruptedRange is NOT a position
    expect(it.parsedMods[1]!.corruptedMult).toBe('0.8')
  })

  it('keeps mods[] BYTE-IDENTICAL — explicit mods stripped of their source tags, implicits excluded', () => {
    const body =
      `Rarity: MAGIC&#10;Sharp Ring&#10;Item Level: 70&#10;Implicits: 1&#10;{enchant}+5 to Dexterity&#10;` +
      `{crafted}+12% increased Attack Speed&#10;+20 to maximum Mana`
    const it = itemWith(body, []).items.get('1')!
    // implicits never enter mods[] (unless {rune}); explicit mods enter, stripped
    expect(it.mods).toEqual(['+12% increased Attack Speed', '+20 to maximum Mana'])
    expect(it.mods).not.toContain('+5 to Dexterity') // the {enchant} implicit is excluded from mods[]
  })

  it('parses uniqueId / itemClass / radius / limitedTo from the body (Increment D)', () => {
    const body =
      `Rarity: UNIQUE&#10;Grand Spectrum&#10;Prismatic Jewel&#10;Unique ID: abc123def&#10;Item Class: Jewels&#10;` +
      `Radius: Medium&#10;Limited to: 1&#10;+10% to all Elemental Resistances`
    const it = itemWith(body, []).items.get('1')!
    expect(it.uniqueId).toBe('abc123def')
    expect(it.itemClass).toBe('Jewels')
    expect(it.radius).toBe('Medium')
    expect(it.limitedTo).toBe('1')
  })

  it('parses item-set useSecondWeaponSet + socketIdUrls (Increment D)', () => {
    const b = parsePob(
      doc(
        `<Items activeItemSet="1"><Item id="1">Rarity: NORMAL&#10;Foo&#10;Bar</Item>` +
          `<ItemSet id="1" useSecondWeaponSet="true"><Slot name="Body Armour" itemId="1"/>` +
          `<SocketIdURL name="Socket 1" nodeId="12345" itemPbURL="https://pobb.in/j"/></ItemSet></Items>`,
      ),
    )
    const set = b.itemSets[0]!
    expect(set.useSecondWeaponSet).toBe(true)
    expect(set.socketIdUrls).toEqual([{ name: 'Socket 1', nodeId: '12345', itemPbURL: 'https://pobb.in/j' }])
  })
})
