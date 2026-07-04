// Edge-case coverage for the convert engine — the small uncovered branches across
// mapItems / mapPassives / summarize / emit / convert index that the main convert.test /
// summarize.test / loadouts.test suites don't reach. Every test drives the REAL pipeline
// (no mocks of the modules under test) and asserts on the emitted .build / summary structure
// for unusual inputs: empty/missing fields, unmapped slots, uncanonical uniques, granted jewel
// sockets, error paths, and the defensive fallbacks.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { convert, convertVariant, DecodeError, overrideSpecNodes } from '../src/convert/index'
import { parsePob } from '../src/convert/parsePob'
import { mapItems } from '../src/convert/mapItems'
import { mapPassives } from '../src/convert/mapPassives'
import { summarizeBuild, splitRunesAndGrants } from '../src/convert/summarize'
import { assembleBuild, validateBuild } from '../src/convert/emit'
import type { Build, PobGem, PobItem, PobSkillGroup, PobSlot, Warning } from '../src/convert/types'
import { emptyPobBuild, emptySpec } from './helpers/pobBuild'
import passivesData from '../src/data/passives.json'

const SAMPLE_XML = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')

// ── vendored tree data → real node ids picked by kind (refresh-safe: derived, not hard-coded) ──
const NODES = (passivesData as { nodes: Record<string, string> }).nodes
const META = (passivesData as { nodeMeta: Record<string, { name: string; kind: string; asc?: number }> }).nodeMeta
const metaId = (pred: (m: { name: string; kind: string; asc?: number }) => boolean): string =>
  Object.keys(META).find((id) => pred(META[id]!) && NODES[id] !== undefined)!
const KEYSTONE = metaId((m) => m.kind === 'keystone')
const MASTERY = metaId((m) => m.kind === 'mastery')
const NOTABLE = metaId((m) => m.kind === 'notable' && !m.asc)
const ASC_NOTABLE = metaId((m) => m.kind === 'notable' && !!m.asc)
// plain resolving nodes with no named meta — used for the structural (weapon-set / socket) roles
const PLAIN = Object.keys(NODES).filter((id) => !META[id])
const UNKNOWN_A = '999999999' // does not resolve via passiveIdForNode
const UNKNOWN_B = '999999998'

