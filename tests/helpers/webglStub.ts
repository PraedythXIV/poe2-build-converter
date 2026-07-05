// jsdom has no WebGL, no Worker, and no OffscreenCanvas — so the marble background's program-setup /
// draw contract and its worker-offload path both need happy-path doubles. Shared by bg.test.ts (the
// worker path + the shared renderer) and marbleMount.test.ts (the inline main-thread fallback).
//
// fakeGl records buffer sizing (gl.canvas.width/height) + a call log ('viewport' / 'draw'), and — so
// colour flow is observable — the uAccent/uBase vec3s each draw feeds the shader (keyed by the tagged
// uniform locations). `compileOk: false` forces getShaderParameter to report a compile failure so
// createMarbleRenderer returns null (the static-background fallback).

import { vi } from 'vitest'

export type FakeGl = WebGLRenderingContext & {
  calls: string[]
  uni: Record<string, [number, number, number]>
  canvas: { width: number; height: number }
}

export function fakeGl(opts: { compileOk?: boolean } = {}): FakeGl {
  const canvas = { width: 0, height: 0 }
  const calls: string[] = []
  const uni: Record<string, [number, number, number]> = {}
  const gl = {
    canvas,
    calls,
    uni,
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
    getShaderParameter: () => opts.compileOk !== false, // COMPILE_STATUS — false forces a renderer failure
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
    getUniformLocation: (_p: unknown, name: string) => ({ name }), // tag locations so uniform3f can record by name
    viewport: () => {
      calls.push('viewport')
    },
    uniform2f: () => {},
    uniform1f: () => {},
    uniform3f: (loc: { name: string }, a: number, b: number, c: number) => {
      uni[loc.name] = [a, b, c]
    },
    drawArrays: () => {
      calls.push('draw')
    },
  }
  return gl as unknown as FakeGl
}

// Worker / OffscreenCanvas doubles — jsdom has neither, so the worker-offload path is driven by stubs.
export class FakeWorker {
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

export const offscreenCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  // jsdom has no OffscreenCanvas — a bare object stands in for the transferred handle
  canvas.transferControlToOffscreen = vi.fn(() => ({}) as unknown as OffscreenCanvas)
  return canvas
}
