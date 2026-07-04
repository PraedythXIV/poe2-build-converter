// ── gear gallery + #311 item tooltips + the item-details overlay ─────────────
// Extracted from main.ts (structural refactor — behaviour/output unchanged). Equipped items are
// grouped by category (weapons, armour, jewellery, flasks & charms) so similar-sized cards sit
// together; each category is a responsive grid. Each group lists its canonical slots (rendered as
// empty placeholders when not equipped); `match` also sweeps up extra items in the category (weapon
// swaps, extra charms).
//
// Two parts, both kept as a pure additive layer over main.ts's state:
//  • renderGearGallery — PURE: returns { html, detailItems }. The data-di index space is produced
//    alongside the markup, so the caller just stores the returned array for its click-delegation.
//  • wireGearGallery — attaches the #bc-gear click/keydown delegation + owns the details overlay
//    (DOM-mutating, but self-contained); the caller passes the live detailItems getter + the bound
//    renderItemDetails engine function via `deps`.
//
// The lazy-engine functions (domainForItem / annotateModLine / groupSocketables / rarityKey /
// poeTierVars / itemArtHtml / renderItemDetails) live in main.ts's ensureEngine bindings and are passed
// in through `deps` — this module never imports the convert engine itself (no cycle, no eager chunk).
import type { BuildSummary, SummaryItem } from '../convert/summarize'
import { escapeHtml } from '../ui/escapeHtml'
import { copy } from '../copy'
import { RUNE_FLAG_RE } from './runeFlag'
import { mountBehaviors, type DialogControl } from '../vendor/uikit/behaviors.js'

/** The bound engine functions + shared helpers the gallery needs, supplied by main.ts. Typed via the
 *  engine modules' own exports so a signature change there surfaces here (type-only — no runtime import). */
export interface GearGalleryDeps {
  domainForItem: (typeof import('./detailsPanel'))['domainForItem']
  annotateModLine: (typeof import('./detailsPanel'))['annotateModLine']
  groupSocketables: (typeof import('../convert/summarize'))['groupSocketables']
  rarityKey: (typeof import('../ui/rarity'))['rarityKey']
  poeTierVars: (typeof import('../ui/rarity'))['poeTierVars']
  itemArtHtml: (typeof import('./icons'))['itemArtHtml']
  /** Shared section header (label + count) — defined in main.ts, reused by skills/perks too. */
  colHead: (label: string, count: number) => string
}

const GEAR_GROUPS: Array<{
  label: string
  slots: Array<{ slot: string; label: string }>
  match: (slot: string) => boolean
}> = [
  {
    label: copy.breakdown.gearWeapons,
    slots: [
      { slot: 'weapon 1', label: copy.breakdown.gearWeapon1 },
      { slot: 'weapon 2', label: copy.breakdown.gearWeapon2 },
      { slot: 'weapon 1 swap', label: copy.breakdown.gearWeapon1Swap },
      { slot: 'weapon 2 swap', label: copy.breakdown.gearWeapon2Swap },
    ],
    match: (s) => s.includes('weapon'),
  },
  {
    label: copy.breakdown.gearArmour,
    slots: [
      { slot: 'helmet', label: copy.breakdown.gearHelmet },
      { slot: 'body armour', label: copy.breakdown.gearBodyArmour },
      { slot: 'gloves', label: copy.breakdown.gearGloves },
      { slot: 'boots', label: copy.breakdown.gearBoots },
      { slot: 'belt', label: copy.breakdown.gearBelt },
    ],
    match: (s) => ['helmet', 'body armour', 'gloves', 'boots', 'belt'].includes(s),
  },
  {
    label: copy.breakdown.gearJewellery,
    slots: [
      { slot: 'amulet', label: copy.breakdown.gearAmulet },
      { slot: 'ring 1', label: copy.breakdown.gearRing1 },
      { slot: 'ring 2', label: copy.breakdown.gearRing2 },
    ],
    match: (s) => s === 'amulet' || s.startsWith('ring'),
  },
  {
    label: copy.breakdown.gearFlasksCharms,
    slots: [
      { slot: 'flask 1', label: copy.breakdown.gearFlask1 },
      { slot: 'flask 2', label: copy.breakdown.gearFlask2 },
    ],
    match: (s) => s.startsWith('flask') || s.startsWith('charm'),
  },
]

/** One #311 tooltip from a SummaryItem — honest data only (no quality/ilvl/base stats we don't parse).
 *  The card is a button: clicking (or Enter/Space) opens the enriched details overlay. Pushes the item
 *  to `detailItems` (the data-di sink) so the gallery's click delegation can resolve a card → item. */
