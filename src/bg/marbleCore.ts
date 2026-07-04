// Marble shader core — ported from ui-component-library #219 "Marble". PURE WebGL, no DOM: this
// shared renderer runs inside marble.worker.ts against an OffscreenCanvas (the normal path) and on
// the main thread in marble.ts (the inline fallback for browsers without OffscreenCanvas). It
// recolours its fluid-warp fbm field by luminance through ramp(): `--accent-rgb` (uAccent) is the
// vein hue, `--bg-marble-base-rgb` (uBase) the ground the veins rise from. The worker message
// protocol lives here too, so both sides share one definition.

export type Rgb = [number, number, number]

const PRELUDE = `precision highp float;
uniform vec2  uResolution;
uniform float uTime;
uniform vec3  uAccent;
uniform vec3  uBase;
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++){ v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
vec3 ramp(float t){
  t = clamp(t, 0.0, 1.0);
  float k = mix(0.05, 0.9, smoothstep(0.0, 0.88, t)) + smoothstep(0.85, 1.0, t) * 0.5;
  // Blend from the GROUND (uBase) up to the accent vein hue. uBase is BLACK in the dark theme, which
  // makes this reduce EXACTLY to the original uAccent*k (mix(0,a,min(k,1)) + a*max(k-1,0) == a*k); the
  // light theme passes a PALE uBase so the marble reads as a light field with accent veins (so dark
  // UI text that sits on the bare wallpaper, e.g. the nav/stepper, stays legible).
  return mix(uBase, uAccent, min(k, 1.0)) + uAccent * max(k - 1.0, 0.0);
}
`

const MARBLE = `void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  float t = uTime * 0.03; // slow ambient drift (the library default 0.1 was too fast)
  vec2 p = uv * 1.4;
  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) + t));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + t * 0.8), fbm(p + 4.0 * q + vec2(8.3, 2.8) + t * 1.1));
  float f = fbm(p + 4.0 * r);
  float e = smoothstep(0.0, 0.6, f) * 0.42 + smoothstep(0.62, 0.95, f * f) * 0.52;
  e += smoothstep(0.75, 1.05, length(r)) * 0.45;        // bright veins
  e *= 1.0 - smoothstep(0.45, 1.55, length(uv));         // vignette toward the edges
  e += (hash21(gl_FragCoord.xy + uTime) - 0.5) * 0.03;   // film grain
  vec3 col = ramp(clamp(e, 0.0, 1.2));
  gl_FragColor = vec4(col, 1.0);
}
`

/** WebGL context attributes for the wallpaper — shared by the worker and the inline fallback.
 *  failIfMajorPerformanceCaveat: a software (CPU-rasterized) context is worse than no context —
 *  an ambient wallpaper must be free, and on GPU-less machines (old hardware, VMs, remote
 *  desktops, blocklisted drivers) the animated shader melts the CPU for a decoration. Those
 *  machines take the static-background fallback instead; GPU machines are unaffected. */
export const MARBLE_CONTEXT_ATTRS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  failIfMajorPerformanceCaveat: true,
}

export interface MarbleRenderer {
  /** Size the drawing buffer to W×H device px if needed, then paint one frame. */
  draw: (W: number, H: number, tSeconds: number, accent: Rgb, base: Rgb) => void
}

/** Compile + link the marble program on an existing context. Returns null if any GL step fails
 *  (the caller falls back to a static background). */
export function createMarbleRenderer(gl: WebGLRenderingContext): MarbleRenderer | null {
  const compile = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      // a broken/empty shader must fail the whole renderer (→ static-bg fallback), not build a
      // half-formed program that silently draws nothing
      console.warn('[bg] shader', gl.getShaderInfoLog(s))
      return null
    }
    return s
  }
  const vs = compile(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}')
  const fs = compile(gl.FRAGMENT_SHADER, PRELUDE + MARBLE)
  const prog = gl.createProgram()
  if (!vs || !fs || !prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[bg] link failed', gl.getProgramInfoLog(prog))
    return null
  }
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  if (!buf) return null
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const al = gl.getAttribLocation(prog, 'p')
  if (al === -1) return null // attribute 'p' not found / optimised out — can't bind the fullscreen tri
  gl.enableVertexAttribArray(al)
  gl.vertexAttribPointer(al, 2, gl.FLOAT, false, 0, 0)
  const uRes = gl.getUniformLocation(prog, 'uResolution')
  const uTime = gl.getUniformLocation(prog, 'uTime')
  const uAccent = gl.getUniformLocation(prog, 'uAccent')
  const uBase = gl.getUniformLocation(prog, 'uBase')

  return {
    draw(W, H, tSeconds, accent, base) {
      if (!W || !H) return
      const canvas = gl.canvas // HTMLCanvasElement or OffscreenCanvas — both size the same way
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
        gl.viewport(0, 0, W, H)
      }
      gl.uniform2f(uRes, W, H)
      gl.uniform1f(uTime, tSeconds)
      gl.uniform3f(uAccent, accent[0], accent[1], accent[2])
      gl.uniform3f(uBase, base[0], base[1], base[2])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
  }
}

