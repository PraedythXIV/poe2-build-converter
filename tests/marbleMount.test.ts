// Coverage for the two marble mount surfaces bg.test.ts leaves untouched: the INLINE fallback in
// marble.ts (the browsers-without-OffscreenCanvas path — main-thread getContext('webgl') → shared
// renderer → rAF loop / reduced-motion / context-loss / resize) and the marble.worker.ts glue that
// wires createMarbleWorkerHandler to the real worker globals (self.onmessage / postMessage / rAF).
//
// Enabler: like bg.test.ts, we hand the inline path a happy-path fake WebGL context per canvas (a
// per-instance getContext spy) so createMarbleRenderer succeeds and its draw code runs — the shared
// canvas2d 2D-stub helper does not apply here (marble is WebGL, never getContext('2d')). requestAnimationFrame
// is stubbed to a recorder so the ambient loop is driven deterministically without a real clock.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mountMarble } from '../src/bg/marble'
import type { MarbleWorkerIn } from '../src/bg/marbleCore'
import { fakeGl, type FakeGl } from './helpers/webglStub'

const drawCount = (gl: FakeGl): number => gl.calls.filter((c) => c === 'draw').length

const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
const devicePx = (cssPx: number): number => Math.max(1, Math.round(cssPx * dpr))

/** A plain canvas with a laid-out CSS box and a getContext spy that yields `gl` for 'webgl'. jsdom
 *  canvases have no transferControlToOffscreen, so mountMarble always takes the inline path here. */
function inlineCanvas(gl: FakeGl | null, w = 800, h = 600): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  setBox(canvas, w, h)
  vi.spyOn(canvas, 'getContext').mockImplementation(((type: string) =>
    type === 'webgl' ? (gl as unknown) : null) as typeof canvas.getContext)
  return canvas
}
function setBox(canvas: HTMLCanvasElement, w: number, h: number): void {
  Object.defineProperty(canvas, 'clientWidth', { value: w, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { value: h, configurable: true })
}

// rAF recorder — captures scheduled loop callbacks + cancelled ids so the ambient loop is driven by hand.
let rafCbs: Array<() => void>
let rafId: number
let cancelled: number[]

describe('marble inline fallback (marble.ts)', () => {
  beforeEach(() => {
    rafCbs = []
    rafId = 0
    cancelled = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafCbs.push(cb)
      return ++rafId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      cancelled.push(id)
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('runs the shared renderer on the main thread: start() paints and schedules the loop, sizing to device px', () => {
    const gl = fakeGl()
    const handle = mountMarble(inlineCanvas(gl))
    expect(handle).not.toBeNull()
    // nothing paints until start()
    expect(drawCount(gl)).toBe(0)

    handle!.start()
    // one frame painted, drawing buffer sized to the device-px box, next frame scheduled
    expect([drawCount(gl), gl.canvas.width, gl.canvas.height, rafCbs.length]).toEqual([
      1,
      devicePx(800),
      devicePx(600),
      1,
    ])
    // the fixed theme hues reach the shader (jsdom has no CSS vars → the documented fallback ember red + black ground)
    expect([gl.uni.uAccent, gl.uni.uBase]).toEqual([
      [0.67, 0.11, 0.06],
      [0, 0, 0],
    ])

    // running the scheduled callback advances the loop: another paint, another frame armed
    rafCbs[rafCbs.length - 1]!()
    expect([drawCount(gl), rafCbs.length]).toEqual([2, 2])
  })

  it('a second start() while already running does not stack a second rAF chain', () => {
    const gl = fakeGl()
    const handle = mountMarble(inlineCanvas(gl))!
    handle.start()
    handle.start() // double-start (rapid toggle) must be a no-op
    expect(rafCbs.length).toBe(1)
  })

  it('stop() halts the loop and cancels the pending frame; the stale callback then no-ops', () => {
    const gl = fakeGl()
    const handle = mountMarble(inlineCanvas(gl))!
    handle.start() // raf id 1 pending
    const drawnBeforeStop = drawCount(gl)
    handle.stop()
    expect(cancelled).toEqual([1])
    // the still-referenced loop callback fires once more (as a real rAF flush might) but must draw nothing
    rafCbs[rafCbs.length - 1]!()
    expect([drawCount(gl), rafCbs.length]).toEqual([drawnBeforeStop, 1])
  })

  it('recolor() while running re-reads colours but defers the paint to the loop (no off-frame draw)', () => {
    const gl = fakeGl()
    const handle = mountMarble(inlineCanvas(gl))!
    handle.start()
    const after = drawCount(gl)
    handle.recolor() // running → repaint is left to the next loop frame, not forced now
    expect(drawCount(gl)).toBe(after)
  })

  it('reduced-motion paints a single static frame (no loop); resize + recolor repaint it on demand', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: true,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }))
    const gl = fakeGl()
    const canvas = inlineCanvas(gl)
    const handle = mountMarble(canvas)!

    handle.start()
    // one static frame, no animation loop scheduled
    expect([drawCount(gl), rafCbs.length]).toEqual([1, 0])

    // a resize while paused needs a manual repaint — and it adopts the new box
    setBox(canvas, 1000, 700)
    window.dispatchEvent(new Event('resize'))
    expect([drawCount(gl), gl.canvas.width, gl.canvas.height]).toEqual([2, devicePx(1000), devicePx(700)])

    // recolor also repaints immediately while paused so the new hue shows without a running loop
    handle.recolor()
    expect([drawCount(gl), rafCbs.length]).toEqual([3, 0])
  })

  it('self-heals a pre-layout 0×0 box: schedules the loop but paints nothing until the box measures', () => {
    const gl = fakeGl()
    const canvas = inlineCanvas(gl, 0, 0) // first frame(s) before layout report 0
    const handle = mountMarble(canvas)!

    handle.start()
    // the loop is armed, but the zero box short-circuits the paint (no draw, no buffer sizing)
    expect([drawCount(gl), gl.canvas.width, rafCbs.length]).toEqual([0, 0, 1])

    // once layout gives the canvas a box, the next frame re-measures and paints
    setBox(canvas, 640, 480)
    rafCbs[rafCbs.length - 1]!()
    expect([drawCount(gl), gl.canvas.width, gl.canvas.height]).toEqual([1, devicePx(640), devicePx(480)])
  })

  it('resize during a running loop refreshes the cached box without an off-loop repaint', () => {
    const gl = fakeGl()
    const canvas = inlineCanvas(gl)
    const handle = mountMarble(canvas)!
    handle.start()
    expect(gl.canvas.width).toBe(devicePx(800))

    setBox(canvas, 1000, 700)
    window.dispatchEvent(new Event('resize'))
    // running: the resize only refreshes the cached box, it does NOT paint off the loop
    expect([drawCount(gl), gl.canvas.width]).toEqual([1, devicePx(800)])

    // the pending loop frame then picks up the new size
    rafCbs[rafCbs.length - 1]!()
    expect([drawCount(gl), gl.canvas.width, gl.canvas.height]).toEqual([2, devicePx(1000), devicePx(700)])
  })

  it('webglcontextlost stops the loop cleanly, prevents default, cancels the frame and detaches listeners', () => {
    const gl = fakeGl()
    const canvas = inlineCanvas(gl)
    const handle = mountMarble(canvas)!
    handle.start() // raf id 1 pending
    const drawnBeforeLoss = drawCount(gl)

    const lost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(lost)
    // the GPU-drop handler asks the browser to keep the context restorable and tears down the loop
    expect([lost.defaultPrevented, cancelled]).toEqual([true, [1]])

    // the stale loop callback no-ops now that running is false
    rafCbs[rafCbs.length - 1]!()
    expect(drawCount(gl)).toBe(drawnBeforeLoss)

    // the resize listener was removed, so a later resize can no longer repaint this canvas
    setBox(canvas, 1200, 900)
    window.dispatchEvent(new Event('resize'))
    expect(drawCount(gl)).toBe(drawnBeforeLoss)
  })

  it('falls back to the static CSS background (and returns null) when the shader fails to build', () => {
    const gl = fakeGl({ compileOk: false }) // gl exists but createMarbleRenderer returns null
    const canvas = inlineCanvas(gl)
    const handle = mountMarble(canvas)
    expect(handle).toBeNull()
    expect(canvas.style.background).toContain('surface-1')
  })

  it('falls back to the static CSS background when no WebGL context is available at all', () => {
    const canvas = inlineCanvas(null) // getContext('webgl') → null
    const handle = mountMarble(canvas)
    expect(handle).toBeNull()
    expect(canvas.style.background).toContain('surface-1')
  })
})

