// Marble shader background — ported from ui-component-library #219 "Marble".
// Runs as a fixed, NON-interactive, toggle-able full-viewport WebGL wallpaper.
// Driven by the canvas's own CSS vars, both THEME-DRIVEN: `--accent-rgb` is the vein hue (a deep ember
// red in the dark theme, arcane blue in the light one) and `--bg-marble-base-rgb` is the GROUND the
// veins rise from (black → the classic dark marble; pale → a light marble whose calm field reads light,
// so dark UI text on the bare wallpaper stays legible). It recolours its fluid-warp fbm field by
// luminance through the shared ramp(); recolor() re-reads both on a theme switch.
// The cursor warp / glow / click ripples from the original are removed (pure ambient).
//
// The shader program itself lives in marbleCore.ts (shared with marble.worker.ts). This module is the
// MAIN-THREAD mount: the normal path hands the canvas to a worker (whole WebGL pipeline off the main
// thread); browsers without OffscreenCanvas render inline here via the same shared renderer.

import { createMarbleRenderer, MARBLE_CONTEXT_ATTRS, type Rgb } from './marbleCore'

export interface BgHandle {
  start: () => void
  stop: () => void
  /** Re-read the canvas's `--accent-rgb` and re-hue the shader — call after a theme switch
   *  (the colour is otherwise read once at mount, since it's a fixed background hue). */
  recolor: () => void
}

/** Mount the marble wallpaper on a canvas. The normal path hands the canvas to a Worker via
 *  OffscreenCanvas so the WebGL probe/compile/render never touch the main thread; browsers
 *  without that support take the inline mount below. Returns null if WebGL is unavailable —
 *  or only available as a software rasterizer (see failIfMajorPerformanceCaveat below). */
