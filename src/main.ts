import './styles.css'
import { mountMarble } from './bg/marble'
import { convert, DecodeError, ParseError, summarizeSafe } from './convert/index'
import { provenance } from './convert/lookups'
import type { ConvertResult, Warning } from './convert/types'
import type { BuildSummary, SummaryItem } from './convert/summarize'

// ── tiny DOM helper ──────────────────────────────────────────────────────────
function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const els = {
  seg: need<HTMLDivElement>('seg'),
  thumb: need<HTMLSpanElement>('seg').querySelector<HTMLSpanElement>('.ix-seg-thumb')!,
  panePaste: need<HTMLDivElement>('pane-paste'),
  paneUpload: need<HTMLDivElement>('pane-upload'),
  code: need<HTMLTextAreaElement>('code'),
  file: need<HTMLInputElement>('file'),
  dz: need<HTMLButtonElement>('dz'),
  dzTxt: need<HTMLSpanElement>('dz-txt'),
  name: need<HTMLInputElement>('name'),
  convert: need<HTMLButtonElement>('convert'),
  clear: need<HTMLButtonElement>('clear'),
  status: need<HTMLSpanElement>('status'),
  statusTxt: need<HTMLSpanElement>('status-txt'),
  stats: need<HTMLDivElement>('stats'),
  warnings: need<HTMLDivElement>('warnings'),
  json: need<HTMLPreElement>('json'),
  jsonName: need<HTMLSpanElement>('json-name'),
  jsonSize: need<HTMLSpanElement>('json-size'),
  download: need<HTMLButtonElement>('download'),
  copy: need<HTMLButtonElement>('copy'),
  provenance: need<HTMLElement>('provenance'),
  bg: need<HTMLCanvasElement>('bg'),
  bgToggle: need<HTMLButtonElement>('bg-toggle'),
  stepper: need<HTMLElement>('stepper'),
  contents: need<HTMLElement>('contents'),
  bcChar: need<HTMLDivElement>('bc-char'),
  bcGear: need<HTMLDivElement>('bc-gear'),
  bcSkills: need<HTMLDivElement>('bc-skills'),
  bcPerks: need<HTMLDivElement>('bc-perks'),
}

let mode: 'paste' | 'upload' = 'paste'
let uploaded: { name: string; text: string } | null = null
let last: ConvertResult | null = null

// ── input mode (segmented control) ───────────────────────────────────────────
function setMode(next: 'paste' | 'upload'): void {
  mode = next
  const buttons = els.seg.querySelectorAll<HTMLButtonElement>('button')
  buttons.forEach((b, i) => {
    const on = b.dataset.mode === next
    b.classList.toggle('on', on)
    b.setAttribute('aria-selected', String(on))
    if (on) els.thumb.style.setProperty('--i', String(i))
  })
  els.panePaste.hidden = next !== 'paste'
  els.paneUpload.hidden = next !== 'upload'
  updateContents()
}
els.seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
  b.addEventListener('click', () => setMode(b.dataset.mode === 'upload' ? 'upload' : 'paste'))
})
els.code.addEventListener('input', scheduleContents)

// ── file upload + drag/drop ──────────────────────────────────────────────────
async function acceptFile(file: File): Promise<void> {
  try {
    const text = await file.text()
    uploaded = { name: file.name, text }
    els.dz.classList.add('done')
    els.dzTxt.textContent = `Loaded ${file.name} (${fmtBytes(text.length)})`
  } catch {
    uploaded = null
    els.dz.classList.remove('done')
    els.dzTxt.textContent = `Couldn't read ${file.name} — try another file`
  }
  updateContents()
}
els.dz.addEventListener('click', () => els.file.click())
els.file.addEventListener('change', () => {
  const f = els.file.files?.[0]
  if (f) void acceptFile(f)
})
;['dragenter', 'dragover'].forEach((ev) =>
  els.dz.addEventListener(ev, (e) => {
    e.preventDefault()
    els.dz.classList.add('over')
  }),
)
;['dragleave', 'drop'].forEach((ev) =>
  els.dz.addEventListener(ev, (e) => {
    e.preventDefault()
    els.dz.classList.remove('over')
  }),
)
els.dz.addEventListener('drop', (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0]
  if (f) void acceptFile(f)
})

// ── convert ──────────────────────────────────────────────────────────────────
function currentInput(): string {
  if (mode === 'upload') return uploaded?.text ?? ''
  return els.code.value
}

function setStatus(state: 'idle' | 'done' | 'error', text: string): void {
  els.status.dataset.state = state
  els.statusTxt.textContent = text
}

