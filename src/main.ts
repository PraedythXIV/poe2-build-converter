import './styles.css'
import type { BgHandle } from './bg/marble'
import type { VariantSelection } from './convert/index'
import type { Loadout } from './export/loadouts'
import type { ConvertResult, Warning, PobBuild } from './convert/types'
import type { BuildSummary, SummaryItem, SummaryGem } from './convert/summarize'
import provenanceData from './data/provenance.json'
import type { TreeView } from './tree/index'
import { fetchPobRaw, BffError } from './economy/client'
import { renderNotesPanel } from './ui/notesPanel'
import { renderConfigPanel } from './ui/configPanel'
import { renderPobInspector } from './ui/pobInspectorPanel'
import { humanizeId } from './ui/humanize'
import { escapeHtml } from './ui/escapeHtml'
import { toastHtml } from './ui/toast'
import { fmtBytes } from './ui/format'
import { copy, applyStaticCopy } from './copy'
import { mountBehaviors, tablist } from './vendor/uikit/behaviors.js'
import { computeJewelSockets } from './tree/jewelSockets'
import { ensureClassNameIndex, classIndexForName, renderAscSplash } from './tree/ascSplash'
import { type VariantRow, defaultVariantRow, variantPreview, blankNote, renderVariantRows } from './convert/variantsUi'
import { type GearGalleryDeps, renderGearGallery, wireGearGallery } from './items/gearGallery'
import { wireAtlas } from './atlas/wiring'
import { wireGenesis } from './genesis/wiring'
import { isFileWatchSupported, createFileWatcher, type FileWatcher } from './watch/fileWatch'

// ── lazy convert engine ───────────────────────────────────────────────────────
// The converter + its lookup tables (passives/gems/uniques) and the gear-preview data
// (itemIcons/modTiers) are ~535 KB — the heaviest part of the bundle. They're code-split into ONE
// "engine" chunk that's PREFETCHED right after first paint, so the shell renders instantly and the
// engine is ready before the user finishes pasting. The convert flow stays SYNCHRONOUS: it's guarded
// on `engineReady`, and the prefetch flips it on (then re-renders any input pasted in the meantime).
const provenance = provenanceData as { captured: string; poe2Patch: string; counts: Record<string, number> }

let engineReady = false
let convert!: (typeof import('./convert/index'))['convert']
let defaultBuildMeta!: (typeof import('./convert/index'))['defaultBuildMeta']
let DecodeError!: (typeof import('./convert/index'))['DecodeError']
let ParseError!: (typeof import('./convert/index'))['ParseError']
let decodePobCode!: (typeof import('./convert/decode'))['decodePobCode']
let parsePob!: (typeof import('./convert/parsePob'))['parsePob']
let buildVariantFiles!: (typeof import('./export/builds'))['buildVariantFiles']
let flaggedFilenames!: (typeof import('./export/builds'))['flaggedFilenames']
let safeStem!: (typeof import('./export/builds'))['safeStem']
let computeLoadouts!: (typeof import('./export/loadouts'))['computeLoadouts']
let summarizeBuild!: (typeof import('./convert/summarize'))['summarizeBuild']
let groupSocketables!: (typeof import('./convert/summarize'))['groupSocketables']
let renderStatsPanel!: (typeof import('./ui/statsPanel'))['renderStatsPanel']
let auditBuild!: (typeof import('./audit/audit'))['auditBuild']
let renderAuditPanel!: (typeof import('./ui/auditPanel'))['renderAuditPanel']
let rarityKey!: (typeof import('./ui/rarity'))['rarityKey']
let poeTierVars!: (typeof import('./ui/rarity'))['poeTierVars']
let annotateModLine!: (typeof import('./items/detailsPanel'))['annotateModLine']
let domainForItem!: (typeof import('./items/detailsPanel'))['domainForItem']
let renderItemDetails!: (typeof import('./items/detailsPanel'))['renderItemDetails']
let itemArtHtml!: (typeof import('./items/icons'))['itemArtHtml']

let enginePromise: Promise<void> | null = null
/** Load the convert+preview engine once (memoised) and bind its exports to the names above. */
function ensureEngine(): Promise<void> {
  return (enginePromise ??= (async () => {
    const [ci, dec, pp, eb, el, sm, sp, au, ap, rar, ip, ii] = await Promise.all([
      import('./convert/index'),
      import('./convert/decode'),
      import('./convert/parsePob'),
      import('./export/builds'),
      import('./export/loadouts'),
      import('./convert/summarize'),
      import('./ui/statsPanel'),
      import('./audit/audit'),
      import('./ui/auditPanel'),
      import('./ui/rarity'),
      import('./items/detailsPanel'),
      import('./items/icons'),
    ])
    convert = ci.convert
    defaultBuildMeta = ci.defaultBuildMeta
    DecodeError = ci.DecodeError
    ParseError = ci.ParseError
    decodePobCode = dec.decodePobCode
    parsePob = pp.parsePob
    buildVariantFiles = eb.buildVariantFiles
    flaggedFilenames = eb.flaggedFilenames
    safeStem = eb.safeStem
    computeLoadouts = el.computeLoadouts
    summarizeBuild = sm.summarizeBuild
    groupSocketables = sm.groupSocketables
    renderStatsPanel = sp.renderStatsPanel
    auditBuild = au.auditBuild
    renderAuditPanel = ap.renderAuditPanel
    rarityKey = rar.rarityKey
    poeTierVars = rar.poeTierVars
    annotateModLine = ip.annotateModLine
    domainForItem = ip.domainForItem
    renderItemDetails = ip.renderItemDetails
    itemArtHtml = ii.itemArtHtml
    engineReady = true
  })())
}
// Prefetch immediately so convert is ready by the time the user pastes; on ready, render whatever may
// already be pasted. Exported so the integration test can await readiness deterministically.
export const enginePrefetch = ensureEngine().then(() => {
  if (currentInput().trim()) updateContents()
})

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
  paneWatch: need<HTMLDivElement>('pane-watch'),
  tabWatch: need<HTMLButtonElement>('tab-watch'),
  watchPick: need<HTMLButtonElement>('watch-pick'),
  bcWatch: need<HTMLDivElement>('bc-watch'),
  bcWatchName: need<HTMLElement>('bc-watch-name'),
  bcWatchStop: need<HTMLButtonElement>('bc-watch-stop'),
  bcWatchNote: need<HTMLElement>('bc-watch-note'),
  bcImportNote: need<HTMLParagraphElement>('bc-import-note'),
  code: need<HTMLTextAreaElement>('code'),
  file: need<HTMLInputElement>('file'),
  dz: need<HTMLButtonElement>('dz'),
  dzTxt: need<HTMLSpanElement>('dz-txt'),
  name: need<HTMLInputElement>('name'),
  author: need<HTMLInputElement>('author'),
  description: need<HTMLTextAreaElement>('description'),
  convert: need<HTMLButtonElement>('convert'),
  convertLoader: need<HTMLDivElement>('convert-loader'),
  clear: need<HTMLButtonElement>('clear'),
  convertReset: need<HTMLButtonElement>('convert-reset'),
  status: need<HTMLSpanElement>('status'),
  statusTxt: need<HTMLSpanElement>('status-txt'),
  stats: need<HTMLDivElement>('stats'),
  warnings: need<HTMLDivElement>('warnings'),
  json: need<HTMLPreElement>('json'),
  jsonName: need<HTMLSpanElement>('json-name'),
  jsonSize: need<HTMLSpanElement>('json-size'),
  download: need<HTMLButtonElement>('download'),
  copy: need<HTMLButtonElement>('copy'),
  varAdd: need<HTMLButtonElement>('var-add'),
  varRows: need<HTMLDivElement>('var-rows'),
  varEmpty: need<HTMLParagraphElement>('var-empty'),
  varNote: need<HTMLDivElement>('var-note'),
  dlNote: need<HTMLDivElement>('dl-note'),
  provenance: need<HTMLElement>('provenance'),
  bg: need<HTMLCanvasElement>('bg'),
  bgToggle: need<HTMLButtonElement>('bg-toggle'),
  themeToggle: need<HTMLButtonElement>('theme-toggle'),
  navConvert: need<HTMLButtonElement>('nav-convert'),
  navAtlas: need<HTMLButtonElement>('nav-atlas'),
  navGenesis: need<HTMLButtonElement>('nav-genesis'),
  navEmotions: need<HTMLButtonElement>('nav-emotions'),
  navPrices: need<HTMLButtonElement>('nav-prices'),
  navFaq: need<HTMLButtonElement>('nav-faq'),
  tbUnderline: document.querySelector<HTMLSpanElement>('.tb-underline')!,
  routeConvert: need<HTMLElement>('route-convert'),
  routeAtlas: need<HTMLElement>('route-atlas'),
  routeGenesis: need<HTMLElement>('route-genesis'),
  routeEmotions: need<HTMLElement>('route-emotions'),
  routePrices: need<HTMLElement>('route-prices'),
  routeFaq: need<HTMLElement>('route-faq'),
  stepper: need<HTMLElement>('stepper'),
  stepBack: need<HTMLButtonElement>('step-back'),
  stepNext: need<HTMLButtonElement>('step-next'),
  importNote: need<HTMLDivElement>('import-note'),
  bcChar: need<HTMLDivElement>('bc-char'),
  bcGear: need<HTMLDivElement>('bc-gear'),
  bcSkills: need<HTMLDivElement>('bc-skills'),
  bcPerks: need<HTMLDivElement>('bc-perks'),
  bcStats: need<HTMLDivElement>('bc-stats'),
  bcAudit: need<HTMLDivElement>('bc-audit'),
  bcNotes: need<HTMLDivElement>('bc-notes'),
  bcConfig: need<HTMLDivElement>('bc-config'),
  bcInspector: need<HTMLDivElement>('bc-inspector'),
  bcStatsNote: need<HTMLParagraphElement>('bc-stats-note'),
  bcLoadout: need<HTMLSelectElement>('bc-loadout'),
  bcLoadoutWrap: need<HTMLLabelElement>('bc-loadout-wrap'),
  treeLoadout: need<HTMLSelectElement>('tree-loadout'),
  treeLoadoutWrap: need<HTMLLabelElement>('tree-loadout-wrap'),
  treeToolbar: need<HTMLDivElement>('tree-toolbar'),
  treeLegend: need<HTMLDivElement>('tree-legend'),
  treeMount: need<HTMLDivElement>('tree-mount'),
  ascSplash: need<HTMLDivElement>('asc-splash'),
  treeMissing: need<HTMLParagraphElement>('tree-missing'),
  atlasMount: need<HTMLDivElement>('atlas-mount'),
  atlasCounts: need<HTMLDivElement>('atlas-counts'),
  atlasMastersCounts: need<HTMLDivElement>('atlas-masters-counts'),
  atlasFit: need<HTMLButtonElement>('atlas-fit'),
  atlasReset: need<HTMLButtonElement>('atlas-reset'),
  atlasShare: need<HTMLButtonElement>('atlas-share'),
  atlasBg: need<HTMLInputElement>('atlas-bg'),
  atlasNote: need<HTMLDivElement>('atlas-note'),
  genesisMount: need<HTMLDivElement>('genesis-mount'),
  genesisCounts: need<HTMLDivElement>('genesis-counts'),
  emotionsMount: need<HTMLDivElement>('emotions-mount'),
  genesisFit: need<HTMLButtonElement>('genesis-fit'),
  genesisReset: need<HTMLButtonElement>('genesis-reset'),
  genesisShare: need<HTMLButtonElement>('genesis-share'),
  genesisBg: need<HTMLInputElement>('genesis-bg'),
  genesisNote: need<HTMLDivElement>('genesis-note'),
  econMount: need<HTMLDivElement>('econ-mount'),
}

