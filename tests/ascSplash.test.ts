// Phase 6 Agent C — class/ascendancy splash (ascSplash.ts). renderAscSplash is PURE
// ({ hidden, html } out of className/ascendancyId/classIndex/graph), so every degradation branch is
// driven by a direct call — the real vendored graph for identity/art, a tiny cast fake graph for the
// flavour permutations the real data never exercises (all real ascendancies ship a string quote + a
// valid colour). No canvas/DOM harness: this module writes no DOM.

import { describe, it, expect } from 'vitest'
import { renderAscSplash, ensureClassNameIndex, classIndexForName } from '../src/tree/ascSplash'
import { loadGraph, listClasses } from '../src/tree/graph'

describe('classIndexForName — lazy class-name → index map', () => {
  it('is null before the map is built, resolves (case/space tolerant) after, null for unknowns', () => {
    const classes = listClasses()
    const c0 = classes[0]!
    // fresh module: CLASS_NAME_TO_INDEX starts null → every lookup is null until ensureClassNameIndex
    expect(classIndexForName(c0.name)).toBeNull() // L47 !CLASS_NAME_TO_INDEX short-circuit
    expect(classIndexForName(null)).toBeNull() // L47 !className short-circuit
    ensureClassNameIndex(classes)
    expect(classIndexForName(c0.name)).toBe(c0.idx) // L48 map hit
    expect(classIndexForName(`  ${c0.name.toUpperCase()}  `)).toBe(c0.idx) // trim + lowercase tolerant
    expect(classIndexForName('__no_such_class__')).toBeNull() // L48 `?? null` miss
  })
})

describe('renderAscSplash — class art frame resolution', () => {
  it('omits art when the class index is null or unmapped, renders it when a frame exists', () => {
    const g = loadGraph()
    // classIndex null → classArtFrame short-circuits (L57 === null); no ascendancy → text-only card
    const noIdx = renderAscSplash('Warrior', null, null, g)
    expect(noIdx.hidden).toBe(false)
    expect(noIdx.html).not.toContain('asc-splash-frame') // L111/L139 no-art branch
    expect(noIdx.html).not.toContain('asc-splash-asc') // ascendancy absent
    // classIndex 99 → byClass has no such key → frameForPath(undefined) returns null (L58, L53 `|| null`)
    const unmapped = renderAscSplash('Warrior', null, 99, g)
    expect(unmapped.html).not.toContain('asc-splash-frame')
    // classIndex 2 (Warrior) → byClass['2'] has a real frame (L58) → windowed art span present
    const withArt = renderAscSplash('Warrior', null, 2, g)
    expect(withArt.html).toContain('asc-splash-frame')
    expect(withArt.html).toContain('asc-splash-art')
  })
})

describe('renderAscSplash — unknown ascendancy id', () => {
  it('falls back to the class identity when the ascendancy id is absent from the graph', () => {
    const g = loadGraph()
    // 'BogusAsc' not in graph.ascendancies → asc null (L99 `?? null`), ascName null (L100 `?? null`)
    const r = renderAscSplash('Warrior', 'BogusAsc', 2, g)
    expect(r.hidden).toBe(false)
    expect(r.html).not.toContain('asc-splash-asc') // no ascendancy name span
    expect(r.html).toContain('asc-splash-cls') // class name span present
    expect(r.html).toContain('aria-label="Warrior class"') // classLabel path (ascName null)
  })
})

describe('renderAscSplash — identity-driven degradation', () => {
  it('hides when nameless; ascendancy-only drops the class span; class-only uses the class label', () => {
    const g = loadGraph()
    // no class AND no ascendancy name → overlay cleared entirely (L107/L108)
    expect(renderAscSplash(null, null, null, g)).toEqual({ hidden: true, html: '' })
    // ascendancy-only (className null) → no class span, ascLabel with NO "(class)" suffix (L114/L135)
    const monk = g.ascendancies.get('Monk1')!
    const ascOnly = renderAscSplash(null, 'Monk1', null, g)
    expect(ascOnly.hidden).toBe(false)
    expect(ascOnly.html).not.toContain('asc-splash-cls')
    expect(ascOnly.html).toContain('asc-splash-asc')
    expect(ascOnly.html).toContain(`aria-label="${monk.name} ascendancy"`)
    // class-only (ascName null) → classLabel branch, className kept (L134 else, L136 `?? fallback`)
    const classOnly = renderAscSplash('Warrior', null, null, g)
    expect(classOnly.html).toContain('aria-label="Warrior class"')
    expect(classOnly.html).not.toContain('asc-splash-asc')
  })
})

describe('renderAscSplash — flavour quote permutations (cast fake graph)', () => {
  it('joins array lines, applies a valid 6-hex colour, and omits missing flavour / invalid colour', () => {
    type Graph = ReturnType<typeof loadGraph>
    const fake = (asc: { name: string; flavourText?: string | string[]; flavourTextColour?: string }): Graph =>
      ({ ascendancies: new Map([['FA', { id: 'FA', ...asc }]]) }) as unknown as Graph

    // array flavourText → lines joined with <br />; a clean 6-hex colour → the --asc-flav style (L122/L125)
    const arr = renderAscSplash('C', 'FA', null, fake({ name: 'X', flavourText: ['L1', 'L2'], flavourTextColour: 'FF0000' }))
    expect(arr.html).toContain('asc-splash-quote')
    expect(arr.html).toContain('L1<br />L2')
    expect(arr.html).toContain('--asc-flav: #ff0000') // sanitized to lowercase

    // no flavourText at all → no quote node (L122 `?? ''`, L123 empty guard)
    const none = renderAscSplash('C', 'FA', null, fake({ name: 'X' }))
    expect(none.html).not.toContain('asc-splash-quote')

    // flavour present but NO colour → quote without the colour style (L81 raw falsy, L125 `''`)
    const noColour = renderAscSplash('C', 'FA', null, fake({ name: 'X', flavourText: 'Hello' }))
    expect(noColour.html).toContain('asc-splash-quote')
    expect(noColour.html).toContain('Hello')
    expect(noColour.html).not.toContain('--asc-flav')
  })
})