// marble.worker.ts is pure glue: it wires createMarbleWorkerHandler to the real worker globals and
// installs self.onmessage. Driving that onmessage with a stubbed self exercises every injected effect.
describe('marble worker glue (marble.worker.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('wires self.onmessage to the shared handler and routes side-effects to the worker globals', async () => {
    const posted: unknown[] = []
    const frames: Array<() => void> = []
    const cancels: number[] = []
    // self === window in the jsdom env; stub the globals the glue forwards to
    vi.spyOn(window, 'postMessage').mockImplementation(((m: unknown) => {
      posted.push(m)
    }) as typeof window.postMessage)
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      cancels.push(id)
    })

    // fresh module execution so the top-level `self.onmessage = …` runs (and picks up nothing stateful)
    vi.resetModules()
    await import('../src/bg/marble.worker')
    const onmessage = window.onmessage as unknown as ((e: { data: MarbleWorkerIn }) => void) | null
    expect(typeof onmessage).toBe('function')

    // init with a real (fake) context, then start → the glue forwards the loop to requestAnimationFrame
    const glCanvas = {
      getContext: () => fakeGl(),
      addEventListener: () => {},
    } as unknown as OffscreenCanvas
    onmessage!({ data: { type: 'init', canvas: glCanvas, w: 8, h: 8, accent: [1, 0, 0], base: [0, 0, 0] } })
    onmessage!({ data: { type: 'start', reduced: false } })
    expect(frames.length).toBe(1)

    // stop → the glue forwards the cancel to cancelAnimationFrame
    onmessage!({ data: { type: 'stop' } })
    expect(cancels.length).toBe(1)

    // a context-less init makes the handler ask the glue to postFallback → self.postMessage({fallback})
    const blindCanvas = { getContext: () => null, addEventListener: () => {} } as unknown as OffscreenCanvas
    onmessage!({ data: { type: 'init', canvas: blindCanvas, w: 8, h: 8, accent: [1, 0, 0], base: [0, 0, 0] } })
    expect(posted).toContainEqual({ type: 'fallback' })
  })
})
