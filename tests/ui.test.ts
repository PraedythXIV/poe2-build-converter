// Smoke test for the DOM wiring: load the real index.html body, boot main.ts, simulate a
// conversion, and assert the output renders. Runs in jsdom (vitest environment).

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeAtlasPlan } from '../src/atlas/share'
import { atlasGraph } from '../src/atlas/index'

const ROOT = process.cwd()
const SAMPLE_XML = readFileSync(join(ROOT, 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')
const LOADOUTS_XML = readFileSync(join(ROOT, 'tests', 'fixtures', 'pob-loadouts.xml'), 'utf8')

// Two real NON-start atlas node ids — encoded into the boot hash below so the '#atlas=…'
// load path runs against the real graph. Start nodes are default-on + uncounted, so a
// meaningful shared plan must be made of non-start nodes.
const ATLAS_BOOT_IDS = Object.keys(atlasGraph.nodes)
  .filter((k) => atlasGraph.nodes[k]?.atlasRoot !== true)
  .slice(0, 2)

function bodyInnerHtml(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const inner = m ? m[1]! : html
  return inner.replace(/<script[\s\S]*?<\/script>/gi, '') // we import main.ts manually
}

describe('UI wiring', () => {
  beforeAll(async () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    document.body.innerHTML = bodyInnerHtml(html)
    // main.ts reads location.hash at module eval (the atlas load-on-boot path), so the
    // shared boot sets a real share hash BEFORE the dynamic import — no exported helper
    // needed, the genuine boot-order code runs.
    window.location.hash = `#atlas=${encodeAtlasPlan(ATLAS_BOOT_IDS)}`
    const main = await import('../src/main') // boots: wires listeners against the DOM above
    await main.enginePrefetch // the convert engine is code-split + prefetched — wait until it's ready
  })

  it('converts the sample build via the Convert button and renders output', () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    const convertBtn = document.getElementById('convert') as HTMLButtonElement
    code.value = SAMPLE_XML
    convertBtn.click()

    const json = document.getElementById('json') as HTMLPreElement
    const status = document.getElementById('status') as HTMLElement
    const download = document.getElementById('download') as HTMLButtonElement
    const stats = document.getElementById('stats') as HTMLElement

    expect(status.dataset.state).toBe('done')
    expect(download.disabled).toBe(false)
    expect(stats.hidden).toBe(false)
    // output JSON (syntax-highlighted) contains the expected mapped values
    expect(json.textContent).toContain('Monk1')
    expect(json.textContent).toContain('Metadata/Items/Gems/SkillGemWhirlingAssault')
    expect(json.textContent).toContain('jewel_slot1979')

    // stepper-router: clicking Convert lands on the Convert step (now index 4, the last) showing
    // the JSON — the four before it read as done
    const states = [...document.querySelectorAll('#stepper .sx-step')].map((s) => s.getAttribute('data-state'))
    expect(states).toEqual(['done', 'done', 'done', 'done', 'current'])
    expect(document.querySelectorAll('#stepper .sx-step')[4]!.getAttribute('aria-current')).toBe('step')

    // gear gallery: equipped items grouped into category sections of #311 tooltips
    const sections = document.querySelectorAll('#bc-gear .bc-gear-sec')
    expect(sections.length).toBeGreaterThan(1)
    expect(document.querySelectorAll('#bc-gear .bc-gear-grid .itc-card').length).toBeGreaterThan(0)
    // the fixture's unique belt resolves into a tier-tagged tooltip name
    const itemNames = [...document.querySelectorAll('#bc-gear .itc-name')].map((n) => n.textContent)
    expect(itemNames).toContain("Shavronne's Satchel")
    // canonical slots the build leaves empty (the fixture has no gloves) render placeholder cards
    expect(document.querySelectorAll('#bc-gear .itc-card--empty').length).toBeGreaterThan(0)
    expect(itemNames).toContain('Gloves') // the empty Gloves placeholder uses the slot label as its name
  })

  it('renders the build-contents preview with accessible, decorative ●/○ markers', () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    const convertBtn = document.getElementById('convert') as HTMLButtonElement
    code.value = SAMPLE_XML
    convertBtn.click() // convert() calls updateContents() synchronously (no debounce on this path)

    const contents = document.getElementById('contents') as HTMLElement
    expect(contents.hidden).toBe(false)
    // a11y: the section must NOT self-announce its whole subtree on every update
    expect(contents.hasAttribute('aria-live')).toBe(false)
    // a11y: columns are real labelled groups (a bare div would have its aria-label ignored)
    expect(document.getElementById('bc-perks')?.getAttribute('role')).toBe('group')
    // perks rendered, and every ●/○ tier marker is decorative (the legend explains them once)
    const perks = document.getElementById('bc-perks') as HTMLElement
    expect(perks.querySelectorAll('.bc-row').length).toBeGreaterThan(0)
    const markers = contents.querySelectorAll('.bc-tier')
    expect(markers.length).toBeGreaterThan(0)
    expect([...markers].every((m) => m.getAttribute('aria-hidden') === 'true')).toBe(true)
  })

  // Integration of the C1/C3/B1/B3/B4 panels into the page (the modules have their own unit
  // tests — this only asserts the wiring renders them from a real conversion).
  it('renders the stats panel, audit panel, tree card, tier chips and economy card', async () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    const convertBtn = document.getElementById('convert') as HTMLButtonElement
    code.value = SAMPLE_XML
    convertBtn.click()
    // the passive tree is code-split now → syncTree mounts it asynchronously; let the dynamic
    // import + toolbar render settle before asserting on the tree card (the breakdown/stats/gear
    // above render synchronously, so this only gates the B1 tree assertions).
    await new Promise((r) => setTimeout(r, 50))

    // C1 — PoB's exported stats render in curated groups
    const stats = document.getElementById('bc-stats') as HTMLElement
    expect(stats.innerHTML.length).toBeGreaterThan(0)
    expect(stats.textContent).toContain('Resistances')

    // C3 — the audit panel renders findings (the fixture over-reserves spirit → an error)
    const audit = document.getElementById('bc-audit') as HTMLElement
    expect(audit.innerHTML.length).toBeGreaterThan(0)
    expect(audit.textContent?.toLowerCase()).toContain('spirit')

    // B1 — the tree card unhides; in jsdom the canvas degrades to logic-only but the toolbar must be
    // wired and show the fixture's points against the LEVEL-100 max (123), so a legal build never reads
    // over. Its 129 allocated nodes = 119 main passives + 8 asc passives + 2 free start nodes.
    const treeCard = document.getElementById('tree-card') as HTMLElement
    expect(treeCard.hidden).toBe(false)
    expect(document.querySelector('#tree-toolbar .ttb-count b')?.textContent).toBe('119/123')
    // the passive tree is a READ-ONLY viewer — no allocation-editing controls in its toolbar
    expect(document.querySelector('#tree-toolbar .ttb-undo')).toBeNull()
    expect(document.querySelector('#tree-toolbar .ttb-redo')).toBeNull()
    // asc segment visible — the fixture selects Monk1, 8/8 ascendancy points
    expect(document.querySelector<HTMLElement>('#tree-toolbar .ttb-count-asc')?.hidden).toBe(false)

    // B3 — at least one gear mod line carries an affix-tier chip from the datamine
    expect(document.querySelectorAll('#bc-gear .idp-chip--inline').length).toBeGreaterThan(0)

    // B4 — the economy card (lazy: mounts when the Prices tab is opened) renders idle, zero-network
    ;(document.getElementById('nav-prices') as HTMLButtonElement).click()
    await new Promise((r) => setTimeout(r, 50)) // economy panel is code-split — let it mount
    const econ = document.getElementById('econ-mount') as HTMLElement
    // opens to a three-card landing (Economy / Currency Exchange / Unique Items), idle + zero-network
    expect(econ.querySelectorAll('#ec-landing .ec-enter').length).toBe(3)
    expect((econ.querySelector('#ec-app') as HTMLElement).hidden).toBe(true)
    expect(econ.querySelector('#ec-league-name')?.textContent).toBe('—')
    ;(document.getElementById('nav-atlas') as HTMLButtonElement).click() // restore the boot route (later #atlas= tests expect it active)
  })

  // The ascendancy splash card is ART — it follows the tree toolbar's Background-art checkbox
  // (owner request 2026-07-04: hidden when the art checkbox is unticked).
  it('unticking the tree Background-art checkbox also hides the ascendancy splash card', () => {
    const bg = document.querySelector<HTMLInputElement>('#tree-toolbar .ttb-bg-input')!
    const splash = document.getElementById('asc-splash') as HTMLElement
    expect(splash.hidden).toBe(false) // precondition: the Monk fixture rendered its splash
    bg.checked = false
    bg.dispatchEvent(new Event('change', { bubbles: true }))
    expect(splash.hidden).toBe(true)
  })

  it('re-ticking Background art shows the splash card again', () => {
    const bg = document.querySelector<HTMLInputElement>('#tree-toolbar .ttb-bg-input')!
    bg.checked = true
    bg.dispatchEvent(new Event('change', { bubbles: true })) // also restores the persisted pref for later tests
    expect((document.getElementById('asc-splash') as HTMLElement).hidden).toBe(false)
  })

  // No browser API reports download completion, but the handoffs are staggered i*150ms — so the note
  // must FLIP from "Downloading…" to a saved state once the last handoff is safely past (owner report:
  // the download is instant and the note never updated).
  it('the download note flips to a saved state after the files are handed to the browser', async () => {
    // jsdom lacks the object-URL statics downloadFile uses
    URL.createObjectURL ??= () => 'blob:mock'
    URL.revokeObjectURL ??= () => {}
    ;(document.getElementById('download') as HTMLButtonElement).click()
    const note = document.getElementById('dl-note') as HTMLElement
    expect(note.textContent).toContain('Downloading') // phase 1, immediately
    await new Promise((r) => setTimeout(r, 700)) // single file: flip scheduled at ~400ms
    expect(note.textContent).toContain('Downloaded') // phase 2, after the last handoff
  })

  // Step 5 anti-scroll-fest: the emitted .build JSON lives in a native <details> that is COLLAPSED
  // by default (owner request 2026-07-04); Download/Copy never depend on it being open.
  it('renders the .build JSON inside a collapsed-by-default disclosure', () => {
    const d = document.querySelector<HTMLDetailsElement>('details.json-details')
    expect([!!d, d?.open ?? null, !!d?.querySelector('#json')]).toEqual([true, false, true])
  })

  it('seeds variants; the Convert-step download adapts to the count + gates on names', () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    code.value = SAMPLE_XML
    ;(document.getElementById('convert') as HTMLButtonElement).click() // builds + lands on Convert (4)

    // Variants step (index 3): one row seeded from the active loadout, with selectors + preview
    ;(document.querySelectorAll('#stepper .sx-step')[3] as HTMLElement).click()
    const rows = (): NodeListOf<Element> => document.querySelectorAll('#var-rows .var-row')
    expect(rows().length).toBe(1)
    const first = rows()[0]!
    expect((first.querySelector('.var-name') as HTMLInputElement).value.length).toBeGreaterThan(0)
    // the three loadout selectors are populated <select>s (tree spec · skill set · item set), not just present
    for (const sel of ['.var-tree', '.var-skills', '.var-gear'] as const) {
      const dropdown = first.querySelector<HTMLSelectElement>(sel)!
      expect(dropdown.tagName).toBe('SELECT')
      expect(dropdown.options.length).toBeGreaterThan(0)
    }
    expect(first.querySelector('.var-preview')?.textContent).toMatch(/\d+ nodes? ·/)
    // the download lives in the Convert step now — the Variants step has no download button
    expect(document.getElementById('var-download')).toBeNull()

    // the Convert-step download: one variant → single-file label, enabled
    const dl = document.getElementById('download') as HTMLButtonElement
    expect(dl.disabled).toBe(false)
    expect(dl.textContent).toBe('Download .build')

    // + Add variant → the label adapts to "Download all (2)"
    ;(document.getElementById('var-add') as HTMLButtonElement).click()
    expect(rows().length).toBe(2)
    expect(dl.textContent).toContain('(2)')

    // blanking a name blocks the download (no nameless .build)
    const name0 = rows()[0]!.querySelector('.var-name') as HTMLInputElement
    name0.value = '   '
    name0.dispatchEvent(new Event('input', { bubbles: true }))
    expect(dl.disabled).toBe(true)
    expect(document.getElementById('var-note')?.textContent?.toLowerCase()).toContain('name')

    // restore a name + land on Convert (4) for the following test's precondition
    name0.value = 'Main'
    name0.dispatchEvent(new Event('input', { bubbles: true }))
    ;(document.querySelectorAll('#stepper .sx-step')[4] as HTMLElement).click()
  })

  it('shows a helpful error for bad input without crashing', () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    const convertBtn = document.getElementById('convert') as HTMLButtonElement
    code.value = 'not a real code'
    convertBtn.click()

    const status = document.getElementById('status') as HTMLElement
    const warnings = document.getElementById('warnings') as HTMLElement
    expect(status.dataset.state).toBe('error')
    expect(warnings.textContent?.toLowerCase()).toContain('error')

    // stepper flags the Convert step (index 4 in the 5-step flow) as errored + current
    const convertStep = document.querySelectorAll('#stepper .sx-step')[4]!
    expect(convertStep.classList.contains('sx-step--err')).toBe(true)
    expect(convertStep.getAttribute('data-state')).toBe('current')
  })

  // B6 — pasting a pobb.in link debounce-fetches the raw code via the BFF and replaces
  // the textarea content, after which the normal convert pipeline takes over.
  it('imports a pasted pobb.in link via the BFF and converts it', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      urls.push(String(input))
      return Promise.resolve(new Response(SAMPLE_XML, { status: 200 }))
    })
    try {
      const code = document.getElementById('code') as HTMLTextAreaElement
      code.value = 'https://pobb.in/TestId01'
      code.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 450)) // 350 ms debounce + fetch microtasks

      expect(urls).toEqual(['http://localhost:8787/api/pob/TestId01'])
      // raw code replaced the pasted link (textarea .value normalizes CRLF → LF per spec)
      expect(code.value).toBe(SAMPLE_XML.replace(/\r\n/g, '\n'))
      // import feedback shows on the Import step's own note (not the Convert step's warnings)
      const note = document.getElementById('import-note') as HTMLElement
      expect(note.textContent).toContain('Loaded build from pobb.in/TestId01')

      ;(document.getElementById('convert') as HTMLButtonElement).click()
      expect((document.getElementById('status') as HTMLElement).dataset.state).toBe('done')
      expect((document.getElementById('json') as HTMLPreElement).textContent).toContain('Monk1')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // .build v1's `link` field (live spec 2026-07-04): a pobb.in link import records its source URL
  // and the converter emits it — the .build carries where the build came from.
  it('emits the pobb.in source URL as the .build link field after a link import', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(SAMPLE_XML, { status: 200 })))
    try {
      const code = document.getElementById('code') as HTMLTextAreaElement
      code.value = 'https://pobb.in/LinkSrc1'
      code.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 450)) // 350 ms debounce + fetch microtasks
      ;(document.getElementById('convert') as HTMLButtonElement).click()
      expect((document.getElementById('json') as HTMLPreElement).textContent).toContain(
        '"link": "https://pobb.in/LinkSrc1"',
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // Bridge 2a — "Publish to PoE2": the Convert step links to GGG's official upload/subscribe page
  // (the .build docs' "Via the Website" channel; there is no API/OAuth publish path).
  it('offers the official pathofexile2.com upload page as a publish affordance on the Convert step', () => {
    const a = document.querySelector<HTMLAnchorElement>('#publish-note a')
    expect(a?.href).toBe('https://pathofexile2.com/my-account/builds')
  })

  it('surfaces a proxy warning when the pobb.in fetch fails (without clobbering the paste)', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    try {
      const code = document.getElementById('code') as HTMLTextAreaElement
      code.value = 'pobb.in/u/someone/BrokenId1' // scheme-less /u/<user>/<id> form
      code.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 450))

      expect(code.value).toBe('pobb.in/u/someone/BrokenId1') // input left untouched
      const note = document.getElementById('import-note') as HTMLElement
      expect(note.textContent).toContain("Couldn't load pobb.in/BrokenId1")
      expect(note.textContent).toContain('serve:bff') // actionable localhost hint
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // invalid paste feedback: a code that fails decode/parse surfaces the tailored error on the
  // Import step's own note (live, before Convert is ever pressed) and clears once input is fixed
  it('shows the decode error live for an invalid paste and clears it when fixed', async () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    const note = document.getElementById('import-note') as HTMLElement
    code.value = 'not a real code'
    code.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 350)) // 250 ms preview debounce
    expect(note.textContent?.length).toBeGreaterThan(0)
    expect(note.textContent?.toLowerCase()).toMatch(/base64|code|xml/)

    code.value = SAMPLE_XML
    code.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 350))
    expect(note.textContent).toBe('')
  })

  // #2 — gear cards expand into the enriched renderItemDetails() overlay
  it('opens an item-details overlay from a gear card and closes it accessibly', () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    code.value = SAMPLE_XML
    ;(document.getElementById('convert') as HTMLButtonElement).click()

    const card = document.querySelector<HTMLElement>('#bc-gear .itc-card[data-di]')!
    expect(card).not.toBeNull()
    expect(card.getAttribute('role')).toBe('button')
    expect(card.tabIndex).toBe(0)
    expect(card.getAttribute('aria-haspopup')).toBe('dialog') // opens a modal dialog
    // empty placeholder cards are NOT clickable
    const empty = document.querySelector<HTMLElement>('#bc-gear .itc-card--empty')!
    expect(empty.getAttribute('role')).not.toBe('button')
    expect(empty.hasAttribute('data-di')).toBe(false)

    // the overlay is now a PERSISTENT modal dialog (vendored `dialog` behavior): shown on open,
    // hidden — not removed — on close, with a focus trap that restores focus to the opener card.
    card.click()
    const overlay = document.querySelector<HTMLElement>('.idm-backdrop')!
    expect(overlay).not.toBeNull()
    expect(overlay.hidden).toBe(false) // opened
    expect(overlay.querySelector('[role="dialog"]')).not.toBeNull()
    expect(overlay.querySelector('.idp-card')).not.toBeNull() // renderItemDetails output

    // Escape dismisses (the trap restores focus to the card). Dispatched on the dialog root — that's
    // where the behavior listens (in a real browser, focus is inside the dialog so the keydown bubbles up).
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(overlay.hidden).toBe(true)
    expect(document.activeElement).toBe(card)

    // keyboard open (Enter on the focused card) + the explicit close button (data-dialog-close)
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(overlay.hidden).toBe(false)
    ;(overlay.querySelector('.idm-close') as HTMLButtonElement).click()
    expect(overlay.hidden).toBe(true)
  })

  // #4 — atlas planning: the boot hash (set in beforeAll, before main.ts was imported)
  // must have opened the planner and loaded the shared plan.
  it('boots a #atlas= share hash: opens the Atlas route and loads the decoded plan', () => {
    // the share-hash boot calls showRoute('atlas') — the Atlas destination is active...
    const atlasRoute = document.getElementById('route-atlas') as HTMLElement
    const atlasTab = document.getElementById('nav-atlas') as HTMLButtonElement
    expect(atlasRoute.hidden).toBe(false)
    expect(atlasTab.getAttribute('aria-selected')).toBe('true')
    // ...and the planner is mounted with the decoded plan
    expect(document.querySelector('#atlas-mount .tree-view')).not.toBeNull()
    // the per-tree counters sum to the 2 decoded (non-start) nodes
    const allocated = [...document.querySelectorAll('#atlas-counts .at-ct-n')].reduce(
      (a, e) => a + Number(e.textContent),
      0,
    )
    expect(allocated).toBe(2)
  })

  it('Copy plan link writes the canonical #atlas= payload into the URL', async () => {
    ;(document.getElementById('atlas-share') as HTMLButtonElement).click()
    await new Promise((r) => setTimeout(r, 0)) // the handler is async (clipboard attempt)
    // round-trip through the live view re-encodes to the same canonical payload
    expect(window.location.hash).toBe(`#atlas=${encodeAtlasPlan(ATLAS_BOOT_IDS)}`)
  })

  // a share link pasted into the address bar of an ALREADY-OPEN tab fires hashchange (no reload) —
  // the new payload must be decoded and applied, not just routed to the stale planner
  it('re-applies a NEW #atlas= share payload arriving via hashchange', async () => {
    const third = Object.keys(atlasGraph.nodes).filter((k) => atlasGraph.nodes[k]?.atlasRoot !== true)[2]!
    window.location.hash = `#atlas=${encodeAtlasPlan([third])}`
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await new Promise((r) => setTimeout(r, 50)) // ensureAtlas microtasks
    const allocated = [...document.querySelectorAll('#atlas-counts .at-ct-n')].reduce(
      (a, e) => a + Number(e.textContent),
      0,
    )
    expect(allocated).toBe(1) // the 2-node boot plan was REPLACED by the new 1-node link
  })

  // a corrupt/truncated share payload must say so — landing on a silently-empty planner is
  // indistinguishable from "my friend shared an empty plan"
  it('shows a notice when an #atlas= share payload fails to decode', async () => {
    window.location.hash = '#atlas=!!!not-a-payload!!!'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await new Promise((r) => setTimeout(r, 50))
    const note = document.getElementById('atlas-note') as HTMLElement
    expect(note.textContent?.toLowerCase()).toContain('share link')
  })

  it('shows a notice when a #genesis= share payload fails to decode', async () => {
    window.location.hash = '#genesis=!!!not-a-payload!!!'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await new Promise((r) => setTimeout(r, 50))
    const note = document.getElementById('genesis-note') as HTMLElement
    expect(note.textContent?.toLowerCase()).toContain('share link')
  })

  it('multi-loadout build: the loadout dropdown switches the breakdown + pins stats to main', () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    code.value = LOADOUTS_XML
    ;(document.getElementById('convert') as HTMLButtonElement).click()

    // two loadouts → the browse dropdown is visible with both names
    const wrap = document.getElementById('bc-loadout-wrap') as HTMLElement
    expect(wrap.hidden).toBe(false)
    const sel = document.getElementById('bc-loadout') as HTMLSelectElement
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Endgame', 'Levelling'])
    // default view = the main loadout → no "stats are for the main loadout" note
    expect((document.getElementById('bc-stats-note') as HTMLElement).hidden).toBe(true)

    // switching to the non-main loadout surfaces the note + keeps the tree dropdown synced
    sel.value = '1'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    expect((document.getElementById('bc-stats-note') as HTMLElement).hidden).toBe(false)
    expect((document.getElementById('tree-loadout') as HTMLSelectElement).value).toBe('1')
  })
})
