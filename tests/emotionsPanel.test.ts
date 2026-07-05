// DOM wiring for the Distilled-Emotion planner (src/emotions/index.ts): mount the panel into a
// jsdom container and drive every interactive path — the three sub-tabs, the Amulet
// inventory→craftable list (steppers / bulk / reset / show-all / hidden-only / search), the Jewel
// normal↔Time-Lost table swap, the Waystone Deliriousness combiner (cap + bonus summary), and the
// shared [data-emotion] tooltip. The pure lookups underneath are covered separately by
// tests/emotions.test.ts — this file asserts the rendered DOM + real user events.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { mountEmotions } from '../src/emotions/index'
import { emotions, JEWEL_COLOURS } from '../src/emotions/data'
import { copy } from '../src/copy'

// The amulet list re-renders on a requestAnimationFrame; jsdom-visual provides rAF, but keep a
// synchronous-ish fallback so the interaction tests never hinge on the environment shipping it.
beforeAll(() => {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = ((id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>)) as typeof cancelAnimationFrame
  }
})

const mounted: HTMLElement[] = []
function mount(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  mountEmotions(el)
  mounted.push(el)
  return el
}
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove()
})

const $ = <T extends HTMLElement = HTMLElement>(c: HTMLElement, sel: string): T => {
  const el = c.querySelector<T>(sel)
  if (!el) throw new Error(`missing element: ${sel}`)
  return el
}
const all = (c: HTMLElement, sel: string): HTMLElement[] => Array.from(c.querySelectorAll<HTMLElement>(sel))

function fire(el: HTMLElement, type: string): void {
  el.dispatchEvent(new Event(type, { bubbles: true }))
}
function setValue(input: HTMLInputElement, val: string): void {
  input.value = val
  fire(input, 'input')
}
function setChecked(input: HTMLInputElement, on: boolean): void {
  input.checked = on
  fire(input, 'change')
}

/** Mount, seed 7 Ire (→ the "Insulated Treads" anoint, floor(7/3)=2×), and wait for the craft list
 *  to populate; returns the container. */
async function mountWithIre7(): Promise<HTMLElement> {
  const c = mount()
  setValue($<HTMLInputElement>(c, '.em-step-n[data-key="Ire"]'), '7')
  const list = $(c, '.em-craft-list')
  await vi.waitFor(() => expect(list.querySelectorAll('.em-craft').length).toBeGreaterThan(0))
  return c
}

// ── shell + sub-tabs ──────────────────────────────────────────────────────────────────────────
describe('mountEmotions — shell + sub-navigation', () => {
  it('renders the wrap, three sub-tabs (Amulet active) and three views (only Amulet visible)', () => {
    const c = mount()
    expect(c.querySelectorAll('.em-wrap')).toHaveLength(1)

    const tabs = all(c, '.em-subtab')
    expect(tabs.map((t) => t.dataset.view)).toEqual(['amulet', 'jewel', 'waystone'])
    expect(tabs[0]!.classList.contains('on')).toBe(true)
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('false')
    // the sub-tab labels come from copy.ts (not hard-coded here)
    expect(tabs[0]!.textContent).toContain(copy.emotions.tabAmulet)
    expect(tabs[2]!.textContent).toContain(copy.emotions.tabWaystoneSub)

    const views = all(c, '.em-view')
    expect(views.map((v) => v.dataset.view)).toEqual(['amulet', 'jewel', 'waystone'])
    expect(views[0]!.hidden).toBe(false)
    expect(views[1]!.hidden).toBe(true)
    expect(views[2]!.hidden).toBe(true)

    // provenance note renders (escaped) at the foot
    expect($(c, '.em-prov').textContent?.length ?? 0).toBeGreaterThan(0)
  })

  it('is idempotent per element — a second mount does not re-render a second shell', () => {
    const c = mount()
    expect(c.dataset.emMounted).toBe('1')
    const wrap = c.querySelector('.em-wrap') // capture the live shell node before re-mounting
    mountEmotions(c) // second call must bail on the mounted flag, not rebuild
    expect(c.querySelectorAll('.em-wrap')).toHaveLength(1)
    expect(c.querySelectorAll('.em-subtab')).toHaveLength(3)
    // the SAME node survives — dropping the guard (container.innerHTML = shell()) would swap in a
    // fresh element, so node identity is what actually proves the second mount was a no-op.
    expect(c.querySelector('.em-wrap')).toBe(wrap)
  })

  it('clicking a sub-tab swaps the visible view and moves aria-selected', () => {
    const c = mount()
    const [amulet, jewel, waystone] = all(c, '.em-subtab') as HTMLButtonElement[]
    const view = (v: string) => $(c, `.em-view[data-view="${v}"]`)

    jewel!.click()
    expect(view('amulet').hidden).toBe(true)
    expect(view('jewel').hidden).toBe(false)
    expect(view('waystone').hidden).toBe(true)
    expect(jewel!.classList.contains('on')).toBe(true)
    expect(jewel!.getAttribute('aria-selected')).toBe('true')
    expect(amulet!.getAttribute('aria-selected')).toBe('false')

    waystone!.click()
    expect(view('jewel').hidden).toBe(true)
    expect(view('waystone').hidden).toBe(false)
    expect(waystone!.classList.contains('on')).toBe(true)
  })
})

