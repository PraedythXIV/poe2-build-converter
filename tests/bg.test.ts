// The marble wallpaper must never run on a software (CPU-rasterized) WebGL implementation —
// on GPU-less machines the animated shader melts the main thread (560ms+ TBT measured under
// SwiftShader) instead of being a free ambient background. mountMarble must ask the browser to
// refuse a software context (failIfMajorPerformanceCaveat), taking the static-background
// fallback path instead. Runs in jsdom (vitest environment), where getContext is stubbed.

import { describe, it, expect, vi } from 'vitest'
import { mountMarble } from '../src/bg/marble'

describe('marble background', () => {
  it('requests the WebGL context with failIfMajorPerformanceCaveat (no software rendering)', () => {
    const canvas = document.createElement('canvas')
    const getContext = vi.spyOn(canvas, 'getContext').mockReturnValue(null)
    mountMarble(canvas)
    expect(getContext).toHaveBeenCalledWith('webgl', expect.objectContaining({ failIfMajorPerformanceCaveat: true }))
  })
})
