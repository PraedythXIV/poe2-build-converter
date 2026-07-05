// Small-gap coverage for the HTML-string panels + a few branch edges in the audit / parser /
// export helpers. Each test drives a real module and asserts on the produced markup / value,
// exercising the specific uncovered branches (colour codes + escaping, optional item fields,
// error-path throws, older-export shapes) rather than merely importing them.

import { describe, it, expect } from 'vitest'
import { renderNotesPanel } from '../src/ui/notesPanel'
import { renderStatsPanel } from '../src/ui/statsPanel'
import { renderPobInspector } from '../src/ui/pobInspectorPanel'
import { renderItemDetails } from '../src/items/detailsPanel'
import { auditBuild } from '../src/audit/audit'
import { parsePob } from '../src/pob'
import { dedupeStems } from '../src/export/builds'
import { emptyPobBuild, emptySummaryItem } from './helpers/pobBuild'
import { byCode, makeSummary } from './helpers/auditSummary'

// ── ui/notesPanel — colourise verbatim PoB <Notes> (^N palette / ^xRRGGBB hex), escape the rest ──
describe('renderNotesPanel', () => {
  it('hides itself (empty string) for null / empty / whitespace-only notes', () => {
    expect(renderNotesPanel(null)).toBe('')
    expect(renderNotesPanel('')).toBe('')
    expect(renderNotesPanel('   \n\t ')).toBe('')
  })

  it('renders plain notes with the header + no colour span when no codes are present', () => {
    const html = renderNotesPanel('Just some plain notes')
    expect(html).toContain('Build notes') // copy.notes.headerLabel
    expect(html).toContain('<pre class="bc-notes">')
    expect(html).toContain('Just some plain notes')
    expect(html).not.toContain('<span style="color') // colour stays inherited
  })

  it('turns ^N (palette) and ^xRRGGBB (hex, lowercased) codes into colour spans and escapes text', () => {
    const html = renderNotesPanel('pre ^7white <tag> & "q" ^xFF8800orange')
    // leading text before any code has no span, and appears before the first span. Scope the
    // position check to the <pre> BODY — an unscoped indexOf('pre ') would match the "pre " inside
    // the "<pre " opening tag, which is trivially before every span (a tautology).
    const preOpen = '<pre class="bc-notes">'
    const body = html.slice(html.indexOf(preOpen) + preOpen.length)
    expect(body.startsWith('pre ')).toBe(true) // the untagged leading run, verbatim
    expect(body.indexOf('pre ')).toBeLessThan(body.indexOf('<span')) // …ahead of the first colour span
    // palette index 7 → #e8e8e8, with the interior text HTML-escaped
    expect(html).toContain('<span style="color:#e8e8e8">')
    expect(html).toContain('&lt;tag&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;q&quot;')
    // hex code, lowercased, wraps the trailing run
    expect(html).toContain('<span style="color:#ff8800">orange</span>')
  })

  it('skips the empty segment when a code opens the notes (no stray empty span)', () => {
    const html = renderNotesPanel('^1red')
    expect(html).toContain('<span style="color:#e23030">red</span>')
    expect(html).not.toContain('<span style="color:#e23030"></span>')
  })

  it('maps palette index 0 to #000000', () => {
    expect(renderNotesPanel('^0black')).toContain('<span style="color:#000000">black</span>')
  })
})

// ── ui/statsPanel — the Offence "Full DPS (all skills)" row (only shown when it differs from TotalDPS) ──
describe('renderStatsPanel — Full DPS (all skills) offence row', () => {
  it('shows the FullDPS row when FullDPS > 0 and differs from TotalDPS', () => {
    const html = renderStatsPanel({ Life: 100, TotalDPS: 1000, FullDPS: 2500 })
    expect(html).toContain('Full DPS (all skills)')
    expect(html).toContain('2,500')
  })

  it('hides the FullDPS row when it equals TotalDPS', () => {
    const html = renderStatsPanel({ Life: 100, TotalDPS: 2500, FullDPS: 2500 })
    expect(html).not.toContain('Full DPS (all skills)')
  })

  it('renders deflection + spell-block rows and flags a negative unreserved-life pool', () => {
    const html = renderStatsPanel({
      Life: 5000,
      LifeUnreserved: -100,
      DeflectionRating: 200,
      DeflectChance: 15,
      EffectiveSpellBlockChance: 20,
    })
    expect(html).toContain('sp-bad') // over-reserved life → danger class on the "(N free)" suffix
    expect(html).toContain('200') // deflection rating
    expect(html).toContain('(15%)') // deflect chance sub
  })
})