// ── amulet (inventory → craftable) ──────────────────────────────────────────────────────────────
describe('mountEmotions — Amulet inventory → craftable', () => {
  it('opens with four rarity columns, one card per emotion and the default summary', () => {
    const c = mount()
    const cols = all(c, '.em-inv-col')
    expect(cols.map((col) => $(col, '.em-inv-col-h').textContent)).toEqual([
      'Diluted',
      'Liquid',
      'Concentrated',
      'Potent',
    ])
    expect(all(c, '.em-inv')).toHaveLength(emotions.length) // 13 inventory cards
    expect(all(c, '.em-step-n')).toHaveLength(emotions.length)
    expect($(c, '.em-craft-summary').textContent).toContain('Set your emotions')
    expect(all(c, '.em-craft-list .em-craft')).toHaveLength(0) // nothing craftable yet
  })

  it('typing an owned count lists the anoints it unlocks, each with an ×N craftable badge', async () => {
    // 7 Ire → Ire+Ire+Ire = "Insulated Treads", floor(7/3) = 2× (verified in tests/emotions.test.ts)
    const c = await mountWithIre7()

    const treads = all(c, '.em-craft').find((li) => li.dataset.name === 'insulated treads')
    expect(treads).toBeTruthy()
    expect($(treads!, '.em-craft-name').textContent).toContain('Insulated Treads')
    expect($(treads!, '.em-craft-times').textContent).toBe('×2')
    // the ordered 3-emotion recipe is drawn as icon chips joined by arrows
    expect(treads!.querySelectorAll('.em-recipe .em-recipe-ico').length).toBe(3)
    expect(treads!.querySelector('.em-recipe .em-arrow')).not.toBeNull()
    // and the count summary reflects the single craftable Notable
    expect($(c, '.em-craft-summary').textContent).toContain('anoint 1 Notable')
  })

  it('the ± stepper buttons mutate the count and re-derive the list', async () => {
    const c = mount()
    const input = $<HTMLInputElement>(c, '.em-step-n[data-key="Ire"]')
    const plus5 = $<HTMLButtonElement>(c, '.em-step-btn[data-key="Ire"][data-step="5"]')
    const plus1 = $<HTMLButtonElement>(c, '.em-step-btn[data-key="Ire"][data-step="1"]')

    plus5!.click()
    plus5!.click() // +10
    plus1!.click() // 11
    expect(input.value).toBe('11')
    await vi.waitFor(() => expect(all(c, '.em-craft').some((li) => li.dataset.name === 'insulated treads')).toBe(true))

    // stepping below zero clamps at 0 (clampInt floor)
    $<HTMLButtonElement>(c, '.em-step-btn[data-key="Ire"][data-step="-10"]')!.click()
    $<HTMLButtonElement>(c, '.em-step-btn[data-key="Ire"][data-step="-10"]')!.click()
    expect(input.value).toBe('0')
    await vi.waitFor(() => expect(all(c, '.em-craft')).toHaveLength(0))
  })

  it('the "Adjust all" bulk buttons and Reset sweep every emotion at once', async () => {
    const c = mount()
    $<HTMLButtonElement>(c, '.em-bulk[data-bulk="10"]')!.click() // +10 to all 13
    const inputs = all(c, '.em-step-n') as HTMLInputElement[]
    expect(inputs.every((i) => i.value === '10')).toBe(true)
    await vi.waitFor(() => expect(all(c, '.em-craft').length).toBeGreaterThan(0))
    expect($(c, '.em-craft-summary').textContent).toContain('anoint')

    $<HTMLButtonElement>(c, '.em-reset')!.click()
    expect(inputs.every((i) => i.value === '0')).toBe(true)
    await vi.waitFor(() => expect(all(c, '.em-craft')).toHaveLength(0))
    expect($(c, '.em-craft-summary').textContent).toContain('Set your emotions')
  })

  it('"Show all recipes" lists every recipe (capped, no ×N badge) via the summaryAll copy', async () => {
    const c = mount()
    setChecked($<HTMLInputElement>(c, '.em-show-all'), true)
    const list = $(c, '.em-craft-list')
    await vi.waitFor(() => expect(list.querySelectorAll('.em-craft').length).toBeGreaterThan(0))

    // the show-all dataset is far larger than the live cap → the list is clamped to MAX_CRAFT_ROWS (250)
    expect(list.querySelectorAll('.em-craft').length).toBe(250)
    // show-all mode drops the per-row craftable-times badge
    expect(list.querySelector('.em-craft-times')).toBeNull()
    expect($(c, '.em-craft-summary').textContent).toMatch(/^All \d+ anoint recipes$/)
  })

  it('"Hidden anoints only" narrows the dataset to off-tree anoint-only Notables', async () => {
    const c = mount()
    setChecked($<HTMLInputElement>(c, '.em-show-all'), true)
    setChecked($<HTMLInputElement>(c, '.em-hidden-only'), true)
    const list = $(c, '.em-craft-list')
    await vi.waitFor(() => expect(list.querySelectorAll('.em-craft').length).toBeGreaterThan(0))

    const rows = all(c, '.em-craft')
    expect(rows.every((li) => li.dataset.hidden === '1')).toBe(true)
    // every hidden row carries the "off-tree" badge from copy.ts
    expect($(rows[0]!, '.em-hidden-badge').textContent).toBe(copy.emotions.hiddenBadge)
  })

  it('the search box filters rows by Notable name and shows the empty-state when nothing matches', async () => {
    const c = await mountWithIre7()

    const search = $<HTMLInputElement>(c, '.em-search')
    const empty = $(c, '.em-empty')
    const treads = () => all(c, '.em-craft').find((li) => li.dataset.name === 'insulated treads')!

    setValue(search, 'insulated') // matches — search is synchronous (applySearch)
    expect(treads().hidden).toBe(false)
    expect(empty.hidden).toBe(true)

    setValue(search, 'zzz-nothing-matches')
    expect(treads().hidden).toBe(true)
    expect(empty.hidden).toBe(false)
    expect(empty.textContent).toBe(copy.emotions.noNotableMatch)

    setValue(search, '') // clearing restores the row
    expect(treads().hidden).toBe(false)
    expect(empty.hidden).toBe(true)
  })
})