// ── worker message protocol (marble.ts ⇄ marble.worker.ts) ──────────────────────────────────
export type MarbleWorkerIn =
  | { type: 'init'; canvas: OffscreenCanvas; w: number; h: number; accent: Rgb; base: Rgb }
  | { type: 'start'; reduced: boolean }
  | { type: 'stop' }
  | { type: 'recolor'; accent: Rgb; base: Rgb }
  | { type: 'resize'; w: number; h: number }

/** fallback: no usable GPU context (refused, failed, or lost) — show the static background */
export type MarbleWorkerOut = { type: 'fallback' }

/** Side-effects the worker handler needs, injected so the state machine is unit-testable without a
 *  real Worker / OffscreenCanvas / requestAnimationFrame. marble.worker.ts supplies the real ones. */
export interface MarbleWorkerHost {
  postFallback: () => void
  now: () => number
  requestFrame: (cb: () => void) => number
  cancelFrame: (id: number) => void
}

/** Build the worker's message handler. Owns the render state (renderer, size, colours, rAF loop)
 *  and drives the shared MarbleRenderer; asks the host to postFallback when no GPU is available. */
export function createMarbleWorkerHandler(host: MarbleWorkerHost): (msg: MarbleWorkerIn) => void {
  let renderer: MarbleRenderer | null = null
  let w = 0
  let h = 0
  let accent: Rgb = [0.67, 0.11, 0.06]
  let base: Rgb = [0, 0, 0]
  let t0 = 0
  let running = false
  let raf = 0

  const draw = (): void => {
    renderer?.draw(w, h, (host.now() - t0) / 1000, accent, base)
  }
  const loop = (): void => {
    if (!running) return
    draw()
    raf = host.requestFrame(loop)
  }

  return (msg) => {
    if (msg.type === 'init') {
      w = msg.w
      h = msg.h
      accent = msg.accent
      base = msg.base
      const gl = msg.canvas.getContext('webgl', MARBLE_CONTEXT_ATTRS) as WebGLRenderingContext | null
      if (!gl) {
        host.postFallback()
        return
      }
      renderer = createMarbleRenderer(gl)
      if (!renderer) {
        host.postFallback()
        return
      }
      t0 = host.now()
      // if the GPU drops the context (driver reset, GPU-process crash, too many live contexts), WebGL
      // calls silently no-op forever — so stop the loop and ask the main thread to reveal the static
      // background, matching the inline path's clean degrade (the worker can't style the canvas itself).
      msg.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault()
        running = false
        if (raf) host.cancelFrame(raf)
        raf = 0
        renderer = null
        host.postFallback()
      })
    } else if (msg.type === 'start') {
      if (!renderer) return // init fell back (no GPU) — stay idle, don't spin a no-op rAF loop
      // reduced-motion paints one static frame; otherwise run the animation loop
      if (msg.reduced) {
        draw()
      } else {
        if (running) return // already looping — a second start must not stack a second rAF chain
        running = true
        loop()
      }
    } else if (msg.type === 'stop') {
      running = false
      if (raf) host.cancelFrame(raf)
      raf = 0
    } else if (msg.type === 'recolor') {
      accent = msg.accent
      base = msg.base
      if (!running) draw() // repaint immediately so the new hue shows even while paused
    } else if (msg.type === 'resize') {
      w = msg.w
      h = msg.h
      if (!running) draw() // the running loop picks up the new size next frame; when paused, repaint now
    }
  }
}
