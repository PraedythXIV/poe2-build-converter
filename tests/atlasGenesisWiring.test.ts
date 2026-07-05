// Wiring-layer tests for the Atlas + Genesis planning viewers (src/atlas/wiring.ts +
// src/genesis/wiring.ts) — the glue main.ts owns that mounts each editable tree over the shared
// mountTree engine, paints the per-subtree / per-master counters, and drives the toolbars
// (Fit / Reset / Share / background-art), the atlas-masters drawer, the allocated-stats flyout,
// and the '#atlas=' / '#genesis=' share-link boot loaders.
//
// jsdom returns null from canvas.getContext('2d') and 0 from getBoundingClientRect, so the
// Canvas2D renderer normally never runs. installCanvas2d() (tests/helpers) hands the tree a no-op
// 2D context; a getBoundingClientRect spy gives the host a real size (so draw() clears its size
// gate); a Path2D shim + a synchronous requestAnimationFrame queue let us flush the dirty-flag
// frame so renderScene() actually executes. We then assert the OBSERVABLE wiring effects (counters
// repaint, buttons gate, share link + clipboard, boot-plan allocation, womb crafting tooltip),
// not the pixels.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installRenderHarness, type RenderHarness } from './helpers/renderHarness'
import { wireAtlas } from '../src/atlas/wiring'
import { wireGenesis } from '../src/genesis/wiring'
import { atlasGraph, atlasRootIds } from '../src/atlas/index'
import { genesisGraph, genesisRootIds } from '../src/genesis/index'
import { encodeAtlasPlan } from '../src/atlas/share'
import { encodeMasters } from '../src/atlas/mastersShare'
import { buildGraph } from '../src/tree/index'
import type { RawTreeGraph, TreeView } from '../src/tree/index'
import { fitToBounds, worldToScreen } from '../src/tree/viewport'
import { copy } from '../src/copy'
import mastersData from '../src/data/atlasMasters.json'

const MASTERS = (mastersData as unknown as { masters: Array<{ id: string; keystones: Array<{ id: string }> }> }).masters

// ── shared render harness ──────────────────────────────────────────────────────────────────
// jsdom scaffolding for the rAF-gated Canvas2D draw path (no-op 2D ctx + Path2D shim, a manual rAF
// queue, a sized getBoundingClientRect) — see tests/helpers/renderHarness.ts. flushRaf() runs the
// scheduled draw() so renderScene() executes against the stub 2D context.
const SIZE = { width: 960, height: 640 }
let harness: RenderHarness

/** Run the currently-queued animation-frame callbacks (the tree schedules draw() via rAF). */
const flushRaf = (): void => {
  harness.flushRaf(1)
}
/** Drain microtasks + one macrotask so an async click handler (await ensureX / copyText) settles. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const captured: TreeView[] = []
const track = (v: TreeView): TreeView => (captured.push(v), v)

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/') // clear any '#atlas=' / '#genesis=' from a prior test
  harness = installRenderHarness({ width: SIZE.width, height: SIZE.height })
})

afterEach(() => {
  vi.useRealTimers() // a fake-timer test must not leak into the next
  for (const v of captured.splice(0)) {
    try {
      v.destroy()
    } catch {
      /* already torn down */
    }
  }
  harness.restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// ── atlas host + deps ────────────────────────────────────────────────────────────────────────
interface AtlasHarness {
  wiring: ReturnType<typeof wireAtlas>
  openAtlasRoute: ReturnType<typeof vi.fn>
  copyText: ReturnType<typeof vi.fn>
  els: {
    atlasMount: HTMLDivElement
    atlasCounts: HTMLDivElement
    atlasMastersCounts: HTMLDivElement
    atlasFit: HTMLButtonElement
    atlasReset: HTMLButtonElement
    atlasShare: HTMLButtonElement
    atlasBg: HTMLInputElement
    atlasNote: HTMLElement
  }
}