// ── jewel (craft) ─────────────────────────────────────────────────────────────────────────────
describe('mountEmotions — Jewel outcome table', () => {
  it('renders a row per emotion with the four jewel-colour columns', () => {
    const c = mount()
    const jewel = $(c, '.em-view[data-view="jewel"]')
    expect(jewel.querySelectorAll('.em-jcol')).toHaveLength(JEWEL_COLOURS.length) // Ruby/Sapphire/Emerald/Diamond
    // every emotion resolves both a normal + Time-Lost jewel outcome → 13 body rows
    expect(jewel.querySelectorAll('tbody .em-jrow-hd')).toHaveLength(emotions.length)
    // the normal segment is the active tab on open
    const [normal, timelost] = all(c, '.em-seg-btn') as HTMLButtonElement[]
    expect(normal!.classList.contains('on')).toBe(true)
    expect(timelost!.getAttribute('aria-selected')).toBe('false')
  })

  it('switching to the Time-Lost segment re-renders the table and slides the segment thumb', () => {
    const c = mount()
    const host = $(c, '[data-jewel-host]')
    const before = host.innerHTML
    const [normal, timelost] = all(c, '.em-seg-btn') as HTMLButtonElement[]

    timelost!.click()
    expect(timelost!.classList.contains('on')).toBe(true)
    expect(timelost!.getAttribute('aria-selected')).toBe('true')
    expect(normal!.getAttribute('aria-selected')).toBe('false')
    expect($(c, '.em-seg .ix-seg-thumb').style.getPropertyValue('--i')).toBe('1')
    // the table content actually changed (Time-Lost takes the smaller "Ancient" rolls) but still has 13 rows
    expect(host.innerHTML).not.toBe(before)
    expect(host.querySelectorAll('tbody .em-jrow-hd')).toHaveLength(emotions.length)

    normal!.click() // and back
    expect(normal!.classList.contains('on')).toBe(true)
    expect($(c, '.em-seg .ix-seg-thumb').style.getPropertyValue('--i')).toBe('0')
  })
})

