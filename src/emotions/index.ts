// Distilled / Liquid Emotion planner — the Delirium "what does this emotion do" reference.
// One tab, three sub-views matching the three ways the game lets you spend an emotion:
//   • Amulet   — inventory grid: enter how many of each emotion you own -> every Notable you can
//                anoint right now and how many times (anointing is an ORDERED 3-emotion recipe)
//   • Jewel    — emotion x jewel-colour outcome table (normal + Time-Lost)
//   • Waystone — per-emotion Deliriousness% + map reward, with a combiner
// Every emotion shows its item icon; hovering one reveals its mods. Pills take the icon's hue.
// Pure string render + event-delegated interactivity; data/lookups live in ./data (unit-tested).

import './emotions.css'
import { escapeHtml } from '../ui/escapeHtml'
import { copy } from '../copy'
import {
  emotions,
  notables,
  constants,
  provenance,
  emotionByKey,
  recipesForNotable,
  craftable,
  isHiddenAnoint,
  JEWEL_COLOURS,
  type Emotion,
  type Rarity,
  type JewelColour,
  type JewelOutcomes,
} from './data'

type View = 'amulet' | 'jewel' | 'waystone'

// ── small render helpers ──────────────────────────────────────────────────────────────────────
/** The emotion's item icon (or a tinted dot fallback). `data-emotion` arms the hover tooltip. */
function icon(e: Emotion, px: number, cls = ''): string {
  const tag = `data-emotion="${escapeHtml(e.key)}"`
  if (e.icon) {
    return `<img class="em-ico ${cls}" ${tag} src="${escapeHtml(e.icon)}" alt="${escapeHtml(e.key)}" width="${px}" height="${px}" loading="lazy">`
  }
  return `<span class="em-ico em-ico-dot ${cls}" ${tag} style="--em-rgb: ${e.rgb}; width:${px}px; height:${px}px"></span>`
}
function statList(lines: string[]): string {
  if (!lines.length) return ''
  return `<ul class="em-stats">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
}
const recipeChips = (c: readonly string[]): string =>
  c
    .map((k) => {
      const e = emotionByKey(k)
      return e ? icon(e, 22, 'em-recipe-ico') : escapeHtml(k)
    })
    .join('<span class="em-arrow" aria-hidden="true">→</span>')

// ── hover tooltip — reuses the app's #311 item card (.itc-card) so the emotion tooltip shares the
// one tooltip vocabulary; the per-emotion hue drives itc-card's tier tint via --itc-tier-rgb. Only
// the emotion-specific stat layout (gem-colour lines, waystone line) carries its own minimal classes.
function jewelSection(out: JewelOutcomes | null, label: string): string {
  if (!out) return ''
  const parts: string[] = []
  for (const { key, label: cl } of JEWEL_COLOURS) {
    const c = out[key]
    if (!c) continue
    const slot = (s: JewelColour['p'], k: string) =>
      s ? `${k} ${s.name ? escapeHtml(s.name) + ' ' : ''}${escapeHtml(s.text)}` : ''
    const bits = [slot(c.p, copy.emotions.tipPrefix), slot(c.s, copy.emotions.tipSuffix)].filter(Boolean).join(', ')
    if (bits) parts.push(`<li><b class="em-tip-col em-tip-col-${key}">${cl}</b> ${bits}</li>`)
  }
  if (!parts.length) return ''
  return `<div class="itc-sec-h">${label}</div><ul class="em-tip-list">${parts.join('')}</ul>`
}
function emotionTooltip(e: Emotion): string {
  const w = e.waystone
  const way =
    w.deliriousPct != null
      ? `<div class="itc-sec-h">${copy.emotions.tipWaystoneHd}</div>` +
        `<div class="em-tip-way">${copy.emotions.tipWaystone(w.deliriousPct, w.bonus ? ' · ' + escapeHtml(w.bonus) : '')}</div>`
      : ''
  // body sections in the original order (jewel → time-lost jewel → waystone), separated by itc-card's
  // own boss-glint separator so the look stays consistent with the gear tooltips.
  const sections = [
    jewelSection(e.jewel, copy.emotions.tipJewel),
    jewelSection(e.jewelTimeLost, copy.emotions.tipJewelTimeLost),
    way,
  ].filter(Boolean)
  const body = sections.join('<hr class="itc-sep" aria-hidden="true" />')
  // The instructional foot is a full sentence — keep it a plain, readable muted line (NOT itc-card's
  // uppercase-centered .itc-stamp, which would mangle the prose).
  return (
    `<div class="itc-card itc-card--featured" style="--itc-tier: rgb(${e.rgb}); --itc-tier-rgb: ${e.rgb};">` +
    `<div class="itc-header">${icon(e, 28)}<span class="itc-name">${escapeHtml(e.name)}</span>` +
    `<span class="itc-subline">${copy.emotions.tipSub(escapeHtml(e.rarity), e.potent ? copy.emotions.tipPotent : '')}</span></div>` +
    `<div class="itc-body">${body}` +
    `<hr class="itc-sep" aria-hidden="true" />` +
    `<p class="em-tip-foot">${copy.emotions.tipFoot}</p>` +
    `</div>` +
    `</div>`
  )
}

// ── AMULET (inventory -> craftable) ─────────────────────────────────────────────────────────────
const TIER_ORDER: Rarity[] = ['Diluted', 'Liquid', 'Concentrated', 'Potent']

/** A stepper button that adds `delta` to one emotion (±1 / ±5 / ±10). */
function stepBtn(key: string, delta: number, label: string): string {
  const mag = Math.abs(delta)
  const cls = mag >= 10 ? ' em-step-lg' : mag >= 5 ? ' em-step-md' : ''
  const txt = `${delta > 0 ? '+' : '−'}${mag}`
  return (
    `<button type="button" class="icb icb--xs em-step-btn${cls}" data-step="${delta}" data-key="${escapeHtml(key)}" ` +
    `title="${txt} ${escapeHtml(key)}" aria-label="${txt} ${escapeHtml(key)}">${label}</button>`
  )
}
function inventoryCard(e: Emotion): string {
  const k = escapeHtml(e.key)
  return (
    `<div class="em-inv" style="--em-rgb: ${e.rgb}">` +
    `<div class="em-inv-top" data-emotion="${k}">${icon(e, 34)}<span class="em-inv-name">${k}</span></div>` +
    `<div class="em-step">` +
    stepBtn(e.key, -1, '−') +
    `<input class="in-input ns-input em-step-n" type="number" min="0" max="999" value="0" inputmode="numeric" data-key="${k}" aria-label="${k} owned">` +
    stepBtn(e.key, 1, '+') +
    `</div>` +
    `<div class="em-step-quick">` +
    stepBtn(e.key, -10, '−−−') +
    stepBtn(e.key, -5, '−−') +
    stepBtn(e.key, 5, '++') +
    stepBtn(e.key, 10, '+++') +
    `</div></div>`
  )
}
function craftRow(n: string, c: readonly string[], times: number, showTimes: boolean): string {
  const hidden = isHiddenAnoint(n)
  return (
    `<li class="em-craft" data-name="${escapeHtml(n.toLowerCase())}" data-hidden="${hidden ? '1' : '0'}">` +
    (showTimes
      ? `<span class="em-craft-times" title="${copy.emotions.craftableTimesTitle(times)}">×${times}</span>`
      : '') +
    `<div class="em-craft-body"><div class="em-craft-hd">` +
    `<span class="em-craft-name">${escapeHtml(n)}` +
    (hidden
      ? `<span class="em-hidden-badge" title="${escapeHtml(copy.emotions.hiddenBadgeTitle)}">${copy.emotions.hiddenBadge}</span>`
      : '') +
    `</span>` +
    `<span class="em-recipe">${recipeChips(c)}</span></div>` +
    statList(notables[n] ?? []) +
    `</div></li>`
  )
}
function amuletView(): string {
  // One column per rarity (Diluted → Liquid → Concentrated → Potent), cards stacked within — keeps
  // the whole grid to a short band and moves the tier label to a single column header (no overflow).
  const cols = TIER_ORDER.map((t) => {
    const cards = emotions
      .filter((e) => e.rarity === t)
      .map(inventoryCard)
      .join('')
    return cards
      ? `<div class="em-inv-col"><h3 class="em-inv-col-h">${escapeHtml(t)}</h3><div class="em-inv-col-cards">${cards}</div></div>`
      : ''
  }).join('')
  return (
    `<div class="em-pane">` +
    `<p class="em-lead">${copy.emotions.amuletLead}</p>` +
    `<div class="em-inv-tools">` +
    `<span class="em-inv-tools-lbl">${copy.emotions.adjustAll}</span>` +
    `<button type="button" class="ix-btn em-bulk em-bulk-sub" data-bulk="-10">−10</button>` +
    `<button type="button" class="ix-btn em-bulk em-bulk-sub" data-bulk="-5">−5</button>` +
    `<button type="button" class="ix-btn em-bulk em-bulk-sub" data-bulk="-1">−1</button>` +
    `<span class="em-bulk-sep" aria-hidden="true"></span>` +
    `<button type="button" class="ix-btn em-bulk" data-bulk="1">+1</button>` +
    `<button type="button" class="ix-btn em-bulk" data-bulk="5">+5</button>` +
    `<button type="button" class="ix-btn em-bulk" data-bulk="10">+10</button>` +
    `<button type="button" class="ix-btn ix-btn--ghost em-reset">${copy.emotions.reset}</button>` +
    `</div>` +
    `<div class="em-inv-cols">${cols}</div>` +
    `<div class="em-craft-bar">` +
    `<span class="em-craft-summary" aria-live="polite">${copy.emotions.summaryDefault}</span>` +
    `<label class="em-alltoggle"><input type="checkbox" class="em-show-all"> ${copy.emotions.showAllRecipes}</label>` +
    `<label class="em-alltoggle"><input type="checkbox" class="em-hidden-only"> ${copy.emotions.hiddenOnly}</label>` +
    `<input type="search" class="in-input em-search" placeholder="${copy.emotions.filterNotables}" aria-label="Filter notables">` +
    `</div>` +
    `<ul class="em-craft-list"></ul>` +
    `<p class="em-empty" hidden>${copy.emotions.noNotableMatch}</p>` +
    `</div>`
  )
}

// ── JEWEL (craft) ──────────────────────────────────────────────────────────────────────────────
function jewelCell(c: JewelColour | undefined): string {
  if (!c || (!c.p && !c.s)) return `<td class="em-jcell em-empty-cell"></td>`
  const slot = (s: JewelColour['p'], kind: 'P' | 'S') =>
    s
      ? `<div class="em-jslot"><span class="em-affix em-affix-${kind === 'P' ? 'pre' : 'suf'}">${kind}</span>` +
        (s.name ? `<b>${escapeHtml(s.name)}</b> ` : '') +
        `${escapeHtml(s.text)}</div>`
      : ''
  return `<td class="em-jcell">${slot(c.p, 'P')}${slot(c.s, 'S')}</td>` // P/S = prefix/suffix affix tags (layout glyphs)
}
function jewelTable(timeLost: boolean): string {
  const rows = emotions
    .map((e) => {
      const out = timeLost ? e.jewelTimeLost : e.jewel
      if (!out) return ''
      const cells = JEWEL_COLOURS.map(({ key }) => jewelCell(out[key])).join('')
      return (
        `<tr><th scope="row" class="em-jrow-hd" style="--em-rgb: ${e.rgb}" data-emotion="${escapeHtml(e.key)}">` +
        `${icon(e, 22)}<span class="em-jrow-name">${escapeHtml(e.key)}</span>` +
        `<span class="em-jrow-rar">${escapeHtml(e.rarity)}</span></th>${cells}</tr>`
      )
    })
    .join('')
  const head = JEWEL_COLOURS.map(({ label }) => `<th scope="col" class="em-jcol">${label}</th>`).join('')
  return `<table class="dt-table em-jtable"><caption class="sr-only">${copy.emotions.jewelTableCaption}</caption><thead><tr><th scope="col">${copy.emotions.jewelColEmotion}</th>${head}</tr></thead><tbody>${rows}</tbody></table>`
}
function jewelView(): string {
  return (
    `<div class="em-pane">` +
    `<p class="em-lead">${copy.emotions.jewelLead}</p>` +
    `<div class="ix-seg em-seg" role="tablist" aria-label="Jewel type" style="--n: 2">` +
    `<span class="ix-seg-thumb" style="--i: 0" aria-hidden="true"></span>` +
    `<button type="button" class="em-seg-btn on" data-jewel="normal" role="tab" aria-selected="true">${copy.emotions.jewelNormal}</button>` +
    `<button type="button" class="em-seg-btn" data-jewel="timelost" role="tab" aria-selected="false">${copy.emotions.jewelTimeLost}</button>` +
    `</div>` +
    `<div class="em-jtable-wrap" data-jewel-host>${jewelTable(false)}</div>` +
    `<p class="em-note"><span class="em-affix em-affix-pre">${copy.emotions.jewelAffixP}</span>${copy.emotions.jewelNotePrefix}<span class="em-affix em-affix-suf">${copy.emotions.jewelAffixS}</span>${copy.emotions.jewelNoteSuffix}</p>` +
    `<aside class="em-sinister">` +
    `<div class="em-sinister-h">${copy.emotions.sinisterNoteHd}</div>` +
    `<p class="em-sinister-b">${copy.emotions.sinisterNote}</p>` +
    `</aside>` +
    `</div>`
  )
}

// ── WAYSTONE (instil) ──────────────────────────────────────────────────────────────────────────
function waystoneRow(e: Emotion): string {
  const w = e.waystone
  const k = escapeHtml(e.key)
  // A count stepper (not a checkbox): the same emotion can be instilled more than once on a waystone,
  // each application adding its own Deliriousness% + reward modifier.
  return (
    `<li class="em-way" style="--em-rgb: ${e.rgb}">` +
    `<div class="em-way-qty">` +
    `<button type="button" class="icb icb--xs em-way-step" data-step="-1" data-key="${k}" aria-label="One less ${k}">−</button>` +
    `<input class="in-input ns-input em-way-n" type="number" min="0" max="100" value="0" inputmode="numeric" data-key="${k}" data-pct="${w.deliriousPct ?? 0}" aria-label="${k} applied">` +
    `<button type="button" class="icb icb--xs em-way-step" data-step="1" data-key="${k}" aria-label="One more ${k}">+</button>` +
    `</div>` +
    `<span class="em-way-name" data-emotion="${k}">${icon(e, 24)}${k}</span>` +
    `<span class="em-way-pct">${w.deliriousPct != null ? copy.emotions.waystonePctEach(w.deliriousPct) : '—'}</span>` +
    `<span class="em-way-bonus">${w.bonus ? escapeHtml(w.bonus) : copy.emotions.waystoneNoModifier}</span>` +
    `</li>`
  )
}
function waystoneView(): string {
  const sorted = [...emotions].sort(
    (a, b) => (a.waystone.deliriousPct ?? 0) - (b.waystone.deliriousPct ?? 0) || a.tier - b.tier,
  )
  const mathBits: string[] = []
  if (constants.deliriousnessPerRare != null)
    mathBits.push(copy.emotions.waystoneDeliriousPerRare(constants.deliriousnessPerRare))
  if (constants.deliriousnessPerUnique != null)
    mathBits.push(copy.emotions.waystoneDeliriousPerUnique(constants.deliriousnessPerUnique))
  if (constants.deliriousnessOnMapComplete != null)
    mathBits.push(copy.emotions.waystoneDeliriousOnComplete(constants.deliriousnessOnMapComplete))
  if (constants.depthToUnlockSimulacrum != null)
    mathBits.push(
      copy.emotions.waystoneSimulacrum(constants.depthToUnlockSimulacrum, String(constants.simulacrumWaves ?? '?')),
    )
  return (
    `<div class="em-pane">` +
    `<p class="em-lead">${copy.emotions.waystoneLead}</p>` +
    `<ul class="em-way-list">${sorted.map(waystoneRow).join('')}</ul>` +
    `<div class="em-way-sum" aria-live="polite"><span class="em-way-sum-lbl">${copy.emotions.waystoneSelected}</span> ` +
    `<b class="em-way-total">${copy.emotions.waystoneTotal}</b> <span class="em-way-sum-bonus em-muted">${copy.emotions.waystoneSumBonusEmpty}</span></div>` +
    (mathBits.length
      ? `<p class="em-note">${copy.emotions.waystoneNoteWithMath(mathBits.map(escapeHtml).join(' · '))}</p>`
      : `<p class="em-note">${copy.emotions.waystoneNote}</p>`) +
    `</div>`
  )
}

// ── shell ──────────────────────────────────────────────────────────────────────────────────────
function shell(): string {
  const tabs = (
    [
      ['amulet', copy.emotions.tabAmulet, copy.emotions.tabAmuletSub],
      ['jewel', copy.emotions.tabJewel, copy.emotions.tabJewelSub],
      ['waystone', copy.emotions.tabWaystone, copy.emotions.tabWaystoneSub],
    ] as Array<[View, string, string]>
  )
    .map(
      ([v, label, sub], i) =>
        `<button type="button" class="em-subtab${i === 0 ? ' on' : ''}" data-view="${v}" role="tab" ` +
        `aria-selected="${i === 0}"><span class="em-subtab-t">${label}</span>` +
        `<span class="em-subtab-s">${sub}</span></button>`,
    )
    .join('')
  return (
    `<div class="em-wrap">` +
    `<div class="em-subnav" role="tablist" aria-label="Emotion use">${tabs}</div>` +
    `<div class="em-views">` +
    `<section class="em-view" data-view="amulet">${amuletView()}</section>` +
    `<section class="em-view" data-view="jewel" hidden>${jewelView()}</section>` +
    `<section class="em-view" data-view="waystone" hidden>${waystoneView()}</section>` +
    `</div>` +
    `<div class="em-tip" role="tooltip" hidden></div>` +
    `<p class="em-prov">${escapeHtml(provenance.note)}</p>` +
    `</div>`
  )
}

const MAX_CRAFT_ROWS = 250 // keep the live list snappy; the search narrows past this

/** Mount the Emotion planner into `container`. Idempotent per element (renders once). */
export function mountEmotions(container: HTMLElement): void {
  if (container.dataset.emMounted) return
  container.dataset.emMounted = '1'
  container.innerHTML = shell()

  wireSubtabs(container)
  wireAmulet(container)
  wireJewel(container)
  wireWaystone(container)
  wireTooltip(container)
}

function wireSubtabs(container: HTMLElement): void {
  const views = Array.from(container.querySelectorAll<HTMLElement>('.em-view'))
  const subtabs = Array.from(container.querySelectorAll<HTMLButtonElement>('.em-subtab'))
  for (const tab of subtabs) {
    tab.addEventListener('click', () => {
      const v = tab.dataset.view as View
      for (const t of subtabs) {
        const on = t === tab
        t.classList.toggle('on', on)
        t.setAttribute('aria-selected', String(on))
      }
      for (const view of views) view.hidden = view.dataset.view !== v
    })
  }
}

function wireAmulet(container: HTMLElement): void {
  const inv: Record<string, number> = {}
  const list = container.querySelector<HTMLElement>('.em-craft-list')!
  const summary = container.querySelector<HTMLElement>('.em-craft-summary')!
  const empty = container.querySelector<HTMLElement>('.em-empty')!
  const search = container.querySelector<HTMLInputElement>('.em-search')!
  const showAll = container.querySelector<HTMLInputElement>('.em-show-all')!
  const hiddenOnly = container.querySelector<HTMLInputElement>('.em-hidden-only')!

  let raf = 0
  const render = () => {
    raf = 0
    let rows = showAll.checked
      ? allRecipesWithCounts(inv)
      : craftable(inv).map((c) => ({ n: c.n, c: c.c, times: c.times }))
    // "Hidden anoints only" filters the dataset (not the rendered DOM) so all hidden anoints show even
    // past the row cap. Pairs with "Show all recipes" to browse every hidden anoint regardless of inventory.
    if (hiddenOnly.checked) rows = rows.filter((r) => isHiddenAnoint(r.n))
    const total = rows.length
    const capped = rows.slice(0, MAX_CRAFT_ROWS)
    list.innerHTML = capped.map((r) => craftRow(r.n, r.c, r.times, !showAll.checked)).join('')
    summary.textContent = showAll.checked
      ? copy.emotions.summaryAll(total)
      : total === 0
        ? copy.emotions.summaryDefault
        : copy.emotions.summaryCount(
            total,
            total === 1 ? '' : 's',
            total > MAX_CRAFT_ROWS ? copy.emotions.summaryCapped(MAX_CRAFT_ROWS) : '',
          )
    applySearch()
  }
  const applySearch = () => {
    const q = search.value.trim().toLowerCase()
    let shown = 0
    for (const li of Array.from(list.querySelectorAll<HTMLElement>('.em-craft'))) {
      const hit = !q || (li.dataset.name ?? '').includes(q)
      li.hidden = !hit
      if (hit) shown++
    }
    empty.hidden = shown > 0 || list.children.length === 0
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(render)
  }

  const setCount = (key: string, val: number) => {
    inv[key] = clampInt(val, 0, 999)
    const input = container.querySelector<HTMLInputElement>(`.em-step-n[data-key="${cssEscape(key)}"]`)
    if (input) input.value = String(inv[key])
    schedule()
  }
  for (const btn of container.querySelectorAll<HTMLButtonElement>('.em-step-btn')) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key!
      setCount(key, (inv[key] ?? 0) + Number(btn.dataset.step))
    })
  }
  for (const input of container.querySelectorAll<HTMLInputElement>('.em-step-n')) {
    input.addEventListener('input', () => setCount(input.dataset.key!, Number(input.value)))
  }
  // bulk "add to all" + reset
  for (const btn of container.querySelectorAll<HTMLButtonElement>('.em-bulk')) {
    btn.addEventListener('click', () => {
      const d = Number(btn.dataset.bulk)
      for (const e of emotions) setCount(e.key, (inv[e.key] ?? 0) + d)
    })
  }
  container.querySelector<HTMLButtonElement>('.em-reset')?.addEventListener('click', () => {
    for (const e of emotions) setCount(e.key, 0)
  })
  search.addEventListener('input', applySearch)
  hiddenOnly.addEventListener('change', schedule)
  showAll.addEventListener('change', schedule)
  render()
}

/** All recipes (Show-all mode), each with how many times the current inventory can make it. */
function allRecipesWithCounts(
  inv: Record<string, number>,
): Array<{ n: string; c: [string, string, string]; times: number }> {
  const made = new Map(craftable(inv).map((c) => [c.n + '|' + c.c.join(','), c.times]))
  const seen = new Set<string>()
  const out: Array<{ n: string; c: [string, string, string]; times: number }> = []
  for (const n of Object.keys(notables).sort((a, b) => a.localeCompare(b))) {
    for (const c of recipesForNotable(n)) {
      const key = n + '|' + c.join(',')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ n, c, times: made.get(key) ?? 0 })
    }
  }
  return out
}

function wireJewel(container: HTMLElement): void {
  const host = container.querySelector<HTMLElement>('[data-jewel-host]')!
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('.em-seg-btn')]
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      for (const b of buttons) {
        const on = b === btn
        b.classList.toggle('on', on)
        b.setAttribute('aria-selected', String(on))
      }
      // slide the vendored ix-seg thumb to the active segment (same idiom as the economy views)
      container
        .querySelector<HTMLElement>('.em-seg .ix-seg-thumb')
        ?.style.setProperty('--i', String(buttons.indexOf(btn)))
      host.innerHTML = jewelTable(btn.dataset.jewel === 'timelost')
    })
  }
}

function wireWaystone(container: HTMLElement): void {
  const total = container.querySelector<HTMLElement>('.em-way-total')!
  const sumBonus = container.querySelector<HTMLElement>('.em-way-sum-bonus')!
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('.em-way-n'))
  const plusBtns = Array.from(container.querySelectorAll<HTMLButtonElement>('.em-way-step[data-step="1"]'))
  const byKey = new Map(inputs.map((i) => [i.dataset.key ?? '', i]))

  const recombine = () => {
    let raw = 0
    const picked: Array<{ key: string; n: number }> = []
    for (const inp of inputs) {
      const n = Math.max(0, Math.min(100, Math.floor(Number(inp.value) || 0)))
      if (n > 0) {
        raw += n * Number(inp.dataset.pct || 0) // each application adds its own Deliriousness%
        picked.push({ key: inp.dataset.key ?? '', n })
      }
    }
    // Deliriousness fills to 100% (its definitional ceiling); AfflictionConstants ships no cap field.
    const pct = Math.min(100, raw)
    const atCap = raw >= 100
    total.textContent = copy.emotions.waystoneTotalLive(pct, atCap ? copy.emotions.waystoneMax : '')
    // At 100% the map is fully Delirious — block any further additions (the − buttons still work).
    for (const b of plusBtns) b.disabled = atCap
    const bonuses = picked
      .map(({ key, n }) => {
        const b = emotionByKey(key)?.waystone.bonus
        return b ? (n > 1 ? `${b} ×${n}` : b) : null
      })
      .filter((b): b is string => Boolean(b))
    if (!picked.length) {
      sumBonus.className = 'em-way-sum-bonus em-muted'
      sumBonus.textContent = copy.emotions.waystoneSumBonusEmpty
    } else {
      sumBonus.className = 'em-way-sum-bonus'
      sumBonus.textContent = bonuses.length ? `· ${bonuses.join(' · ')}` : ''
    }
  }

  const setCount = (key: string, val: number) => {
    const inp = byKey.get(key)
    if (!inp) return
    inp.value = String(clampInt(val, 0, 100))
    recombine()
  }

  for (const inp of inputs) inp.addEventListener('input', recombine)
  for (const btn of container.querySelectorAll<HTMLButtonElement>('.em-way-step')) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key ?? ''
      setCount(key, (Number(byKey.get(key)?.value) || 0) + Number(btn.dataset.step))
    })
  }
  recombine()
}

/** Shared hover/focus tooltip for any `[data-emotion]` element. */
function wireTooltip(container: HTMLElement): void {
  const tip = container.querySelector<HTMLElement>('.em-tip')!
  let current = ''
  const show = (target: HTMLElement) => {
    const key = target.dataset.emotion!
    const e = emotionByKey(key)
    if (!e) return
    if (current !== key) {
      tip.innerHTML = emotionTooltip(e)
      current = key
    }
    tip.hidden = false
    position(target)
  }
  const position = (target: HTMLElement) => {
    const r = target.getBoundingClientRect()
    const tr = tip.getBoundingClientRect()
    let left = r.left + r.width / 2 - tr.width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8))
    let top = r.top - tr.height - 10
    if (top < 8) top = r.bottom + 10 // flip below if no room above
    tip.style.left = `${Math.round(left)}px`
    tip.style.top = `${Math.round(top)}px`
  }
  const hide = () => {
    tip.hidden = true
    current = ''
  }
  const armed = (ev: Event): HTMLElement | null => {
    const t = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-emotion]')
    return t && container.contains(t) ? t : null
  }
  container.addEventListener('pointerover', (ev) => {
    const t = armed(ev)
    if (t) show(t)
  })
  container.addEventListener('pointerout', (ev) => {
    if (armed(ev)) hide()
  })
  container.addEventListener('focusin', (ev) => {
    const t = armed(ev)
    if (t) show(t)
  })
  container.addEventListener('focusout', hide)
}

/** Clamp a possibly-fractional/NaN count into the integer range [min, max]. */
function clampInt(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(val) || 0))
}

/** CSS.escape for attribute selectors, with a tiny fallback (emotion keys are word chars anyway). */
function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&')
}