els.convert.addEventListener('click', () => {
  const input = currentInput()
  const name = els.name.value.trim()
  try {
    last = convert(input, name ? { name } : {})
    renderResult(last)
    updateContents()
    setStatus('done', 'Converted')
  } catch (err) {
    last = null
    const msg =
      err instanceof DecodeError || err instanceof ParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Unknown error.'
    renderError(msg)
    setStatus('error', 'Error')
    renderStepper()
  }
})

els.clear.addEventListener('click', () => {
  els.code.value = ''
  els.name.value = ''
  uploaded = null
  els.file.value = ''
  els.dz.classList.remove('done')
  els.dzTxt.textContent = 'Drop a .xml / code file, or click to choose'
  last = null
  els.stats.hidden = true
  els.stats.innerHTML = ''
  els.warnings.innerHTML = ''
  els.json.innerHTML = '<span class="muted">Converted .build JSON will appear here.</span>'
  els.jsonName.textContent = 'build.json'
  els.jsonSize.textContent = ''
  els.download.disabled = true
  els.copy.disabled = true
  els.contents.hidden = true
  setStatus('idle', 'Idle')
  renderStepper()
})

// ── render ───────────────────────────────────────────────────────────────────
function renderResult(r: ConvertResult): void {
  // stats
  const s = r.stats
  const stats: Array<[string, string]> = [
    ['Class', s.ascendancy ? `${s.className ?? '?'} · ${s.ascendancy}` : s.className ?? '?'],
    ['Level', s.level != null ? String(s.level) : '?'],
    ['Passives', `${s.passiveCount}${s.passivesSkipped ? ` (−${s.passivesSkipped})` : ''}`],
    ['Skills', `${s.skillCount} + ${s.supportCount} supp`],
    ['Items', `${s.itemCount}${s.itemsSkipped ? ` (−${s.itemsSkipped})` : ''}`],
    ['Tree', s.treeVersion],
  ]
  els.stats.innerHTML = stats.map(([k, v]) => `<span class="stat">${k} <b>${escapeHtml(v)}</b></span>`).join('')
  els.stats.hidden = false

  renderWarnings(r.warnings)

  els.json.innerHTML = highlightJson(r.json)
  const filename = buildFilename(r.build.name)
  els.jsonName.textContent = filename
  els.jsonSize.textContent = fmtBytes(r.json.length)
  els.download.disabled = false
  els.copy.disabled = false
}

function renderError(message: string): void {
  els.stats.hidden = true
  els.stats.innerHTML = ''
  renderWarnings([{ level: 'error', code: 'convert-failed', message }])
  els.json.innerHTML = '<span class="muted">No output — fix the input and convert again.</span>'
  els.jsonSize.textContent = ''
  els.download.disabled = true
  els.copy.disabled = true
}

function renderWarnings(warnings: Warning[]): void {
  const cls = (lvl: Warning['level']) => (lvl === 'error' ? 'danger' : lvl === 'warn' ? 'warn' : 'info')
  const title = (lvl: Warning['level']) => (lvl === 'error' ? 'Error' : lvl === 'warn' ? 'Warning' : 'Note')
  els.warnings.innerHTML = warnings
    .map(
      (w) =>
        `<div class="ts-toast ${cls(w.level)}"><span class="ts-dot"></span><div class="ts-txt"><b>${title(
          w.level,
        )}</b><span>${escapeHtml(w.message)}</span></div></div>`,
    )
    .join('')
}

