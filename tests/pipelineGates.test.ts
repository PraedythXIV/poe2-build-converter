// Pipeline fail-loud gate helpers (scripts/lib.mjs) — the "nothing approximate / never ship a
// truncated dataset" rule as testable units. The builder scripts themselves can't be imported
// (module-level runMain side effects), so the gate BEHAVIOR lives in lib.mjs and the builders wire it.

import { describe, it, expect } from 'vitest'
import { assertFloor, mustResolve } from '../scripts/lib.mjs'

describe('assertFloor (dataset count gate)', () => {
  it('throws when the decoded count shrinks below the floor', () => {
    expect(() => assertFloor(5, 13, 'emotions')).toThrow(/only 5 emotions .* >= 13/)
  })
})

describe('mustResolve (no-fabrication guard)', () => {
  it('throws on an unresolved value instead of letting a placeholder ship', () => {
    expect(() => mustResolve(undefined, 'anoint ingredient 4 for "Charisma"')).toThrow(
      /anoint ingredient 4 for "Charisma"/,
    )
  })
})
