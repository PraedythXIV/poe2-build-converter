// Atlas-Masters drawer — a planner-only LEFT flyout beside the atlas tree canvas.
//
// PoE2's atlas masters (Doryani / Hilda / Jado) are NOT part of the free-BFS atlas passive
// tree and never touch a .build (the format has no atlas fields). Each master shows its 12
// keystones in a 3-column × 4-row grid (matching the in-game panel) and you may allocate ANY
// of them up to a 4-point cap — there is no per-row limit (the `row`/`col` fields are purely
// the display layout). This is a self-contained selector layer that sits alongside
// mountAtlasTree, not inside it. Panel layout mirrors the game: a centred master title +
// "Points: X (4)" header above a [portrait | keystone grid] body.
//
// Data: src/data/atlasMasters.json (scripts/build-atlas-masters.mjs — row/budget from the
// schema-unmapped game columns). Glyphs: src/data/atlasMasterIcons.json + the packed sprite
// (scripts/build-atlas-master-icons.mjs); each keystone has an inactive + active (lit) glyph.

import mastersData from '../data/atlasMasters.json'
import iconData from '../data/atlasMasterIcons.json'
import portraitsManifest from '../data/atlasMasterPortraits.json'
import spriteUrl from '../assets/tree/atlas-master-icons.webp'
import { copy } from '../copy'
import { escapeHtml } from '../ui/escapeHtml'
import { setFlyoutOpen } from '../ui/flyout'

// Portraits are tall character art (one webp each, not square-packed). DATA-DRIVEN: the manifest
// (scripts/build-atlas-master-portraits.mjs) lists each master's webp filename, and import.meta.glob
// eagerly resolves every atlas-master-*.webp to its hashed asset URL (fetched on demand by the online
// build) — so a master is keyed by its data, not a hardcoded name→import binding. (The icons SPRITE
// also matches the glob but is never looked up here, so the lookup ignores it.)
const PORTRAIT_URLS = import.meta.glob('../assets/tree/atlas-master-*.webp', { eager: true }) as Record<
  string,
  { default: string }
>
const PORTRAIT_MANIFEST = portraitsManifest as unknown as Record<string, { src?: string }>
const DATA = mastersData as unknown as { budget: number; masters: Master[] }
const PORTRAIT: Record<string, string> = Object.fromEntries(
  DATA.masters
    .map((m): [string, string | undefined] => {
      const src = PORTRAIT_MANIFEST[m.id]?.src
      return [m.id, src ? PORTRAIT_URLS[`../assets/tree/${src}`]?.default : undefined]
    })
    .filter((pair): pair is [string, string] => Boolean(pair[1])),
)

export interface MasterKeystone {
  id: string
  row: number
  col: number
  name: string
  flavour: string
  stats: string[]
  iconDds: string
  iconDdsActive: string
}
export interface Master {
  id: string
  name: string
  budget: number
  keystones: MasterKeystone[]
}

const RECTS = iconData as unknown as Record<string, { x: number; y: number; w: number; h: number }> & {
  _atlas: { w: number; h: number; tile: number }
  _accents?: Record<string, string>
}

/** Fallback accent for a master with no chromatic glyph (one spelling, reused everywhere). */
const NEUTRAL_ACCENT = '150, 150, 150'

/** Keystones in grid order (row, then col) — game data is static, so sort once at load. */
const ORDERED_KEYSTONES: Record<string, MasterKeystone[]> = Object.fromEntries(
  DATA.masters.map((m) => [m.id, [...m.keystones].sort((a, b) => a.row - b.row || a.col - b.col)]),
)

/** Master id -> accent triple ("r, g, b") so each tab + its grid reads in the master's hue.
 *  DATA-DRIVEN: derived offline from the lit/active keystone glyph art (atlasMasterIcons.json
 *  `_accents`, scripts/build-atlas-master-icons.mjs) — no colour column exists in the game data.
 *  A master with no chromatic glyph falls back to neutral grey. */
export const MASTER_ACCENT: Record<string, string> = Object.fromEntries(
  DATA.masters.map((m) => [m.id, RECTS._accents?.[m.id] ?? NEUTRAL_ACCENT]),
)