// ── download / copy ──────────────────────────────────────────────────────────
els.download.addEventListener('click', () => {
  if (!last) return
  const filename = buildFilename(last.build.name)
  const blob = new Blob([last.json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

els.copy.addEventListener('click', async () => {
  if (!last) return
  const ok = await copyText(last.json)
  els.copy.textContent = ok ? 'Copied!' : 'Copy failed'
  setTimeout(() => (els.copy.textContent = 'Copy JSON'), 1400)
})

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to legacy path (e.g. file:// without clipboard permission) */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

// ── formatting helpers ───────────────────────────────────────────────────────
function buildFilename(name: string): string {
  const base = name.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'build'
  return `${base}.build`
}
function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}
function escapeHtml(s: string): string {
  // also escapes quotes — several call sites interpolate into HTML attributes (aria-label, etc.)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
function highlightJson(json: string): string {
  const esc = escapeHtml(json)
  return esc.replace(
    /("(?:\\.|[^"\\])*"\s*:?)|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g,
    (m, str: string | undefined, bool: string | undefined, numb: string | undefined) => {
      if (str !== undefined) return `<span class="${/:\s*$/.test(str) ? 'k' : 's'}">${str}</span>`
      if (bool !== undefined) return `<span class="b">${m}</span>`
      if (numb !== undefined) return `<span class="n">${m}</span>`
      return m
    },
  )
}

// ── build contents preview (live, debounced) ─────────────────────────────────
let contentsTimer: number | undefined
function scheduleContents(): void {
  clearTimeout(contentsTimer)
  contentsTimer = window.setTimeout(updateContents, 250)
}
function updateContents(): void {
  const s = summarizeSafe(currentInput())
  if (!s) {
    els.contents.hidden = true
    renderStepper()
    return
  }
  renderContents(s)
  els.contents.hidden = false
  renderStepper()
}

// ── stepper (Import → Preview → Convert → Download) ──────────────────────────
// Derive the progress purely from existing state — no separate "current step"
// variable to drift. `reached` = the furthest milestone the input has cleared.
function renderStepper(): void {
  const hasInput = currentInput().trim().length > 0
  const hasPreview = !els.contents.hidden
  const converted = last != null
  const errored = els.status.dataset.state === 'error'
  let reached = 0
  if (hasInput) reached = 1
  if (hasInput && hasPreview) reached = 2
  if (errored) reached = 2 // a Convert attempt clears Import+Preview; the error lands on Convert
  if (converted) reached = 3
  els.stepper.querySelectorAll<HTMLLIElement>('.sx-step').forEach((li, i) => {
    li.classList.remove('sx-step--err')
    let state: 'done' | 'current' | 'upcoming'
    if (errored && i === 2) {
      // a failed Convert flags its own step rather than advancing
      state = 'current'
      li.classList.add('sx-step--err')
    } else if (i < reached) state = 'done'
    else if (i === reached) state = 'current'
    else state = 'upcoming'
    li.dataset.state = state
    if (state === 'current') li.setAttribute('aria-current', 'step')
    else li.removeAttribute('aria-current')
  })
}
function colHead(label: string, count: number): string {
  return `<div class="bc-col-hd">${label} <span>${count}</span></div>`
}
/** Group a per-node name list into unique rows, tagging repeats with their allocation count. */
function groupCount(names: string[]): { name: string; n: number }[] {
  const m = new Map<string, number>()
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n }))
}
function perkList(label: string, names: string[], cls = ''): string {
  if (!names.length) return ''
  // badge counts allocations (per-node), but identical names collapse to one row with a ×N multiplier
  const rows = groupCount(names)
    .map(
      ({ name, n }) =>
        `<li class="bc-row ${cls}"><span class="bc-name">${MK_IN}${escapeHtml(name)}${
          n > 1 ? `<i class="bc-mult">×${n}</i>` : ''
        }</span></li>`,
    )
    .join('')
  return `<div class="bc-subhd">${label} <span>${names.length}</span></div><ul class="bc-list">${rows}</ul>`
}
// conversion markers: everything written to the .build (structured OR guidance text) is ●; preview-only is ○
const MK_IN = '<span class="bc-tier" title="Part of the build — saved to the .build" aria-hidden="true">●</span> '
const MK_PREV = '<span class="bc-tier" title="Preview only — not stored in the .build" aria-hidden="true">○</span> '

// ── gear gallery + #311 item tooltips ────────────────────────────────────────
// equipped items are grouped by category (weapons, armour, jewellery, flasks &
// charms) so similar-sized cards sit together; each category is a responsive grid.
// each group lists its canonical slots (rendered as empty placeholders when not equipped);
// `match` also sweeps up extra items in the category (weapon swaps, extra charms).
const GEAR_GROUPS: Array<{ label: string; slots: Array<{ slot: string; label: string }>; match: (slot: string) => boolean }> = [
  {
    label: 'Weapons',
    slots: [
      { slot: 'weapon 1', label: 'Weapon 1' },
      { slot: 'weapon 2', label: 'Weapon 2' },
      { slot: 'weapon 1 swap', label: 'Weapon 1 · Swap' },
      { slot: 'weapon 2 swap', label: 'Weapon 2 · Swap' },
    ],
    match: (s) => s.includes('weapon'),
  },
  {
    label: 'Armour',
    slots: [
      { slot: 'helmet', label: 'Helmet' },
      { slot: 'body armour', label: 'Body Armour' },
      { slot: 'gloves', label: 'Gloves' },
      { slot: 'boots', label: 'Boots' },
      { slot: 'belt', label: 'Belt' },
    ],
    match: (s) => ['helmet', 'body armour', 'gloves', 'boots', 'belt'].includes(s),
  },
  {
    label: 'Jewellery',
    slots: [{ slot: 'amulet', label: 'Amulet' }, { slot: 'ring 1', label: 'Ring 1' }, { slot: 'ring 2', label: 'Ring 2' }],
    match: (s) => s === 'amulet' || s.startsWith('ring'),
  },
  {
    label: 'Flasks & Charms',
    slots: [{ slot: 'flask 1', label: 'Flask 1' }, { slot: 'flask 2', label: 'Flask 2' }],
    match: (s) => s.startsWith('flask') || s.startsWith('charm'),
  },
]
/** rarity → the inline --itc-tier hue + rgb triple that drives a #311 card. */
function rarityKey(rarity: string): 'unique' | 'rare' | 'magic' | 'normal' {
  const r = rarity.toUpperCase()
  return r === 'UNIQUE' || r === 'RELIC' ? 'unique' : r === 'RARE' ? 'rare' : r === 'MAGIC' ? 'magic' : 'normal'
}
function tierVars(rarity: string): string {
  const k = rarityKey(rarity)
  return `--itc-tier: var(--poe-${k}); --itc-tier-rgb: var(--poe-${k}-rgb);`
}
/** One #311 tooltip from a SummaryItem — honest data only (no quality/ilvl/base stats we don't parse). */
function itemTooltip(it: SummaryItem): string {
  const base = it.baseType && it.baseType !== it.name ? `<span class="itc-base">${escapeHtml(it.baseType)}</span>` : ''
  const reqs = it.levelReq > 1 ? `<div class="itc-reqs">Requires <span class="itc-attr-c">Level ${it.levelReq}</span></div>` : ''
  const mods = it.mods
    .map((m) => {
      const rune = /\(rune\)$/.test(m)
      const text = escapeHtml(m.replace(/\s*\(rune\)$/, ''))
      return rune ? `<div class="itc-mod itc-mod--bonus" data-tag="rune">${text}</div>` : `<div class="itc-mod">${text}</div>`
    })
    .join('')
  const runeNames = it.runes.length
    ? `<div class="itc-runes"><span>Runes</span>${it.runes.map(escapeHtml).join(' · ')}</div>`
    : ''
  const sep = mods || runeNames ? '<hr class="itc-sep" aria-hidden="true" />' : ''
  const stampCls = it.inBuild ? 'itc-stamp' : 'itc-stamp itc-stamp--preview'
  const stampTxt = it.inBuild ? escapeHtml(it.slot) : `${escapeHtml(it.slot)} · preview only`
  const stamp = `<div class="${stampCls}"><span class="bc-tier" aria-hidden="true">${it.inBuild ? '●' : '○'}</span> ${stampTxt}</div>`
  return (
    `<div class="itc-card itc-card--featured itc-r-${rarityKey(it.rarity)}" style="${tierVars(it.rarity)}" role="group" aria-label="${escapeHtml(it.slot)}: ${escapeHtml(it.name)}">` +
    `<div class="itc-header"><span class="itc-name">${escapeHtml(it.name)}</span>${base}</div>` +
    `<div class="itc-body">${reqs}${sep}${mods}${runeNames}</div>${stamp}</div>`
  )
}
/** A muted placeholder card for a canonical slot the build leaves empty. */
function emptyTooltip(label: string): string {
  return (
    `<div class="itc-card itc-card--empty" role="group" aria-label="${escapeHtml(label)} slot: empty">` +
    `<div class="itc-header"><span class="itc-name">${escapeHtml(label)}</span></div>` +
    `<div class="itc-body itc-empty-body">No item equipped</div>` +
    `<div class="itc-stamp">Empty</div></div>`
  )
}
/** One category section: a header + a responsive grid of its #311 tooltips. */
function gearSection(label: string, items: SummaryItem[]): string {
  if (!items.length) return ''
  return `<section class="bc-gear-sec">${colHead(label, items.length)}<div class="bc-gear-grid">${items
    .map(itemTooltip)
    .join('')}</div></section>`
}
/** The gear gallery: each category shows its canonical slots (empty if unequipped),
 *  plus any extras (swaps/charms); tree jewels last. */
function renderGear(s: BuildSummary): string {
  const remaining = [...s.items]
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
        cards.push(itemTooltip(it))
        equipped++
      } else {
        cards.push(emptyTooltip(label))
      }
    }
    // extra equipped items in this category (weapon swaps, charms) — appended, no empty placeholders
    for (const it of remaining.filter((x) => g.match(x.slot.toLowerCase()))) {
      remaining.splice(remaining.indexOf(it), 1)
      cards.push(itemTooltip(it))
      equipped++
    }
    sections.push(`<section class="bc-gear-sec">${colHead(g.label, equipped)}<div class="bc-gear-grid">${cards.join('')}</div></section>`)
  }
  if (remaining.length) sections.push(gearSection('Other gear', remaining)) // anything unmatched
  sections.push(gearSection('Tree jewels', s.jewels))
  return sections.filter(Boolean).join('')
}
function renderContents(s: BuildSummary): void {
  // character identity line + main skill
  const id: string[] = []
  if (s.className) id.push(`<span class="bc-cls">${escapeHtml(s.className)}</span>`)
  if (s.ascendancy) id.push(`<span class="bc-asc">${escapeHtml(s.ascendancy)}</span>`)
  if (s.level != null) id.push(`<span class="bc-lv">Lv ${s.level}</span>`)
  els.bcChar.innerHTML =
    `<div class="bc-id">${id.join('<i class="bc-sep" aria-hidden="true"></i>')}</div>` +
    (s.mainSkill ? `<div class="bc-main"><span>Main skill</span><b>${escapeHtml(s.mainSkill)}</b></div>` : '')

  // GEAR — every equipped item as a #311 tooltip, laid out in the in-game paper-doll positions
  els.bcGear.innerHTML = s.items.length || s.jewels.length ? renderGear(s) : '<p class="bc-empty">No items equipped.</p>'

  // SKILLS — one row per socket group (main gem + level + its supports); main group flagged
  let skills = colHead('Skills', s.skills.length) + '<ul class="bc-list">'
  for (const g of s.skills) {
    const sup = g.supports.length ? `<span class="bc-sub">${g.supports.map(escapeHtml).join(' · ')}</span>` : ''
    const q = g.quality > 0 ? ` · Q${g.quality}` : ''
    skills += `<li class="bc-row bc-skill"><div class="bc-line"><span class="bc-name">${MK_IN}${escapeHtml(g.main)}${
      g.isMain ? '<i class="bc-tag">main</i>' : ''
    }</span><span class="bc-lvl">${MK_PREV}Lv ${g.level}${q}</span></div>${sup}</li>`
  }
  skills += '</ul>'
  els.bcSkills.innerHTML = skills

  // PERKS — named keystones (gold) + ascendancy notables + tree notables; masteries + total in the footer
  let perks = colHead('Perks', s.keystones.length + s.ascNotables.length + s.notables.length)
  const blocks = perkList('Keystones', s.keystones, 'bc-key') + perkList('Ascendancy', s.ascNotables) + perkList('Notables', s.notables)
  perks += blocks || '<p class="bc-empty">No notable passives allocated.</p>'
  const pfoot: string[] = []
  if (s.masteries.length) pfoot.push(`${s.masteries.length} master${s.masteries.length > 1 ? 'ies' : 'y'}`)
  pfoot.push(`${s.passiveCount} passives allocated`)
  perks += `<p class="bc-foot">${pfoot.join(' · ')}</p>`
  els.bcPerks.innerHTML = perks
}