function itemTooltip(it: SummaryItem, detailItems: SummaryItem[], deps: GearGalleryDeps): string {
  const di = detailItems.push(it) - 1
  const domain = deps.domainForItem(it)
  const base = it.baseType && it.baseType !== it.name ? `<span class="itc-base">${escapeHtml(it.baseType)}</span>` : ''
  const reqs = it.levelReq > 1 ? `<div class="itc-reqs">${copy.breakdown.requiresLevel(it.levelReq)}</div>` : ''
  const mods = it.mods
    .map((m) => {
      const rune = RUNE_FLAG_RE.test(m)
      const text = escapeHtml(m.replace(RUNE_FLAG_RE, ''))
      // "socketed", not "rune": PoB tags soul-core stats {rune} too — the generic word is the accurate one
      if (rune) return `<div class="itc-mod itc-mod--bonus" data-tag="socketed">${text}</div>`
      // B3 — affix-tier chip ("T3/9", from our own datamine); '' when no exact in-domain match
      return `<div class="itc-mod">${text}${deps.annotateModLine(m, domain)}</div>`
    })
    .join('')
  const grants = it.grantedSkills.length
    ? `<div class="itc-runes itc-grants"><span>${copy.breakdown.grants}</span>${it.grantedSkills
        .map((g) => escapeHtml(g.level !== null ? copy.breakdown.grantWithLevel(g.name, g.level) : g.name))
        .join(' · ')}</div>`
    : ''
  // socketables split by their stated category (PoB labels them all "Rune:")
  const runeNames = deps
    .groupSocketables(it.runes)
    .map((g) => `<div class="itc-runes"><span>${g.label}</span>${g.names.map(escapeHtml).join(' · ')}</div>`)
    .join('')
  const sep = mods || grants || runeNames ? '<hr class="itc-sep" aria-hidden="true" />' : ''
  const stampCls = it.inBuild ? 'itc-stamp' : 'itc-stamp itc-stamp--preview'
  const stampTxt = it.inBuild ? escapeHtml(it.slot) : copy.breakdown.previewStamp(escapeHtml(it.slot))
  const stamp = `<div class="${stampCls}"><span class="bc-tier" aria-hidden="true">${it.inBuild ? '●' : '○'}</span> ${stampTxt}</div>`
  const grk = deps.rarityKey(it.rarity)
  return (
    `<div class="itc-card itc-card--featured itc-r-${grk}" style="${deps.poeTierVars(grk)}" role="button" tabindex="0" aria-haspopup="dialog" data-di="${di}" aria-label="${copy.breakdown.cardAria(escapeHtml(it.slot), escapeHtml(it.name))}">` +
    `<div class="itc-header">${deps.itemArtHtml(it)}<span class="itc-name">${escapeHtml(it.name)}</span>${base}</div>` +
    `<div class="itc-body">${reqs}${sep}${mods}${grants}${runeNames}</div>${stamp}</div>`
  )
}

/** A muted placeholder card for a canonical slot the build leaves empty. */
function emptyTooltip(label: string): string {
  return (
    `<div class="itc-card itc-card--empty" role="group" aria-label="${copy.breakdown.emptySlotAria(escapeHtml(label))}">` +
    `<div class="itc-header"><span class="itc-name">${escapeHtml(label)}</span></div>` +
    `<div class="itc-body itc-empty-body">${copy.breakdown.noItemEquipped}</div>` +
    `<div class="itc-stamp">${copy.breakdown.empty}</div></div>`
  )
}
/** One category section: a header + a responsive grid of its #311 tooltips. */
function gearSection(label: string, items: SummaryItem[], detailItems: SummaryItem[], deps: GearGalleryDeps): string {
  if (!items.length) return ''
  return `<section class="bc-gear-sec">${deps.colHead(label, items.length)}<div class="bc-gear-grid">${items
    .map((it) => itemTooltip(it, detailItems, deps))
    .join('')}</div></section>`
}
/** The gear gallery markup: each category shows its canonical slots (empty if unequipped), plus any
 *  extras (swaps/charms); tree jewels last. Builds the data-di index space (`detailItems`) as it goes. */
function renderGear(s: BuildSummary, detailItems: SummaryItem[], deps: GearGalleryDeps): string {
  let remaining = [...s.items]
  const takeSlot = (slot: string): SummaryItem | undefined => {
    const i = remaining.findIndex((x) => x.slot.toLowerCase() === slot)
    return i >= 0 ? remaining.splice(i, 1)[0] : undefined
  }
  // only surface the weapon-swap slots when the build actually runs a swap set
  const hasSwap = s.items.some((it) => it.slot.toLowerCase().includes('swap'))
  const sections: string[] = []
  for (const g of GEAR_GROUPS) {
    const slots = hasSwap ? g.slots : g.slots.filter((x) => !x.slot.includes('swap'))
    const cards: string[] = []
    let equipped = 0
    for (const { slot, label } of slots) {
      const it = takeSlot(slot)
      if (it) {
        cards.push(itemTooltip(it, detailItems, deps))
        equipped++
      } else {
        cards.push(emptyTooltip(label))
      }
    }
    // extra equipped items in this category (weapon swaps, charms) — appended, no empty placeholders.
    // Single filter pass (O(n)): collect this group's matches, then drop them from `remaining` in one go
    // — avoids the O(n²) indexOf-splice loop and the risk of splice removing the wrong item on overlap.
    const extras = remaining.filter((x) => g.match(x.slot.toLowerCase()))
    if (extras.length) {
      remaining = remaining.filter((x) => !g.match(x.slot.toLowerCase()))
      for (const it of extras) {
        cards.push(itemTooltip(it, detailItems, deps))
        equipped++
      }
    }
    sections.push(
      `<section class="bc-gear-sec">${deps.colHead(g.label, equipped)}<div class="bc-gear-grid">${cards.join('')}</div></section>`,
    )
  }
  if (remaining.length) sections.push(gearSection(copy.breakdown.otherGear, remaining, detailItems, deps)) // anything unmatched
  sections.push(gearSection(copy.breakdown.treeJewels, s.jewels, detailItems, deps))
  return sections.filter(Boolean).join('')
}

