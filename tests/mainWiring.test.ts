// Complements tests/ui.test.ts: it boots the REAL index.html body + main.ts in jsdom (identical
// harness) and drives the wiring ui.test.ts leaves cold — the theme + marble toggles, the genesis /
// emotions / faq routes and hash-driven routing, the segmented input control + file upload, the
// Clear/Reset flow, Copy, per-field invalidation, step Back/Next + keyboard, variant reorder/remove/
// select edits, a multi-file download, and the tree-loadout dropdown sync. Assertions target
// paths NOT already exercised by ui.test.ts (no duplicate coverage).

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { copy } from '../src/copy'
import { SAMPLE_XML, LOADOUTS_XML, byId as $, mountIndexBody } from './helpers/bootHarness'

/** Click one of the input-mode segmented-control buttons (paste | upload | watch). */
function clickMode(m: 'paste' | 'upload' | 'watch'): void {
  document.querySelector<HTMLButtonElement>(`#seg button[data-mode="${m}"]`)!.click()
}

/** Land on the Convert route + paste mode, paste a build, and press Convert (synchronous pipeline). */
function convertSample(xml: string = SAMPLE_XML): void {
  ;($('nav-convert') as HTMLButtonElement).click()
  clickMode('paste')
  const code = $<HTMLTextAreaElement>('code')
  code.value = xml
  ;($('convert') as HTMLButtonElement).click()
}

/** Convert the sample build, open the Variants step, add a second row, and return live row/name accessors. */
function openVariantsAndAddRow(): { rows: () => NodeListOf<HTMLElement>; names: () => string[] } {
  convertSample()
  ;(document.querySelectorAll('#stepper .sx-step')[3] as HTMLElement).click() // Variants step
  const rows = (): NodeListOf<HTMLElement> => document.querySelectorAll<HTMLElement>('#var-rows .var-row')
  const names = (): string[] =>
    [...document.querySelectorAll<HTMLInputElement>('#var-rows .var-name')].map((n) => n.value)
  ;($('var-add') as HTMLButtonElement).click() // → 2 rows
  return { rows, names }
}

