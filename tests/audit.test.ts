// C3 audit rules — fixture-driven (the real Monk CI build) + synthetic-summary unit tests,
// plus a C1 statsPanel smoke test. Fixture facts (from its PlayerStat block): Life=1, ES=5915,
// SpiritUnreserved=-200, FireResist=58, Cold/Lightning=75 (+11/+18 overcap), ChaosResist=0,
// CI keystone allocated, gloves slot empty, 3 charms + life & mana flasks equipped, level 96
// with all item LevelReqs <= 80, no duplicate supports inside any link.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarize } from '../src/convert/summarize'
import type { BuildSummary, SummaryItem } from '../src/convert/summarize'
import { emptySummaryItem } from './helpers/pobBuild'
import { auditBuild } from '../src/audit/audit'
import type { AuditFinding } from '../src/audit/audit'
import { renderAuditPanel } from '../src/ui/auditPanel'
import { renderStatsPanel } from '../src/ui/statsPanel'

const XML = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')

const byCode = (f: AuditFinding[], code: string): AuditFinding[] => f.filter((x) => x.code === code)
const codes = (f: AuditFinding[]): string[] => f.map((x) => x.code)

function makeSummary(over: Partial<BuildSummary> = {}): BuildSummary {
  return {
    className: 'Monk',
    ascendancy: null,
    level: 90,
    mainSkill: null,
    items: [],
    itemCount: 0,
    uniqueCount: 0,
    jewels: [],
    skills: [],
    keystones: [],
    notables: [],
    ascNotables: [],
    masteries: [],
    passiveCount: 0,
    playerStats: {},
    specNodes: [],
    ascendancyInternalId: null,
    ...over,
  }
}
function makeItem(over: Partial<SummaryItem> = {}): SummaryItem {
  return emptySummaryItem({ slot: 'Helmet', rarity: 'RARE', name: 'Test Helm', baseType: 'Iron Hat', ...over })
}

describe('auditBuild — fixture (Monk CI build)', () => {
  const findings = auditBuild(summarize(XML))

  it('flags the over-reserved spirit as the single error', () => {
    const errors = findings.filter((f) => f.level === 'error')
    expect(errors.map((f) => f.code)).toEqual(['spirit-overreserved'])
    expect(errors[0]!.detail).toContain('200') // SpiritUnreserved = -200
    expect(errors[0]!.detail).toContain('145') // Spirit total
  })

  it('warns only about the uncapped fire resist (58%, 17 short of cap)', () => {
    const warns = findings.filter((f) => f.level === 'warn')
    expect(warns.map((f) => f.code)).toEqual(['res-uncapped-fire'])
    expect(warns[0]!.detail).toContain('58')
    expect(warns[0]!.detail).toContain('17')
  })

  it('reports capped cold + lightning (with overcap) as one good finding', () => {
    const good = findings.filter((f) => f.level === 'good')
    expect(good.map((f) => f.code)).toEqual(['res-capped'])
    expect(good[0]!.detail).toContain('Cold 75% (+11 overcap)')
    expect(good[0]!.detail).toContain('Lightning 75% (+18 overcap)')
  })

  it('explains CI and suppresses all chaos-resistance findings', () => {
    expect(byCode(findings, 'ci')).toHaveLength(1)
    expect(codes(findings).some((c) => c.startsWith('chaos'))).toBe(false)
  })

  it('inventories the two defensive layers (evasion + energy shield) without warning', () => {
    const layers = byCode(findings, 'layers')
    expect(layers).toHaveLength(1)
    expect(layers[0]!.level).toBe('info')
    expect(layers[0]!.detail).toContain('evasion')
    expect(layers[0]!.detail).toContain('energy shield')
    expect(byCode(findings, 'layers-thin')).toHaveLength(0)
  })

  it('surfaces the weakest max-hit type (physical 5,916; the "inf" chaos hit is excluded)', () => {
    const hit = byCode(findings, 'weakest-hit')
    expect(hit).toHaveLength(1)
    expect(hit[0]!.title).toContain('physical')
    expect(hit[0]!.detail).toContain('5,916')
  })

  it('lists the empty gloves slot, and nothing else structural fires', () => {
    const gear = byCode(findings, 'gear-missing')
    expect(gear).toHaveLength(1)
    expect(gear[0]!.detail).toContain('Gloves')
    expect(gear[0]!.detail).not.toContain('Helmet')
    // met requirements / full flask + charm loadout / clean links / stats present → no findings
    for (const code of ['attr-unmet', 'flasks', 'charms', 'duplicate-supports', 'item-level', 'no-stats']) {
      expect(byCode(findings, code)).toHaveLength(0)
    }
  })
})

