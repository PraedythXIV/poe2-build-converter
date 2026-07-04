// Atlas-masters drawer tests (jsdom): the data join is sound (3 masters × 12 keystones,
// 4 rows × 3 cols display, exact stat text — no raw fallback), and mountAtlasMasters enforces
// the in-game rule (pick ANY keystones, hard 4-point cap, no per-row limit) via clicks + setState.

import { describe, it, expect, beforeEach } from 'vitest'
import { mountAtlasMasters, allocatedMasterStats, MASTER_ACCENT, type MastersApi } from '../src/atlas/masters'
import mastersData from '../src/data/atlasMasters.json'
import iconData from '../src/data/atlasMasterIcons.json'

interface Keystone {
  id: string
  row: number
  col: number
  name: string
  stats: string[]
}
interface MasterJson {
  id: string
  name: string
  budget: number
  keystones: Keystone[]
}
const DATA = mastersData as unknown as { budget: number; masters: MasterJson[] }

function mount(): MastersApi {
  document.body.innerHTML = `<div class="at-stage"><button id="t"></button><aside id="d"></aside></div>`
  const drawer = document.getElementById('d') as HTMLElement
  const toggle = document.getElementById('t') as HTMLElement
  return mountAtlasMasters(drawer, toggle)
}
const cells = () => [...document.querySelectorAll<HTMLButtonElement>('.am-cell')]
const onCount = () => document.querySelectorAll('.am-cell.is-on').length
const clickSwitch = (id: string) =>
  document.querySelector<HTMLButtonElement>(`.am-switch-btn[data-master="${id}"]`)!.click()

describe('atlasMasters data integrity', () => {
  it('has exactly 3 masters, each 12 keystones over 4 rows × 3 cols', () => {
    expect(DATA.masters).toHaveLength(3)
    for (const m of DATA.masters) {
      expect(m.keystones).toHaveLength(12)
      expect(m.budget).toBe(4)
      const byRow: Record<number, number> = {}
      for (const k of m.keystones) byRow[k.row] = (byRow[k.row] ?? 0) + 1
      expect([1, 2, 3, 4].map((r) => byRow[r])).toEqual([3, 3, 3, 3])
      expect(new Set(m.keystones.map((k) => `${k.row},${k.col}`)).size).toBe(12) // unique cells
    }
  })

  it('resolves every keystone to exact English text (no raw "stat_id = value" fallback)', () => {
    for (const m of DATA.masters) {
      for (const k of m.keystones) {
        expect(k.stats.length).toBeGreaterThan(0)
        for (const s of k.stats) expect(s).not.toMatch(/^[a-z0-9_]+ = -?\d/) // raw fallback shape
      }
    }
  })
})

