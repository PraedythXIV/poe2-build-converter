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
