// The rAF-gated Canvas2D draw path (tree/render.ts + the atlas/genesis views over the shared
// mountTree engine, and interact.ts) is dead under a plain jsdom mount: jsdom returns null from
// getContext('2d'), ships no Path2D / setPointerCapture, reports a 0×0 getBoundingClientRect, and
// never fires <img> onload — so draw() either short-circuits or throws before it runs. This helper
// installs the minimum stubs to let the render path EXECUTE against no-op sinks, then hands back a
// flushRaf() (to run the manually-queued animation frames deterministically) and a restore().
//
// It composes with canvas2d.ts (installCanvas2d makes getContext('2d') return a Proxy sink); each
// caller keeps its own graph fixtures + assertions — only this jsdom scaffolding is shared. Sizes are
// parameterized (callers mount at 900×600 / 960×640 / 800×600). The synchronous Image stub is opt-in
// because it flips render.ts's icon/sprite singletons to loaded (drawImage branches run) — only the
// full render-coverage suite wants it.

import { vi } from 'vitest'
import { installCanvas2d } from './canvas2d'

// jsdom ships no Path2D; every method is a no-op sink (pixels are out of scope). A superset of the 2D
// sub-path methods the tree/atlas/genesis renderers build paths with.
class FakePath2D {
  moveTo(): void {}
  lineTo(): void {}
  arc(): void {}
  ellipse(): void {}
  arcTo(): void {}
  closePath(): void {}
  rect(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
}

// Synchronous <img>: assigning .src fires onload immediately (jsdom never does), so render.ts image
// singletons decode and flip `loaded` before the first flushed draw → the drawImage branches run.
class SyncImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  width = 8
  height = 8
  naturalWidth = 8
  naturalHeight = 8
  private _src = ''
  set src(v: string) {
    this._src = v
    this.onload?.()
  }
  get src(): string {
    return this._src
  }
}

export interface RenderHarness {
  /** Run the queued animation frames (up to `rounds` batches; stops early once the queue drains — a
   *  bounded drain since draw() re-schedules itself while animating). Returns how many callbacks ran,
   *  so a caller can assert draw() actually executed. Any throw in draw() propagates and fails the test. */
  flushRaf(rounds?: number): number
  /** Undo the pointer-capture stubs and the canvas2d 2D-context stub. The Path2D / Image / rAF globals
   *  and the getBoundingClientRect spy are cleaned by the caller's vi.unstubAllGlobals() / restoreAllMocks(). */
  restore(): void
}

export interface RenderHarnessOptions {
  /** getBoundingClientRect width the mounted host reports (jsdom returns 0, which would leave the
   *  viewport unset and draw() short-circuiting). */
  width?: number
  height?: number
  /** Also stub a synchronous Image so render.ts's icon/sprite singletons load and their drawImage
   *  branches run (only the full render-coverage suite needs it). */
  image?: boolean
}

/** Install the Canvas2D render harness the rAF-gated tree/atlas/genesis draw path needs under jsdom:
 *  a no-op 2D context, a Path2D shim, a manual requestAnimationFrame queue, a sized
 *  getBoundingClientRect, no-op pointer capture, and (opt-in) a synchronous Image. */
export function installRenderHarness(opts: RenderHarnessOptions = {}): RenderHarness {
  const width = opts.width ?? 800
  const height = opts.height ?? 600

  const restoreCanvas = installCanvas2d()
  vi.stubGlobal('Path2D', FakePath2D)
  if (opts.image) vi.stubGlobal('Image', SyncImage)

  // draw() is scheduled through requestAnimationFrame; a manual queue lets a test flush the frame
  // deterministically. cancelAnimationFrame nulls the slot by id so a cancelled frame is skipped.
  const queue: Array<FrameRequestCallback | null> = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => queue.push(cb))
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    if (id > 0) queue[id - 1] = null
  })

  // jsdom has no pointer capture; a no-op keeps the drag-start path from throwing. Direct assignment
  // (not vi.spyOn) so we save + restore the originals ourselves.
  const proto = Element.prototype as unknown as Record<string, unknown>
  const origSetPC = proto.setPointerCapture
  const origRelPC = proto.releasePointerCapture
  proto.setPointerCapture = (): void => {}
  proto.releasePointerCapture = (): void => {}

  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON() {},
  } as DOMRect)

  return {
    flushRaf(rounds = 2): number {
      let ran = 0
      for (let i = 0; i < rounds; i++) {
        const batch = queue.splice(0)
        if (batch.length === 0) break
        for (const cb of batch) {
          if (cb) {
            cb(performance.now())
            ran++
          }
        }
      }
      return ran
    },
    restore(): void {
      proto.setPointerCapture = origSetPC
      proto.releasePointerCapture = origRelPC
      restoreCanvas()
    },
  }
}