// ── waystone (instil) ─────────────────────────────────────────────────────────────────────────
describe('mountEmotions — Waystone Deliriousness combiner', () => {
  it('lists every emotion sorted by Deliriousness% ascending and opens at 0% total', () => {
    const c = mount()
    const rows = all(c, '.em-way')
    expect(rows).toHaveLength(emotions.length)
    // sorted ascending by deliriousPct → Ire (7%) leads
    expect($(rows[0]!, '.em-way-name').textContent?.trim()).toBe('Ire')
    expect($(c, '.em-way-total').textContent).toBe('0% Delirious')
    expect($(c, '.em-way-sum-bonus').classList.contains('em-muted')).toBe(true)
  })

  it('entering a count sums the Deliriousness% live and lights the bonus summary', () => {
    const c = mount()
    const ire = $<HTMLInputElement>(c, '.em-way-n[data-key="Ire"]')
    expect(ire.dataset.pct).toBe('7') // Ire = 7% each

    setValue(ire, '3') // 3 × 7% = 21%
    expect($(c, '.em-way-total').textContent).toBe('21% Delirious')
    // any selection un-mutes the bonus summary line
    const sumBonus = $(c, '.em-way-sum-bonus')
    expect(sumBonus.classList.contains('em-muted')).toBe(false)
  })

  it('caps at 100% and disables the + steppers once the map is fully Delirious', () => {
    const c = mount()
    // Isolation = 50% each (tests/emotions.test.ts), so 2 applications hit the 100% ceiling
    setValue($<HTMLInputElement>(c, '.em-way-n[data-key="Isolation"]'), '2')

    expect($(c, '.em-way-total').textContent).toContain('100% Delirious')
    expect($(c, '.em-way-total').textContent).toContain(copy.emotions.waystoneMax.trim())
    const plusBtns = all(c, '.em-way-step[data-step="1"]') as HTMLButtonElement[]
    expect(plusBtns.every((b) => b.disabled)).toBe(true)
  })

  it('the ± steppers on a row adjust its count and recombine the total', () => {
    const c = mount()
    const isoInput = $<HTMLInputElement>(c, '.em-way-n[data-key="Isolation"]')
    const plus = $<HTMLButtonElement>(c, '.em-way-step[data-key="Isolation"][data-step="1"]')
    const minus = $<HTMLButtonElement>(c, '.em-way-step[data-key="Isolation"][data-step="-1"]')

    plus!.click()
    expect(isoInput.value).toBe('1')
    expect($(c, '.em-way-total').textContent).toBe('50% Delirious')

    minus!.click()
    expect(isoInput.value).toBe('0')
    expect($(c, '.em-way-total').textContent).toBe('0% Delirious')
    // back to empty → the bonus summary is muted again
    expect($(c, '.em-way-sum-bonus').classList.contains('em-muted')).toBe(true)
  })

  it('a single application of a bonus emotion prints the bonus without a ×N multiplier', () => {
    const c = mount()
    const ire = emotions.find((e) => e.key === 'Ire')!
    expect(ire.waystone.bonus).toBeTruthy() // Ire carries a per-application waystone modifier

    setValue($<HTMLInputElement>(c, '.em-way-n[data-key="Ire"]'), '1') // exactly one → the n > 1 false arm
    const sumBonus = $(c, '.em-way-sum-bonus')
    expect(sumBonus.classList.contains('em-muted')).toBe(false)
    expect(sumBonus.textContent).toContain(ire.waystone.bonus!)
    // a count of 1 renders the bonus bare; the "×N" tail only appears for n > 1
    expect(sumBonus.textContent!.endsWith(ire.waystone.bonus!)).toBe(true)
  })
})

