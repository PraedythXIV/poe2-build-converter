// Atlas-stats aggregation: repeated stats sum (additive); flags are grouped + counted; "Select …"
// choice prompts are dropped; numbers anywhere in the line are matched and the rest is the group key.

import { describe, it, expect } from 'vitest'
import {
  aggregateStats,
  collectAllocatedStats,
  collectStats,
  mountStatsPanel,
  type ExtraStatsSource,
  type StatsNodes,
} from '../src/atlas/statsPanel'
import { mountAtlasTree, atlasGraph, atlasRootIds } from '../src/atlas/index'
import type { TreeView } from '../src/tree/index'

/** TreeView stub with a fixed allocation + chosen mastery options (for collectStats unit tests). */
function choiceView(allocated: string[], picks: Record<string, number> = {}): TreeView {
  return {
    getAllocated: () => new Set(allocated),
    getMasteryChoices: () => new Map(Object.entries(picks)),
    subscribe: () => () => {},
  } as unknown as TreeView
}

/** Minimal TreeView stub for panel tests: a fixed allocation + a manual subscriber list. */
function stubView(allocated: string[]): { view: TreeView; fire: (a: string[]) => void } {
  let cur: ReadonlySet<string> = new Set(allocated)
  const subs: Array<(a: ReadonlySet<string>) => void> = []
  const view = {
    getAllocated: () => cur,
    getMasteryChoices: () => new Map<string, number>(),
    subscribe: (fn: (a: ReadonlySet<string>) => void) => {
      subs.push(fn)
      return () => {}
    },
  } as unknown as TreeView
  return { view, fire: (a) => ((cur = new Set(a)), subs.forEach((fn) => fn(cur))) }
}

/** Mount a stats panel (fixed single-node view) into a fresh toggle+aside pair; returns both. */
function mountPanelFixture(): { panel: HTMLElement; toggle: HTMLElement } {
  document.body.innerHTML = '<button id="t"></button><aside id="p"></aside>'
  const panel = document.getElementById('p') as HTMLElement
  const toggle = document.getElementById('t') as HTMLElement
  mountStatsPanel(
    panel,
    toggle,
    stubView(['A']).view,
    { A: { stats: ['10% increased Rarity'] } },
    { title: 'T', empty: 'E' },
  )
  return { panel, toggle }
}

describe('aggregateStats', () => {
  it('sums repeated numeric stats (additive)', () => {
    expect(aggregateStats(['10% increased Rarity', '5% increased Rarity'])).toEqual([
      { text: '15% increased Rarity', count: 2 },
    ])
  })

  it('matches a number anywhere in the line, not just the start', () => {
    expect(aggregateStats(['Shrines have 10% chance to spawn', 'Shrines have 5% chance to spawn'])).toEqual([
      { text: 'Shrines have 15% chance to spawn', count: 2 },
    ])
  })

  it('groups distinct stats separately and preserves first-seen order', () => {
    expect(aggregateStats(['5% increased A', '3% increased B', '5% increased A'])).toEqual([
      { text: '10% increased A', count: 2 },
      { text: '3% increased B', count: 1 },
    ])
  })

  it('counts flag (number-less) stats instead of summing', () => {
    expect(
      aggregateStats(['Azmeri Spirits may Possess Strongboxes', 'Azmeri Spirits may Possess Strongboxes']),
    ).toEqual([{ text: 'Azmeri Spirits may Possess Strongboxes', count: 2 }])
  })

  it('drops "Select …" choice prompts and blank lines', () => {
    expect(
      aggregateStats(['Select a bonus within Forest Areas', 'Select an Abyss Faction', '', '7% increased X']),
    ).toEqual([{ text: '7% increased X', count: 1 }])
  })

  it('collapses mid-stat newlines and handles decimals', () => {
    expect(aggregateStats(['1.5% increased\nQuantity', '1.5% increased Quantity'])).toEqual([
      { text: '3% increased Quantity', count: 2 },
    ])
  })

  it('rounds a floating-point sum to two decimals instead of leaking IEEE-754 error', () => {
    // 0.1 + 0.2 = 0.30000000000000004; the non-integer format path rounds it back to a clean 0.3
    expect(aggregateStats(['0.1% increased Quantity', '0.2% increased Quantity'])).toEqual([
      { text: '0.3% increased Quantity', count: 2 },
    ])
  })
})