// ── ui/pobInspectorPanel — the JSON dump + its stringify-failure guard ──
describe('renderPobInspector', () => {
  it('dumps the parsed build as escaped JSON inside a details/pre', () => {
    const html = renderPobInspector(emptyPobBuild({ notes: 'hello' }))
    expect(html).toContain('Full PoB data')
    expect(html).toContain('<pre class="pob-inspector-json">')
    expect(html).toContain('&quot;notes&quot;: &quot;hello&quot;') // JSON is HTML-escaped into the <pre>
  })

  it('drops the panel (returns "") when the build cannot be serialised', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular // JSON.stringify throws on a cycle → the catch branch returns ''
    const build = emptyPobBuild({ party: circular as unknown as Record<string, string> })
    expect(renderPobInspector(build)).toBe('')
  })
})

// ── items/detailsPanel — optional meta fields, granted skills, and a negative applyRange roll ──
describe('renderItemDetails — optional fields + roll application', () => {
  it('renders radius / limited-to / defences / flags / granted skills for a unique jewel', () => {
    const item = emptySummaryItem({
      slot: 'Jewel 1',
      rarity: 'UNIQUE',
      name: 'Grand Spectrum',
      baseType: 'Grand Spectrum', // === name → the base-type span is suppressed
      radius: 'Medium',
      limitedTo: '1',
      itemLevel: 68,
      quality: 5,
      socketString: 'S',
      defences: { 'Energy Shield': '250', Spirit: '30' },
      flags: ['Corrupted'],
      grantedSkills: [
        { name: 'Fireball', level: 20 },
        { name: 'Frostbolt', level: null },
      ],
      mods: ['+10% to all Elemental Resistances'],
      inBuild: false, // → the "preview only" stamp
    })
    const html = renderItemDetails(item)
    expect(html).toContain('Radius')
    expect(html).toContain('Medium')
    expect(html).toContain('Limited to')
    expect(html).toContain('Energy Shield')
    expect(html).toContain('250')
    expect(html).toContain('Spirit')
    expect(html).toContain('<span class="idp-flag">Corrupted</span>')
    expect(html).toContain('Grants')
    expect(html).toContain('Fireball (Lv 20)') // grantWithLevel branch
    expect(html).toContain('Frostbolt') // no-level branch
    expect(html).toContain('itc-stamp--preview') // inBuild:false preview stamp
    expect(html).toContain('preview only')
    expect(html).not.toContain('itc-base') // name === baseType suppresses the base span
  })

  it('applies a negative (min-max) roll at its resolved position and shows the roll percent', () => {
    const item = emptySummaryItem({
      slot: 'Ring 1',
      rarity: 'RARE',
      name: 'Test Ring',
      baseType: 'Gold Ring',
      mods: ['-(10-20)% to Cold Resistance'],
      parsedMods: [
        { text: '-(10-20)% to Cold Resistance', tags: [], isImplicit: false, rangeHint: '0.5', corruptedMult: null },
      ],
    })
    const html = renderItemDetails(item)
    expect(html).toContain('-15% to Cold Resistance') // 10 + 0.5*(20-10) = 15, negated
    expect(html).toContain('50%') // rangeHint 0.5 → 50% roll
  })
})

// ── audit/audit — the branch-edge findings the fixture never triggers ──
describe('auditBuild — branch edges', () => {
  it('flags a below-cap (non-negative) chaos resist on a non-CI build as info', () => {
    const f = auditBuild(makeSummary({ playerStats: { ChaosResist: 20 } }))
    const chaos = byCode(f, 'chaos-uncapped')
    expect(chaos).toHaveLength(1)
    expect(chaos[0]!.level).toBe('info')
    expect(chaos[0]!.detail).toContain('20%')
  })

  it('errors when life is fully reserved (unreserved <= 0)', () => {
    const err = byCode(auditBuild(makeSummary({ playerStats: { LifeUnreserved: 0 } })), 'life-overreserved')
    expect(err).toHaveLength(1)
    expect(err[0]!.level).toBe('error')
  })

  it('errors when mana is over-reserved (unreserved < 0)', () => {
    const err = byCode(auditBuild(makeSummary({ playerStats: { ManaUnreserved: -50 } })), 'mana-overreserved')
    expect(err).toHaveLength(1)
    expect(err[0]!.detail).toContain('-50')
  })

  it('inventories armour + block + deflection as defensive layers', () => {
    const f = auditBuild(
      makeSummary({ playerStats: { Armour: 5000, EffectiveBlockChance: 30, DeflectionRating: 100 } }),
    )
    const layers = byCode(f, 'layers')
    expect(layers).toHaveLength(1)
    expect(layers[0]!.detail).toContain('armour')
    expect(layers[0]!.detail).toContain('block')
    expect(layers[0]!.detail).toContain('deflection')
    expect(byCode(f, 'layers-thin')).toHaveLength(0)
  })

  it('warns "no mitigation layer" when the snapshot shows none', () => {
    const thin = byCode(auditBuild(makeSummary({ playerStats: { Life: 100 } })), 'layers-thin')
    expect(thin).toHaveLength(1)
    expect(thin[0]!.detail).toContain('No mitigation layer')
  })

  it('warns "only one defensive layer" when exactly one is present', () => {
    const thin = byCode(auditBuild(makeSummary({ playerStats: { Armour: 5000 } })), 'layers-thin')
    expect(thin).toHaveLength(1)
    expect(thin[0]!.detail).toContain('Only one defensive layer')
    expect(thin[0]!.detail).toContain('armour')
  })

  it('flags a missing life flask on a non-CI build that carries a non-life flask', () => {
    const f = auditBuild(
      makeSummary({
        items: [emptySummaryItem({ slot: 'Flask 1', name: 'Ruby', baseType: 'Ruby Flask' })],
      }),
    )
    const flasks = byCode(f, 'flasks')
    expect(flasks).toHaveLength(1)
    expect(flasks[0]!.detail).toContain('life')
    expect(flasks[0]!.detail).toContain('mana')
  })

  it('stays quiet about flasks when both a life and a mana flask are equipped', () => {
    const f = auditBuild(
      makeSummary({
        items: [
          emptySummaryItem({ slot: 'Flask 1', name: 'Grand Life Flask', baseType: 'Life Flask' }),
          emptySummaryItem({ slot: 'Flask 2', name: 'Grand Mana Flask', baseType: 'Mana Flask' }),
        ],
      }),
    )
    expect(byCode(f, 'flasks')).toHaveLength(0)
  })
})