// Push the editable shell labels (nav, taglines, brand, steps — all in src/copy.ts) into the static
// markup now that the DOM is in hand. copy.ts is the source of truth; the index.html literals are a
// first-paint mirror this overwrites.
applyStaticCopy(document)
// Each route's card title is a styled <div class="card-hd">; expose them as level-2 headings so every
// route reads h1 (sr-only page title) → h2 (card) → h3 (content) with no skipped levels (the axe
// "heading-order" a11y check). Done in JS to cover all cards from one place without 10 markup edits.
for (const hd of document.querySelectorAll('.card-hd')) {
  // Some card-hd bars also hold controls (a button, pickers, a live status pill); role=heading names
  // itself from its contents, so put the role on the title span alone when one exists — otherwise the
  // control text (and its runtime changes) would pollute the heading's accessible name.
  const target = hd.querySelector(':scope > span[data-copy], :scope > span[data-copy-html]') ?? hd
  target.setAttribute('role', 'heading')
  target.setAttribute('aria-level', '2')
}
// Wire the vendored APG behaviors layer over the now-rendered static markup — currently the FAQ
// accordion (the routing-coupled nav / input-mode tablists + the lock/error step-router keep their
// hand-rolled wiring below, which the library's panel-owning tabs/stepper behaviors would break).
mountBehaviors()

type InputMode = 'paste' | 'upload' | 'watch'
let mode: InputMode = 'paste'
let uploaded: { name: string; text: string } | null = null
let watched: { name: string; text: string } | null = null // Bridge 1(a) live file-watch buffer
let last: ConvertResult | null = null

// ── Convert-flow stepper-router ──────────────────────────────────────────────
// The 5 steps map 1:1 to the .step-panel[data-step] wrappers in the Convert route.
// Steps 1-4 stay locked until a valid build parses; after that the user moves freely.
const STEP_TITLES = copy.steps.map((s) => s.label) // single source — edit in src/copy.ts
const stepPanels = Array.from(document.querySelectorAll<HTMLElement>('#route-convert .step-panel'))
let currentStep = 0

// ── parsed-build state ─────────────────────────────────────────────────────────
// The passive tree is a READ-ONLY viewer: it displays the imported PoB tree and never edits it,
// so the parsed build is the single source of truth — there is no edit-override layer.
let pobParsed: PobBuild | null = null
let treeView: TreeView | null = null

// ── input mode (segmented control) ───────────────────────────────────────────
function setMode(next: InputMode): void {
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
  els.paneWatch.hidden = next !== 'watch'
  updateContents()
}
els.seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
  b.addEventListener('click', () => {
    const m = b.dataset.mode
    setMode(m === 'upload' ? 'upload' : m === 'watch' ? 'watch' : 'paste')
  })
})
els.code.addEventListener('input', scheduleContents)

// ── B6 — pobb.in link import: paste a link, the raw code is fetched via the BFF ─
// Accepts https://pobb.in/<id>, https://pobb.in/u/<user>/<id>, and scheme-less forms;
// the whole (trimmed) paste must be the URL so XML that merely mentions pobb.in never
// triggers a fetch.
const POBBIN_RE = /^(?:https?:\/\/)?pobb\.in\/(?:u\/[A-Za-z0-9_-]+\/)?([A-Za-z0-9_-]{4,})\/?$/
const POBBIN_DEBOUNCE_MS = 350
let pobbinTimer: number | undefined
let pobbinBusy = false // re-entry guard: replacing the textarea value re-triggers 'input'
// Source of the current textarea content when it came from a pobb.in import — emitted as the
// .build root `link` (v1 spec, 2026-07-04). `raw` is compared against currentInput() at convert
// time, so ANY edit / upload / watch content silently drops the claim (no stale source URLs).
let pobbinSource: { url: string; raw: string } | null = null

function pobbinId(value: string): string | null {
  const m = POBBIN_RE.exec(value.trim())
  return m ? m[1]! : null
}

/** One toast in the Import step's own feedback area (separate from the Convert step's warnings). */
function importNote(level: 'info' | 'warn', message: string): void {
  els.importNote.innerHTML = toastHtml(level, level === 'warn' ? copy.toast.warn : copy.toast.note, message)
}

async function importFromPobbin(id: string): Promise<void> {
  const snapshot = els.code.value // compare before replacing — the user may edit mid-fetch
  pobbinBusy = true
  importNote('info', copy.imp.pobbinFetching(id))
  try {
    const raw = await fetchPobRaw(id)
    if (els.code.value !== snapshot) return // user moved on — never clobber their input
    els.code.value = raw
    // store the value AS THE TEXTAREA HOLDS IT (it normalizes CRLF→LF) so the convert-time
    // currentInput() comparison in pobbinLink() is exact
    pobbinSource = { url: `https://pobb.in/${id}`, raw: els.code.value }
    importNote('info', copy.imp.pobbinLoaded(id))
    updateContents() // programmatic value write fires no 'input' — refresh the preview now
  } catch (err) {
    const detail =
      err instanceof BffError
        ? err.message // unreachable already says: run "npm run serve:bff" against localhost
        : copy.convert.pobbinUnexpected
    importNote('warn', copy.imp.pobbinFailed(id, detail))
  } finally {
    pobbinBusy = false
  }
}

els.code.addEventListener('input', () => {
  if (pobbinBusy) return
  clearTimeout(pobbinTimer)
  const id = pobbinId(els.code.value)
  if (!id) return
  pobbinTimer = window.setTimeout(() => {
    if (pobbinId(els.code.value) === id) void importFromPobbin(id) // still the same link?
  }, POBBIN_DEBOUNCE_MS)
})