// ── boot ─────────────────────────────────────────────────────────────────────
const c = provenance.counts
els.provenance.textContent =
  `Lookup data captured ${provenance.captured} — ${c.passiveNodes} passives, ${c.gems} gems, ${c.uniques} uniques. ` +
  `Passive ids from GGG's poe2-skilltree-export; gem/unique names from the repoe-fork PoE2 datamine.`
setMode('paste')
setStatus('idle', 'Idle')

// ── marble shader background — toggle-able + persisted (default ON) ───────────
const bg = mountMarble(els.bg)
const BG_KEY = 'poe2-bg'
function setBg(on: boolean): void {
  els.bg.hidden = !on
  if (on) bg?.start()
  else bg?.stop()
  els.bgToggle.classList.toggle('on', on)
  els.bgToggle.setAttribute('aria-pressed', String(on))
  try {
    localStorage.setItem(BG_KEY, on ? 'on' : 'off')
  } catch {
    /* localStorage blocked (private mode / file://) — ignore */
  }
}
let bgPref: string | null = null
try {
  bgPref = localStorage.getItem(BG_KEY)
} catch {
  /* ignore */
}
setBg(bgPref !== 'off') // default ON; remembers the user's choice
els.bgToggle.addEventListener('click', () => setBg(els.bg.hidden))