// ── full-fidelity local factories (kept here, not in helpers/, so sibling agents don't collide) ──
function item(over: Partial<PobItem> = {}): PobItem {
  return {
    id: 'x',
    rarity: 'NORMAL',
    name: '',
    baseType: '',
    mods: [],
    levelReq: 1,
    runes: [],
    grantedSkills: [],
    raw: '',
    itemLevel: null,
    quality: null,
    uniqueId: null,
    itemClass: null,
    socketString: null,
    radius: null,
    limitedTo: null,
    defences: {},
    flags: [],
    implicits: [],
    parsedMods: [],
    modRanges: [],
    variantAttrs: {},
    ...over,
  }
}
function gem(over: Partial<PobGem> = {}): PobGem {
  return {
    gemId: '',
    skillId: '',
    nameSpec: '',
    level: 1,
    quality: 0,
    enabled: true,
    variantId: null,
    count: null,
    enableGlobal1: null,
    enableGlobal2: null,
    corrupted: null,
    corruptLevel: null,
    statSetIndex: null,
    statSetIndexCalcs: null,
    minion: null,
    rawAttrs: {},
    ...over,
  }
}
function group(over: Partial<PobSkillGroup> = {}): PobSkillGroup {
  return {
    enabled: true,
    mainActiveSkill: null,
    source: null,
    gems: [],
    slot: null,
    label: null,
    includeInFullDPS: null,
    mainActiveSkillCalcs: null,
    rawAttrs: {},
    ...over,
  }
}
function slot(name: string, itemId: string): PobSlot {
  return { name, itemId, active: true, itemPbURL: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// mapItems — unmapped slots, missing items, uncanonical uniques, mod overflow, bare items
// ─────────────────────────────────────────────────────────────────────────────
describe('mapItems edge cases', () => {
  const items = new Map<string, PobItem>([
    // an uncanonical unique WITH a base type → unique_name falls back to the item name + baseType note
    ['fakeU', item({ id: 'fakeU', rarity: 'UNIQUE', name: 'Zzz Fake Unique Blade', baseType: 'Rusted Sword' })],
    // an uncanonical unique with NO base type and no sockets/grants → only the name → no additional_text
    ['bareU', item({ id: 'bareU', rarity: 'UNIQUE', name: 'Qqq Nameless Relic', baseType: '' })],
    // an item with an EMPTY rarity string → treated as NORMAL, no mods (rareGuidance empty branches)
    ['plain', item({ id: 'plain', rarity: '', name: 'Plain Ring', baseType: '' })],
    // a RARE with >10 mods (mod overflow "+N more") + a granted skill that has no level (bare grantLabel)
    [
      'rareBig',
      item({
        id: 'rareBig',
        rarity: 'RARE',
        name: 'Doom Ward',
        baseType: 'Ancient Belt',
        levelReq: 55,
        mods: Array.from({ length: 12 }, (_, i) => `Mod line ${i + 1}`),
        grantedSkills: [{ name: 'Some Granted Skill', level: null }],
      }),
    ],
    [
      'gear',
      item({ id: 'gear', rarity: 'MAGIC', name: 'Magic Boots', baseType: 'Leather Boots', mods: ['+10 to Life'] }),
    ],
  ])
  const pob = emptyPobBuild({
    items,
    slots: [
      slot('Weapon 1', 'fakeU'),
      slot('Amulet', 'bareU'),
      slot('Ring 1', 'plain'),
      slot('Belt', 'rareBig'),
      slot('Boots', 'gear'),
      slot('Weird Extra Slot', 'gear'), // slot name not in SLOT_MAP → unmapped + skipped
      slot('Gloves', 'doesNotExist'), // valid slot, itemId absent from the item pool → skipped
      slot('Helmet', '0'), // empty itemId sentinel → silently continued (not skipped)
    ],
  })
  const warnings: Warning[] = []
  const res = mapItems(pob, warnings)

  it('maps the five real items and skips the unmapped slot + missing item', () => {
    expect(res.itemCount).toBe(5)
    expect(res.skipped).toBe(2) // unmapped "Weird Extra Slot" + missing "doesNotExist"
    const ids = res.inventory_slots.map((s) => s.inventory_id).sort()
    expect(ids).toEqual(['Amulet1', 'Belt1', 'Boots1', 'Ring1', 'Weapon1'])
  })

  it('warns about the unmapped slot and the uncanonical uniques', () => {
    expect(warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['slot-unmapped', 'unique-name-unverified']))
  })

  it('an uncanonical unique keeps its own name and notes the base type', () => {
    const weapon = res.inventory_slots.find((s) => s.inventory_id === 'Weapon1')!
    expect(weapon.unique_name).toBe('Zzz Fake Unique Blade') // no canonical form → item name verbatim
    expect(weapon.additional_text).toContain('Rusted Sword')
    expect(weapon.level_interval).toEqual([1, 100])
  })

  it('a bare unique (no base type, no sockets/grants) emits no additional_text', () => {
    const amulet = res.inventory_slots.find((s) => s.inventory_id === 'Amulet1')!
    expect(amulet.unique_name).toBe('Qqq Nameless Relic')
    expect(amulet.additional_text).toBeUndefined()
  })

  it('an empty-rarity item is guided as NORMAL with no mod list', () => {
    const ring = res.inventory_slots.find((s) => s.inventory_id === 'Ring1')!
    // titleCase('') → '' so the head reads " — Plain Ring"; the mods block is omitted (no mods)
    expect(ring.additional_text).toContain('Plain Ring')
  })

  it('a rare with >10 mods shows an overflow count and a level-less granted skill', () => {
    const belt = res.inventory_slots.find((s) => s.inventory_id === 'Belt1')!
    expect(belt.additional_text).toContain('(+2 more)') // 12 mods, MAX_MODS = 10
    expect(belt.additional_text).toContain('Grants Skill: Some Granted Skill') // no "(Lv …)" — level is null
    expect(belt.level_interval).toEqual([55, 100])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// mapPassives — dedup, weapon-set tagging, missing/granted jewel sockets, unknown nodes
// ─────────────────────────────────────────────────────────────────────────────
describe('mapPassives edge cases', () => {
  const [nodeDup, nodeWs1, nodeWs2, nodeMissingJewel, grantMissing, grantOk] = PLAIN

  const spec = emptySpec({
    treeVersion: '0_5',
    nodes: [nodeDup!, nodeDup!, nodeWs1!, nodeWs2!, nodeMissingJewel!, UNKNOWN_A],
    weaponSet1: [nodeWs1!],
    weaponSet2: [nodeWs2!],
    sockets: [
      { nodeId: nodeWs1!, itemId: '0' }, // empty socket → skipped when building jewelByNode
      { nodeId: nodeMissingJewel!, itemId: 'jm1' }, // allocated node, jewel absent from the pool → missing
      { nodeId: UNKNOWN_B, itemId: 'jvalid' }, // granted socket on an UNRESOLVABLE node → skipped
      { nodeId: grantMissing!, itemId: 'jm2' }, // granted socket that resolves but its jewel is absent
      { nodeId: grantOk!, itemId: 'jvalid' }, // granted socket that resolves with a real jewel → carried
    ],
  })
  const pob = emptyPobBuild({
    spec,
    specs: [spec],
    items: new Map<string, PobItem>([['jvalid', item({ id: 'jvalid', name: 'Test Jewel Alpha' })]]),
  })
  const warnings: Warning[] = []
  const { passives, skipped } = mapPassives(pob, warnings)

  it('skips the unknown node and de-dupes the repeated node', () => {
    expect(skipped).toBe(1) // only UNKNOWN_A is unresolvable
    const dupId = NODES[nodeDup!]
    const dupCount = passives.filter((p) => (typeof p === 'string' ? p : p.id) === dupId).length
    expect(dupCount).toBe(1) // emitted once despite appearing twice in <Spec nodes>
  })

  it('tags weapon-set-specific nodes with weapon_set 1 / 2', () => {
    const byId = (numericNode: string) => passives.find((p) => typeof p !== 'string' && p.id === NODES[numericNode])
    expect(byId(nodeWs1!)).toMatchObject({ weapon_set: 1 })
    expect(byId(nodeWs2!)).toMatchObject({ weapon_set: 2 })
  })

  it('carries a jewel from a granted (unallocated) socket and drops the resolvable-but-empty ones', () => {
    const carried = passives.find(
      (p) => typeof p !== 'string' && (p.additional_text ?? '').includes('Test Jewel Alpha'),
    )
    expect(carried).toBeDefined()
    expect((carried as { id: string }).id).toBe(NODES[grantOk!])
  })

  it('emits the info/warn diagnostics for every edge (unknown node, weapon sets, missing + granted jewels)', () => {
    expect(warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining([
        'passive-node-unknown',
        'weapon-set-tagging',
        'socket-jewel-missing', // nodeMissingJewel + grantMissing both reference absent jewels
        'granted-socket-jewels',
      ]),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// summarize — gem-name fallbacks, skipped groups, unusual slots, empty fields, jewels
// ─────────────────────────────────────────────────────────────────────────────
describe('summarizeBuild edge cases', () => {
  const skillGroups: PobSkillGroup[] = [
    // main group: three gem-name resolution paths (nameSpec absent throughout)
    group({
      gems: [
        gem({ gemId: 'Metadata/Items/Gems/SkillGemIceNova' }), // resolved via the vendored gem table
        gem({ gemId: 'Metadata/Items/Gems/SupportGemFizzleBang' }), // unknown id → prettified token
        gem({ gemId: 'Zzz/' }), // unprettifiable token → "Unknown gem"
      ],
    }),
    group({ enabled: false, gems: [gem({ gemId: 'g', nameSpec: 'Disabled' })] }), // enabled=false → skipped
    group({ source: 'Tree:1', gems: [gem({ gemId: 'g', nameSpec: 'FromTree' })] }), // tree-granted → skipped
    group({ gems: [gem({ gemId: '', nameSpec: 'NoId' })] }), // all gems filtered out → summariseGroup null
  ]
  const spec = emptySpec({
    treeVersion: '0_5',
    nodes: [KEYSTONE, MASTERY, NOTABLE, ASC_NOTABLE, PLAIN[0]!], // one of every named kind + a plain node
    sockets: [
      { nodeId: KEYSTONE, itemId: 'jewA' }, // resolves → jewel is in the .build
      { nodeId: UNKNOWN_A, itemId: 'jewB' }, // unresolved node → jewel is preview-only (inBuild:false)
      { nodeId: NOTABLE, itemId: '0' }, // empty socket → skipped
      { nodeId: MASTERY, itemId: 'ghost' }, // references an absent jewel → skipped
    ],
  })
  const pob = emptyPobBuild({
    className: 'Monk',
    level: 90,
    mainSocketGroup: 1, // 1-based → the first group is the headline
    spec,
    specs: [spec],
    skillGroups,
    items: new Map<string, PobItem>([
      ['unk', item({ id: 'unk', rarity: '', name: '', baseType: '' })], // empty everything → "(unknown)" / NORMAL
      ['baseonly', item({ id: 'baseonly', rarity: 'MAGIC', name: '', baseType: 'Iron Greaves' })], // name from base
      ['ra', item({ id: 'ra', rarity: 'RARE', name: 'Ring A', baseType: 'Gold Ring' })],
      ['rb', item({ id: 'rb', rarity: 'RARE', name: 'Ring B', baseType: 'Gold Ring' })],
      ['jewA', item({ id: 'jewA', rarity: 'UNIQUE', name: 'Tree Jewel One' })],
      ['jewB', item({ id: 'jewB', rarity: 'RARE', name: 'Tree Jewel Two' })],
    ]),
    slots: [
      slot('Weird Gadget', 'unk'), // slot name matches no rank keyword → falls to the default rank
      slot('Body Armour', 'baseonly'),
      slot('Ring 1', 'ra'),
      slot('Ring 1', 'rb'), // same slot name again → the rank cache short-circuits
      slot('Amulet', 'missingItem'), // itemId absent from the pool → skipped
      slot('Boots', '0'), // empty itemId sentinel → skipped
    ],
  })
  const s = summarizeBuild(pob)

  it('resolves gem display names through nameSpec → gem table → prettified token → "Unknown gem"', () => {
    expect(s.skills).toHaveLength(1) // disabled / source / empty groups all dropped
    expect(s.skills[0]!.main).toBe('Ice Nova')
    expect(s.skills[0]!.supports).toEqual(['Fizzle Bang', 'Unknown gem'])
    expect(s.skills[0]!.gems.map((g) => g.name)).toEqual(['Ice Nova', 'Fizzle Bang', 'Unknown gem'])
    expect(s.mainSkill).toBe('Ice Nova')
  })

  it('falls back item names: base type, then "(unknown)"', () => {
    expect(s.itemCount).toBe(4) // unk, baseonly, ra, rb — missing item + empty-id slot dropped
    const gadget = s.items.find((i) => i.slot === 'Weird Gadget')!
    expect(gadget.name).toBe('(unknown)')
    expect(gadget.rarity).toBe('NORMAL') // empty rarity normalised
    expect(s.items.find((i) => i.slot === 'Body Armour')!.name).toBe('Iron Greaves')
  })

  it('extracts named perks of every kind from the tree', () => {
    expect(s.keystones).toContain(META[KEYSTONE]!.name)
    expect(s.masteries).toContain(META[MASTERY]!.name)
    expect(s.notables).toContain(META[NOTABLE]!.name)
    expect(s.ascNotables).toContain(META[ASC_NOTABLE]!.name)
    expect(s.passiveCount).toBe(5)
  })

  it('lists tree jewels with inBuild reflecting whether their socket node resolves', () => {
    expect(s.jewels.map((j) => j.name).sort()).toEqual(['Tree Jewel One', 'Tree Jewel Two'])
    expect(s.jewels.find((j) => j.name === 'Tree Jewel One')!.inBuild).toBe(true) // socket on a real node
    expect(s.jewels.find((j) => j.name === 'Tree Jewel Two')!.inBuild).toBe(false) // socket on an unknown node
  })
})

describe('splitRunesAndGrants dedup', () => {
  it('prefers the granted-skill entry that knows its level (null-level entry seen first)', () => {
    const out = splitRunesAndGrants({
      runes: [],
      grantedSkills: [
        { name: 'Frost Bomb', level: null }, // seen first, no level
        { name: 'Frost Bomb', level: 7 }, // overwrites — a level is more informative
      ],
    })
    expect(out.grantedSkills).toEqual([{ name: 'Frost Bomb', level: 7 }])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// emit — validateBuild diagnostics + assembleBuild blank-override fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('emit edge cases', () => {
  it('validateBuild flags a missing name as an error', () => {
    const warnings: Warning[] = []
    validateBuild({ name: '' } as Build, warnings)
    expect(warnings).toContainEqual(expect.objectContaining({ level: 'error', code: 'missing-name' }))
  })

  it('validateBuild flags a passive id with illegal characters', () => {
    const warnings: Warning[] = []
    validateBuild({ name: 'Ok', passives: ['good_id', 'bad id!'] } as Build, warnings)
    expect(warnings).toContainEqual(expect.objectContaining({ level: 'warn', code: 'passive-id-format' }))
  })

  it('assembleBuild treats whitespace-only overrides as blank and uses the generated defaults', () => {
    const pob = emptyPobBuild({ className: 'Monk', level: 96, spec: emptySpec({ treeVersion: '0_5' }) })
    const build = assembleBuild(pob, {
      passives: [],
      skills: [],
      inventory_slots: [],
      name: '   ',
      author: '   ',
      description: '   ',
      link: '   ',
    })
    expect(build.name).toBe('Monk (Lv 96)') // whitespace name → generated default
    expect(build.author).toBe('poe2-build-converter (PoB2 import)')
    expect(build.description).toContain('0_5') // default description carries the tree version
    expect(build.link).toBeUndefined() // blank link is dropped, not emitted empty
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// convert index — empty-input guard, node override, convertVariant defensive fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('convert index edge cases', () => {
  it('rejects empty / whitespace input with a DecodeError', () => {
    expect(() => convert('')).toThrow(DecodeError)
    expect(() => convert('   ')).toThrow(DecodeError)
  })

  it('applies a nodesOverride, converting only the overridden allocation', () => {
    const full = convert(SAMPLE_XML)
    const res = convert(SAMPLE_XML, { name: 'Override run', nodesOverride: ['11495'] })
    // the override replaces the ~129-node allocation with just node 11495 (plus any jewel that the
    // fixture's still-present sockets grant dynamically), so the count collapses dramatically
    expect(res.stats.passiveCount).toBeLessThan(full.stats.passiveCount)
    expect(res.stats.passiveCount).toBeLessThanOrEqual(5)
    expect(res.build.name).toBe('Override run')
    const ids = (res.build.passives ?? []).map((p) => (typeof p === 'string' ? p : p.id))
    expect(ids).toContain('AscendancyMonk1Start') // node 11495, the one node we kept
    expect(ids).not.toContain('criticals85') // node 61333 from the full build is gone
  })

  it('overrideSpecNodes intersects the weapon-set lists with the override', () => {
    const pob = parsePob(SAMPLE_XML)
    const kept = pob.spec.weaponSet1[0] // a node that IS weapon-set-1 specific in the fixture
    const over = overrideSpecNodes(pob, kept ? [kept] : [])
    expect(over.spec.nodes).toEqual(kept ? [kept] : [])
    // weapon-set lists only keep nodes still present in the override
    for (const n of over.spec.weaponSet1) expect(over.spec.nodes).toContain(n)
    for (const n of over.spec.weaponSet2) expect(over.spec.nodes).toContain(n)
  })

  it('convertVariant falls back to the active axes when the selectors do not resolve', () => {
    const active = convert(SAMPLE_XML)
    const pob = parsePob(SAMPLE_XML)
    const v = convertVariant(pob, { specIndex: 99, skillSetId: 'nope', itemSetId: 'nope', name: 'Fallback' })
    // out-of-range spec index and unknown set ids → the active spec / groups / slots are used
    expect(v.build.passives).toEqual(active.build.passives)
    expect(v.build.skills).toEqual(active.build.skills)
    expect(v.build.inventory_slots).toEqual(active.build.inventory_slots)
    expect(v.build.name).toBe('Fallback')
  })
})