function makeAtlas(copyOk = true): AtlasHarness {
  document.body.innerHTML = `
    <div class="at-stage">
      <div id="atlas-mount"></div>
      <div id="atlas-counts"></div>
      <div id="atlas-masters-counts"></div>
      <button id="atlas-fit"></button>
      <button id="atlas-reset"></button>
      <button id="atlas-share">${copy.convert.copyPlanLink}</button>
      <input id="atlas-bg" type="checkbox" />
      <div id="atlas-note" aria-live="polite"></div>
      <button id="atlas-masters-toggle"></button>
      <aside id="atlas-masters-drawer"></aside>
      <aside id="atlas-stats-panel"></aside>
      <button id="atlas-stats-toggle"></button>
    </div>`
  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
  const els = {
    atlasMount: byId<HTMLDivElement>('atlas-mount'),
    atlasCounts: byId<HTMLDivElement>('atlas-counts'),
    atlasMastersCounts: byId<HTMLDivElement>('atlas-masters-counts'),
    atlasFit: byId<HTMLButtonElement>('atlas-fit'),
    atlasReset: byId<HTMLButtonElement>('atlas-reset'),
    atlasShare: byId<HTMLButtonElement>('atlas-share'),
    atlasBg: byId<HTMLInputElement>('atlas-bg'),
    atlasNote: byId<HTMLElement>('atlas-note'),
  }
  const openAtlasRoute = vi.fn()
  const copyText = vi.fn(async () => copyOk)
  const wiring = wireAtlas({ els, copyText, openAtlasRoute })
  return { wiring, openAtlasRoute, copyText, els }
}

/** An atlas (root, adjacent non-root neighbour) pair — the neighbour allocates directly from a seed. */
function atlasNeighbor(): { neighbor: string; sub: string } {
  const root = Number(atlasRootIds()[0]!)
  const edge = atlasGraph.edges.find((e) => e.from === root || e.to === root)!
  const neighbor = String(edge.from === root ? edge.to : edge.from)
  const sub = atlasGraph.nodes[neighbor]!.subTree ?? 'general'
  return { neighbor, sub }
}

