import { describe, it, expect } from 'vitest'
import { computeLoadouts } from '../src/export/loadouts'
import type { PobBuild, PobSpec, PobSkillSet, PobItemSet, PobConfigSet } from '../src/convert/types'
import { emptyPobBuild, emptySpec, emptyItemSet } from './helpers/pobBuild'

const spec = (title: string | null): PobSpec => emptySpec({ treeVersion: '0_5', title })
const skills = (id: string, title: string | null): PobSkillSet => ({ id, title, groups: [] })
const items = (id: string, title: string | null): PobItemSet => emptyItemSet(id, title)
const config = (id: string, title: string | null): PobConfigSet => ({ id, title, inputs: [], placeholders: [] })

function pob(over: {
  specs: PobSpec[]
  skillSets: PobSkillSet[]
  itemSets: PobItemSet[]
  configSets?: PobConfigSet[]
}): PobBuild {
  return emptyPobBuild({
    className: 'Monk',
    spec: over.specs[0]!,
    activeSkillSetId: over.skillSets[0]?.id ?? null,
    activeItemSetId: over.itemSets[0]?.id ?? null,
    configSets: over.configSets ?? [config('1', 'Default')],
    ...over,
  })
}

describe('computeLoadouts (faithful PoB SyncLoadouts)', () => {
  it('recovers the pob4 scenario: full-title equality across 4 axes', () => {
    // 3 trees, 3 skill sets, 3 item sets, 2 config sets — "New Loadout test levelling" spans all axes
    const build = pob({
      specs: [spec(null), spec('New Tree test'), spec('New Loadout test levelling')],
      skillSets: [skills('1', null), skills('2', 'New Skill Set test'), skills('3', 'New Loadout test levelling')],
      itemSets: [items('1', 'Default'), items('2', 'New Item Set test'), items('3', 'New Loadout test levelling')],
      configSets: [config('1', 'Default'), config('2', 'New Loadout test levelling')],
    })
    expect(computeLoadouts(build)).toEqual([
      { name: 'Default', specIndex: 0, skillSetId: '1', itemSetId: '1' },
      { name: 'New Loadout test levelling', specIndex: 2, skillSetId: '3', itemSetId: '3' },
    ])
    // "New Tree test" (spec 1) is correctly NOT a loadout — no item/skill set shares its title
  })

  it('a single set on an axis fans out to every loadout (oneItem / oneConfig)', () => {
    const build = pob({
      specs: [spec('A'), spec('B')],
      skillSets: [skills('s1', 'A'), skills('s2', 'B')],
      itemSets: [items('only', 'whatever')], // oneItem → applies to all
      configSets: [config('c', 'ignored')], // oneConfig → applies to all
    })
    expect(computeLoadouts(build)).toEqual([
      { name: 'A', specIndex: 0, skillSetId: 's1', itemSetId: 'only' },
      { name: 'B', specIndex: 1, skillSetId: 's2', itemSetId: 'only' },
    ])
  })

  it('the trivial single-set build yields one "Default" loadout', () => {
    const build = pob({ specs: [spec(null)], skillSets: [skills('1', null)], itemSets: [items('1', null)] })
    expect(computeLoadouts(build)).toEqual([{ name: 'Default', specIndex: 0, skillSetId: '1', itemSetId: '1' }])
  })

  it('links sets by a {id} brace key, after the full-name loadouts', () => {
    const build = pob({
      specs: [spec('Endgame'), spec('Lvl {1}')],
      skillSets: [skills('s0', 'Endgame'), skills('s1', 'boss {1}')],
      itemSets: [items('i0', 'Endgame'), items('i1', 'gear {1}')],
      configSets: [config('c', 'Default')], // oneConfig
    })
    expect(computeLoadouts(build)).toEqual([
      { name: 'Endgame', specIndex: 0, skillSetId: 's0', itemSetId: 'i0' }, // full-name first
      { name: 'Lvl {1}', specIndex: 1, skillSetId: 's1', itemSetId: 'i1' }, // brace link
    ])
  })

  it('a {1,2} brace key joins multiple loadouts', () => {
    const build = pob({
      specs: [spec('Tree {1}'), spec('Tree {2}')],
      skillSets: [skills('shared', 'skills {1,2}')], // oneSkill anyway, but also linked to both
      itemSets: [items('i1', 'gear {1}'), items('i2', 'gear {2}')],
      configSets: [config('c', 'x')], // oneConfig
    })
    expect(computeLoadouts(build)).toEqual([
      { name: 'Tree {1}', specIndex: 0, skillSetId: 'shared', itemSetId: 'i1' },
      { name: 'Tree {2}', specIndex: 1, skillSetId: 'shared', itemSetId: 'i2' },
    ])
  })

  it('does not let absent config sets suppress otherwise-valid loadouts', () => {
    const build = pob({
      specs: [spec('A'), spec('B')],
      skillSets: [skills('s1', 'A'), skills('s2', 'B')],
      itemSets: [items('i1', 'A'), items('i2', 'B')],
      configSets: [], // none parsed → config must not block
    })
    expect(computeLoadouts(build)).toEqual([
      { name: 'A', specIndex: 0, skillSetId: 's1', itemSetId: 'i1' },
      { name: 'B', specIndex: 1, skillSetId: 's2', itemSetId: 'i2' },
    ])
  })

  it('returns [] when no spec resolves on every axis', () => {
    const build = pob({
      specs: [spec('A')],
      skillSets: [skills('s1', 'B'), skills('s2', 'C')], // no "A"
      itemSets: [items('i1', 'A'), items('i2', 'D')],
      configSets: [config('c1', 'x'), config('c2', 'y')],
    })
    expect(computeLoadouts(build)).toEqual([])
  })
})
