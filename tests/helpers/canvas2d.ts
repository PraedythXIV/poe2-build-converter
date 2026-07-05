// jsdom returns null from canvas.getContext('2d'), so every Canvas2D renderer (tree/render, the
// atlas/genesis views over the shared mountTree engine, interaction hit-testing) degrades to
// logic-only and its draw code never executes → 0% coverage. This helper installs a STUB 2D context
// so getContext('2d') returns a non-null object: the draw code then runs against no-op sinks, which
// is enough to COVER it (we're verifying the render path executes without throwing, not the pixels —
// pixel correctness is a job for the visual/Playwright toolbox checks). A Proxy backs any ctx.* method
// as a no-op, so the stub never needs updating when the renderer calls a new 2D API.

import { vi } from 'vitest'

const gradient = { addColorStop: () => {} }

/** One recorded 2D-context method call plus a snapshot of the style state at call time. Lets a test
 *  assert WHICH draw ran (e.g. a fallback dot filled with palette.ws1, a mastery glow drawn at alpha
 *  0.42) instead of only that draw() executed — the difference between a mutation-sensitive test and a
 *  "didn't throw" one for the pixel-less render path. Recording is OPT-IN (startCtxRecording) so the
 *  rest of the suite pays nothing and behaves exactly as before. */
export interface CtxCall {
  name: string
  args: readonly unknown[]
  fillStyle: unknown
  strokeStyle: unknown
  globalAlpha: unknown
  lineWidth: unknown
}
let recording = false
export const ctxCalls: CtxCall[] = []
/** Begin capturing ctx method calls (clears any prior log). */
export function startCtxRecording(): void {
  recording = true
  ctxCalls.length = 0
}
/** Stop capturing and drop the log — call in afterEach so recording never leaks across tests/files. */
export function stopCtxRecording(): void {
  recording = false
  ctxCalls.length = 0
}
/** Empty the log without stopping — use between actions within one test. */
export function clearCtxCalls(): void {
  ctxCalls.length = 0
}

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
    get: (t, p) => {
      if (typeof p !== 'string') return undefined
      if (p in t) return t[p]
      // any un-stubbed method → a (optionally recording) no-op sink
      return (...args: unknown[]): undefined => {
        if (recording)
          ctxCalls.push({
            name: p,
            args,
            fillStyle: t.fillStyle,
            strokeStyle: t.strokeStyle,
            globalAlpha: t.globalAlpha,
            lineWidth: t.lineWidth,
          })
        return undefined
      }
    },
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