describe('wireAtlas — mount, counters, masters drawer', () => {
  it('mounts the editable atlas tree, seeds the 6 starts, and paints the subtree + master counters', async () => {
    const { wiring, els } = makeAtlas()
    const view = track(await wiring.ensureAtlas())
    flushRaf() // execute the scheduled draw() → renderScene runs against the stub 2D context

    // the shared engine mounted a canvas into the host
    expect(els.atlasMount.querySelector('.tree-view canvas')).not.toBeNull()
    // the 6 atlasRoot starts are on by default and free
    expect(view.getAllocated().size).toBe(atlasRootIds().length)
    // per-subtree counter chips are data-driven (General + one per subtree)
    const subChips = els.atlasCounts.querySelectorAll('.at-ct')
    expect(subChips.length).toBeGreaterThan(1)
    expect(els.atlasCounts.querySelector('.at-ct[data-sub="general"]')).not.toBeNull()
    // the atlas-masters drawer mounted its 3 master counter chips + its 12-cell grid
    expect(els.atlasMastersCounts.querySelectorAll('.at-ct').length).toBe(MASTERS.length)
    expect(document.querySelectorAll('#atlas-masters-drawer .am-cell').length).toBe(12)
    // the allocated-stats flyout mounted too
    expect(document.querySelector('#atlas-stats-panel.as-panel')).not.toBeNull()
    // nothing user-picked yet → Share + Reset are disabled
    expect(els.atlasShare.disabled).toBe(true)
    expect(els.atlasReset.disabled).toBe(true)
  })

  it('allocating a tree node repaints its subtree counter and enables Share/Reset', async () => {
    const { wiring, els } = makeAtlas()
    const view = track(await wiring.ensureAtlas())
    const { neighbor, sub } = atlasNeighbor()

    view.toggle(neighbor) // a user edit → subscribe(updateAtlasCounts) fires
    flushRaf()

    expect(view.getAllocated().has(neighbor)).toBe(true)
    const chip = els.atlasCounts.querySelector<HTMLElement>(`.at-ct[data-sub="${sub}"]`)!
    expect(chip.querySelector('.at-ct-n')!.textContent).toBe('1')
    expect(chip.classList.contains('at-ct--on')).toBe(true)
    expect(els.atlasShare.disabled).toBe(false)
    expect(els.atlasReset.disabled).toBe(false)
  })

  it('allocating an atlas-master keystone persists it, repaints its counter, and enables Share', async () => {
    const { wiring, els } = makeAtlas()
    track(await wiring.ensureAtlas())

    document.querySelector<HTMLButtonElement>('#atlas-masters-drawer .am-cell')!.click()

    const onChip = els.atlasMastersCounts.querySelector<HTMLElement>('.at-ct.at-ct--on')
    expect(onChip).not.toBeNull()
    expect(onChip!.querySelector('.at-ct-n')!.textContent).toBe('1')
    expect(localStorage.getItem('poe2.atlasMasters')).toBeTruthy() // persisted the pick
    expect(els.atlasShare.disabled).toBe(false) // a master pick alone arms Share
  })

  it('Reset clears the tree back to the starts and drops every master pick', async () => {
    const { wiring, els } = makeAtlas()
    const view = track(await wiring.ensureAtlas())
    const { neighbor } = atlasNeighbor()
    view.toggle(neighbor)
    document.querySelector<HTMLButtonElement>('#atlas-masters-drawer .am-cell')!.click()
    expect(els.atlasReset.disabled).toBe(false)

    els.atlasReset.click()
    await tick() // the handler resolves ensureAtlas() then resets

    expect(view.getAllocated().size).toBe(atlasRootIds().length) // back to just the starts
    expect(els.atlasMastersCounts.querySelector('.at-ct.at-ct--on')).toBeNull() // masters cleared
    expect(localStorage.getItem('poe2.atlasMasters')).toBeNull()
    expect(els.atlasShare.disabled).toBe(true)
    expect(els.atlasReset.disabled).toBe(true)
  })

  it('Fit re-frames the camera without throwing', async () => {
    const { wiring, els } = makeAtlas()
    track(await wiring.ensureAtlas())
    els.atlasFit.click()
    await tick()
    flushRaf() // the refit invalidated → a fresh draw runs
    expect(els.atlasMount.querySelector('.tree-canvas')).not.toBeNull()
  })

  it('the background-art toggle persists the pref and re-applies it on both edges', async () => {
    const { wiring, els } = makeAtlas()
    track(await wiring.ensureAtlas())
    expect(els.atlasBg.checked).toBe(true) // default pref = on

    els.atlasBg.checked = false
    els.atlasBg.dispatchEvent(new Event('change'))
    await tick()
    expect(localStorage.getItem('poe2.atlasBgVisible')).toBe('0')

    els.atlasBg.checked = true
    els.atlasBg.dispatchEvent(new Event('change'))
    await tick()
    expect(localStorage.getItem('poe2.atlasBgVisible')).toBe('1')
  })

  it('the saved background-art OFF pref is reflected on the checkbox at wire time', () => {
    localStorage.setItem('poe2.atlasBgVisible', '0')
    const { els } = makeAtlas()
    expect(els.atlasBg.checked).toBe(false)
  })

  it('Share copies a "#atlas=" link with the current picks and flips the label to Copied!', async () => {
    const { wiring, els, copyText } = makeAtlas(true)
    const view = track(await wiring.ensureAtlas())
    const { neighbor } = atlasNeighbor()
    view.toggle(neighbor)
    document.querySelector<HTMLButtonElement>('#atlas-masters-drawer .am-cell')!.click()

    els.atlasShare.click()
    await tick()

    expect(copyText).toHaveBeenCalledTimes(1)
    expect(String(copyText.mock.calls[0]![0])).toContain('#atlas=')
    expect(location.hash.startsWith('#atlas=')).toBe(true) // address bar became the share link
    expect(els.atlasShare.textContent).toBe(copy.convert.copied)
  })

  it('Share reports a clipboard failure with the "Copy failed" label', async () => {
    const { wiring, els } = makeAtlas(false) // copyText resolves false
    const view = track(await wiring.ensureAtlas())
    const { neighbor } = atlasNeighbor()
    view.toggle(neighbor)

    els.atlasShare.click()
    await tick()
    expect(els.atlasShare.textContent).toBe(copy.convert.copyFailed)
  })

  it('loadBootPlan applies a shared "#atlas=" node+masters link: opens the route and allocates the picks', async () => {
    const { neighbor } = atlasNeighbor()
    const nodeCode = encodeAtlasPlan([neighbor])
    const mastersCode = encodeMasters({ [MASTERS[0]!.id]: [MASTERS[0]!.keystones[0]!.id] }, MASTERS)
    window.history.replaceState(null, '', `/#atlas=${nodeCode}.${mastersCode}`)

    const { wiring, els, openAtlasRoute } = makeAtlas()
    wiring.loadBootPlan()
    await tick()
    flushRaf()

    expect(openAtlasRoute).toHaveBeenCalled() // followed a link → switch to the Atlas route
    const view = track(await wiring.ensureAtlas())
    expect(view.getAllocated().has(neighbor)).toBe(true) // shared node picks applied (+ the starts)
    expect(els.atlasNote.innerHTML).toBe('') // a readable link supersedes any damaged-link notice
    // the shared master pick was applied + persisted + counted
    expect(els.atlasMastersCounts.querySelector('.at-ct.at-ct--on')).not.toBeNull()
    expect(localStorage.getItem('poe2.atlasMasters')).toBeTruthy()
  })

  it('loadBootPlan on a damaged "#atlas=" link opens the route with a warning notice', async () => {
    window.history.replaceState(null, '', '/#atlas=@@@not-base64@@@')
    const { wiring, els, openAtlasRoute } = makeAtlas()
    wiring.loadBootPlan()
    await tick()

    expect(openAtlasRoute).toHaveBeenCalled()
    expect(els.atlasNote.innerHTML).not.toBe('') // an aria-live damaged-link toast was written
    expect(els.atlasNote.textContent).toContain(copy.share.damagedLink)
  })

  it('ensureAtlas is memoised: concurrent callers share one mount (no double canvas)', async () => {
    const { wiring, els } = makeAtlas()
    const [a, b] = await Promise.all([wiring.ensureAtlas(), wiring.ensureAtlas()])
    track(a)
    expect(a).toBe(b) // same TreeView instance
    expect(els.atlasMount.querySelectorAll('.tree-view').length).toBe(1) // mounted exactly once
  })
})