// ── file upload + drag/drop ──────────────────────────────────────────────────
async function acceptFile(file: File): Promise<void> {
  try {
    const text = await file.text()
    uploaded = { name: file.name, text }
    els.dz.classList.add('done')
    els.dzTxt.textContent = copy.imp.loaded(file.name, fmtBytes(text.length))
  } catch {
    uploaded = null
    els.dz.classList.remove('done')
    els.dzTxt.textContent = copy.convert.fileReadError(file.name)
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

// ── Bridge 1(a) — live PoB file-watch (Chromium only; design: _workbench/Docs/bridge1-live-pob-file-watch.md) ─
// Pick a PoB2 build .xml once; saving in PoB re-reads + re-imports it. Read-only, nothing leaves the
// browser. Gated on isFileWatchSupported() so unsupported browsers never see the Watch segment and
// keep the 2-segment paste/upload control.
let watcher: FileWatcher | null = null
// The watch status lives in ONE persistent banner (#bc-watch) that sits under the stepper, so it shows
// on EVERY step of the Convert flow while a file is watched. The pick button stays in the Watch pane.
function showWatching(name: string | null): void {
  els.bcWatch.hidden = name === null
  if (name) els.bcWatchName.textContent = name
}
function watchNote(level: 'info' | 'warn', msg: string): void {
  els.bcWatchNote.textContent = msg
  // recolour the banner by state: green while live, amber on a read problem
  els.bcWatch.classList.toggle('bn--warning', level === 'warn')
  els.bcWatch.classList.toggle('bn--success', level !== 'warn')
}
function stopWatch(): void {
  watcher?.stop()
  showWatching(null) // keep the last imported build converted; just stop the live updates
  els.bcWatchNote.textContent = ''
  els.bcWatch.classList.remove('bn--warning')
  els.bcWatch.classList.add('bn--success')
}
function resetWatch(): void {
  watched = null
  stopWatch()
}
if (isFileWatchSupported()) {
  els.tabWatch.hidden = false
  els.seg.style.setProperty('--n', '3') // reveal the 3rd segment; thumb width tracks --n
  watcher = createFileWatcher({
    onChange: (text, name) => {
      watched = { name, text }
      // filename is shown by the pill — don't repeat it. Only claim "re-imported" when the watch
      // input mode is actually active; in paste/upload mode the preview still shows that input.
      watchNote('info', mode === 'watch' ? copy.watch.reimported : copy.watch.savedNotShown)
      updateContents()
    },
    onError: () => watchNote('warn', copy.watch.readError),
  })
  els.watchPick.addEventListener('click', () => {
    void (async () => {
      const picked = await watcher!.pick()
      if (!picked) return // user cancelled the OS picker
      watched = picked
      showWatching(picked.name)
      setMode('watch') // auto-switch to Watch on pick (design D3); setMode runs updateContents()
      if (pobParsed) {
        watchNote('info', copy.watch.editAndSave)
        goToStep(1) // jump to the breakdown so the imported build is immediately visible
      } else {
        // a non-build file (e.g. an empty PoB stub) parses to nothing — say so instead of looking dead
        watchNote('warn', copy.watch.noBuildYet)
      }
    })()
  })
  els.bcWatchStop.addEventListener('click', () => stopWatch())
}

// ── convert ──────────────────────────────────────────────────────────────────
function currentInput(): string {
  if (mode === 'upload') return uploaded?.text ?? ''
  if (mode === 'watch') return watched?.text ?? ''
  return els.code.value
}

/** The .build `link` value: the pobb.in source URL, ONLY while the text being converted is still
 *  exactly the fetched raw — mode-agnostic by construction (an upload/watch/edited paste never
 *  matches), so no clearing bookkeeping is needed. (Refactor while green: extracted VERBATIM from
 *  the identical expressions in doConvert and the download handler.) */
function pobbinLink(): string | undefined {
  return pobbinSource && currentInput() === pobbinSource.raw ? pobbinSource.url : undefined
}

function setStatus(state: 'idle' | 'done' | 'error', text: string): void {
  els.status.dataset.state = state
  els.statusTxt.textContent = text
}

let refreshingAfterConvert = false
function doConvert(refreshContents: boolean): void {
  if (!engineReady) return // engine still loading (prefetch in flight) — near-instant in practice
  const name = els.name.value.trim()
  const author = els.author.value.trim()
  const description = els.description.value.trim()
  const link = pobbinLink()
  try {
    last = convert(currentInput(), {
      ...(name ? { name } : {}),
      ...(author ? { author } : {}),
      ...(link ? { link } : {}),
      ...(description ? { description } : {}),
    })
    renderResult(last)
    if (refreshContents) {
      // re-sync the breakdown/variants/download with the new result. Suppress the input-changed
      // result-reset so it can't wipe the `last` we just built; finally-scoped so a throw inside
      // updateContents can't leave the flag stuck on (which would dead-disable the reset forever).
      refreshingAfterConvert = true
      try {
        updateContents()
      } finally {
        refreshingAfterConvert = false
      }
    }
    setStatus('done', copy.status.converted)
  } catch (err) {
    last = null
    const msg =
      err instanceof DecodeError || err instanceof ParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : copy.convert.unknownError
    renderError(msg)
    setStatus('error', copy.status.error)
    renderStepper()
  }
}
const CONVERT_LOADER_MS = 480
let convertLoaderTimer: number | undefined
// The Convert step's primary action: convert NOW (synchronous, so the result + `last` are ready
// immediately), then show a brief loader OVERLAY on the freshly-rendered result — the requested
// visual feedback for an otherwise-instant op (data isn't deferred, so tests/automation stay sync).
els.convert.addEventListener('click', () => {
  doConvert(true)
  if (!last) return // conversion failed — renderError already shown; no loader
  goToStep(4) // ensure we're on the Convert step showing the result (a no-op when already there)
  els.convertLoader.hidden = false
  clearTimeout(convertLoaderTimer)
  convertLoaderTimer = window.setTimeout(() => (els.convertLoader.hidden = true), CONVERT_LOADER_MS)
})

/** A changed import invalidates the prior conversion — clear `last` + reset the Convert step's output
 *  (JSON/stats/warnings/download) so the user re-converts with the new build. */
function resetConvertResult(): void {
  last = null
  clearTimeout(convertLoaderTimer)
  els.convertLoader.hidden = true
  els.json.innerHTML = `<span class="muted">${copy.convert.jsonPlaceholder}</span>`
  els.stats.hidden = true
  els.stats.innerHTML = ''
  els.warnings.innerHTML = ''
  els.jsonName.textContent = copy.convert.defaultFilename
  els.jsonSize.textContent = ''
  els.download.disabled = true
  els.copy.disabled = true
  setStatus('idle', copy.status.idle)
}

// Editing a metadata field after a conversion invalidates it, so the preview + downloaded files can't
// silently diverge from what the fields now say — the user re-clicks Convert to apply the change.
for (const field of [els.name, els.author, els.description]) {
  field.addEventListener('input', () => {
    if (last) resetConvertResult()
  })
}

// FULL RESET — clears the pasted/uploaded input, the optional fields, the parsed build, the JSON
// output, the variant set + loadout views, then returns to the Import step. Shared by the Import
// "Clear" button and the Convert step's "Reset" button (both are a "start over").
function resetAll(): void {
  els.code.value = ''
  els.name.value = ''
  els.author.value = ''
  els.description.value = ''
  uploaded = null
  els.file.value = ''
  els.dz.classList.remove('done')
  els.dzTxt.textContent = copy.convert.dzReset
  resetWatch() // stop any live file-watch + clear its buffer
  els.importNote.innerHTML = ''
  els.ascSplash.hidden = true
  els.ascSplash.innerHTML = ''
  resetConvertResult() // last=null + JSON/stats/warnings/download/loader/status reset
  variants = []
  variantsInput = ''
  els.varRows.innerHTML = ''
  els.varNote.innerHTML = ''
  els.dlNote.innerHTML = ''
  viewLoadouts = []
  viewIdx = 0
  els.bcLoadoutWrap.hidden = true
  els.treeLoadoutWrap.hidden = true
  els.bcStatsNote.hidden = true
  setStatus('idle', copy.status.idle)
  goToStep(0) // back to Import (also re-renders the stepper + nav)
}
els.clear.addEventListener('click', resetAll)
els.convertReset.addEventListener('click', resetAll)

// ── render ───────────────────────────────────────────────────────────────────
function renderResult(r: ConvertResult): void {
  // stats
  const s = r.stats
  const stats: Array<[string, string]> = [
    [copy.breakdown.statClass, s.ascendancy ? `${s.className ?? '?'} · ${s.ascendancy}` : (s.className ?? '?')],
    [copy.breakdown.statLevel, s.level != null ? String(s.level) : '?'],
    [copy.breakdown.statPassives, `${s.passiveCount}${s.passivesSkipped ? ` (−${s.passivesSkipped})` : ''}`],
    [copy.breakdown.statSkills, copy.breakdown.statSkillsValue(s.skillCount, s.supportCount)],
    [copy.breakdown.statItems, `${s.itemCount}${s.itemsSkipped ? ` (−${s.itemsSkipped})` : ''}`],
    [copy.breakdown.statTree, s.treeVersion],
  ]
  els.stats.innerHTML = stats
    .map(([k, v]) => `<span class="stat">${escapeHtml(k)} <b>${escapeHtml(v)}</b></span>`)
    .join('')
  els.stats.hidden = false

  renderWarnings(r.warnings)

  els.json.innerHTML = highlightJson(r.json)
  const filename = `${safeStem(r.build.name)}.build`
  els.jsonName.textContent = filename
  els.jsonSize.textContent = fmtBytes(r.json.length)
  els.copy.disabled = false
  updateDownloadButton() // download exports the variant rows (1 or N), gated on names
}

function renderError(message: string): void {
  els.stats.hidden = true
  els.stats.innerHTML = ''
  renderWarnings([{ level: 'error', code: 'convert-failed', message }])
  els.json.innerHTML = `<span class="muted">${copy.conv.noOutput}</span>`
  els.jsonSize.textContent = ''
  els.download.disabled = true
  els.copy.disabled = true
}

function renderWarnings(warnings: Warning[]): void {
  const title = (lvl: Warning['level']) =>
    lvl === 'error' ? copy.toast.error : lvl === 'warn' ? copy.toast.warn : copy.toast.note
  els.warnings.innerHTML = warnings.map((w) => toastHtml(w.level, title(w.level), w.message)).join('')
}

// ── download / copy ──────────────────────────────────────────────────────────
let dlNoteTimer: number | undefined // pending "Downloading → Downloaded" note flip (reset per click)

/** Trigger a browser download of one text file (Blob → objURL → <a download> → revoke). */
function downloadFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Enable + label the Convert-step download for the current variant set (1 file, or N). */
function updateDownloadButton(): void {
  const n = variants.length
  els.download.disabled = !last || !pobParsed || n === 0 || variantsHaveBlank()
  els.download.textContent = n > 1 ? copy.convert.downloadAll(n) : copy.convert.downloadOne
}

// One download button, adaptive: exports one `.build` per variant row (just one for a single-loadout
// PoB), straight to the user's Downloads folder. The Variants step is where the set is corrected.
els.download.addEventListener('click', () => {
  const pob = pobParsed
  if (!engineReady || !pob || !last || variants.length === 0 || variantsHaveBlank()) return
  const built = last.build
  const author = els.author.value.trim()
  const description = els.description.value.trim()
  const link = pobbinLink() // the shared source URL — same value for every variant file
  const single = variants.length === 1
  const sels: VariantSelection[] = variants.map((r) => ({
    specIndex: r.specIndex,
    skillSetId: r.skillSetId,
    itemSetId: r.itemSetId,
    // single-loadout: the downloaded file mirrors the previewed build name (= the Convert-step Name
    // field); multi-loadout: each file keeps its own per-row name from the Variants step.
    name: single ? built.name : r.name,
    ...(author ? { author } : {}),
    ...(link ? { link } : {}),
    ...(description ? { description } : {}),
  }))
  const files = buildVariantFiles(pob, sels)
  // sequential + slightly staggered so the browser doesn't drop rapid back-to-back downloads
  files.forEach((f, i) => setTimeout(() => downloadFile(f.filename, f.json), i * 150))
  const n = files.length
  const flagged = flaggedFilenames(files)
  const warnLine = flagged.length
    ? toastHtml('warn', copy.conv.flaggedTitle(flagged.length), copy.conv.flaggedBody(flagged.join(', ')))
    : ''
  els.dlNote.innerHTML = toastHtml('info', copy.conv.downloadingTitle(n), copy.conv.downloadingBody) + warnLine
  // No browser API reports download completion — flip the note to its saved state once the LAST
  // staggered handoff ((n-1)*150ms) is safely past, instead of reading "Downloading" forever.
  // The flagged-variants warning (if any) must survive the flip.
  clearTimeout(dlNoteTimer)
  dlNoteTimer = window.setTimeout(
    () => {
      els.dlNote.innerHTML = toastHtml('good', copy.conv.downloadedTitle(n), copy.conv.downloadedBody(n)) + warnLine
    },
    (n - 1) * 150 + 400,
  )
})

let copyTimer: number | undefined
els.copy.addEventListener('click', async () => {
  if (!last) return
  const ok = await copyText(last.json)
  els.copy.textContent = ok ? copy.convert.copied : copy.convert.copyFailed
  // clear any pending reset so rapid clicks don't snap the label back early
  clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => (els.copy.textContent = copy.convert.copyJson), 1400)
})

async function copyText(text: string): Promise<boolean> {
  // navigator.clipboard covers every secure context the app actually runs in (https + localhost; the
  // build is http-served, never file://). The old execCommand textarea fallback only mattered for
  // file:// and is deprecated, so it's gone. Returns false if the clipboard is unavailable/denied.
  try {
    if (!navigator.clipboard?.writeText) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// ── Variants step (multi-`.build` export) ────────────────────────────────────
// One PoB can hold several loadouts. Each row = one .build: a (tree spec, skill set, item set)
// tuple + a name. The user maps them, then downloads them all at once (N files to Downloads).
let variants: VariantRow[] = []
let variantSeq = 0
let variantsInput = '' // the import the current variants were seeded from (reset when it changes)

/** A blank row name can't produce a valid filename, so it gates the download until fixed. */
function variantsHaveBlank(): boolean {
  return variants.some((r) => r.name.trim().length === 0)
}

function renderVariants(): void {
  const pob = pobParsed
  if (!pob) {
    els.varRows.innerHTML = ''
    els.varEmpty.hidden = false
    els.varNote.innerHTML = ''
    updateDownloadButton()
    return
  }
  els.varRows.innerHTML = renderVariantRows(pob, variants)
  els.varEmpty.hidden = variants.length > 0
  els.varNote.innerHTML = variantsHaveBlank() ? blankNote : ''
  updateDownloadButton() // the download lives in the Convert step; keep it in sync
}

/**
 * Seed the rows the first time the step is shown for a given import. Auto-seed from the build's
 * loadouts (faithful PoB `SyncLoadouts` — one row per loadout PoB itself shows); if the build has
 * no resolvable loadouts, fall back to a single row for the active loadout. Auto-seed only PRE-FILLS
 * — the user reviews / renames / adds / removes before exporting.
 */
function ensureVariantsSeeded(): void {
  if (!pobParsed || variants.length > 0) return
  const loadouts = computeLoadouts(pobParsed)
  variants =
    loadouts.length > 0
      ? loadouts.map((l) => ({
          id: ++variantSeq,
          name: l.name,
          specIndex: l.specIndex,
          skillSetId: l.skillSetId,
          itemSetId: l.itemSetId,
        }))
      : [defaultVariantRow(pobParsed, ++variantSeq)]
}

function rowIndexFromEvent(e: Event): number {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.var-row')
  if (!el) return -1
  return variants.findIndex((r) => r.id === Number(el.dataset.id))
}

els.varAdd.addEventListener('click', () => {
  if (!pobParsed) return
  variants = [...variants, defaultVariantRow(pobParsed, ++variantSeq)]
  renderVariants()
})

// row name typing — update state + the download gate WITHOUT a full re-render (keeps input focus)
els.varRows.addEventListener('input', (e) => {
  const i = rowIndexFromEvent(e)
  if (i < 0) return
  const t = e.target as HTMLElement
  if (!t.classList.contains('var-name')) return
  variants[i]!.name = (t as HTMLInputElement).value
  const blank = variants[i]!.name.trim().length === 0
  ;(t.closest('.var-row') as HTMLElement).classList.toggle('var-row--blank', blank)
  els.varNote.innerHTML = variantsHaveBlank() ? blankNote : ''
  updateDownloadButton()
})

// selector change — update state + just this row's preview
els.varRows.addEventListener('change', (e) => {
  const i = rowIndexFromEvent(e)
  if (i < 0) return
  const t = e.target as HTMLElement
  if (t.classList.contains('var-tree')) variants[i]!.specIndex = Number((t as HTMLSelectElement).value)
  else if (t.classList.contains('var-skills')) variants[i]!.skillSetId = (t as HTMLSelectElement).value
  else if (t.classList.contains('var-gear')) variants[i]!.itemSetId = (t as HTMLSelectElement).value
  else return
  const prev = (t.closest('.var-row') as HTMLElement).querySelector('.var-preview')
  if (prev && pobParsed) prev.textContent = variantPreview(pobParsed, variants[i]!)
})

// remove / reorder
els.varRows.addEventListener('click', (e) => {
  const i = rowIndexFromEvent(e)
  if (i < 0) return
  const t = e.target as HTMLElement
  if (t.classList.contains('var-remove')) variants = variants.filter((_, idx) => idx !== i)
  else if (t.classList.contains('var-up') && i > 0) [variants[i - 1], variants[i]] = [variants[i]!, variants[i - 1]!]
  else if (t.classList.contains('var-down') && i < variants.length - 1)
    [variants[i + 1], variants[i]] = [variants[i]!, variants[i + 1]!]
  else return
  renderVariants()
})

// ── formatting helpers ───────────────────────────────────────────────────────
function highlightJson(json: string): string {
  // Match structure on the RAW JSON (the regex needs literal `"` delimiters), then escape each token
  // before wrapping it — escaping first would turn `"` into `&quot;` and the string/key branch would
  // never match. Unmatched structural text (braces, brackets, colons, commas, whitespace) is HTML-safe.
  return json.replace(
    /("(?:\\.|[^"\\])*"\s*:?)|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g,
    (m, str: string | undefined, bool: string | undefined, numb: string | undefined) => {
      if (str !== undefined) return `<span class="${/:\s*$/.test(str) ? 'k' : 's'}">${escapeHtml(str)}</span>`
      if (bool !== undefined) return `<span class="b">${escapeHtml(m)}</span>`
      if (numb !== undefined) return `<span class="n">${escapeHtml(m)}</span>`
      return escapeHtml(m) // unreachable (alternation always captures one group); escaped for safety
    },
  )
}

// ── build contents preview (live, debounced) ─────────────────────────────────
let contentsTimer: number | undefined
function scheduleContents(): void {
  clearTimeout(contentsTimer)
  contentsTimer = window.setTimeout(updateContents, 250)
}

// The last decode/parse failure, kept so the live preview can SHOW the tailored message
// (PoB1 code / not base64 / inflate failed / bad XML) instead of dead-ending silently.
// importErrorShown tracks that WE put the current note there, so clearing it never clobbers
// the pobb.in flow's own import notes.
let lastParseError: string | null = null
let importErrorShown = false
function parseSafe(input: string): PobBuild | null {
  lastParseError = null
  if (!input || !input.trim()) return null
  try {
    return parsePob(decodePobCode(input))
  } catch (e) {
    lastParseError = e instanceof Error ? e.message : String(e)
    return null
  }
}

// `view` = the loadout being browsed (gear / skills / perks / char follow it). `main` = the active
// loadout — stats + the stats-derived audit ALWAYS show the main loadout, because PoB only exports
// the active loadout's numbers (defaults to `view` for the common single-loadout case).
function renderPanels(view: BuildSummary, main: BuildSummary = view): void {
  renderContents(view)
  els.bcStats.innerHTML = renderStatsPanel(main.playerStats, pobParsed?.fullDpsSkills ?? [])
  els.bcAudit.innerHTML = renderAuditPanel(auditBuild(main))
}

// ── loadout view selector (Verify breakdown + Passive tree) ───────────────────
// A shared dropdown to BROWSE each of the PoB's loadouts. Switching it re-renders the breakdown
// (gear/skills/jewels) and the passive tree for that loadout; stats stay on the main loadout.
let viewLoadouts: Loadout[] = []
let viewIdx = 0

/** Index in `viewLoadouts` of the loadout whose tuple equals the PoB's active one (else 0). */
function activeLoadoutIdx(): number {
  if (!pobParsed) return 0
  const i = viewLoadouts.findIndex(
    (l) =>
      l.specIndex === pobParsed!.activeSpecIndex &&
      l.skillSetId === (pobParsed!.activeSkillSetId ?? '') &&
      l.itemSetId === (pobParsed!.activeItemSetId ?? ''),
  )
  return i >= 0 ? i : 0
}

/** The build to DISPLAY in the breakdown + tree — the selected loadout's tuple, or the active build. */
function currentViewPob(): PobBuild | null {
  if (!pobParsed) return null
  const l = viewLoadouts[viewIdx]
  if (!l || viewLoadouts.length <= 1) return pobParsed
  const spec = pobParsed.specs[l.specIndex] ?? pobParsed.spec
  const skillGroups = pobParsed.skillSets.find((s) => s.id === l.skillSetId)?.groups ?? pobParsed.skillGroups
  const slots = pobParsed.itemSets.find((s) => s.id === l.itemSetId)?.slots ?? pobParsed.slots
  return { ...pobParsed, spec, skillGroups, slots }
}

/** Populate + show/hide both loadout dropdowns and the "stats are for the main loadout" note. */
function renderLoadoutSelectors(): void {
  const show = viewLoadouts.length > 1
  const opts = viewLoadouts
    .map((l, i) => `<option value="${i}"${i === viewIdx ? ' selected' : ''}>${escapeHtml(l.name)}</option>`)
    .join('')
  for (const sel of [els.bcLoadout, els.treeLoadout]) {
    sel.innerHTML = opts
    sel.value = String(viewIdx)
  }
  els.bcLoadoutWrap.hidden = !show
  els.treeLoadoutWrap.hidden = !show
  const nonMain = show && viewIdx !== activeLoadoutIdx()
  els.bcStatsNote.hidden = !nonMain
  if (nonMain) {
    els.bcStatsNote.textContent = copy.loadout.statsNote(viewLoadouts[viewIdx]!.name)
  }
}

/** Render the breakdown + tree for the current view; stats/audit stay on the main loadout. */
function renderForView(): void {
  const view = currentViewPob()
  if (!view || !pobParsed) return
  const viewS = summarizeBuild(view)
  const mainS = viewLoadouts.length <= 1 || viewIdx === activeLoadoutIdx() ? viewS : summarizeBuild(pobParsed)
  renderPanels(viewS, mainS)
  // build-level read-only context (same across loadout views) — from the parsed build, not the summary
  els.bcNotes.innerHTML = renderNotesPanel(pobParsed.notes)
  els.bcConfig.innerHTML = renderConfigPanel(pobParsed)
  els.bcInspector.innerHTML = renderPobInspector(pobParsed)
  void syncTree(view)
}

function onLoadoutChange(idx: number): void {
  if (idx === viewIdx || idx < 0 || idx >= viewLoadouts.length) return
  viewIdx = idx
  renderForView()
  renderLoadoutSelectors()
}
els.bcLoadout.addEventListener('change', () => onLoadoutChange(Number(els.bcLoadout.value)))
els.treeLoadout.addEventListener('change', () => onLoadoutChange(Number(els.treeLoadout.value)))

function updateContents(): void {
  if (!engineReady) return // convert engine still loading; the prefetch re-runs this once ready
  const input = currentInput()
  // variants belong to the import they were mapped on — a changed import starts a fresh slate
  // (the Variants step re-seeds one row from the new build's active loadout when next shown).
  const inputChanged = input !== variantsInput
  if (inputChanged) {
    variants = []
    variantsInput = input
    // a genuine import change invalidates the prior conversion — but NOT doConvert's own refresh,
    // which just produced `last` (see refreshingAfterConvert).
    if (!refreshingAfterConvert) resetConvertResult()
  }
  pobParsed = parseSafe(input)
  const pob = pobParsed
  if (!pob) {
    // a non-empty paste that failed to decode/parse gets its tailored message on the Import note —
    // silently dead-ending was the old behavior. Empty input just clears any prior error. A pobb.in
    // link is unparseable BY DESIGN (the fetch flow owns it and writes its own notes) — never flag it.
    const showError = Boolean(input.trim() && lastParseError && !pobbinId(input))
    if (showError) importNote('warn', lastParseError!)
    else if (importErrorShown) els.importNote.innerHTML = ''
    importErrorShown = showError
    // no valid build → relock everything past Import; snap back if the user is beyond it
    if (currentStep > 0) goToStep(0)
    else {
      renderStepper()
      updateStepNav()
    }
    return
  }
  // input parses now — drop OUR error note (never clobber the pobb.in flow's own notes)
  if (importErrorShown) {
    els.importNote.innerHTML = ''
    importErrorShown = false
  }
  // loadouts drive the browse dropdown; a new import resets the view to the main loadout, otherwise
  // keep the current selection (clamped) so flipping between steps doesn't jump it back.
  viewLoadouts = computeLoadouts(pob)
  viewIdx = inputChanged ? activeLoadoutIdx() : Math.min(viewIdx, Math.max(0, viewLoadouts.length - 1))
  renderForView()
  renderLoadoutSelectors()
  ensureVariantsSeeded() // seed variant rows now so they exist for both the Variants + Convert steps
  renderVariants()
  updateDownloadButton()
  renderStepper()
  updateStepNav()
}

// ── passive tree (B1) — read-only full-fidelity viewer of the imported tree ───────
// The tree module + treeGraph.json (~1.7 MB) + the render-atlas descriptors are code-split: they
// download on the first convert that reaches here, NOT in the initial bundle. syncTree is therefore
// async, and renderForView fires it off — the breakdown/stats render synchronously, the tree canvas
// mounts a tick later.
async function syncTree(pob: PobBuild): Promise<void> {
  const [{ mountTree, renderTreeToolbar, wireTreeToolbar }, { loadGraph, listClasses }] = await Promise.all([
    import('./tree/index'),
    import('./tree/graph'),
  ])
  // class-name → index map, built once from the tree export the first time the tree loads
  ensureClassNameIndex(listClasses())
  // visibility is the step-router's job now (the tree lives in step-panel 2); just mount/update
  if (!treeView) {
    treeView = mountTree(els.treeMount, { viewerOnly: true, centralArt: true, ariaLabel: copy.tree.canvasAria })
    els.treeToolbar.innerHTML = renderTreeToolbar()
    wireTreeToolbar(els.treeToolbar, treeView)
    // the ascendancy splash is ART: it follows the toolbar's Background-art checkbox (delegated on
    // the toolbar host — the fragment is re-queried live, so this survives toolbar re-renders)
    els.treeToolbar.addEventListener('change', (ev) => {
      if ((ev.target as HTMLElement).classList?.contains('ttb-bg-input'))
        els.ascSplash.hidden = !splashAvailable || !treeArtOn()
    })
  }
  treeView.setBuild({
    allocated: pob.spec.nodes,
    ascendancyId: pob.spec.ascendancyInternalId,
    // class is inferred from the ascendancy or the allocated frontier (import has no explicit index)
    classIndex: null,
    // weapon-set tinting follows the spec's per-set node lists, exactly as imported (read-only)
    weaponSet1: pob.spec.weaponSet1,
    weaponSet2: pob.spec.weaponSet2,
    jewels: computeJewelSockets(pob),
    attributeChoices: pob.spec.attributeChoices,
  })
  const missing = treeView.getMissing()
  els.treeMissing.hidden = missing.length === 0
  if (missing.length > 0) {
    els.treeMissing.textContent = copy.treeMissing(missing.length, missing.length > 1 ? 's' : '')
  }

  // Weapon-set legend: only meaningful when the build allocates nodes specific to ONE set
  // (a node in both sets is shared and never tinted). Hidden for builds without weapon swap.
  const ws1 = new Set(pob.spec.weaponSet1)
  const ws2 = new Set(pob.spec.weaponSet2)
  const hasSetSpecific = [...ws1].some((id) => !ws2.has(id)) || [...ws2].some((id) => !ws1.has(id))
  els.treeLegend.hidden = !hasSetSpecific

  // Phase 6 splash: read the RESOLVED ascendancy back from the view (setBuild validates it), then
  // pick a class index — an ascendancy fixes its own class, else fall back to the build's className.
  const graph = loadGraph()
  const ascendancyId = treeView.getAscendancyId()
  const classIndex = ascendancyId
    ? (graph.ascendancies.get(ascendancyId)?.classIdx ?? null)
    : classIndexForName(pob.className)
  const splash = renderAscSplash(pob.className, ascendancyId, classIndex, graph)
  splashAvailable = !splash.hidden
  // hidden when there is no splash content OR the toolbar's Background-art checkbox is unticked
  // (reading the live checkbox also honours the persisted art-off pref on the first render)
  els.ascSplash.hidden = splash.hidden || !treeArtOn()
  els.ascSplash.innerHTML = splash.html
}

/** Whether the tree toolbar's Background-art checkbox is ticked (default on when absent). */
function treeArtOn(): boolean {
  return els.treeToolbar.querySelector<HTMLInputElement>('.ttb-bg-input')?.checked ?? true
}
let splashAvailable = false // the last render produced splash content (class/asc art or quote)

// ── stepper-router (Import → Verify breakdown → Passive tree → Convert → Download) ──
// `currentStep` is the active panel; steps 1-4 unlock once a valid build parses, after
// which the user moves freely (click a step, or Back/Next). renderStepper paints the
// progress; goToStep performs the navigation + per-step side effects.
const STEP_COUNT = STEP_TITLES.length

/** Highest reachable step: only Import (0) until a valid build exists, then all of them. */
function stepUnlockMax(): number {
  return pobParsed ? STEP_COUNT - 1 : 0
}

function renderStepper(): void {
  const max = stepUnlockMax()
  const errored = els.status.dataset.state === 'error'
  els.stepper.querySelectorAll<HTMLLIElement>('.sx-step').forEach((li, i) => {
    li.classList.remove('sx-step--err')
    let state: 'done' | 'current' | 'upcoming'
    if (i === currentStep) state = 'current'
    else if (i < currentStep) state = 'done'
    else state = 'upcoming'
    if (errored && i === 4) li.classList.add('sx-step--err') // a failed Convert flags its own step (now step 4)
    li.dataset.state = state
    if (state === 'current') li.setAttribute('aria-current', 'step')
    else li.removeAttribute('aria-current')
    // lock + interactivity: unlocked steps behave as buttons; locked ones are inert
    const locked = i > max
    li.classList.toggle('sx-step--locked', locked)
    if (locked) {
      li.removeAttribute('tabindex')
      li.removeAttribute('role')
      li.setAttribute('aria-disabled', 'true')
    } else {
      li.tabIndex = 0
      li.setAttribute('role', 'button')
      li.removeAttribute('aria-disabled')
    }
  })
}

/** Show one step's panel, run its on-enter side effects, refresh the stepper + Back/Next. */
function goToStep(target: number): void {
  const max = stepUnlockMax()
  const i = Math.max(0, Math.min(target, max))
  currentStep = i
  stepPanels.forEach((panel) => {
    panel.hidden = Number(panel.dataset.step) !== i
  })
  if (i === 2 && treeView) requestAnimationFrame(() => treeView?.fit()) // refit once the panel has size
  if (i === 3) {
    ensureVariantsSeeded() // seed rows from the build's loadouts on first visit
    renderVariants()
  }
  if (i === 4) {
    setConvertPlaceholders() // surface the auto-generated name/author/description as field placeholders
    updateDownloadButton() // Convert step owns the download — refresh its gate/label
  }
  renderStepper()
  updateStepNav()
}

/** Show the auto-generated build metadata as placeholders so the user sees what blank fields produce. */
function setConvertPlaceholders(): void {
  if (!pobParsed || !engineReady) return
  const d = defaultBuildMeta(pobParsed)
  els.name.placeholder = d.name
  els.author.placeholder = d.author
  els.description.placeholder = d.description
}

function updateStepNav(): void {
  const max = stepUnlockMax()
  els.stepBack.hidden = currentStep === 0
  els.stepBack.disabled = currentStep === 0
  const isLast = currentStep === STEP_COUNT - 1
  els.stepNext.hidden = isLast
  els.stepNext.disabled = currentStep >= max
  if (!isLast) {
    const next = currentStep + 1
    // keep the nav INTO the Convert step purely navigational ("Next →"), not "Convert →" — the Convert
    // ACTION is now the primary button on the Convert step itself, so a "Convert →" nav would confuse.
    els.stepNext.textContent = next === STEP_COUNT - 1 ? copy.stepper.next : copy.stepper.nextTo(STEP_TITLES[next]!)
  }
}

els.stepBack.addEventListener('click', () => goToStep(currentStep - 1))
els.stepNext.addEventListener('click', () => goToStep(currentStep + 1))

/** Index of the .sx-step an event landed on, or -1. */
function stepIndexFromEvent(e: Event): number {
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('.sx-step')
  if (!li) return -1
  return Array.from(els.stepper.querySelectorAll('.sx-step')).indexOf(li)
}
els.stepper.addEventListener('click', (e) => {
  const i = stepIndexFromEvent(e)
  if (i >= 0 && i <= stepUnlockMax()) goToStep(i)
})
els.stepper.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const i = stepIndexFromEvent(e)
  if (i >= 0 && i <= stepUnlockMax()) {
    e.preventDefault()
    goToStep(i)
  }
})
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
const MK_IN = `<span class="bc-tier" title="${copy.breakdown.inBuildTitle}" aria-hidden="true">●</span> `
const MK_PREV = `<span class="bc-tier" title="${copy.breakdown.previewTitle}" aria-hidden="true">○</span> `

