// The marble wallpaper must never run on a software (CPU-rasterized) WebGL implementation —
// on GPU-less machines the animated shader melts the main thread (560ms+ TBT measured under
// SwiftShader) instead of being a free ambient background. mountMarble must ask the browser to
// refuse a software context (failIfMajorPerformanceCaveat), taking the static-background
// fallback path instead. Runs in jsdom (vitest environment), where getContext is stubbed.

import { describe, it, expect, vi } from 'vitest'
import { mountMarble } from '../src/bg/marble'
import {
  MARBLE_CONTEXT_ATTRS,
  createMarbleRenderer,
  createMarbleWorkerHandler,
  type MarbleWorkerIn,
} from '../src/bg/marbleCore'

// Minimal fake WebGL context — jsdom has no GL, so the program-setup/draw contract is pinned
// against a happy-path double that records buffer sizing + draw calls.
const fakeGl = () => {
  const canvas = { width: 0, height: 0 }
  const calls: string[] = []
  const gl = {
    canvas,
    calls,
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713,
    LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    FLOAT: 5126,
    TRIANGLES: 4,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    useProgram: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    getUniformLocation: () => ({}),
    viewport: () => {
      calls.push('viewport')
    },
    uniform2f: () => {},
    uniform1f: () => {},
    uniform3f: () => {},
    drawArrays: () => {
      calls.push('draw')
    },
  }
  return gl as unknown as WebGLRenderingContext & { calls: string[]; canvas: { width: number; height: number } }
}

// Worker/OffscreenCanvas doubles — jsdom has neither, so the worker path is driven by stubs.
class FakeWorker {
  static instances: FakeWorker[] = []
  posted: unknown[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  postMessage(msg: unknown): void {
    this.posted.push(msg)
  }
  terminate(): void {}
  constructor() {
    FakeWorker.instances.push(this)
  }
}
const offscreenCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  // jsdom has no OffscreenCanvas — a bare object stands in for the transferred handle
  canvas.transferControlToOffscreen = vi.fn(() => ({}) as unknown as OffscreenCanvas)
  return canvas
}