// ── genesis host + deps ────────────────────────────────────────────────────────────────────────
interface GenesisHarness {
  wiring: ReturnType<typeof wireGenesis>
  openGenesisRoute: ReturnType<typeof vi.fn>
  copyText: ReturnType<typeof vi.fn>
  els: {
    genesisMount: HTMLDivElement
    genesisCounts: HTMLDivElement
    genesisFit: HTMLButtonElement
    genesisReset: HTMLButtonElement
    genesisShare: HTMLButtonElement
    genesisBg: HTMLInputElement
    genesisNote: HTMLElement
  }
}

function makeGenesis(copyOk = true): GenesisHarness {
  document.body.innerHTML = `
    <div class="at-stage">
      <div id="genesis-mount"></div>
      <div id="genesis-counts"></div>
      <button id="genesis-fit"></button>
      <button id="genesis-reset"></button>
      <button id="genesis-share">${copy.convert.copyPlanLink}</button>
      <input id="genesis-bg" type="checkbox" />
      <div id="genesis-note" aria-live="polite"></div>
      <aside id="genesis-stats-panel"></aside>
      <button id="genesis-stats-toggle"></button>
    </div>`
  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
  const els = {
    genesisMount: byId<HTMLDivElement>('genesis-mount'),
    genesisCounts: byId<HTMLDivElement>('genesis-counts'),
    genesisFit: byId<HTMLButtonElement>('genesis-fit'),
    genesisReset: byId<HTMLButtonElement>('genesis-reset'),
    genesisShare: byId<HTMLButtonElement>('genesis-share'),
    genesisBg: byId<HTMLInputElement>('genesis-bg'),
    genesisNote: byId<HTMLElement>('genesis-note'),
  }
  const openGenesisRoute = vi.fn()
  const copyText = vi.fn(async () => copyOk)
  const wiring = wireGenesis({ els, copyText, openGenesisRoute })
  return { wiring, openGenesisRoute, copyText, els }
}