// ── shared [data-emotion] tooltip ───────────────────────────────────────────────────────────────
describe('mountEmotions — hover/focus tooltip', () => {
  it('shows the itc-card tooltip on pointerover of an emotion and hides it on pointerout', () => {
    const c = mount()
    const tip = $(c, '.em-tip')
    expect(tip.hidden).toBe(true)

    const target = $(c, '[data-emotion]')
    const key = target.dataset.emotion!
    fire(target, 'pointerover')
    expect(tip.hidden).toBe(false)
    expect(tip.querySelector('.itc-card')).not.toBeNull()
    // the tooltip is built for the hovered emotion (its full base-item name ends with the key)
    const name = $(tip, '.itc-name').textContent ?? ''
    expect(name.endsWith(key)).toBe(true)
    expect(tip.textContent).toContain('Distilled Emotion') // copy.emotions.tipSub

    fire(target, 'pointerout')
    expect(tip.hidden).toBe(true)
  })

  it('also opens on focusin and closes on focusout (keyboard parity)', () => {
    const c = mount()
    const tip = $(c, '.em-tip')
    const target = $(c, '[data-emotion]')

    fire(target, 'focusin')
    expect(tip.hidden).toBe(false)
    expect(tip.querySelector('.itc-card')).not.toBeNull()

    fire(target, 'focusout')
    expect(tip.hidden).toBe(true)
  })

  it('a Potent, bonus-less emotion tooltip shows the Potent tag, an unnamed jewel slot and no waystone bonus', () => {
    const c = mount()
    const tip = $(c, '.em-tip')
    const target = $(c, '[data-emotion="Contempt"]') // Potent, waystone.bonus === null, unnamed jewel slots
    fire(target, 'pointerover')

    // Potent flag → the " · Potent" subline tag (empty string for non-Potent emotions)
    expect($(tip, '.itc-subline').textContent).toContain(copy.emotions.tipPotent)
    // no waystone bonus → the waystone line is just the Deliriousness%, with no " · <bonus>" tail
    expect($(tip, '.em-tip-way').textContent).toBe('Players in Area are 50% Delirious')
    // an unnamed jewel slot omits the name, leaving a single space after the affix label
    const ruby = all(tip, '.em-tip-list li').find((li) => li.textContent?.startsWith('Ruby'))
    expect(ruby).toBeTruthy()
    expect(ruby!.textContent).toContain('prefix 0 Prefix Modifier allowed, +1 Suffix Modifier allowed')
    expect(ruby!.textContent).not.toContain('prefix  0') // a named slot would inject a double space here
  })

  it('re-hovering the same emotion key keeps the already-built tooltip instead of rebuilding it', () => {
    const c = mount()
    const tip = $(c, '.em-tip')
    const [first, second] = all(c, '[data-emotion="Ire"]') // Ire tags multiple elements (row + its icon)
    expect(second).toBeTruthy()

    fire(first!, 'pointerover')
    expect(tip.querySelector('.itc-card')).not.toBeNull() // built once for Ire

    tip.innerHTML = '<i data-sentinel="1"></i>' // if show() rebuilds for the same key, this gets wiped
    fire(second!, 'pointerover')
    expect(tip.querySelector('[data-sentinel]')).not.toBeNull() // current === key → no rebuild
    expect(tip.hidden).toBe(false) // still shown
  })

  it('pointer/focus events off any emotion neither open nor close the tooltip', () => {
    const c = mount()
    const tip = $(c, '.em-tip')
    const lead = $(c, '.em-lead') // a paragraph with no [data-emotion] ancestor
    expect(lead.closest('[data-emotion]')).toBeNull()

    fire(lead, 'pointerover') // armed() → null, so show() must not run
    expect(tip.hidden).toBe(true)
    fire(lead, 'focusin')
    expect(tip.hidden).toBe(true)

    // open a real tooltip, then a pointerout off any emotion must NOT hide it (armed() → null → hide() skipped)
    fire($(c, '[data-emotion="Ire"]'), 'pointerover')
    expect(tip.hidden).toBe(false)
    fire(lead, 'pointerout')
    expect(tip.hidden).toBe(false)
  })
})