// ── gear gallery + #311 item tooltips ────────────────────────────────────────
// The gallery markup + the item-details overlay live in items/gearGallery.ts (pure renderer +
// self-contained wiring); main.ts owns the price/engine state they read through a deps object.
/** Items rendered as cards this pass, indexed by their data-di attribute — the click
 *  delegation on #bc-gear resolves a card back to its SummaryItem through this list.
 *  Replaced on every gallery render (renderGearGallery returns the matching list). */
let detailItems: SummaryItem[] = []

/** Bundle the (lazy-bound) engine functions + shared helpers the gear gallery needs. Built per render
 *  so it always reads the CURRENT engine bindings (assigned in ensureEngine). */
function gearGalleryDeps(): GearGalleryDeps {
  return { domainForItem, annotateModLine, groupSocketables, rarityKey, poeTierVars, itemArtHtml, colHead }
}

// the #bc-gear click/keydown delegation that opens the item-details overlay — wired once at boot.
wireGearGallery(els.bcGear, { getDetailItems: () => detailItems, renderItemDetails: (item) => renderItemDetails(item) })

function renderContents(s: BuildSummary): void {
  // character identity line + main skill
  const id: string[] = []
  if (s.className) id.push(`<span class="bc-cls">${escapeHtml(s.className)}</span>`)
  if (s.ascendancy) id.push(`<span class="bc-asc">${escapeHtml(s.ascendancy)}</span>`)
  if (s.level != null) id.push(`<span class="bc-lv">${copy.breakdown.level(s.level)}</span>`)
  els.bcChar.innerHTML =
    `<div class="bc-id">${id.join('<i class="bc-sep" aria-hidden="true"></i>')}</div>` +
    (s.mainSkill
      ? `<div class="bc-main"><span>${copy.breakdown.mainSkillLabel}</span><b>${escapeHtml(s.mainSkill)}</b></div>`
      : '')

  // GEAR — every equipped item as a #311 tooltip, laid out in the in-game paper-doll positions.
  // renderGearGallery returns the markup + the matching data-di list (re-rendering replaces every card,
  // so the index space restarts each pass — store the fresh list for #bc-gear's click delegation).
  const gallery = renderGearGallery(s, gearGalleryDeps())
  detailItems = gallery.detailItems
  els.bcGear.innerHTML = gallery.html

  // SKILLS — one row per socket group (main gem + level + its supports); main group flagged.
  // The level chip renders only when a level is stated (g.level > 0); PoB exports always
  // state one (parsePob defaults absent to 1, PoB's own semantic).
  // Compact PoB detail markers beside a gem (only when present, so normal gems stay clean).
  const gemMarkers = (gem: SummaryGem): string => {
    let m = ''
    if (gem.count > 1) m += ` <span class="bc-gm" title="${copy.breakdown.gemCopies(gem.count)}">×${gem.count}</span>`
    if (gem.corrupted)
      m += ` <span class="bc-gm bc-gm--corrupt" title="${copy.breakdown.gemCorrupt}">${copy.breakdown.gemCorruptLabel}</span>`
    if (gem.minion) {
      // PoB's skillMinion is a camelCase id ("BearCompanion") that IS the minion's name; space it for
      // reading (shared humanizeId), keep the raw id in the title.
      m += ` <span class="bc-gm bc-gm--minion" title="${copy.breakdown.gemMinionTitle(escapeHtml(gem.minion))}">↣ ${escapeHtml(humanizeId(gem.minion))}</span>`
    }
    return m
  }
  let skills = colHead(copy.breakdown.sectionSkills, s.skills.length) + '<ul class="bc-list">'
  for (const g of s.skills) {
    const head = g.gems[0]
    const supGems = g.gems.slice(1)
    const sup = supGems.length
      ? `<span class="bc-sub">${supGems.map((sg) => escapeHtml(sg.name) + gemMarkers(sg)).join(' · ')}</span>`
      : ''
    const q = g.quality > 0 ? copy.breakdown.skillQuality(g.quality) : ''
    const lvl = g.level > 0 ? `<span class="bc-lvl">${MK_PREV}${copy.breakdown.level(g.level)}${q}</span>` : ''
    skills += `<li class="bc-row bc-skill"><div class="bc-line"><span class="bc-name">${MK_IN}${escapeHtml(g.main)}${
      head ? gemMarkers(head) : ''
    }${g.isMain ? `<i class="bc-tag">${copy.breakdown.skillMain}</i>` : ''}</span>${lvl}</div>${sup}</li>`
  }
  skills += '</ul>'
  els.bcSkills.innerHTML = skills

  // PERKS — named keystones (gold) + ascendancy notables + tree notables; masteries + total in the footer
  let perks = colHead(copy.breakdown.sectionPerks, s.keystones.length + s.ascNotables.length + s.notables.length)
  const blocks =
    perkList(copy.breakdown.subKeystones, s.keystones, 'bc-key') +
    perkList(copy.breakdown.subAscendancy, s.ascNotables) +
    perkList(copy.breakdown.subNotables, s.notables)
  perks += blocks || `<p class="bc-empty">${copy.breakdown.noNotables}</p>`
  const pfoot: string[] = []
  if (s.masteries.length) pfoot.push(copy.breakdown.masteries(s.masteries.length, s.masteries.length > 1 ? 'ies' : 'y'))
  pfoot.push(copy.breakdown.passivesAllocated(s.passiveCount))
  perks += `<p class="bc-foot">${pfoot.join(' · ')}</p>`
  els.bcPerks.innerHTML = perks
}