/** A genesis (womb, adjacent subtree node) pair — toggling the node auto-paths its womb. */
function genesisNeighbor(): { neighbor: string; sub: string } {
  const roots = new Set(genesisRootIds())
  const edge = genesisGraph.edges.find((e) => roots.has(String(e.from)) !== roots.has(String(e.to)))!
  const neighbor = roots.has(String(edge.from)) ? String(edge.to) : String(edge.from)
  return { neighbor, sub: genesisGraph.nodes[neighbor]!.subTree }
}

describe('wireGenesis — mount, counters, share, womb tooltip', () => {
  it('mounts the editable genesis tree with nothing allocated and paints one counter per mini-tree', async () => {
    const { wiring, els } = makeGenesis()
    const view = track(await wiring.ensureGenesis())
    flushRaf()

    expect(els.genesisMount.querySelector('.tree-view canvas')).not.toBeNull()
    expect(view.getAllocated().size).toBe(0) // wombs are allocatable roots, not on by default
    // one counter chip per subtree that HAS countable (non-womb) nodes
    const countable = new Set(
      Object.values(genesisGraph.nodes)
        .filter((n) => !n.keystone)
        .map((n) => n.subTree),
    )
    expect(els.genesisCounts.querySelectorAll('.at-ct').length).toBe(countable.size)
    expect(document.querySelector('#genesis-stats-panel.as-panel')).not.toBeNull()
    expect(els.genesisShare.disabled).toBe(true)
    expect(els.genesisReset.disabled).toBe(true)
  })

  it('allocating a subtree node auto-paths its womb, repaints the counter, and enables Share/Reset', async () => {
    const { wiring, els } = makeGenesis()
    const view = track(await wiring.ensureGenesis())
    const { neighbor, sub } = genesisNeighbor()

    view.toggle(neighbor)
    flushRaf()

    expect(view.getAllocated().has(neighbor)).toBe(true)
    const chip = els.genesisCounts.querySelector<HTMLElement>(`.at-ct[data-sub="${sub}"]`)!
    expect(chip.querySelector('.at-ct-n')!.textContent).toBe('1') // the womb itself isn't counted
    expect(chip.classList.contains('at-ct--on')).toBe(true)
    expect(els.genesisShare.disabled).toBe(false)
    expect(els.genesisReset.disabled).toBe(false)
  })

  it('hovering a Womb shows its Wombgift crafting reference; a normal node falls back to the default card', async () => {
    const { wiring, els } = makeGenesis()
    track(await wiring.ensureGenesis())
    flushRaf()
    const canvas = els.genesisMount.querySelector<HTMLCanvasElement>('.tree-canvas')!
    const tip = els.genesisMount.querySelector<HTMLElement>('.tree-tip')!

    // Reconstruct the exact fit viewport mountTree uses, so a synthetic pointermove lands on a node.
    const g = buildGraph(genesisGraph as unknown as RawTreeGraph)
    const vp = fitToBounds(g.mainBounds, SIZE, 0.06 * Math.min(SIZE.width, SIZE.height))
    const hover = (id: string): void => {
      const n = g.nodeById.get(id)!
      const { sx, sy } = worldToScreen(vp, SIZE, n.x, n.y)
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: sx, clientY: sy, bubbles: true }))
    }

    // a Womb keystone → the tooltipOverride returns the Wombgift card (gc-womb-tip)
    hover(genesisRootIds()[0]!)
    expect(tip.hidden).toBe(false)
    expect(tip.innerHTML).toContain('gc-womb-tip')

    // a non-womb node → override returns null → the shared default node card (no womb markup)
    const plain = Object.keys(genesisGraph.nodes).find((id) => !genesisGraph.nodes[id]!.keystone)!
    hover(plain)
    expect(tip.hidden).toBe(false)
    expect(tip.innerHTML).toContain('itc-card')
    expect(tip.innerHTML).not.toContain('gc-womb-tip')
  })

  it('Reset clears the genesis plan back to empty and disables Share/Reset', async () => {
    const { wiring, els } = makeGenesis()
    const view = track(await wiring.ensureGenesis())
    const { neighbor } = genesisNeighbor()
    view.toggle(neighbor)
    expect(els.genesisReset.disabled).toBe(false)

    els.genesisReset.click()
    await tick()

    expect(view.getAllocated().size).toBe(0)
    expect(els.genesisShare.disabled).toBe(true)
    expect(els.genesisReset.disabled).toBe(true)
  })

  it('Fit re-frames the genesis camera without throwing', async () => {
    const { wiring, els } = makeGenesis()
    track(await wiring.ensureGenesis())
    els.genesisFit.click()
    await tick()
    flushRaf()
    expect(els.genesisMount.querySelector('.tree-canvas')).not.toBeNull()
  })

  it('the genesis background-art toggle persists the pref on both edges', async () => {
    const { wiring, els } = makeGenesis()
    track(await wiring.ensureGenesis())
    els.genesisBg.checked = false
    els.genesisBg.dispatchEvent(new Event('change'))
    await tick()
    expect(localStorage.getItem('poe2.genesisBgVisible')).toBe('0')
    els.genesisBg.checked = true
    els.genesisBg.dispatchEvent(new Event('change'))
    await tick()
    expect(localStorage.getItem('poe2.genesisBgVisible')).toBe('1')
  })

  it('Share copies a "#genesis=" link and flips the label; a rapid second click clears the stale reset timer', async () => {
    const { wiring, els, copyText } = makeGenesis(true)
    const view = track(await wiring.ensureGenesis())
    const { neighbor } = genesisNeighbor()
    view.toggle(neighbor)

    els.genesisShare.click() // arms the 1400ms label-reset timer
    els.genesisShare.click() // rapid second click → clears the stale timer before re-arming
    await tick()

    expect(copyText).toHaveBeenCalled()
    expect(String(copyText.mock.calls[0]![0])).toContain('#genesis=')
    expect(location.hash.startsWith('#genesis=')).toBe(true)
    expect(els.genesisShare.textContent).toBe(copy.convert.copied)
  })

  it('loadBootPlan applies a shared "#genesis=" link: opens the route and allocates exactly the shared picks', async () => {
    const { neighbor } = genesisNeighbor()
    const womb = genesisRootIds().find((r) =>
      genesisGraph.edges.some(
        (e) =>
          (String(e.from) === r && String(e.to) === neighbor) || (String(e.to) === r && String(e.from) === neighbor),
      ),
    )!
    const code = encodeAtlasPlan([womb, neighbor]) // wombs are part of the shareable selection
    window.history.replaceState(null, '', `/#genesis=${code}`)

    const { wiring, els, openGenesisRoute } = makeGenesis()
    wiring.loadBootPlan()
    await tick()
    flushRaf()

    expect(openGenesisRoute).toHaveBeenCalled()
    const view = track(await wiring.ensureGenesis())
    expect(view.getAllocated().has(neighbor)).toBe(true)
    expect(view.getAllocated().has(womb)).toBe(true)
    expect(els.genesisNote.innerHTML).toBe('')
    expect(els.genesisShare.disabled).toBe(false)
  })

  it('the genesis Share label resets to "Copy plan link" after its copied-timeout elapses', async () => {
    const { wiring, els } = makeGenesis(true)
    const view = track(await wiring.ensureGenesis()) // mount under real timers first
    const { neighbor } = genesisNeighbor()
    view.toggle(neighbor)

    vi.useFakeTimers()
    els.genesisShare.click()
    await vi.advanceTimersByTimeAsync(1400) // flush the async handler, then fire the 1400ms reset
    expect(els.genesisShare.textContent).toBe(copy.convert.copyPlanLink)
  })

  it('loadBootPlan on a damaged "#genesis=" link opens the route with a warning notice', async () => {
    window.history.replaceState(null, '', '/#genesis=@@@bad@@@')
    const { wiring, els, openGenesisRoute } = makeGenesis()
    wiring.loadBootPlan()
    await tick()

    expect(openGenesisRoute).toHaveBeenCalled()
    expect(els.genesisNote.innerHTML).not.toBe('')
    expect(els.genesisNote.textContent).toContain(copy.share.damagedLink)
  })
})
