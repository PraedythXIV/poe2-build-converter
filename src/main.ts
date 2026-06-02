import './styles.css'
import { convert, DecodeError, ParseError } from './convert/index'
import { provenance } from './convert/lookups'
import type { ConvertResult, Warning } from './convert/types'

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
  provenance: need<HTMLParagraphElement>('provenance'),
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
}
els.seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
  b.addEventListener('click', () => setMode(b.dataset.mode === 'upload' ? 'upload' : 'paste'))
})

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
  setStatus('idle', 'Idle')
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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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

// ── boot ─────────────────────────────────────────────────────────────────────
const c = provenance.counts
els.provenance.textContent =
  `Lookup data captured ${provenance.captured} — ${c.passiveNodes} passives, ${c.gems} gems, ${c.uniques} uniques. ` +
  `Passive ids from GGG's poe2-skilltree-export; gem/unique names from the repoe-fork PoE2 datamine.`
setMode('paste')
setStatus('idle', 'Idle')