// ── boot ─────────────────────────────────────────────────────────────────────
els.provenance.textContent = copy.provenance(provenance.captured, provenance.poe2Patch)
setMode('paste')
setStatus('idle', copy.status.idle)

// ── top-level routing — 6 destinations (Convert flow / Atlas / Genesis / Emotions / Prices / FAQ) ──
// Routes are display-toggled, never detached: every els.* host must stay in the DOM at all times (they're
// resolved eagerly at load). The active route is mirrored in the URL as a bare hash ('#prices') so tabs are
// deep-linkable and the Back button steps through them; this coexists with the '#atlas=<payload>' share
// links — both name their route in the hash's pre-'=' segment, and showRoute() never clobbers a payload.
type Route = 'convert' | 'atlas' | 'genesis' | 'emotions' | 'prices' | 'faq'
const routeNodes: Record<Route, { route: HTMLElement; tab: HTMLButtonElement }> = {
  convert: { route: els.routeConvert, tab: els.navConvert },
  atlas: { route: els.routeAtlas, tab: els.navAtlas },
  genesis: { route: els.routeGenesis, tab: els.navGenesis },
  emotions: { route: els.routeEmotions, tab: els.navEmotions },
  prices: { route: els.routePrices, tab: els.navPrices },
  faq: { route: els.routeFaq, tab: els.navFaq },
}
let currentRoute: Route = 'convert'