// ── pob/parse — error paths + rarely-hit shapes (no-stat PlayerStat, MinionStat, FullDPSSkill, legacy Skills) ──
describe('parsePob — error paths', () => {
  it('throws on malformed XML', () => {
    expect(() => parsePob('<a></b>')).toThrow(/could not be parsed|malformed/i)
  })

  it('rejects a Path of Building 1 (PoE1) build', () => {
    expect(() => parsePob('<PathOfBuilding></PathOfBuilding>')).toThrow(/Path of Building 1|PoE1/i)
  })

  it('rejects an unexpected root element', () => {
    expect(() => parsePob('<Foo></Foo>')).toThrow(/Unexpected root element/i)
  })

  it('throws when there is no passive tree spec', () => {
    expect(() => parsePob('<PathOfBuilding2><Build level="1"/></PathOfBuilding2>')).toThrow(/No passive tree/i)
  })
})

describe('parsePob — rarely-hit shapes', () => {
  it('skips a PlayerStat with no stat attribute and parses MinionStat + FullDPSSkill children', () => {
    const b = parsePob(
      `<PathOfBuilding2><Build level="92" className="Monk">` +
        `<PlayerStat value="5"/>` + // no stat attribute → skipped, no bogus key
        `<PlayerStat stat="TotalDPS" value="100"/>` +
        `<MinionStat stat="MinionLife" value="500"/>` +
        `<MinionStat value="7"/>` + // no stat attribute → skipped
        `<FullDPSSkill stat="FullDPS" value="12345" skillPart="Proj" source="Ballista"/></Build>` +
        `<Tree activeSpec="1"><Spec treeVersion="0_5" nodes="1,2"><URL>x</URL></Spec></Tree></PathOfBuilding2>`,
    )
    expect(b.playerStats.TotalDPS).toBe(100)
    expect(Object.keys(b.playerStats)).toEqual(['TotalDPS']) // the attribute-less PlayerStat did not land
    expect(b.minionStats.MinionLife).toBe('500')
    expect(b.fullDpsSkills).toEqual([{ stat: 'FullDPS', value: '12345', skillPart: 'Proj', source: 'Ballista' }])
  })

  it('reads a legacy <Skills> with <Skill> children directly (no <SkillSet> wrapper)', () => {
    const b = parsePob(
      `<PathOfBuilding2><Build level="1"/>` +
        `<Tree activeSpec="1"><Spec treeVersion="0_5" nodes=""/></Tree>` +
        `<Skills activeSkillSet="3"><Skill enabled="true">` +
        `<Gem gemId="G" skillId="S" nameSpec="Test" level="20" quality="0"/></Skill></Skills></PathOfBuilding2>`,
    )
    expect(b.skillSets).toHaveLength(1)
    expect(b.skillSets[0]!.id).toBe('3') // synthesised from activeSkillSet
    expect(b.activeSkillSetId).toBe('3')
    expect(b.skillGroups).toHaveLength(1)
    expect(b.skillGroups[0]!.gems[0]!.nameSpec).toBe('Test')
  })
})

// ── export/builds — the dedupe while-loop when a generated suffix collides with a user-provided name ──
describe('dedupeStems — suffix collision with a user name', () => {
  it('keeps incrementing past a name that already matches the generated suffix', () => {
    expect(dedupeStems(['a', 'a (2)', 'a'])).toEqual(['a', 'a (2)', 'a (3)'])
  })
})
