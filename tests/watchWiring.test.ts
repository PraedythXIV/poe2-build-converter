// New file (from the coverage analysis): boots the REAL index.html body + main.ts in jsdom with
// window.showOpenFilePicker DEFINED before the import (so isFileWatchSupported() → true) plus a
// controllable file handle — exercising the Chromium-only live file-watch wiring jsdom can't otherwise
// reach. The boot hash is a bare '#prices' so the deep-link boot-route branch runs in the same boot.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { copy } from '../src/copy'
import { SAMPLE_XML, byId as $, mountIndexBody } from './helpers/bootHarness'

// ── controllable File System Access stubs (module-level so tests can retarget them) ──
let nextFile: File = new File([SAMPLE_XML], 'build.xml', { type: 'text/xml', lastModified: 1000 })
let getFileMode: 'ok' | 'reject' = 'ok'
const handle = {
  getFile: (): Promise<File> =>
    getFileMode === 'reject' ? Promise.reject(new Error('gone')) : Promise.resolve(nextFile),
}
let pickerResult: unknown[] = [handle]

describe('file-watch wiring (Chromium File System Access) + bare #route deep-link boot', () => {
  beforeAll(async () => {
    // MUST be defined before main.ts evaluates its `if (isFileWatchSupported())` block
    ;(window as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker = () =>
      Promise.resolve(pickerResult)
    mountIndexBody()
    // a bare route hash (NOT a share payload, NOT the default 'convert') → the deep-link boot-route runs
    window.location.hash = '#prices'
    const main = await import('../src/main')
    await main.enginePrefetch
    URL.createObjectURL ??= () => 'blob:mock'
    URL.revokeObjectURL ??= () => {}
  })

  afterAll(() => {
    getFileMode = 'ok'
    $<HTMLButtonElement>('bc-watch-stop').click() // stop the 700ms poll loop so it can't fire post-teardown
  })

  // ── deep-link boot: a bare '#prices' hash opens the Prices route on load (main.ts boot-route block) ──
  it('boots a bare #prices deep-link straight onto the Prices route', () => {
    expect($('route-prices').hidden).toBe(false)
    expect($('route-convert').hidden).toBe(true)
    expect($('nav-prices').getAttribute('aria-selected')).toBe('true')
  })

  // ── watch pick: reveals the segment, reads the file, banners it, switches to Watch, jumps to breakdown ──
  it('picking a build file reveals the Watch pane, banners the file, and jumps to the breakdown', async () => {
    $<HTMLButtonElement>('nav-convert').click() // leave the Prices boot route for the Convert flow
    // the Watch segment is revealed (3-segment control) — isFileWatchSupported() returned true
    expect($('tab-watch').hidden).toBe(false)
    expect($('seg').style.getPropertyValue('--n')).toBe('3')

    getFileMode = 'ok'
    nextFile = new File([SAMPLE_XML], 'build.xml', { type: 'text/xml', lastModified: 1000 })
    pickerResult = [handle]
    $<HTMLButtonElement>('watch-pick').click()
    // pick() → watchHandle() reads the file, then the wiring runs showWatching / setMode / goToStep
    await vi.waitFor(() => expect($('bc-watch').hidden).toBe(false), { timeout: 2000 })
    expect($('bc-watch-name').textContent).toBe('build.xml') // showWatching(name)
    expect($('pane-watch').hidden).toBe(false) // setMode('watch') revealed the Watch pane
    expect($('bc-watch').classList.contains('bn--success')).toBe(true) // watchNote 'info' → green banner
    expect($('bc-watch-note').textContent).toBe(copy.watch.editAndSave) // pobParsed truthy → editAndSave
    // goToStep(1): the imported build is shown on the breakdown step
    expect(document.querySelectorAll('#stepper .sx-step')[1]!.getAttribute('data-state')).toBe('current')
    // let syncTree's (code-split, uncached) tree imports settle inside the test so they don't resolve
    // against a torn-down environment after the suite ends
    await vi.waitFor(() => expect(document.querySelector('#tree-toolbar .ttb-count b')).not.toBeNull(), {
      timeout: 3000,
    })
  })

  // ── onChange: a save (new lastModified) is polled up and re-imported; in Watch mode it says so ──
  it('saving the watched file re-imports it and notes "Re-imported on save"', async () => {
    // a new File with a LATER lastModified is what the poll compares; content stays a valid build
    nextFile = new File([SAMPLE_XML], 'build.xml', { type: 'text/xml', lastModified: 5000 })
    await vi.waitFor(() => expect($('bc-watch-note').textContent).toBe(copy.watch.reimported), { timeout: 2500 })
    expect($('bc-watch').classList.contains('bn--success')).toBe(true) // still the green live banner
  })

  // ── onError: a failing read flips the banner amber with the read-error note ──
  it('a failing file read flips the banner to the amber read-error state', async () => {
    getFileMode = 'reject' // next poll's getFile() rejects → the watcher's onError fires once
    await vi.waitFor(() => expect($('bc-watch-note').textContent).toBe(copy.watch.readError), { timeout: 2500 })
    expect($('bc-watch').classList.contains('bn--warning')).toBe(true) // watchNote('warn') → amber
  })

  // ── pick a file that holds no build → the else arm of `if (pobParsed)` (noBuildYet) ──
  it('picking a file with no build in it reports that no build was found', async () => {
    getFileMode = 'ok'
    nextFile = new File(['just some notes, not a PoB build'], 'notes.txt', { type: 'text/plain', lastModified: 9000 })
    pickerResult = [handle]
    $<HTMLButtonElement>('watch-pick').click() // re-pick → watchHandle stops the old watch, reads the new file
    await vi.waitFor(() => expect($('bc-watch-note').textContent).toBe(copy.watch.noBuildYet), { timeout: 2500 })
  })
})