describe('marble background', () => {
  it('shares one context-attrs contract (with the software-rendering refusal) across worker + inline paths', () => {
    expect(MARBLE_CONTEXT_ATTRS.failIfMajorPerformanceCaveat).toBe(true)
  })

  it('requests the WebGL context with failIfMajorPerformanceCaveat (no software rendering)', () => {
    const canvas = document.createElement('canvas')
    const getContext = vi.spyOn(canvas, 'getContext').mockReturnValue(null)
    mountMarble(canvas)
    expect(getContext).toHaveBeenCalledWith('webgl', expect.objectContaining({ failIfMajorPerformanceCaveat: true }))
  })

  it('createMarbleRenderer returns null when a shader fails to compile (no half-built program)', () => {
    const gl = fakeGl()
    gl.getShaderParameter = (() => false) as unknown as typeof gl.getShaderParameter // COMPILE_STATUS false
    expect(createMarbleRenderer(gl)).toBeNull()
  })

  it('compiles a real fragment shader — the marble GLSL is present, not an empty placeholder', () => {
    const gl = fakeGl()
    const sources: string[] = []
    gl.shaderSource = ((_s: unknown, src: string) => sources.push(src)) as unknown as typeof gl.shaderSource
    createMarbleRenderer(gl)
    const fragment = sources.find((s) => s.includes('gl_FragColor')) ?? ''
    // guards against the extraction ever leaving the shader body empty again (the fbm warp + ramp)
    expect([fragment.includes('fbm'), fragment.includes('ramp'), fragment.includes('uAccent')]).toEqual([
      true,
      true,
      true,
    ])
  })

  it('createMarbleRenderer sets up the program; draw() sizes the drawing buffer and paints', () => {
    const gl = fakeGl()
    const renderer = createMarbleRenderer(gl)
    renderer?.draw(320, 200, 1, [1, 0, 0], [0, 0, 0])
    expect([renderer !== null, gl.canvas.width, gl.canvas.height, gl.calls.includes('draw')]).toEqual([
      true,
      320,
      200,
      true,
    ])
  })

  it('hands the canvas to a worker when OffscreenCanvas is supported — no main-thread WebGL', () => {
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
    try {
      const canvas = offscreenCanvas()
      const getContext = vi.spyOn(canvas, 'getContext')
      const handle = mountMarble(canvas)
      expect([FakeWorker.instances.length, getContext.mock.calls.length, handle !== null]).toEqual([1, 0, true])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('inits the worker with the transferred canvas, device-px size and theme colors', () => {
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
    try {
      const canvas = offscreenCanvas()
      mountMarble(canvas)
      // jsdom: CSS vars are unset → the documented fallback hues; layout boxes are 0 until measured live
      expect(FakeWorker.instances[0]!.posted[0]).toMatchObject({
        type: 'init',
        w: expect.any(Number),
        h: expect.any(Number),
        accent: [0.67, 0.11, 0.06],
        base: [0, 0, 0],
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the handle forwards start / stop / recolor to the worker as messages', () => {
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
    try {
      const handle = mountMarble(offscreenCanvas())!
      const worker = FakeWorker.instances[0]!
      handle.start()
      handle.stop()
      handle.recolor()
      // posted[0] is the init; the three commands follow in order
      expect(worker.posted.slice(1)).toEqual([
        { type: 'start', reduced: expect.any(Boolean) },
        { type: 'stop' },
        { type: 'recolor', accent: [0.67, 0.11, 0.06], base: [0, 0, 0] },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows the static CSS background when the worker reports no usable GPU (fallback)', () => {
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
    try {
      const canvas = offscreenCanvas()
      mountMarble(canvas)
      // the worker refused/failed/lost the context and asked the main thread to fall back
      FakeWorker.instances[0]!.onmessage?.({ data: { type: 'fallback' } })
      expect(canvas.style.background).toContain('surface-1')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('forwards window resizes to the worker (the worker can not read the DOM box)', () => {
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
    try {
      mountMarble(offscreenCanvas())
      const worker = FakeWorker.instances[0]!
      window.dispatchEvent(new Event('resize'))
      expect(worker.posted).toContainEqual({ type: 'resize', w: expect.any(Number), h: expect.any(Number) })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// The worker's state machine, unit-tested via a host of injected side-effects (no real Worker /
// OffscreenCanvas / rAF needed). marble.worker.ts is then just the glue that wires the real ones.
describe('marble worker handler', () => {
  const host = () => {
    const rec = { fallbacks: 0, frames: [] as (() => void)[], cancelled: [] as number[] }
    return {
      rec,
      postFallback: () => {
        rec.fallbacks++
      },
      now: () => 0,
      requestFrame: (cb: () => void) => {
        rec.frames.push(cb)
        return rec.frames.length
      },
      cancelFrame: (id: number) => {
        rec.cancelled.push(id)
      },
    }
  }
  const initMsg = (getContext: () => unknown): MarbleWorkerIn => ({
    type: 'init',
    canvas: { getContext, addEventListener: () => {} } as unknown as OffscreenCanvas,
    w: 8,
    h: 8,
    accent: [1, 0, 0],
    base: [0, 0, 0],
  })

  it('posts a fallback when the OffscreenCanvas yields no WebGL context', () => {
    const h = host()
    const handle = createMarbleWorkerHandler(h)
    handle(initMsg(() => null))
    expect(h.rec.fallbacks).toBe(1)
  })

  it('start (motion allowed) paints a frame and schedules the next via requestFrame', () => {
    const h = host()
    const handle = createMarbleWorkerHandler(h)
    let gl: ReturnType<typeof fakeGl> | undefined
    handle(initMsg(() => (gl = fakeGl())))
    handle({ type: 'start', reduced: false })
    expect([h.rec.fallbacks, gl!.calls.includes('draw'), h.rec.frames.length]).toEqual([0, true, 1])
  })

  it('a second start while already running does NOT stack a second rAF loop', () => {
    const h = host()
    const handle = createMarbleWorkerHandler(h)
    handle(initMsg(() => fakeGl()))
    handle({ type: 'start', reduced: false })
    handle({ type: 'start', reduced: false }) // double-start (e.g. rapid toggle during chunk load)
    expect(h.rec.frames.length).toBe(1) // exactly one loop, not two drawing 2×/frame
  })

  it('start after an init fallback (no renderer) stays idle — no perpetual no-op rAF loop', () => {
    const h = host()
    const handle = createMarbleWorkerHandler(h)
    handle(initMsg(() => null)) // no context → postFallback, renderer stays null
    handle({ type: 'start', reduced: false })
    expect(h.rec.frames.length).toBe(0) // GPU-less machines pay nothing, not a 60Hz no-op timer
  })

  it('on webglcontextlost the worker stops the loop and asks the main thread to fall back', () => {
    const h = host()
    const handle = createMarbleWorkerHandler(h)
    const listeners: Record<string, (e: { preventDefault: () => void }) => void> = {}
    const canvas = {
      getContext: () => fakeGl(),
      addEventListener: (t: string, cb: (e: { preventDefault: () => void }) => void) => (listeners[t] = cb),
    } as unknown as OffscreenCanvas
    handle({ type: 'init', canvas, w: 8, h: 8, accent: [1, 0, 0], base: [0, 0, 0] })
    handle({ type: 'start', reduced: false }) // running; raf id 1 pending
    let prevented = false
    listeners['webglcontextlost']!({ preventDefault: () => (prevented = true) })
    // preventDefault (so the browser may restore), loop cancelled, fallback signalled to the main thread
    expect([prevented, h.rec.cancelled, h.rec.fallbacks]).toEqual([true, [1], 1])
  })

  it('stop halts the loop and cancels the pending frame', () => {
    const h = host()
    const handle = createMarbleWorkerHandler(h)
    handle(initMsg(() => fakeGl()))
    handle({ type: 'start', reduced: false }) // raf id 1 is now pending
    handle({ type: 'stop' })
    // the pending frame was cancelled, and re-running the loop callback draws nothing more
    const framesAfterStop = h.rec.frames.length
    h.rec.frames[0]!() // the still-referenced loop callback must no-op now that running=false
    expect([h.rec.cancelled, h.rec.frames.length]).toEqual([[1], framesAfterStop])
  })

  it('recolor repaints once while paused, without starting the loop', () => {
    const h = host()
    const handle = createMarbleWorkerHandler(h)
    let gl: ReturnType<typeof fakeGl> | undefined
    handle(initMsg(() => (gl = fakeGl()))) // init alone does not draw
    handle({ type: 'recolor', accent: [0, 0, 1], base: [0.1, 0.1, 0.1] })
    expect([gl!.calls.includes('draw'), h.rec.frames.length]).toEqual([true, 0])
  })

  it('resize adopts the new device-px size and repaints it while paused', () => {
    const h = host()
    const handle = createMarbleWorkerHandler(h)
    let gl: ReturnType<typeof fakeGl> | undefined
    handle(initMsg(() => (gl = fakeGl()))) // inits at 8×8
    handle({ type: 'resize', w: 500, h: 300 })
    // the repaint sized the drawing buffer to the new dimensions
    expect([gl!.canvas.width, gl!.canvas.height, h.rec.frames.length]).toEqual([500, 300, 0])
  })
})
