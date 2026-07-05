import { describe, it, expect } from 'vitest'
import { renderStatsPanel } from '../src/ui/statsPanel'

// The "Full DPS skills" sub-section surfaces PoB's per-skill FullDPS breakdown (PobBuild.fullDpsSkills).
// The numbers are PoB's exported strings shown VERBATIM — never reformatted/recomputed — so the test
// pins that the exact value string survives, and that the section self-hides with no rows.
describe('renderStatsPanel — Full DPS skills', () => {
  const stats = { Life: 4200, TotalDPS: 1_000_000 }

  it('renders the Full DPS skills section with verbatim PoB values + skill source', () => {
    const html = renderStatsPanel(stats, [
      { stat: 'FullDPS', value: '1234567.8', skillPart: 'Projectile', source: 'Lightning Arrow' },
      { stat: 'FullDPS', value: '98765', skillPart: '', source: 'Herald of Thunder' },
    ])
    expect(html).toContain('Full DPS skills')
    expect(html).toContain('Lightning Arrow')
    expect(html).toContain('1234567.8') // verbatim — not run through the numeric formatter
    expect(html).toContain('part Projectile') // skillPart shown as a muted sub when present
    expect(html).toContain('Herald of Thunder')
    expect(html).toContain('98765')
  })

  it('omits the Full DPS section when there are no rows', () => {
    expect(renderStatsPanel(stats, [])).not.toContain('Full DPS skills')
  })

  it('is back-compatible when the fullDps argument is not passed', () => {
    expect(renderStatsPanel(stats)).not.toContain('Full DPS skills')
  })
})

// Branch-coverage tests: each forces one uncovered leg of a defence/offence/resist/reservation
// path and asserts the exact rendered class / value / suffix (or its exact absence) — mutation-sensitive.
describe('renderStatsPanel — branch coverage', () => {
  // CLUSTER 44 — a partly-reserved pool (0 ≤ unreserved < total) shows a plain sp-sub suffix, not sp-bad
  it('shows a non-danger "(N free)" suffix for a partly-reserved pool', () => {
    const html = renderStatsPanel({ Mana: 100, ManaUnreserved: 60 })
    expect(html).toContain('<span class="sp-sub">(60 free)</span>')
    expect(html).not.toContain('sp-sub sp-bad')
  })
  // CLUSTER 70 — the Culling DPS offence row (only shown when CullingDPS > 0)
  it('renders the Culling DPS row when CullingDPS > 0', () => {
    const html = renderStatsPanel({ Life: 100, TotalDPS: 1000, CullingDPS: 50000 })
    expect(html).toContain('Culling DPS')
    expect(html).toContain('50,000')
  })
  // CLUSTER 79 + 84 (present leg) — the Armour row + its physical-damage-reduction sub
  it('renders the Armour row with a physical-damage-reduction sub when present', () => {
    const html = renderStatsPanel({ Life: 100, Armour: 5000, PhysicalDamageReduction: 35 })
    expect(html).toContain('Armour')
    expect(html).toContain('5,000')
    expect(html).toContain('(35% phys)')
  })
  // CLUSTER 84/93/100 (absent legs) — armour/evasion/deflection rows render WITHOUT their optional subs
  it('renders armour / evasion / deflection rows without subs when the chance stats are absent', () => {
    const html = renderStatsPanel({ Life: 100, Armour: 5000, Evasion: 3000, DeflectionRating: 200 })
    expect(html).toContain('5,000') // armour value
    expect(html).toContain('3,000') // evasion value
    expect(html).toContain('200') // deflection value
    expect(html).not.toContain('phys') // no PhysicalDamageReduction → no phys sub
    expect(html).not.toContain('evade') // no EvadeChance → no evade sub
    expect(html).not.toContain('(0%)') // no DeflectChance → no deflect-chance paren
  })
  // CLUSTER 102 — the Block-chance defence row (only shown when EffectiveBlockChance > 0)
  it('renders the Block chance row when EffectiveBlockChance > 0', () => {
    const html = renderStatsPanel({ Life: 100, EffectiveBlockChance: 25 })
    expect(html).toContain('Block chance')
    expect(html).toContain('25%')
  })
  // CLUSTER 117 — a negative resistance takes the sp-bad colour class (the val < 0 leg)
  it('colours a negative resistance with sp-bad', () => {
    const html = renderStatsPanel({ Life: 100, ChaosResist: -30 })
    expect(html).toContain('<span class="sp-bad">-30%</span>')
  })
  // CLUSTER 161 (leg 1) — a Full-DPS row with an empty source falls back to its stat name for the label
  it('falls back to the stat name for a Full-DPS row whose source is empty', () => {
    const html = renderStatsPanel({ Life: 100 }, [{ stat: 'FullDPS', value: '5', skillPart: '', source: '' }])
    expect(html).toContain('Full DPS skills')
    expect(html).toContain('<dt>FullDPS</dt>')
  })
})