/** Render the gear gallery for a build summary. Returns the markup AND the data-di item list the
 *  caller stores for its #bc-gear click delegation (one list per render — indices match the DOM). */
export function renderGearGallery(
  s: BuildSummary,
  deps: GearGalleryDeps,
): { html: string; detailItems: SummaryItem[] } {
  const detailItems: SummaryItem[] = []
  const html =
    s.items.length || s.jewels.length
      ? renderGear(s, detailItems, deps)
      : `<p class="bc-empty">${copy.breakdown.noItems}</p>`
  return { html, detailItems }
}

/** Dependencies for the click-to-open details overlay wiring. */
export interface GearWiringDeps {
  /** The current render's data-di item list (a clicked card resolves through this). */
  getDetailItems: () => SummaryItem[]
  /** Bound engine renderer for the enriched item-details body. */
  renderItemDetails: (item: SummaryItem) => string
}

// ── item-details overlay — a clicked gear card expands into the enriched tier view ──
/** Attach the #bc-gear click/keydown delegation that opens the item-details overlay. Owns the single
 *  open-overlay handle internally (one overlay at a time). Call once during boot. */
export function wireGearGallery(gearEl: HTMLElement, deps: GearWiringDeps): void {
  // ONE persistent modal overlay, content swapped per item. The vendored library `dialog` behavior
  // (data-behavior="dialog") owns the modal mechanics: focus enters + is TRAPPED (Tab cycles, can't
  // escape), Escape + the [data-dialog-close] ✕ + the scrim close it, the background goes inert +
  // aria-hidden, and focus restores to the opener card. (The old hand-rolled overlay had Escape +
  // close + restore but NO focus trap — audit 5.1.)
  let overlay: (HTMLElement & { _dialog?: DialogControl }) | null = null

  function ensureOverlay(): HTMLElement & { _dialog?: DialogControl } {
    if (overlay) return overlay
    const ov = document.createElement('div') as HTMLElement & { _dialog?: DialogControl }
    ov.className = 'idm-backdrop'
    ov.id = 'item-overlay'
    ov.setAttribute('data-behavior', 'dialog')
    ov.hidden = true
    ov.innerHTML =
      `<div class="idm" role="dialog" aria-modal="true">` +
      `<button type="button" class="icb icb--xs idm-close" data-dialog-close aria-label="${escapeHtml(copy.breakdown.closeDetails)}">✕</button>` +
      `<div class="idm-body"></div>` +
      `</div>`
    document.body.appendChild(ov)
    // click on the scrim (outside the .idm panel) dismisses — the behavior closes via Escape / ✕
    ov.addEventListener('click', (ev) => {
      if (ev.target === ov) ov._dialog?.close()
    })
    mountBehaviors(ov) // wires the dialog behavior → ov._dialog (trap, Escape, restore, background inert)
    overlay = ov
    return ov
  }

  function openItemDetails(item: SummaryItem, card: HTMLElement): void {
    const ov = ensureOverlay()
    ov._dialog?.close() // if one's already open, reset before swapping to the new item
    ov.querySelector('.idm')!.setAttribute('aria-label', copy.breakdown.itemDetailsAria(item.name))
    ov.querySelector('.idm-body')!.innerHTML = deps.renderItemDetails(item)
    card.focus() // make the card the dialog's opener so the trap restores focus here on close
    ov._dialog?.open()
  }

  /** Resolve a gallery event back to its card + item (empty placeholders have no data-di). */
  function detailCardFromEvent(ev: Event): { card: HTMLElement; item: SummaryItem } | null {
    const card = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.itc-card[data-di]') ?? null
    if (!card) return null
    const item = deps.getDetailItems()[Number(card.dataset.di)]
    return item ? { card, item } : null
  }
  gearEl.addEventListener('click', (ev) => {
    const hit = detailCardFromEvent(ev)
    if (hit) openItemDetails(hit.item, hit.card)
  })
  gearEl.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    const hit = detailCardFromEvent(ev)
    if (!hit) return
    ev.preventDefault() // Space must not scroll the page
    openItemDetails(hit.item, hit.card)
  })
}