describe('collectStats — choice node with a REAL base effect (regression: hidden allocated nodes)', () => {
  const nodes: StatsNodes = {
    // a chooser whose base line is a real effect; the Remnants/Explosives options carry NO stat text
    steady: {
      stats: ['Add an Explosive or Verisium Remnant to Expeditions'],
      choices: [
        { name: 'Remnants', stats: [] },
        { name: 'Explosives', stats: [] },
      ],
    },
    // a real-description chooser whose options carry the actual bonus text (the base is just a category)
    blood: {
      name: 'Blood on the Stones',
      stats: ['Summoning Circles summon packs or a more powerful Boss'],
      choices: [
        { name: 'Bosses', stats: ['Summoning Circle Bosses are Powerful'] },
        { name: 'Guardians', stats: ['Summoning Circle Runes are guarded by 2 Packs of Random Monsters'] },
      ],
    },
  }

  it('shows ONLY the selected option (not the base descriptor) when the option carries stat text', () => {
    const out = collectStats(choiceView(['blood'], { blood: 0 }), nodes)
    expect(out).toEqual(['Summoning Circle Bosses are Powerful']) // just the chosen bonus
    expect(out).not.toContain('Summoning Circles summon packs or a more powerful Boss') // base descriptor dropped
  })

  it('folds a bare-qualifier choice into the base effect (option has no stats of its own)', () => {
    // steady allocated with "Remnants" picked (idx 0, empty stats)
    const out = collectStats(choiceView(['steady'], { steady: 0 }), nodes)
    expect(out).toContain('Add an Explosive or Verisium Remnant to Expeditions (Remnants)')
    expect(out).not.toContain('Add an Explosive or Verisium Remnant to Expeditions') // not the bare base
    expect(out.some((s) => /^select /i.test(s))).toBe(false) // the bare prompt is never collected
  })

  it('switching the qualifier changes which option shows', () => {
    expect(collectStats(choiceView(['steady'], { steady: 1 }), nodes)).toEqual([
      'Add an Explosive or Verisium Remnant to Expeditions (Explosives)',
    ])
  })

  it('shows a real-base chooser even before any option is picked (bare base)', () => {
    expect(collectStats(choiceView(['steady']), nodes)).toEqual(['Add an Explosive or Verisium Remnant to Expeditions'])
  })

  it('falls back to "Node: Option" for a pure prompt node whose chosen option has no stats', () => {
    const prompt: StatsNodes = {
      azmeri: {
        name: 'Spirit Tempo',
        stats: ['Select between faster or stable Azmeri Spirits'],
        choices: [
          { name: 'Faster', stats: [] },
          { name: 'Stable', stats: [] },
        ],
      },
    }
    expect(collectStats(choiceView(['azmeri'], { azmeri: 1 }), prompt)).toEqual(['Spirit Tempo: Stable'])
  })

  it('tolerates an allocated node with no stats field (defensive ?? [])', () => {
    // a node object that omits `stats` entirely — collectStats must not crash on `undefined.filter`
    expect(collectStats(choiceView(['n']), { n: {} })).toEqual([])
  })

  it('uses the chosen option name alone for a prompt-only chooser that has no node name', () => {
    const nodes: StatsNodes = {
      // no `name`, base is a bare "Select …" prompt (dropped), option carries no stats of its own
      x: {
        stats: ['Select a bonus'],
        choices: [
          { name: 'A', stats: [] },
          { name: 'B', stats: [] },
        ],
      },
    }
    expect(collectStats(choiceView(['x'], { x: 1 }), nodes)).toEqual(['B']) // not "undefined: B"
  })
})

describe('collectAllocatedStats (live atlas view)', () => {
  it('gathers allocated node stats and a mastery’s CHOSEN option (not the prompt)', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = mountAtlasTree(container, { editable: true })
    const choiceId = Object.keys(atlasGraph.nodes).find(
      (k) => ((atlasGraph.nodes as Record<string, { choices?: unknown[] }>)[k]!.choices?.length ?? 0) > 0,
    )!
    const optStat = (atlasGraph.nodes as unknown as Record<string, { choices: Array<{ stats: string[] }> }>)[choiceId]!
      .choices[0]!.stats[0]!
    view.setBuild({ allocated: [...atlasRootIds(), choiceId], masteryChoices: new Map([[choiceId, 0]]) })
    const stats = collectAllocatedStats(view)
    expect(stats).toContain(optStat) // the chosen bonus's stat is present
    expect(stats.some((s) => /^select /i.test(s))).toBe(false) // never the bare prompt
    view.destroy()
    container.remove()
  })
})

describe('mountStatsPanel open/close a11y state', () => {
  it('toggling flips inert + aria-hidden on the panel and aria-expanded on the toggle', () => {
    const { panel, toggle } = mountPanelFixture()
    toggle.click() // open
    expect(panel.hasAttribute('inert')).toBe(false)
    expect(panel.getAttribute('aria-hidden')).toBe('false')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    toggle.click() // close — its content must leave the tab order + a11y tree
    expect(panel.hasAttribute('inert')).toBe(true)
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('Escape on the open panel dismisses it', () => {
    const { panel, toggle } = mountPanelFixture()
    toggle.click() // open
    expect(panel.classList.contains('is-open')).toBe(true)
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(panel.classList.contains('is-open')).toBe(false)
    expect(panel.hasAttribute('inert')).toBe(true)
  })
})

describe('mountStatsPanel folds an extra allocated source (atlas masters)', () => {
  const text = (p: HTMLElement) => (p.querySelector('.as-body') as HTMLElement).textContent ?? ''

  it('sums extra stats with node stats, then re-renders on extra change and on refresh()', () => {
    document.body.innerHTML = '<button id="t"></button><aside id="p"></aside>'
    const panel = document.getElementById('p') as HTMLElement
    const toggle = document.getElementById('t') as HTMLElement
    const nodes = { A: { stats: ['10% increased Rarity'] } }
    const { view } = stubView(['A'])

    let extra: string[] = ['20% increased Quantity']
    const extraSubs: Array<() => void> = []
    const source: ExtraStatsSource = { collect: () => extra, subscribe: (fn) => extraSubs.push(fn) }

    const handle = mountStatsPanel(panel, toggle, view, nodes, { title: 'T', empty: 'E' }, source)
    // both the tree node and the extra (master) stat show up
    expect(text(panel)).toContain('10% increased Rarity')
    expect(text(panel)).toContain('20% increased Quantity')

    // the extra source changes (a master keystone toggled) → its subscription re-renders + sums
    extra = ['20% increased Quantity', '5% increased Quantity']
    extraSubs.forEach((fn) => fn())
    expect(text(panel)).toContain('25% increased Quantity')

    // refresh() (used after a share-link applies master picks programmatically) re-reads the source
    extra = []
    handle.refresh()
    expect(text(panel)).toContain('10% increased Rarity')
    expect(text(panel)).not.toContain('Quantity')
  })
})
