// Marble shader background — ported from ui-component-library #219 "Marble".
// Runs as a fixed, NON-interactive, toggle-able full-viewport WebGL wallpaper.
// Driven RED via the canvas's own `--accent-rgb` (not the gold brand accent): the
// shader recolours its fluid-warp fbm field by luminance through the shared ramp().
// The cursor warp / glow / click ripples from the original are removed (pure ambient).

const PRELUDE = `precision highp float;
uniform vec2  uResolution;
uniform float uTime;
uniform vec3  uAccent;
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
  // ONLY shades of the (red) accent: pure brightness modulation — no hue shift toward
  // orange, no blend toward white. Every pixel is the same red, just lighter/darker.
  float k = mix(0.05, 0.9, smoothstep(0.0, 0.88, t)) + smoothstep(0.85, 1.0, t) * 0.5;
  return uAccent * k;
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

export interface BgHandle {
  start: () => void
  stop: () => void
}

/** Mount the marble wallpaper on a canvas. Returns null if WebGL is unavailable. */
export function mountMarble(canvas: HTMLCanvasElement): BgHandle | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false })
  if (!gl) {
    canvas.style.background = 'var(--surface-1)'
    return null
  }
  const compile = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('[bg] shader', gl.getShaderInfoLog(s))
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
    canvas.style.background = 'var(--surface-1)'
    return null
  }
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const al = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(al)
  gl.vertexAttribPointer(al, 2, gl.FLOAT, false, 0, 0)
  const uRes = gl.getUniformLocation(prog, 'uResolution')
  const uTime = gl.getUniformLocation(prog, 'uTime')
  const uAccent = gl.getUniformLocation(prog, 'uAccent')

  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  const t0 = performance.now()
  // the shader colour comes from the canvas's own --accent-rgb (a red). Read ONCE — it's
  // a fixed background hue, so a per-frame getComputedStyle would be a needless hot path.
  const accent = ((): [number, number, number] => {
    const parts = getComputedStyle(canvas).getPropertyValue('--accent-rgb').trim().split(',').map((x) => parseFloat(x) / 255)
    return parts.length === 3 && parts.every((n) => !Number.isNaN(n)) ? [parts[0]!, parts[1]!, parts[2]!] : [0.67, 0.11, 0.06]
  })()
  const draw = (): void => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    const W = Math.max(1, Math.round(w * dpr))
    const H = Math.max(1, Math.round(h * dpr))
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W
      canvas.height = H
      gl.viewport(0, 0, W, H)
    }
    gl.uniform2f(uRes, W, H)
    gl.uniform1f(uTime, (performance.now() - t0) / 1000)
    gl.uniform3f(uAccent, accent[0], accent[1], accent[2])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  let raf = 0
  let running = false
  const loop = (): void => {
    if (!running) return
    draw()
    raf = requestAnimationFrame(loop)
  }
  // reduced-motion paints one frame with no loop; a resize then needs a manual repaint
  const onResize = (): void => {
    if (!running && mq?.matches) draw()
  }
  window.addEventListener('resize', onResize)
  // if the GPU drops the context, stop cleanly (the canvas falls back to its CSS bg)
  // instead of every gl.* call erroring each frame
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    running = false
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  })
  return {
    start() {
      if (running) return
      running = true
      if (mq?.matches) {
        draw() // one static frame, no animation — reduced-motion re-checked live each start
        running = false
      } else {
        loop()
      }
    },
    stop() {
      running = false
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    },
  }
}