describe('auditBuild — synthetic summaries', () => {
  it('warns per uncapped elemental resist, stating the gap', () => {
    const f = auditBuild(makeSummary({ playerStats: { FireResist: 40, ColdResist: 75, LightningResist: 80 } }))
    const warn = byCode(f, 'res-uncapped-fire')
    expect(warn).toHaveLength(1)
    expect(warn[0]!.level).toBe('warn')
    expect(warn[0]!.detail).toContain('35') // 75 - 40
    expect(byCode(f, 'res-capped')).toHaveLength(1) // cold + lightning still earn the good finding
  })

  it('treats a resist sitting at a LOWERED cap (OverCap > 0, value < 75) as capped, not uncapped', () => {
    // A max-resistance-lowering mod can cap a resist below 75; PoB reports it AT its cap via OverCap.
    // The old code blindly compared to 75 and false-warned "15% short"; OverCap is now authoritative.
    const f = auditBuild(makeSummary({ playerStats: { ColdResist: 60, ColdResistOverCap: 5 } }))
    expect(byCode(f, 'res-uncapped-cold')).toHaveLength(0)
    const good = byCode(f, 'res-capped')
    expect(good).toHaveLength(1)
    expect(good[0]!.detail).toContain('Cold 60% (+5 overcap)')
  })

  it('escalates a negative elemental resist to an error', () => {
    const f = auditBuild(makeSummary({ playerStats: { ColdResist: -20 } }))
    const err = byCode(f, 'res-negative-cold')
    expect(err).toHaveLength(1)
    expect(err[0]!.level).toBe('error')
  })

  it('errors on unmet attribute requirements', () => {
    const f = auditBuild(makeSummary({ playerStats: { Str: 50, ReqStr: 100, Dex: 80, ReqDex: 70 } }))
    const err = byCode(f, 'attr-unmet')
    expect(err).toHaveLength(1)
    expect(err[0]!.level).toBe('error')
    expect(err[0]!.detail).toContain('Str 50 < required 100')
    expect(err[0]!.detail).not.toContain('Dex 80') // met requirement is not reported
  })

  it('warns when one link lists the same support twice', () => {
    const f = auditBuild(
      makeSummary({
        skills: [
          { main: 'Spark', level: 1, quality: 0, supports: ['Heft', 'Heft', 'Blind II'], isMain: true, gems: [] },
        ],
      }),
    )
    const warn = byCode(f, 'duplicate-supports')
    expect(warn).toHaveLength(1)
    expect(warn[0]!.level).toBe('warn')
    expect(warn[0]!.title).toContain('Spark')
    expect(warn[0]!.detail).toContain('Heft')
    expect(warn[0]!.detail).not.toContain('Blind II')
  })

  it('suppresses chaos-resist findings under Chaos Inoculation (and not otherwise)', () => {
    const stats = { ChaosResist: -60 }
    const ci = auditBuild(makeSummary({ playerStats: { ...stats }, keystones: ['Chaos Inoculation'] }))
    expect(codes(ci).some((c) => c.startsWith('chaos'))).toBe(false)
    expect(byCode(ci, 'ci')).toHaveLength(1)
    const noCi = auditBuild(makeSummary({ playerStats: { ...stats } }))
    expect(byCode(noCi, 'chaos-negative')).toHaveLength(1)
    expect(byCode(noCi, 'ci')).toHaveLength(0)
  })

  it('warns per item whose level requirement exceeds the build level', () => {
    const f = auditBuild(
      makeSummary({
        level: 10,
        items: [makeItem({ levelReq: 30 }), makeItem({ slot: 'Boots', name: 'Low Boots', levelReq: 5 })],
      }),
    )
    const warn = byCode(f, 'item-level')
    expect(warn).toHaveLength(1)
    expect(warn[0]!.detail).toContain('requires level 30')
    expect(warn[0]!.detail).toContain('level 10')
  })

  it('falls back to a single "no PoB stats" note + structural rules only when stats are absent', () => {
    const f = auditBuild(makeSummary({ playerStats: {} }))
    expect(byCode(f, 'no-stats')).toHaveLength(1)
    // no stat-based findings at all
    expect(codes(f).some((c) => c.startsWith('res-') || c.startsWith('chaos') || c.startsWith('layers'))).toBe(false)
    // structural rules still ran (empty gear → coverage findings)
    expect(byCode(f, 'gear-missing')).toHaveLength(1)
  })
})

describe('renderAuditPanel', () => {
  it('groups by severity (errors first), shows a summary line, and reuses the toast vocabulary', () => {
    const html = renderAuditPanel(auditBuild(summarize(XML)))
    expect(html).toContain('1 issue')
    expect(html).toContain('1 warning')
    expect(html).toContain('1 OK')
    expect(html).toContain('alert danger')
    expect(html).toContain('alert success')
    // errors render before everything else
    expect(html.indexOf('alert danger')).toBeLessThan(html.indexOf('alert warn'))
    expect(html.indexOf('alert warn')).toBeLessThan(html.indexOf('alert success'))
  })

  it('returns an empty string for no findings', () => {
    expect(renderAuditPanel([])).toBe('')
  })
})

describe('renderStatsPanel (C1 smoke)', () => {
  it('returns an empty string when the export carries no stats', () => {
    expect(renderStatsPanel({})).toBe('')
  })

  it('renders the fixture stats with separators, % colouring, charges and the full table', () => {
    const stats = summarize(XML).playerStats
    const html = renderStatsPanel(stats)
    expect(html).toContain('28,142') // TotalDPS 28142.41… with thousands separator
    expect(html).toContain('0.63') // Speed, 2 decimals
    expect(html).toContain('69.15%') // CritChance, ≤2 decimals + % suffix
    expect(html).toContain('sp-good') // capped cold/lightning resists
    expect(html).toContain('sp-mid') // fire 58 / chaos 0
    expect(html).toContain('0 / 6') // power charges current/max
    expect(html).toContain(`All exported stats (${Object.keys(stats).length})`)
    expect(html).toContain('snapshot') // the honesty caption
  })

  it('flags unmet attribute requirements as value / required in danger colour', () => {
    const html = renderStatsPanel({ Str: 50, ReqStr: 100 })
    expect(html).toContain('50 / 100 req')
    expect(html).toContain('sp-bad')
  })
})
