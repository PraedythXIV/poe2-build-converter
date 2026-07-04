// Web Worker that runs the marble wallpaper's WebGL pipeline off the main thread (spawned by
// mountMarble in marble.ts on browsers with OffscreenCanvas). This file is GLUE only: the whole
// state machine lives in createMarbleWorkerHandler (marbleCore.ts, unit-tested) — here we just wire
// it to the real worker globals (postMessage / requestAnimationFrame / performance.now).

import { createMarbleWorkerHandler, type MarbleWorkerIn, type MarbleWorkerOut } from './marbleCore'

// The DOM lib types `self` as a Window; in a Worker it's a DedicatedWorkerGlobalScope. Narrow it to
// just the members used here (the project's tsconfig doesn't pull in the conflicting webworker lib).
interface WorkerScope {
  postMessage: (message: MarbleWorkerOut) => void
  requestAnimationFrame: (cb: () => void) => number
  cancelAnimationFrame: (id: number) => void
  onmessage: ((e: MessageEvent<MarbleWorkerIn>) => void) | null
}
const scope = self as unknown as WorkerScope

const handle = createMarbleWorkerHandler({
  postFallback: () => scope.postMessage({ type: 'fallback' }),
  now: () => performance.now(),
  requestFrame: (cb) => scope.requestAnimationFrame(cb),
  cancelFrame: (id) => scope.cancelAnimationFrame(id),
})

scope.onmessage = (e) => handle(e.data)
