// Complements tests/ui.test.ts: it boots the REAL index.html body + main.ts in jsdom (identical
// harness) and drives the wiring ui.test.ts leaves cold — the theme + marble toggles, the genesis /
// emotions / faq routes and hash-driven routing, the segmented input control + file upload, the
// Clear/Reset flow, Copy, per-field invalidation, step Back/Next + keyboard, variant reorder/remove/
// select edits, a multi-file download, and the tree-loadout dropdown sync. Assertions target
// paths NOT already exercised by ui.test.ts (no duplicate coverage).

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { copy } from '../src/copy'

const ROOT = process.cwd()
const SAMPLE_XML = readFileSync(join(ROOT, 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')
const LOADOUTS_XML = readFileSync(join(ROOT, 'tests', 'fixtures', 'pob-loadouts.xml'), 'utf8')

function bodyInnerHtml(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const inner = m ? m[1]! : html
  return inner.replace(/<script[\s\S]*?<\/script>/gi, '') // we import main.ts manually
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

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

describe('main.ts wiring — toggles, routing, input, variants (gaps beyond ui.test.ts)', () => {
  beforeAll(async () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    document.body.innerHTML = bodyInnerHtml(html)
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

  // ── Variants step: reorder, selector edits, remove ───────────────────────────
  it('variant rows reorder, react to selector changes, and remove down to one', () => {
    convertSample()
    ;(document.querySelectorAll('#stepper .sx-step')[3] as HTMLElement).click() // Variants step
    const rows = (): NodeListOf<HTMLElement> => document.querySelectorAll<HTMLElement>('#var-rows .var-row')
    const names = (): string[] =>
      [...document.querySelectorAll<HTMLInputElement>('#var-rows .var-name')].map((n) => n.value)

    ;($('var-add') as HTMLButtonElement).click() // → 2 rows
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

    // each selector-change branch (tree / skills / gear) refreshes just that row's preview
    for (const sel of ['.var-tree', '.var-skills', '.var-gear'] as const) {
      rows()[0]!
        .querySelector<HTMLSelectElement>(sel)!
        .dispatchEvent(new Event('change', { bubbles: true }))
      expect(rows()[0]!.querySelector('.var-preview')!.textContent).toMatch(/·/)
    }

    // remove the first row (Beta) → back to a single Alpha row
    rows()[0]!.querySelector<HTMLButtonElement>('.var-remove')!.click()
    expect(rows().length).toBe(1)
    expect(names()).toEqual(['Alpha'])
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
})