describe('drawer open/close a11y state', () => {
  it('toggling flips inert + aria-hidden on the drawer and aria-expanded on the toggle', () => {
    mount()
    const drawer = document.getElementById('d') as HTMLElement
    const toggle = document.getElementById('t') as HTMLElement
    toggle.click() // open
    expect(drawer.hasAttribute('inert')).toBe(false)
    expect(drawer.getAttribute('aria-hidden')).toBe('false')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    toggle.click() // close — its buttons must leave the tab order + a11y tree
    expect(drawer.hasAttribute('inert')).toBe(true)
    expect(drawer.getAttribute('aria-hidden')).toBe('true')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('MASTER_ACCENT is data-driven (no hardcoded hues)', () => {
  it('reads each master accent straight from the glyph-derived _accents table', () => {
    const accents = (iconData as unknown as { _accents?: Record<string, string> })._accents ?? {}
    expect(Object.keys(accents).length).toBeGreaterThan(0) // the build wrote real accents
    for (const m of DATA.masters) {
      expect(MASTER_ACCENT[m.id]).toBe(accents[m.id]) // sourced, not a literal in masters.ts
      expect(MASTER_ACCENT[m.id]).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/)
    }
  })
})

describe('allocatedMasterStats', () => {
  it('returns the picked keystones’ exact stats in keystone order, ignoring unpicked', () => {
    const m = DATA.masters[0]!
    const k0 = m.keystones[0]!
    const k2 = m.keystones[2]!
    // pick order reversed — output still follows the master’s keystone order
    expect(allocatedMasterStats({ [m.id]: [k2.id, k0.id] })).toEqual([...k0.stats, ...k2.stats])
  })

  it('returns [] for an empty or unknown allocation', () => {
    expect(allocatedMasterStats({})).toEqual([])
    expect(allocatedMasterStats({ NotAMaster: ['x'] })).toEqual([])
  })

  it('re-applies the 4-point cap so an over-budget (hand-edited) link can’t inflate the summary', () => {
    const m = DATA.masters[0]!
    const sixPicks = m.keystones.slice(0, 6).map((k) => k.id) // 6 > the 4-point budget
    const capped = m.keystones.slice(0, m.budget).flatMap((k) => k.stats) // only the first 4 contribute
    expect(allocatedMasterStats({ [m.id]: sixPicks })).toEqual(capped)
  })
})

describe('mountAtlasMasters rule enforcement', () => {
  beforeEach(() => mount())

  it('starts empty with all three masters present', () => {
    const api = mount()
    expect(api.total()).toBe(0)
    expect(Object.keys(api.getState())).toEqual(DATA.masters.map((m) => m.id))
  })

  it('renders the first master as a 12-cell grid', () => {
    expect(cells()).toHaveLength(12)
  })

  it('allows multiple picks in the same display row (no per-row limit)', () => {
    // render() rebuilds the grid on each toggle, so always act on freshly-queried cells
    cells()[0]!.click() // display row1 col1
    cells()[1]!.click() // display row1 col2 — same row, both should stay on
    cells()[2]!.click() // display row1 col3
    expect(onCount()).toBe(3)
    expect(cells()[0]!.classList.contains('is-on')).toBe(true)
    expect(cells()[2]!.classList.contains('is-on')).toBe(true)
  })

  it('clicking an allocated keystone deallocates it', () => {
    cells()[0]!.click()
    expect(onCount()).toBe(1)
    cells()[0]!.click()
    expect(onCount()).toBe(0)
  })

  it('caps at the 4-point budget and refuses a 5th pick (any keystones)', () => {
    const c = cells()
    c[0]!.click()
    c[1]!.click()
    c[2]!.click()
    c[3]!.click()
    expect(onCount()).toBe(4)
    cells()[4]!.click() // 5th pick is rejected by the cap
    expect(onCount()).toBe(4)
  })

  it('setState re-applies the budget cap, dropping over-budget input', () => {
    const api = mount()
    const m = DATA.masters[0]!
    const fivePicks = m.keystones.slice(0, 5).map((k) => k.id) // 5 distinct keystones
    api.setState({ [m.id]: fivePicks })
    expect(api.getState()[m.id]).toHaveLength(4) // trimmed to the 4-point budget
  })

  it('getState/setState round-trips a legal plan (incl. clustered picks)', () => {
    const api = mount()
    const m = DATA.masters[0]!
    const legal = m.keystones.slice(0, 4).map((k) => k.id) // first 4 keystones (two share row 1)
    api.setState({ [m.id]: legal })
    expect(new Set(api.getState()[m.id])).toEqual(new Set(legal))
    expect(api.total()).toBe(4)
  })

  it('subscribe fires on a user click with the new state', () => {
    const api = mount()
    let seen: Record<string, string[]> | null = null
    api.subscribe((s) => (seen = s))
    cells()[0]!.click()
    expect(seen).not.toBeNull()
    expect(api.total()).toBe(1)
  })

  it('the master selector switches the active master’s grid', () => {
    clickSwitch('Hilda')
    expect(document.querySelector('.am-name')!.textContent).toBe(DATA.masters.find((m) => m.id === 'Hilda')!.name)
    expect(document.querySelector('.am-switch-btn[data-master="Hilda"]')!.classList.contains('is-active')).toBe(true)
    expect(cells()).toHaveLength(12)
  })

  it('hovering a keystone shows the tooltip with its exact stats', () => {
    const c = cells()
    c[0]!.dispatchEvent(new Event('mouseenter'))
    const tip = document.querySelector('.am-tip') as HTMLElement
    expect(tip.hidden).toBe(false)
    expect(tip.querySelector('.am-tip-name')!.textContent).toBe(DATA.masters[0]!.keystones[0]!.name)
    expect(tip.querySelectorAll('.am-tip-stats li').length).toBe(DATA.masters[0]!.keystones[0]!.stats.length)
  })

  it('hovering a master selector previews that master’s selected perks', () => {
    const api = mount()
    const m = DATA.masters[0]!
    const chosen = m.keystones.slice(0, 2)
    api.setState({ [m.id]: chosen.map((k) => k.id) })
    document.querySelector(`.am-switch-btn[data-master="${m.id}"]`)!.dispatchEvent(new Event('mouseenter'))
    const tip = document.querySelector('.am-tip') as HTMLElement
    expect(tip.hidden).toBe(false)
    expect(tip.querySelector('.am-tip-name')!.textContent).toBe(m.name)
    expect(tip.querySelector('.am-tip-sub')!.textContent).toContain('Points: 2 (4)')
    // one <li> per stat line across the allocated keystones (a keystone may have 2 stats)
    expect(tip.querySelectorAll('.am-tip-stats li').length).toBe(chosen.flatMap((k) => k.stats).length)
  })

  it('a selector with no picks previews the empty state', () => {
    mount()
    const id = DATA.masters[1]!.id
    document.querySelector(`.am-switch-btn[data-master="${id}"]`)!.dispatchEvent(new Event('mouseenter'))
    const tip = document.querySelector('.am-tip') as HTMLElement
    expect(tip.querySelector('.am-tip-empty')).not.toBeNull()
    expect(tip.querySelectorAll('.am-tip-stats li').length).toBe(0)
  })
})