export function mountMarble(canvas: HTMLCanvasElement): BgHandle | null {
  // the shader colours come from the canvas's own CSS vars: --accent-rgb is the vein hue (red in the
  // dark theme, blue in the light one) and --bg-marble-base-rgb is the GROUND (black by default →
  // the classic dark marble; pale in the light theme → a light marble). Read on the MAIN thread (a
  // worker can't reach the DOM/CSS cascade) and shipped to whichever renderer runs.
  const readColors = (): { accent: Rgb; base: Rgb } => {
    const cs = getComputedStyle(canvas)
    const readRgb = (prop: string, fallback: Rgb): Rgb => {
      const parts = cs
        .getPropertyValue(prop)
        .trim()
        .split(',')
        .map((x) => parseFloat(x) / 255)
      return parts.length === 3 && parts.every((n) => !Number.isNaN(n)) ? [parts[0]!, parts[1]!, parts[2]!] : fallback
    }
    return { accent: readRgb('--accent-rgb', [0.67, 0.11, 0.06]), base: readRgb('--bg-marble-base-rgb', [0, 0, 0]) }
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  const deviceSize = (): { w: number; h: number } => ({
    w: Math.max(1, Math.round(canvas.clientWidth * dpr)),
    h: Math.max(1, Math.round(canvas.clientHeight * dpr)),
  })

  if (typeof Worker === 'function' && typeof canvas.transferControlToOffscreen === 'function') {
    // Normal path: run the whole WebGL pipeline (probe → compile → render loop) in a Worker so the
    // context creation cost + every frame stay off the main thread — the page stays responsive and
    // the ambient wallpaper never shows up in main-thread blocking-time metrics.
    const offscreen = canvas.transferControlToOffscreen()
    const worker = new Worker(new URL('./marble.worker.ts', import.meta.url), { type: 'module' })
    const { accent, base } = readColors()
    const { w, h } = deviceSize()
    worker.postMessage({ type: 'init', canvas: offscreen, w, h, accent, base }, [offscreen])
    // the worker owns the WebGL probe now; if it can't get a (non-software) context it asks us to
    // reveal the static CSS background instead — the one thing only the main thread can still do
    // once the canvas is transferred (CSS styling survives, drawing does not).
    worker.onmessage = (e: MessageEvent<{ type?: string }>): void => {
      if (e.data?.type === 'fallback') canvas.style.background = 'var(--surface-1)'
    }
    // the worker can't read the DOM box, so the main thread measures on resize and posts the new size
    window.addEventListener('resize', () => {
      const size = deviceSize()
      worker.postMessage({ type: 'resize', w: size.w, h: size.h })
    })
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
    return {
      start() {
        worker.postMessage({ type: 'start', reduced: !!mq?.matches })
      },
      stop() {
        worker.postMessage({ type: 'stop' })
      },
      recolor() {
        worker.postMessage({ type: 'recolor', ...readColors() })
      },
    }
  }
  // Inline fallback (no OffscreenCanvas): run the same shared renderer on the main thread.
  // MARBLE_CONTEXT_ATTRS carries failIfMajorPerformanceCaveat — a software (CPU-rasterized) context
  // is worse than none for an ambient wallpaper, so GPU-less machines fall through to the static bg.
  const gl = canvas.getContext('webgl', MARBLE_CONTEXT_ATTRS)
  const renderer = gl && createMarbleRenderer(gl)
  if (!gl || !renderer) {
    canvas.style.background = 'var(--surface-1)'
    return null
  }

  const t0 = performance.now()
  // colours read once on mount + on demand (recolor()) — NOT per frame: they're fixed background hues,
  // so a per-frame getComputedStyle would be a needless hot path; a theme switch calls recolor().
  let { accent, base } = readColors()
  // Cache the canvas's CSS box and re-measure only on resize — NOT every frame. Reading clientWidth/Height
  // inside the rAF loop forces the browser to flush layout each frame (a "forced reflow"); the #bg canvas is
  // fixed full-viewport, so its box changes only when the window resizes.
  let cw = 0
  let ch = 0
  const measure = (): void => {
    cw = canvas.clientWidth
    ch = canvas.clientHeight
  }
  measure()
  const draw = (): void => {
    if (!cw || !ch) measure() // self-heal: the first frame(s) before layout may report 0, re-read until valid
    if (!cw || !ch) return
    // the renderer sizes the drawing buffer + viewport itself; we just feed device px, time and hues
    renderer.draw(
      Math.max(1, Math.round(cw * dpr)),
      Math.max(1, Math.round(ch * dpr)),
      (performance.now() - t0) / 1000,
      accent,
      base,
    )
  }

  const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  let raf = 0
  let running = false
  const cancelRaf = (): void => {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
  const loop = (): void => {
    if (!running) return
    draw()
    raf = requestAnimationFrame(loop)
  }
  // reduced-motion paints one frame with no loop; a resize then needs a manual repaint
  const onResize = (): void => {
    measure() // refresh the cached box — the running loop picks it up next frame
    if (!running && mq?.matches) draw()
  }
  window.addEventListener('resize', onResize)
  // if the GPU drops the context, stop cleanly (the canvas falls back to its CSS bg)
  // instead of every gl.* call erroring each frame — and drop our listeners, since the
  // context is gone for good (this also bounds listener lifetime, avoiding accumulation)
  const onContextLost = (e: Event): void => {
    e.preventDefault()
    running = false
    cancelRaf()
    window.removeEventListener('resize', onResize)
    canvas.removeEventListener('webglcontextlost', onContextLost)
  }
  canvas.addEventListener('webglcontextlost', onContextLost)
  return {
    start() {
      if (running) return
      if (mq?.matches) {
        draw() // one static frame, no animation — reduced-motion re-checked live each start
      } else {
        running = true
        loop()
      }
    },
    stop() {
      running = false
      cancelRaf()
    },
    recolor() {
      ;({ accent, base } = readColors())
      // repaint immediately so the new hue shows even while paused (reduced-motion / not running)
      if (!running) draw()
    },
  }
}