/** Flat stat lines for an allocation snapshot (master id -> picked keystone ids), in master/keystone
 *  order — so the allocated-stats panel can fold the masters' bonuses in alongside the tree nodes.
 *  Re-applies the per-master point cap (like setState) so a hand-edited over-budget share link can't
 *  inflate the summary, independent of the caller. */
export function allocatedMasterStats(state: Record<string, string[]>): string[] {
  const out: string[] = []
  for (const m of DATA.masters) {
    const picked = new Set(state[m.id] ?? [])
    let n = 0
    // iterate in display-grid order (matching the drawer) so an over-budget share link is
    // truncated to the same 4 keystones the UI would keep, not the first 4 in JSON order
    for (const k of ORDERED_KEYSTONES[m.id] ?? m.keystones) {
      if (!picked.has(k.id)) continue
      if (n++ >= m.budget) break // hard 4-point cap, mirroring the drawer
      out.push(...k.stats)
    }
  }
  return out
}

const DISPLAY = 74 // rendered glyph size (native tile is 128); keep in sync with .am-cell in styles.css
const SCALE = DISPLAY / RECTS._atlas.tile // sprite scale factor (static — both operands are constants)

/** Inline sprite-background for one glyph .dds path, scaled to the DISPLAY size. */
function glyphStyle(dds: string): string {
  const r = RECTS[dds]
  if (!r) return ''
  return (
    `background-image:url(${spriteUrl});` +
    `background-size:${RECTS._atlas.w * SCALE}px ${RECTS._atlas.h * SCALE}px;` +
    `background-position:-${r.x * SCALE}px -${r.y * SCALE}px`
  )
}

/** Escaped `<li>` list items for a set of stat lines (shared by both tooltips). */
function statsListHtml(stats: string[]): string {
  return stats.map((s) => `<li>${escapeHtml(s)}</li>`).join('')
}

export interface MastersApi {
  /** Picks per master, as keystone-id arrays (stable order) — for serialization. */
  getState(): Record<string, string[]>
  setState(state: Record<string, string[]>): void
  /** Fires after any USER change (not setState) — drives the share button / persistence. */
  subscribe(fn: (state: Record<string, string[]>) => void): void
  /** Total allocated keystones across all masters (0 = nothing to share/reset). */
  total(): number
}

/**
 * Build the masters drawer into `drawer`, wire the `toggle` button, and return an API for
 * reading/writing the allocation (used by main.ts for the share link + reset).
 */
