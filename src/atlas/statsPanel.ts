// Allocated-stats panel — a right-side summary (mirrors the masters drawer on the left) that lists
// the COMBINED stats of every allocated tree node. Stats that repeat are summed: each line is grouped
// by its text with the first number blanked out, and the numbers are added. Flag stats (no number) are
// grouped exactly and counted. "Select …" choice prompts are dropped (not a stat); a "Select a bonus"
// mastery instead contributes its CHOSEN option's stats (via getMasteryChoices).
//
// Graph-agnostic by design: the node-stat lookup map is PASSED IN, so the atlas tree and the Genesis
// tree each summarise their OWN nodes. `mountAtlasStats` is the atlas-bound wrapper (keeps the atlas
// call sites + tests); the Genesis tab calls the generic `mountStatsPanel` with the Genesis nodes.

import { atlasGraph } from './index'
import { escapeHtml } from '../ui/escapeHtml'
import { setFlyoutOpen } from '../ui/flyout'
import type { TreeView } from '../tree/index'
import { copy } from '../copy'

export interface StatsNode {
  name?: string
  stats?: string[]
  atlasRoot?: boolean
  choices?: Array<{ name: string; stats: string[] }>
}
export type StatsNodes = Record<string, StatsNode>
const ATLAS_NODES = (atlasGraph as unknown as { nodes: StatsNodes }).nodes

const numFmt = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100))
const NUM_RE = /-?\d+(?:\.\d+)?/ // first signed integer/decimal in a line

/** A choice node's base line is sometimes just a "Select a bonus …" PROMPT (the real stat lives in the
 *  chosen option) rather than an effective stat — so it's dropped wherever stats are collected/aggregated.
 *  Single source of truth: a chooser node that ALSO carries a real base effect ("Add an Explosive …",
 *  "Alter the difficulty of Rituals") does NOT start with "Select", so that effect is kept. */
const isChoicePrompt = (line: string): boolean => /^select /i.test(line.trim())

/** One aggregated line: the rendered text + how many source stats folded into it. */
export interface AggStat {
  text: string
  count: number
}

/**
 * Fold a flat list of stat lines into additive groups. A line with a number is grouped by that
 * line with its FIRST number replaced by a sentinel; the numbers across the group are summed (so
 * three "10% increased X" → "30% increased X"). A line with no number is grouped verbatim and
 * counted. "Select …" prompts are skipped. Output keeps first-seen order.
 */
export function aggregateStats(lines: readonly string[]): AggStat[] {
  const groups = new Map<string, { template: string; sum: number; numeric: boolean; count: number }>()
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim() // collapse the game data's mid-stat newlines
    if (!line || isChoicePrompt(line)) continue
    const m = NUM_RE.exec(line)
    if (m) {
      const template = `${line.slice(0, m.index)}\x00${line.slice(m.index + m[0].length)}`
      const g = groups.get(template) ?? { template, sum: 0, numeric: true, count: 0 }
      g.sum += parseFloat(m[0])
      g.count++
      groups.set(template, g)
    } else {
      const g = groups.get(line) ?? { template: line, sum: 0, numeric: false, count: 0 }
      g.count++
      groups.set(line, g)
    }
  }
  return [...groups.values()].map((g) => ({
    text: g.numeric ? g.template.replace('\x00', numFmt(g.sum)) : g.template,
    count: g.count,
  }))
}

/** Collect every effective stat line from the allocated set, looking each allocated id up in the GIVEN
 *  node map — so the atlas and Genesis trees summarise their own. For a "Select a bonus" choice node the
 *  EFFECTIVE bonus is the chosen option, not the node's umbrella description (the blue tooltip line is
 *  a category descriptor — "Summoning Circles summon packs or a more powerful Boss" — that the option
 *  fully restates: "Summoning Circle Bosses are Powerful"). So:
 *   • chosen option WITH stat text → ONLY the option's stats (the base descriptor is dropped).
 *   • chosen option with NO stats (a bare qualifier like Remnants/Explosives, Double/Nothing) → its NAME
 *     is the only signal, folded into the single base effect: "Add an Explosive … to Expeditions (Remnants)"
 *     (or "Node: Option" when there's no base line, i.e. a pure prompt node).
 *   • no option chosen yet → the base effect (minus the bare "Select …" prompt) so the node still shows.
 *  Showing both base + option (an earlier attempt) double-printed the descriptor; dropping the base
 *  entirely (the original behaviour) hid choosers whose option carries no stats. */