let underlineRaf = 0
/** Slide the tab underline to the active destination (measured from the live tab box). */
function moveNavUnderline(): void {
  // Defer the layout read to the next frame, coalescing bursts. moveNavUnderline() is called straight after
  // showRoute()'s write loop flips .hidden/.on on every tab (and on every resize event), so reading
  // offsetWidth/offsetLeft synchronously here forces the browser to re-layout mid-script (a "forced reflow").
  // rAF lets layout settle once, then we measure; the underline's CSS transition hides the one-frame defer.
  if (underlineRaf) cancelAnimationFrame(underlineRaf)
  underlineRaf = requestAnimationFrame(() => {
    underlineRaf = 0
    const { tab } = routeNodes[currentRoute]
    // composited transform ONLY: translateX slides, scaleX sizes off the 100px CSS base (read the live
    // layout box so the divisor never desyncs from the stylesheet). No width set → no layout animation.
    const base = els.tbUnderline.offsetWidth || 100
    els.tbUnderline.style.transform = `translateX(${tab.offsetLeft}px) scaleX(${tab.offsetWidth / base})`
  })
}

/** The route a URL hash points at — both bare ('#atlas') and share links ('#atlas=…') name it pre-'='. */
function routeFromHash(): Route | null {
  const base = location.hash.replace(/^#/, '').split('=')[0] ?? ''
  return base in routeNodes ? (base as Route) : null
}

function showRoute(route: Route, opts: { syncHash?: boolean } = {}): void {
  currentRoute = route
  for (const r of Object.keys(routeNodes) as Route[]) {
    const { route: node, tab } = routeNodes[r]
    const active = r === route
    node.hidden = !active
    tab.classList.toggle('on', active)
    tab.setAttribute('aria-selected', String(active))
  }
  moveNavUnderline()
  // the tree canvases measure their host at mount — only mount/fit once their route is visible
  if (route === 'atlas') void ensureAtlas().then((v) => v.fit())
  if (route === 'genesis') void ensureGenesis().then((v) => v.fit())
  if (route === 'emotions') void ensureEmotions()
  if (route === 'prices') void ensureEconomy()
  // Mirror the route into the URL (deep-link + Back support). pushState adds the history entry without
  // firing hashchange (no re-entrancy); skip it for hash-driven calls (popstate/boot) and never overwrite
  // a share payload already in the hash for this same route ('#atlas=…' stays put when Atlas is shown).
  if (opts.syncHash !== false && (location.hash.replace(/^#/, '').split('=')[0] ?? '') !== route) {
    history.pushState(null, '', `#${route}`)
  }
}

for (const [route, { tab }] of Object.entries(routeNodes) as [Route, (typeof routeNodes)[Route]][]) {
  tab.addEventListener('click', () => showRoute(route))
}
// Back/forward and manual address-bar hash edits re-drive the router (an empty/unknown hash → convert).
window.addEventListener('popstate', () => showRoute(routeFromHash() ?? 'convert', { syncHash: false }))
window.addEventListener('hashchange', () => showRoute(routeFromHash() ?? 'convert', { syncHash: false }))
window.addEventListener('resize', moveNavUnderline)
window.addEventListener('load', moveNavUnderline) // re-measure once web fonts settle tab widths
moveNavUnderline() // initial position (convert is the default route, already visible)

// Complete the WAI-ARIA tab pattern the nav + input-mode controls declare in the markup with the
// vendored uikit `tablist` behavior (this app's original wiring, backported into the library):
// Arrow/Home/End rove focus between the visible tabs and activate them via each tab's own click
// handler, with tabindex roving so only the selected tab sits in the Tab order.
document.querySelectorAll<HTMLElement>('[role="tablist"]').forEach(tablist)

// ── atlas tree (B2) — planning-only editor, mounted when its route is first shown ────
// All atlas state + listeners + the lazy mount live in atlas/wiring.ts; main.ts owns only the entry
// point the router awaits (ensureAtlas). Plans share by '#atlas=' link but never export to a .build.
const { ensureAtlas, loadBootPlan: loadAtlasBootPlan } = wireAtlas({
  els: {
    atlasMount: els.atlasMount,
    atlasCounts: els.atlasCounts,
    atlasMastersCounts: els.atlasMastersCounts,
    atlasFit: els.atlasFit,
    atlasReset: els.atlasReset,
    atlasShare: els.atlasShare,
    atlasBg: els.atlasBg,
    atlasNote: els.atlasNote,
  },
  copyText,
  openAtlasRoute: () => showRoute('atlas'),
})
// Apply a shared '#atlas=' link now that ensureAtlas is in scope for showRoute (the boot path opens
// the Atlas route, which calls ensureAtlas).
loadAtlasBootPlan()

// ── genesis tree — planning-only editor for the 0.5 Breach/Chayula crafting tree ("Brequel") ──
// All genesis state + listeners + the lazy mount live in genesis/wiring.ts (the near-identical twin of
// atlas/wiring.ts); main.ts owns only the entry point the router awaits (ensureGenesis). Plans share by
// '#genesis=' link but never export to a .build.
const { ensureGenesis, loadBootPlan: loadGenesisBootPlan } = wireGenesis({
  els: {
    genesisMount: els.genesisMount,
    genesisCounts: els.genesisCounts,
    genesisFit: els.genesisFit,
    genesisReset: els.genesisReset,
    genesisShare: els.genesisShare,
    genesisBg: els.genesisBg,
    genesisNote: els.genesisNote,
  },
  copyText,
  openGenesisRoute: () => showRoute('genesis'),
})

// Distilled-Emotion reference — static render, mounted (once) when its route is first shown.
// The module (+ its emotions/emotionIcons JSON) is code-split: it only downloads when the
// Emotions tab is first opened, keeping it out of the initial bundle.
let emotionsMounted = false
async function ensureEmotions(): Promise<void> {
  if (emotionsMounted) return
  emotionsMounted = true
  const { mountEmotions } = await import('./emotions/index')
  mountEmotions(els.emotionsMount)
  // the panel renders its own tablists (sub-nav + jewel-type segment) after the boot-time pass
  els.emotionsMount.querySelectorAll<HTMLElement>('[role="tablist"]').forEach(tablist)
}

// Apply a shared '#genesis=' link now that ensureGenesis is in scope for showRoute.
loadGenesisBootPlan()

// A share payload arriving in an ALREADY-OPEN tab (link pasted into the address bar, back/forward
// between two plans) fires hashchange with no reload — the router alone would show the planner with
// its stale state, so re-run the boot loader for a payload we haven't applied yet. The share button
// rewrites the hash via replaceState (no hashchange), so in-progress edits are never clobbered.
let lastAppliedShareHash = /^#(?:atlas|genesis)=/.test(location.hash) ? location.hash : ''
window.addEventListener('hashchange', () => {
  const h = location.hash
  if (!/^#(?:atlas|genesis)=/.test(h) || h === lastAppliedShareHash) return
  lastAppliedShareHash = h
  if (h.startsWith('#atlas=')) loadAtlasBootPlan()
  else loadGenesisBootPlan()
})

// ── economy (B4) — optional, zero network until the user clicks Load prices ──
// The Prices panel is code-split: it mounts when the Prices tab is first opened. (The pobb.in-paste
// client `economy/client` stays eager — it's part of the import path, not this tab.)
let renderEconomyPanel!: (typeof import('./economy/panel'))['renderEconomyPanel']
let wireEconomyPanel!: (typeof import('./economy/panel'))['wireEconomyPanel']
let economyPromise: Promise<void> | null = null
/** Load + mount the Prices panel once (memoised); called when the Prices tab is opened. */
function ensureEconomy(): Promise<void> {
  return (economyPromise ??= import('./economy/panel').then((m) => {
    renderEconomyPanel = m.renderEconomyPanel
    wireEconomyPanel = m.wireEconomyPanel
    els.econMount.innerHTML = renderEconomyPanel()
    wireEconomyPanel(els.econMount)
    // the Browse/Exchange segment is a tablist rendered after the boot-time pass
    els.econMount.querySelectorAll<HTMLElement>('[role="tablist"]').forEach(tablist)
  }))
}

// Deep-link / refresh: a bare '#prices' (etc.) hash opens that route on load (placed after every ensure*
// is defined, since showRoute may call one). A share payload ('#atlas=…') was already routed by the boot
// loaders above (they set currentRoute), so only act when the hash names a different route. syncHash:false
// — the hash is already correct, don't push a duplicate history entry.
{
  const bootRoute = routeFromHash()
  if (bootRoute && bootRoute !== currentRoute) showRoute(bootRoute, { syncHash: false })
  // The <head> data-boot-route gate has done its job (the correct route is already shown via the normal
  // [hidden] state now). Drop the attribute so later tab navigation isn't pinned by the boot CSS override,
  // which force-hides the Convert route for as long as the attribute is present.
  document.documentElement.removeAttribute('data-boot-route')
}

// ── marble shader background — LAZY, fade-in, toggle-able + persisted (default ON) ───────────
// The WebGL wallpaper is code-split: it only downloads when the background is ON, so a user who turns
// it off never pays the chunk or the WebGL cost (on this or any later visit). It fades in once its
// first frame is painted, and fades out — then unmounts from the compositor — when toggled off.
const BG_KEY = 'poe2-bg'
let bg: BgHandle | null = null
let bgLoading: Promise<void> | null = null
let bgOn = false

/** Load + mount the marble module once (memoised); only ever called while the bg is ON. */
function loadMarble(): Promise<void> {
  return (bgLoading ??= import('./bg/marble').then(({ mountMarble }) => {
    bg = mountMarble(els.bg)
  }))
}

function setBg(on: boolean): void {
  bgOn = on
  els.bgToggle.classList.toggle('on', on)
  els.bgToggle.setAttribute('aria-pressed', String(on))
  try {
    localStorage.setItem(BG_KEY, on ? 'on' : 'off')
  } catch {
    /* localStorage blocked (private mode / file://) — ignore */
  }
  if (on) {
    void loadMarble().then(() => {
      if (!bgOn) return // toggled back off while the chunk was loading
      els.bg.hidden = false // restore the canvas to the compositor (still opacity 0)
      bg?.start() // paints the first frame synchronously…
      requestAnimationFrame(() => els.bg.classList.add('bg-on')) // …then fade that frame in
    })
  } else {
    els.bg.classList.remove('bg-on') // fade out
    bg?.stop()
    // once faded, drop it from the compositor (unless it was re-enabled meanwhile)
    window.setTimeout(() => {
      if (!bgOn) els.bg.hidden = true
    }, 650)
  }
}

let bgPref: string | null = null
try {
  bgPref = localStorage.getItem(BG_KEY)
} catch {
  /* ignore */
}
setBg(bgPref !== 'off') // default ON; an OFF preference never loads the WebGL chunk
els.bgToggle.addEventListener('click', () => setBg(!bgOn))

// ── theme: dark (default, Wraeclast gold) ↔ light (frost: white ground, steel chrome, blue marble) ──
// The DOM/CSS chrome recolours itself through the token cascade (html.theme-light flips the ground +
// text + metal ramp). Only the two Canvas2D surfaces need a nudge: the marble re-hues red↔blue via
// recolor(), and any mounted tree re-reads resolvePalette on the poe2:themechange event. The early
// inline script in index.html already applied the saved class before first paint (no FOUC).
const THEME_KEY = 'poe2-theme'
const isLight = (): boolean => document.documentElement.classList.contains('theme-light')
function setTheme(light: boolean): void {
  document.documentElement.classList.toggle('theme-light', light)
  els.themeToggle.classList.toggle('on', light)
  els.themeToggle.setAttribute('aria-pressed', String(light))
  try {
    localStorage.setItem(THEME_KEY, light ? 'light' : 'dark')
  } catch {
    /* storage blocked (private mode / file://) — applies for this session only */
  }
  bg?.recolor() // re-hue the marble (no-op when the wallpaper isn't mounted; it reads on mount)
  window.dispatchEvent(new Event('poe2:themechange')) // mounted Canvas2D trees re-read their palette
}
// sync the button to the class the inline head script may already have applied (don't re-dispatch)
els.themeToggle.classList.toggle('on', isLight())
els.themeToggle.setAttribute('aria-pressed', String(isLight()))
els.themeToggle.addEventListener('click', () => setTheme(!isLight()))