describe('main.ts wiring — toggles, routing, input, variants (gaps beyond ui.test.ts)', () => {
  beforeAll(async () => {
    mountIndexBody()
    // No share hash: boot lands on the default Convert route.
    const main = await import('../src/main')
    await main.enginePrefetch // convert engine is code-split + prefetched — wait until it's ready
    // jsdom lacks the object-URL statics the download path uses
    URL.createObjectURL ??= () => 'blob:mock'
    URL.revokeObjectURL ??= () => {}
  })

  // ── theme toggle (dark ⇄ light) ──────────────────────────────────────────────
  it('the theme toggle flips the html theme-light class, aria-pressed, and fires poe2:themechange', () => {
    const btn = $<HTMLButtonElement>('theme-toggle')
    const html = document.documentElement
    let themeChanges = 0
    const onChange = (): void => void themeChanges++
    window.addEventListener('poe2:themechange', onChange)
    try {
      // precondition: booted dark (no theme-light class, not pressed)
      expect(html.classList.contains('theme-light')).toBe(false)
      expect(btn.getAttribute('aria-pressed')).toBe('false')

      btn.click() // → light
      expect(html.classList.contains('theme-light')).toBe(true)
      expect(btn.classList.contains('on')).toBe(true)
      expect(btn.getAttribute('aria-pressed')).toBe('true')
      expect(localStorage.getItem('poe2-theme')).toBe('light')
      expect(themeChanges).toBe(1) // mounted Canvas2D trees re-read their palette on this event

      btn.click() // → back to dark (leave the app as booted for later tests)
      expect(html.classList.contains('theme-light')).toBe(false)
      expect(btn.getAttribute('aria-pressed')).toBe('false')
      expect(localStorage.getItem('poe2-theme')).toBe('dark')
      expect(themeChanges).toBe(2)
    } finally {
      window.removeEventListener('poe2:themechange', onChange)
    }
  })

  // ── marble background toggle (persisted, lazy) ───────────────────────────────
  it('the background toggle turns the wallpaper off then on, updating aria-pressed + the persisted pref', async () => {
    const btn = $<HTMLButtonElement>('bg-toggle')
    const canvas = $<HTMLCanvasElement>('bg')
    // precondition: booted ON (default; localStorage had no 'off' pref)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.classList.contains('on')).toBe(true)

    btn.click() // → OFF: fades out (bg-on removed now), unmounts from the compositor after ~650ms
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(btn.classList.contains('on')).toBe(false)
    expect(localStorage.getItem('poe2-bg')).toBe('off')
    expect(canvas.classList.contains('bg-on')).toBe(false)
    await vi.waitFor(() => expect(canvas.hidden).toBe(true), { timeout: 2000 })

    btn.click() // → ON again: restores the canvas to the compositor (memoised marble module)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('poe2-bg')).toBe('on')
    await vi.waitFor(() => expect(canvas.hidden).toBe(false), { timeout: 2000 })
  })

  // ── top-nav routing to the routes ui.test.ts never opens ─────────────────────
  it('the FAQ tab shows its route, selects the tab, and mirrors #faq into the URL', () => {
    ;($('nav-faq') as HTMLButtonElement).click()
    expect($('route-faq').hidden).toBe(false)
    expect($('route-convert').hidden).toBe(true)
    expect($('nav-faq').getAttribute('aria-selected')).toBe('true')
    expect(location.hash).toBe('#faq') // showRoute pushes the bare route hash
  })

  it('the Genesis tab lazily mounts its planning tree', async () => {
    ;($('nav-genesis') as HTMLButtonElement).click()
    expect($('route-genesis').hidden).toBe(false)
    expect($('nav-genesis').getAttribute('aria-selected')).toBe('true')
    await vi.waitFor(() => expect(document.querySelector('#genesis-mount .tree-view')).not.toBeNull(), {
      timeout: 4000,
    })
  })

  it('the Emotions tab lazily mounts its reference panel', async () => {
    ;($('nav-emotions') as HTMLButtonElement).click()
    expect($('route-emotions').hidden).toBe(false)
    await vi.waitFor(() => expect($('emotions-mount').innerHTML.length).toBeGreaterThan(0), { timeout: 4000 })
  })

  it('hashchange re-drives the router: a bare #faq opens FAQ, an unknown hash falls back to Convert', () => {
    location.hash = '#faq'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect($('route-faq').hidden).toBe(false)

    location.hash = '#totally-unknown-route'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect($('route-convert').hidden).toBe(false) // routeFromHash() → null → convert fallback
  })

  it('popstate re-drives the router from the current hash', () => {
    location.hash = '#emotions'
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect($('route-emotions').hidden).toBe(false)

    location.hash = ''
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect($('route-convert').hidden).toBe(false) // empty hash → convert
  })

  // ── segmented input-mode control ─────────────────────────────────────────────
  it('the segmented control switches the Paste/Upload panes and their aria state', () => {
    ;($('nav-convert') as HTMLButtonElement).click()
    clickMode('upload')
    const upBtn = document.querySelector<HTMLButtonElement>('#seg button[data-mode="upload"]')!
    expect($('pane-upload').hidden).toBe(false)
    expect($('pane-paste').hidden).toBe(true)
    expect(upBtn.classList.contains('on')).toBe(true)
    expect(upBtn.getAttribute('aria-selected')).toBe('true')

    clickMode('paste')
    expect($('pane-paste').hidden).toBe(false)
    expect($('pane-upload').hidden).toBe(true)
  })

  // ── file upload: drag classes, drop, and the hidden <input> ──────────────────
  it('drag hover toggles the .over class, and a dropped .xml drives the breakdown in upload mode', async () => {
    ;($('nav-convert') as HTMLButtonElement).click()
    clickMode('upload')
    const dz = $<HTMLButtonElement>('dz')

    dz.dispatchEvent(new Event('dragenter'))
    expect(dz.classList.contains('over')).toBe(true)
    dz.dispatchEvent(new Event('dragleave'))
    expect(dz.classList.contains('over')).toBe(false)

    const drop = new Event('drop', { bubbles: true }) as Event & { dataTransfer: unknown }
    drop.dataTransfer = { files: [new File([SAMPLE_XML], 'dropped.xml', { type: 'text/xml' })] }
    dz.dispatchEvent(drop)

    await vi.waitFor(() => expect(dz.classList.contains('done')).toBe(true), { timeout: 2000 })
    expect($('dz-txt').textContent).toContain('dropped.xml')
    // upload mode → updateContents() parsed the dropped build → the breakdown populated
    await vi.waitFor(() => expect($('bc-char').innerHTML.length).toBeGreaterThan(0), { timeout: 2000 })
    clickMode('paste')
  })

  it('a file chosen through the hidden <input> is accepted the same way', async () => {
    ;($('nav-convert') as HTMLButtonElement).click()
    clickMode('upload')
    const dz = $<HTMLButtonElement>('dz')
    dz.click() // exercises the dz→file.click() proxy (jsdom no-ops the picker)
    const fileInput = $<HTMLInputElement>('file')
    Object.defineProperty(fileInput, 'files', {
      value: [new File([SAMPLE_XML], 'picked.xml', { type: 'text/xml' })],
      configurable: true,
    })
    fileInput.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect($('dz-txt').textContent).toContain('picked.xml'), { timeout: 2000 })
    clickMode('paste')
  })

  // ── Copy JSON ────────────────────────────────────────────────────────────────
  it('Copy JSON writes the emitted .build to the clipboard and flips the label to Copied!', async () => {
    convertSample()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const copyBtn = $<HTMLButtonElement>('copy')
    copyBtn.click()
    await vi.waitFor(() => expect(copyBtn.textContent).toBe(copy.convert.copied), { timeout: 2000 })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(String(writeText.mock.calls[0]![0])).toContain('Monk1')
  })

  it('Copy JSON shows "Copy failed" when the clipboard write rejects', async () => {
    convertSample()
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const copyBtn = $<HTMLButtonElement>('copy')
    copyBtn.click()
    await vi.waitFor(() => expect(copyBtn.textContent).toBe(copy.convert.copyFailed), { timeout: 2000 })
  })

  // ── metadata edit invalidates a prior conversion ─────────────────────────────
  it('editing a metadata field after converting invalidates the result (download re-disabled, JSON cleared)', () => {
    convertSample()
    const dl = $<HTMLButtonElement>('download')
    expect(dl.disabled).toBe(false)

    const name = $<HTMLInputElement>('name')
    name.value = 'Renamed by test'
    name.dispatchEvent(new Event('input', { bubbles: true }))

    expect(dl.disabled).toBe(true)
    expect($('status').dataset.state).toBe('idle')
    expect($('json').textContent).toContain(copy.convert.jsonPlaceholder)
    name.value = '' // restore for later tests
  })

  // ── full reset (Clear + Convert-step Reset) ──────────────────────────────────
  it('Clear wipes the input and returns to the Import step', () => {
    convertSample()
    expect($('status').dataset.state).toBe('done')
    ;($('clear') as HTMLButtonElement).click()
    expect($<HTMLTextAreaElement>('code').value).toBe('')
    expect($('status').dataset.state).toBe('idle')
    expect($<HTMLButtonElement>('download').disabled).toBe(true)
    const steps = [...document.querySelectorAll('#stepper .sx-step')]
    expect(steps[0]!.getAttribute('data-state')).toBe('current') // back on Import
    expect($('dz-txt').textContent).toBe(copy.convert.dzReset) // upload drop-zone label reset
  })

  it('the Convert-step Reset button also starts over', () => {
    convertSample()
    ;($('convert-reset') as HTMLButtonElement).click()
    expect($<HTMLTextAreaElement>('code').value).toBe('')
    expect($('status').dataset.state).toBe('idle')
  })

  // ── step Back/Next buttons + keyboard activation ─────────────────────────────
  it('Back/Next buttons and Enter/Space keyboard activate the unlocked steps', () => {
    convertSample() // lands on Convert (step 4, the last)
    const steps = (): Element[] => [...document.querySelectorAll('#stepper .sx-step')]
    const next = $<HTMLButtonElement>('step-next')
    const back = $<HTMLButtonElement>('step-back')

    expect(next.hidden).toBe(true) // no Next on the last step
    expect(back.disabled).toBe(false)
    back.click() // → step 3
    expect(steps()[3]!.getAttribute('data-state')).toBe('current')
    expect(next.hidden).toBe(false) // Next reappears off the last step
    next.click() // → step 4
    expect(steps()[4]!.getAttribute('data-state')).toBe('current')

    // keyboard: Enter on step 1 navigates there; Space on step 2 as well
    steps()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(steps()[1]!.getAttribute('data-state')).toBe('current')
    steps()[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(steps()[2]!.getAttribute('data-state')).toBe('current')
  })

  // ── Variants step: reorder + remove ──────────────────────────────────────────
  it('variant rows add, rename, reorder, and remove down to one', () => {
    const { rows, names } = openVariantsAndAddRow()
    expect(rows().length).toBe(2)

    const n0 = rows()[0]!.querySelector<HTMLInputElement>('.var-name')!
    const n1 = rows()[1]!.querySelector<HTMLInputElement>('.var-name')!
    n0.value = 'Alpha'
    n0.dispatchEvent(new Event('input', { bubbles: true }))
    n1.value = 'Beta'
    n1.dispatchEvent(new Event('input', { bubbles: true }))
    expect(names()).toEqual(['Alpha', 'Beta'])

    // move the 2nd row up (re-renders the rows in the new order)
    rows()[1]!.querySelector<HTMLButtonElement>('.var-up')!.click()
    expect(names()).toEqual(['Beta', 'Alpha'])

    // remove the first row (Beta) → back to a single Alpha row
    rows()[0]!.querySelector<HTMLButtonElement>('.var-remove')!.click()
    expect(rows().length).toBe(1)
    expect(names()).toEqual(['Alpha'])
  })

  // ── Variants step: selector edits rewrite the row's preview from the new selection ──
  // Uses the 2-loadout fixture so every <select> has a real alternative to switch to — the
  // single-loadout SAMPLE_XML has one option each, which can only ever re-render the same value.
  it('a variant row selector edit rewrites its preview from the newly-selected tree/skills/gear', () => {
    convertSample(LOADOUTS_XML)
    ;(document.querySelectorAll('#stepper .sx-step')[3] as HTMLElement).click() // Variants step
    const row0 = (): HTMLElement => document.querySelector<HTMLElement>('#var-rows .var-row')!
    const preview = (): string => row0().querySelector('.var-preview')!.textContent ?? ''

    // tree spec (3 vs 1 node), skill set, and item set each toggle to their OTHER option; every
    // change must move the preview, proving the handler reads the new value (not a fixed re-render).
    for (const cls of ['.var-tree', '.var-skills', '.var-gear'] as const) {
      const select = row0().querySelector<HTMLSelectElement>(cls)!
      const other = [...select.options].find((o) => o.value !== select.value)
      expect(other).toBeDefined()
      const before = preview()
      select.value = other!.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      expect(preview()).not.toBe(before)
    }

    // the preview's skills + gear segments now echo the freshly-selected option labels verbatim
    const seg = preview().split(' · ')
    expect(seg[1]).toBe(row0().querySelector<HTMLSelectElement>('.var-skills')!.selectedOptions[0]!.textContent)
    expect(seg[2]).toBe(row0().querySelector<HTMLSelectElement>('.var-gear')!.selectedOptions[0]!.textContent)
  })

  // ── multi-file download (n>1 branch of the download handler) ──────────────────
  it('a two-variant download adapts the label + notes to the file count', async () => {
    convertSample()
    ;(document.querySelectorAll('#stepper .sx-step')[3] as HTMLElement).click() // Variants
    ;($('var-add') as HTMLButtonElement).click()
    // guarantee both rows carry a name so the download gate opens
    for (const [i, n] of [...document.querySelectorAll<HTMLInputElement>('#var-rows .var-name')].entries()) {
      if (!n.value.trim()) {
        n.value = `Loadout ${i + 1}`
        n.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
    ;(document.querySelectorAll('#stepper .sx-step')[4] as HTMLElement).click() // Convert step
    const dl = $<HTMLButtonElement>('download')
    expect(dl.disabled).toBe(false)
    expect(dl.textContent).toContain('(2)') // "Download all (2)"

    dl.click()
    const note = $('dl-note')
    expect(note.textContent).toContain('Downloading')
    await vi.waitFor(() => expect(note.textContent).toContain('Downloaded'), { timeout: 3000 })
  })

  // ── tree-loadout dropdown (the twin of ui.test's breakdown dropdown, opposite direction) ──
  it('the passive-tree loadout dropdown switches the view and syncs the breakdown dropdown + stats note', () => {
    convertSample(LOADOUTS_XML)
    expect($('tree-loadout-wrap').hidden).toBe(false)
    const treeSel = $<HTMLSelectElement>('tree-loadout')
    const bcSel = $<HTMLSelectElement>('bc-loadout')
    expect($('bc-stats-note').hidden).toBe(true) // default view = main loadout

    treeSel.value = '1'
    treeSel.dispatchEvent(new Event('change', { bubbles: true }))
    expect(bcSel.value).toBe('1') // breakdown dropdown followed the tree dropdown
    expect($('bc-stats-note').hidden).toBe(false) // non-main view → the "stats are for main" note shows
  })

  // ── file upload: acceptFile catch — a File whose .text() rejects ─────────────
  it('a file whose read rejects surfaces the file-read error and never marks the drop-zone done', async () => {
    ;($('nav-convert') as HTMLButtonElement).click()
    clickMode('upload')
    const dz = $<HTMLButtonElement>('dz')
    dz.classList.remove('done')
    const fileInput = $<HTMLInputElement>('file')
    // a File-shaped stub whose text() rejects drives acceptFile's catch (jsdom's real File.text() resolves)
    Object.defineProperty(fileInput, 'files', {
      value: [{ name: 'unreadable.xml', text: () => Promise.reject(new Error('io')) }],
      configurable: true,
    })
    fileInput.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect($('dz-txt').textContent).toBe(copy.convert.fileReadError('unreadable.xml')), {
      timeout: 2000,
    })
    expect(dz.classList.contains('done')).toBe(false) // catch cleared any prior .done
    clickMode('paste')
  })

  // ── Variants step: move a row DOWN (the twin of the var-up test) ─────────────
  it('the var-down button moves a variant row down, swapping it with the next', () => {
    const { rows, names } = openVariantsAndAddRow()
    const n0 = rows()[0]!.querySelector<HTMLInputElement>('.var-name')!
    const n1 = rows()[1]!.querySelector<HTMLInputElement>('.var-name')!
    n0.value = 'First'
    n0.dispatchEvent(new Event('input', { bubbles: true }))
    n1.value = 'Second'
    n1.dispatchEvent(new Event('input', { bubbles: true }))
    expect(names()).toEqual(['First', 'Second'])

    // row 0's ↓ is enabled (only the LAST row's ↓ is disabled); clicking it swaps rows 0↔1
    rows()[0]!.querySelector<HTMLButtonElement>('.var-down')!.click()
    expect(names()).toEqual(['Second', 'First'])
  })

  // ── segmented control: the (unsupported-browser-hidden) Watch button still switches mode ──
  // Covers the m==='watch' dispatch (setMode) and currentInput()'s `mode==='watch'` arm: with an
  // empty watch buffer the preview reads '' — NOT the pasted textarea — so the flow relocks to Import.
  it('switching to Watch mode reads the (empty) watch buffer, relocking past-Import steps', () => {
    convertSample() // pastes SAMPLE_XML, parses, lands on the Convert step (4)
    clickMode('watch')
    expect($('pane-watch').hidden).toBe(false) // setMode('watch') revealed the Watch pane…
    expect($('pane-paste').hidden).toBe(true)
    expect(document.querySelector('#seg button[data-mode="watch"]')!.getAttribute('aria-selected')).toBe('true')
    // currentInput() returned the empty watch buffer (not els.code.value) → no build → back to Import
    expect(document.querySelectorAll('#stepper .sx-step')[0]!.getAttribute('data-state')).toBe('current')
    clickMode('paste') // restore for later tests
  })

  // ── doConvert optional-field spreads: Name/Author/Description reach the emitted JSON ──
  it('the optional Name/Author/Description fields are spread into the converted .build', () => {
    const name = $<HTMLInputElement>('name')
    const author = $<HTMLInputElement>('author')
    const description = $<HTMLTextAreaElement>('description')
    name.value = 'My Build X'
    author.value = 'Author Y'
    description.value = 'Desc Z'
    convertSample() // reads the fields at Convert-click time (values set without 'input' → no reset)
    const json = $('json').textContent ?? ''
    expect(json).toContain('"name": "My Build X"') // 454 — name spread
    expect(json).toContain('"author": "Author Y"') // 455 — author spread
    expect(json).toContain('"description": "Desc Z"') // 457 — description spread
    name.value = '' // restore (later tests expect empty metadata)
    author.value = ''
    description.value = ''
  })

  // ── download handler: the per-variant Author/Description spreads reach every emitted file ──
  it('a two-variant download spreads Author/Description into each downloaded .build', async () => {
    const author = $<HTMLInputElement>('author')
    const description = $<HTMLTextAreaElement>('description')
    author.value = 'DL Author'
    description.value = 'DL Desc'
    convertSample()
    ;(document.querySelectorAll('#stepper .sx-step')[3] as HTMLElement).click() // Variants
    ;($('var-add') as HTMLButtonElement).click() // → 2 auto-named rows
    ;(document.querySelectorAll('#stepper .sx-step')[4] as HTMLElement).click() // Convert step
    const dl = $<HTMLButtonElement>('download')
    expect(dl.disabled).toBe(false)

    // capture the exact JSON string handed to each Blob (robust regardless of jsdom Blob.text support)
    const captured: string[] = []
    const RealBlob = globalThis.Blob
    class CapturingBlob extends RealBlob {
      constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
        super(parts, opts)
        captured.push(String(parts[0]))
      }
    }
    ;(globalThis as unknown as { Blob: typeof Blob }).Blob = CapturingBlob as unknown as typeof Blob
    try {
      dl.click()
      await vi.waitFor(() => expect(captured.length).toBeGreaterThanOrEqual(2), { timeout: 2000 })
    } finally {
      ;(globalThis as unknown as { Blob: typeof Blob }).Blob = RealBlob
    }
    expect(captured.every((j) => j.includes('"author": "DL Author"'))).toBe(true) // 640
    expect(captured.every((j) => j.includes('"description": "DL Desc"'))).toBe(true) // 642
    author.value = ''
    description.value = ''
  })

  // ── stepper keyboard: a non-activation key is ignored (only Enter/Space navigate) ──
  it('an arrow key on a stepper step is ignored — only Enter/Space activate', () => {
    convertSample() // lands on Convert (4); every step unlocked
    const steps = (): Element[] => [...document.querySelectorAll('#stepper .sx-step')]
    expect(steps()[4]!.getAttribute('data-state')).toBe('current')
    expect(steps()[1]!.getAttribute('data-state')).toBe('done')
    steps()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    // the key guard returned early: no navigation happened
    expect(steps()[1]!.getAttribute('data-state')).toBe('done')
    expect(steps()[4]!.getAttribute('data-state')).toBe('current')
  })
})