export function collectStats(view: TreeView, nodes: StatsNodes): string[] {
  const allocated = view.getAllocated()
  const choices = view.getMasteryChoices()
  const out: string[] = []
  for (const id of allocated) {
    const node = nodes[id]
    if (!node || node.atlasRoot) continue // starts carry no stats
    const base = (node.stats ?? []).filter((s) => !isChoicePrompt(s)) // node's own effect, minus the prompt
    const pick = choices.get(id) // chosen option index, or undefined when no choice is selected yet
    const opt = pick !== undefined ? node.choices?.[pick] : undefined
    if (opt?.stats.length) {
      out.push(...opt.stats) // the selected option IS the effect; its text restates the base descriptor
    } else if (opt?.name && base.length === 1) {
      out.push(`${base[0]} (${opt.name})`) // bare qualifier → fold the choice into the single base effect
    } else {
      out.push(...base)
      if (opt?.name) out.push(node.name ? `${node.name}: ${opt.name}` : opt.name) // prompt-only chooser
    }
  }
  return out
}

/** Atlas-bound convenience (back-compat for the atlas call site + tests). */
export function collectAllocatedStats(view: TreeView): string[] {
  return collectStats(view, ATLAS_NODES)
}

export interface StatsPanelLabels {
  /** Panel heading, e.g. "Allocated Atlas Bonuses". */
  title: string
  /** Empty-state prompt shown when nothing is allocated. */
  empty: string
}

/** An extra source of allocated stat lines folded into the panel beside the tree nodes (e.g. the
 *  atlas-master keystones, which aren't tree nodes). `subscribe` fires when that source changes. */
export interface ExtraStatsSource {
  collect(): readonly string[]
  subscribe(onChange: () => void): void
}

/** Handle returned by the panel so callers can force a re-render after a programmatic state change
 *  (e.g. applying a shared '#atlas=' link's master picks, which bypass the user-change subscription). */
export interface StatsPanelHandle {
  refresh(): void
}

/**
 * Mount a live allocated-stats panel into `panel`, wired to the `toggle` button (a right-side flyout
 * that mirrors the masters drawer — closed by default). `nodes` is the graph's node-stat map (atlas or
 * Genesis), `labels` the panel's wording. Subscribes to the tree view and re-renders on every change.
 */
export function mountStatsPanel(
  panel: HTMLElement,
  toggle: HTMLElement,
  view: TreeView,
  nodes: StatsNodes,
  labels: StatsPanelLabels,
  extra?: ExtraStatsSource,
): StatsPanelHandle {
  panel.classList.add('as-panel')
  panel.innerHTML =
    `<div class="as-head"><span class="as-title">${escapeHtml(labels.title)}</span><span class="as-count"></span>` +
    `<button type="button" class="ix-btn ix-btn--ghost ix-btn--xs as-close" aria-label="Hide allocated bonuses">✕</button></div>` +
    `<div class="as-body" aria-live="polite"></div>`
  const body = panel.querySelector('.as-body') as HTMLElement
  const countEl = panel.querySelector('.as-count') as HTMLElement

  function render(): void {
    // tree nodes + any extra allocated source (e.g. atlas masters), summed together
    const lines = [...collectStats(view, nodes), ...(extra?.collect() ?? [])]
    const agg = aggregateStats(lines)
    countEl.textContent = agg.length ? String(agg.length) : ''
    body.innerHTML = agg.length
      ? agg
          .map(
            (a) =>
              `<div class="as-stat">${escapeHtml(a.text)}${a.count > 1 ? `<span class="as-x">×${a.count}</span>` : ''}</div>`,
          )
          .join('')
      : `<p class="as-empty">${escapeHtml(labels.empty)}</p>`
  }

  // ── flyout open/close — the shared non-modal flyout contract (ui/flyout.ts) ────────────────
  const setOpen = (open: boolean, restoreFocus = false): void => setFlyoutOpen(panel, toggle, open, restoreFocus)
  toggle.addEventListener('click', () => setOpen(!panel.classList.contains('is-open')))
  panel.querySelector('.as-close')!.addEventListener('click', () => setOpen(false, true))
  // non-modal flyout: Escape dismisses + restores focus; the stats panel stays a live AT text-alternative
  // (aria-live) beside the canvas, so it is NOT a modal and does not trap focus.
  panel.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && panel.classList.contains('is-open')) setOpen(false, true)
  })
  setOpen(false)

  view.subscribe(render)
  extra?.subscribe(render)
  render()
  return { refresh: render }
}

/** Atlas-bound convenience wrapper (atlas nodes + atlas wording). `masters` folds the allocated
 *  atlas-master keystone bonuses into the same summary (they aren't tree nodes). */
export function mountAtlasStats(
  panel: HTMLElement,
  toggle: HTMLElement,
  view: TreeView,
  masters?: ExtraStatsSource,
): StatsPanelHandle {
  return mountStatsPanel(
    panel,
    toggle,
    view,
    ATLAS_NODES,
    {
      title: copy.atlas.statsTitle,
      empty: copy.atlas.statsEmpty,
    },
    masters,
  )
}
