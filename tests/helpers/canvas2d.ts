// jsdom returns null from canvas.getContext('2d'), so every Canvas2D renderer (tree/render, the
// atlas/genesis views over the shared mountTree engine, interaction hit-testing) degrades to
// logic-only and its draw code never executes → 0% coverage. This helper installs a STUB 2D context
// so getContext('2d') returns a non-null object: the draw code then runs against no-op sinks, which
// is enough to COVER it (we're verifying the render path executes without throwing, not the pixels —
// pixel correctness is a job for the visual/Playwright toolbox checks). A Proxy backs any ctx.* method
// as a no-op, so the stub never needs updating when the renderer calls a new 2D API.

import { vi } from 'vitest'

const gradient = { addColorStop: () => {} }

/** A no-op CanvasRenderingContext2D stand-in. Records nothing; every method is a sink, every
 *  property is settable, and the gradient/pattern/measureText factories return usable stubs. */
export function stub2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {
    canvas,
    // settable style/state props the renderers assign to
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    // factories that must return usable objects
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    createPattern: () => ({}),
    measureText: () => ({ width: 0 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  }
  return new Proxy(target, {
    get: (t, p: string) => (p in t ? t[p] : () => {}), // any un-stubbed method → no-op sink
    set: (t, p: string, v) => {
      t[p] = v
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

/** Spy HTMLCanvasElement.getContext so '2d' yields the stub (webgl/others stay null). Returns a
 *  restore fn; call it in afterEach (or use vi.restoreAllMocks). */
export function installCanvas2d(): () => void {
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext') as unknown as {
    mockImplementation: (fn: (type: string) => unknown) => void
    mockRestore: () => void
  }
  spy.mockImplementation(function (this: HTMLCanvasElement, type: string) {
    return type === '2d' ? stub2dContext(this) : null
  })
  return () => spy.mockRestore()
}