export function mountAtlasMasters(drawer: HTMLElement, toggle: HTMLElement): MastersApi {
  // allocation state: master id -> set of allocated keystone ids
  const picks = new Map<string, Set<string>>(DATA.masters.map((m) => [m.id, new Set<string>()]))
  let current = DATA.masters[0]?.id ?? ''
  let hoveredId: string | null = null // the keystone the tooltip is showing, if any
  const listeners: Array<(s: Record<string, string[]>) => void> = []

  const snapshot = (): Record<string, string[]> =>
    Object.fromEntries(DATA.masters.map((m) => [m.id, [...(picks.get(m.id) ?? [])]]))
  const emit = () => {
    const s = snapshot()
    for (const fn of listeners) fn(s)
  }

  // ── drawer chrome ────────────────────────────────────────────────────────
  drawer.classList.add('am-drawer')
  drawer.innerHTML = `
    <button type="button" class="icb icb--xs am-close" aria-label="${escapeHtml(copy.atlas.hideMasters)}">✕</button>
    <div class="am-title">
      <h3 class="am-name"></h3>
      <p class="am-points" aria-live="polite"></p>
    </div>
    <div class="am-body">
      <figure class="am-portrait"><img class="am-portrait-img" alt="" decoding="async" /></figure>
      <div class="am-grid" role="group"></div>
    </div>
    <div class="am-switch" role="tablist" aria-label="Atlas master" aria-orientation="vertical"></div>`

  const switchEl = drawer.querySelector('.am-switch') as HTMLElement
  const nameEl = drawer.querySelector('.am-name') as HTMLElement
  const pointsEl = drawer.querySelector('.am-points') as HTMLElement
  const gridEl = drawer.querySelector('.am-grid') as HTMLElement
  const portraitImg = drawer.querySelector('.am-portrait-img') as HTMLImageElement

  // Rich hover tooltip — appended to the positioned stage (NOT the drawer, whose overflow
  // would clip it) so it can float out over the atlas canvas beside the hovered glyph.
  const stage = (drawer.parentElement ?? drawer) as HTMLElement
  const tip = document.createElement('div')
  tip.className = 'am-tip'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  stage.appendChild(tip)

  // Wire the show-on-hover/focus, hide-on-leave/blur tooltip pattern shared by the master
  // selector emblems and the keystone cells (onShow differs; hide is always hideTip).
  function attachTip(el: HTMLElement, onShow: () => void): void {
    el.addEventListener('mouseenter', onShow)
    el.addEventListener('mouseleave', hideTip)
    el.addEventListener('focus', onShow)
    el.addEventListener('blur', hideTip)
  }

  // master selector emblems — a vertical strip OUTSIDE the panel's right edge (mirrors the
  // in-game master switcher). Each shows the master's portrait thumb, themed in its hue.
  for (const m of DATA.masters) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'am-switch-btn'
    btn.dataset.master = m.id
    btn.setAttribute('role', 'tab')
    btn.style.setProperty('--am-accent', MASTER_ACCENT[m.id] ?? NEUTRAL_ACCENT)
    const portrait = PORTRAIT[m.id]
    if (portrait) btn.style.backgroundImage = `url(${portrait})`
    btn.setAttribute('aria-label', m.name)
    btn.addEventListener('click', () => {
      current = m.id
      render()
    })
    // hover/focus → preview that master's currently-selected perks (even another master's)
    attachTip(btn, () => showMasterTip(btn, m))
    switchEl.appendChild(btn)
  }

  function masterOf(id: string): Master {
    return DATA.masters.find((m) => m.id === id) ?? DATA.masters[0]!
  }

  /** Budget rule: toggle a keystone within its master — any keystones, hard 4-point cap. */
  function toggleKeystone(masterId: string, k: MasterKeystone): void {
    const set = picks.get(masterId)!
    if (set.has(k.id)) {
      set.delete(k.id)
    } else {
      const master = masterOf(masterId)
      if (set.size >= master.budget) return // 4-point cap — no per-row limit
      set.add(k.id)
    }
    render()
    emit()
  }

  function render(): void {
    const master = masterOf(current)
    const set = picks.get(master.id)!
    const accent = MASTER_ACCENT[master.id] ?? NEUTRAL_ACCENT
    drawer.style.setProperty('--am-accent', accent)

    for (const btn of Array.from(switchEl.children) as HTMLElement[]) {
      const on = btn.dataset.master === master.id
      btn.classList.toggle('is-active', on)
      btn.setAttribute('aria-selected', String(on))
    }
    nameEl.textContent = master.name
    pointsEl.textContent = copy.atlas.points(set.size, master.budget)
    pointsEl.classList.toggle('is-full', set.size >= master.budget)

    const portrait = PORTRAIT[master.id]
    if (portrait) {
      portraitImg.src = portrait
      portraitImg.alt = master.name
    }

    gridEl.innerHTML = ''
    const ordered = ORDERED_KEYSTONES[master.id] ?? master.keystones
    for (const k of ordered) {
      const on = set.has(k.id)
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'am-cell' + (on ? ' is-on' : '')
      cell.style.cssText = glyphStyle(on ? k.iconDdsActive : k.iconDds)
      cell.setAttribute('aria-pressed', String(on))
      cell.setAttribute('aria-label', `${k.name} (row ${k.row})${on ? ', allocated' : ''}`)
      cell.addEventListener('click', () => toggleKeystone(master.id, k))
      attachTip(cell, () => showTip(cell, k))
      gridEl.appendChild(cell)
    }

    // the hovered cell was just rebuilt — re-anchor the open tooltip so its state (and the
    // allocate/remove hint) stays correct without waiting for the mouse to move
    if (hoveredId) {
      const idx = ordered.findIndex((k) => k.id === hoveredId)
      if (idx >= 0) showTip(gridEl.children[idx] as HTMLElement, ordered[idx]!)
      else hideTip()
    }
  }

  // ── tooltip (keystone: name + exact stats + flavour + allocate/remove hint) ──
  function showTip(anchor: HTMLElement, k: MasterKeystone): void {
    hoveredId = k.id
    tip.style.setProperty('--am-accent', MASTER_ACCENT[current] ?? NEUTRAL_ACCENT)
    const on = picks.get(current)?.has(k.id) ?? false
    const stats = statsListHtml(k.stats)
    const flav = k.flavour ? `<p class="am-tip-flav">${escapeHtml(k.flavour).replace(/\n/g, '<br>')}</p>` : ''
    tip.innerHTML =
      `<p class="am-tip-name">${escapeHtml(k.name)}</p>` +
      `<ul class="am-tip-stats">${stats}</ul>` +
      flav +
      `<p class="am-tip-hint">${on ? copy.atlas.clickToRemove : copy.atlas.clickToAllocate}</p>`
    tip.hidden = false
    positionTip(anchor)
  }

  // ── tooltip (master selector: that master's currently-SELECTED perks) ────────
  function showMasterTip(anchor: HTMLElement, m: Master): void {
    hoveredId = null // not a keystone hover, so render() won't try to re-anchor it
    tip.style.setProperty('--am-accent', MASTER_ACCENT[m.id] ?? NEUTRAL_ACCENT)
    const set = picks.get(m.id)!
    const chosen = m.keystones.filter((k) => set.has(k.id))
    const body = chosen.length
      ? `<ul class="am-tip-stats">${statsListHtml(chosen.flatMap((k) => k.stats))}</ul>`
      : `<p class="am-tip-empty">${copy.atlas.noKeystones}</p>`
    tip.innerHTML =
      `<p class="am-tip-name">${escapeHtml(m.name)}</p>` +
      `<p class="am-tip-sub">${copy.atlas.points(set.size, m.budget)}</p>` +
      body
    tip.hidden = false
    positionTip(anchor)
  }

  function hideTip(): void {
    hoveredId = null
    tip.hidden = true
  }
  /** Float the tip past the drawer AND its selector wing (never over the grid/emblems),
      vertically aligned with the hovered glyph; flip to the drawer's left / clamp on-stage. */
  function positionTip(anchor: HTMLElement): void {
    const sr = stage.getBoundingClientRect()
    const dr = drawer.getBoundingClientRect()
    const wr = switchEl.getBoundingClientRect()
    const rightEdge = Math.max(dr.right, wr.right) // clear the protruding selector wing too
    const ar = anchor.getBoundingClientRect()
    tip.style.left = `${rightEdge - sr.left + 10}px`
    tip.style.top = `${ar.top - sr.top}px`
    const tr = tip.getBoundingClientRect()
    if (tr.bottom > sr.bottom - 8) tip.style.top = `${Math.max(8, sr.height - tr.height - 8)}px`
    if (tr.right > sr.right - 8) tip.style.left = `${Math.max(8, dr.left - sr.left - tr.width - 10)}px`
  }

  // ── toggle (flyout open/close) — the shared non-modal flyout contract (ui/flyout.ts) ──────
  const setOpen = (open: boolean, restoreFocus = false): void => setFlyoutOpen(drawer, toggle, open, restoreFocus)
  toggle.addEventListener('click', () => setOpen(!drawer.classList.contains('is-open')))
  drawer.querySelector('.am-close')!.addEventListener('click', () => setOpen(false, true))
  // non-modal flyout: Escape dismisses (and restores focus); focus is NOT trapped/stolen on open so the
  // canvas behind stays usable while the drawer is open.
  drawer.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && drawer.classList.contains('is-open')) setOpen(false, true)
  })
  setOpen(false)
  render()

  return {
    getState: snapshot,
    setState(state) {
      for (const m of DATA.masters) {
        const set = picks.get(m.id)!
        set.clear()
        const wanted = new Set(state[m.id] ?? [])
        // re-apply the 4-point cap (in display-grid order, matching the drawer and
        // allocatedMasterStats) so a malformed/over-budget share link can't exceed it
        for (const k of ORDERED_KEYSTONES[m.id] ?? m.keystones) {
          if (!wanted.has(k.id)) continue
          if (set.size >= m.budget) break
          set.add(k.id)
        }
      }
      render()
    },
    subscribe(fn) {
      listeners.push(fn)
    },
    total: () => DATA.masters.reduce((n, m) => n + (picks.get(m.id)?.size ?? 0), 0),
  }
}
