import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStem, dedupeStems, buildVariantFiles, flaggedFilenames } from '../src/export/builds'
import { parsePob } from '../src/convert/parsePob'
import type { PobBuild } from '../src/convert/types'

const SAMPLE_XML = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')

describe('safeStem', () => {
  it('keeps a clean name as-is', () => {
    expect(safeStem('Levelling')).toBe('Levelling')
    expect(safeStem('Endgame Boss')).toBe('Endgame Boss') // spaces are legal
  })
  it('replaces illegal filesystem characters with "-"', () => {
    expect(safeStem('a/b:c')).toBe('a-b-c')
    expect(safeStem('x|y')).toBe('x-y')
    expect(safeStem('q*?')).toBe('q--')
    expect(safeStem('back\\slash')).toBe('back-slash')
  })
  it('collapses whitespace and strips trailing dots/spaces', () => {
    expect(safeStem('a   b')).toBe('a b')
    expect(safeStem('name...')).toBe('name')
    expect(safeStem('trailing ')).toBe('trailing')
  })
  it('falls back to "build" when empty after cleanup', () => {
    expect(safeStem('')).toBe('build')
    expect(safeStem('   ')).toBe('build')
    expect(safeStem('...')).toBe('build')
  })
})

describe('dedupeStems', () => {
  it('suffixes collisions in order', () => {
    expect(dedupeStems(['a', 'a', 'b'])).toEqual(['a', 'a (2)', 'b'])
  })
  it('is case-insensitive (Windows/macOS filesystems are)', () => {
    expect(dedupeStems(['Boss', 'boss', 'BOSS'])).toEqual(['Boss', 'boss (2)', 'BOSS (3)'])
  })
  it('leaves distinct stems untouched', () => {
    expect(dedupeStems(['x', 'y', 'z'])).toEqual(['x', 'y', 'z'])
  })
})

describe('flaggedFilenames', () => {
  const file = (filename: string, warnings: { level: 'error' | 'warn' | 'info'; code: string; message: string }[]) => ({
    filename,
    json: '{}',
    warnings,
  })
  it('flags files carrying warn- OR error-level diagnostics (info alone stays quiet)', () => {
    const files = [
      file('clean.build', []),
      file('warned.build', [{ level: 'warn', code: 'passive-node-unknown', message: '3 nodes' }]),
      file('errored.build', [{ level: 'error', code: 'bad', message: 'broken' }]),
      file('informed.build', [{ level: 'info', code: 'weapon-set-tagging', message: 'fyi' }]),
    ]
    expect(flaggedFilenames(files)).toEqual(['warned.build', 'errored.build'])
  })
})

describe('buildVariantFiles', () => {
  const base = parsePob(SAMPLE_XML)
  const multi: PobBuild = {
    ...base,
    specs: [base.spec, { ...base.spec, title: 'Levelling', nodes: ['11495'] }],
  }

  it('produces one .build file per variant with unique, safe names', () => {
    const files = buildVariantFiles(multi, [
      { specIndex: 0, skillSetId: '1', itemSetId: '1', name: 'Endgame' },
      { specIndex: 1, skillSetId: '1', itemSetId: '1', name: 'Endgame' }, // same name → deduped
      { specIndex: 1, skillSetId: '1', itemSetId: '1', name: 'a/b' }, // illegal char
    ])
    expect(files.map((f) => f.filename)).toEqual(['Endgame.build', 'Endgame (2).build', 'a-b.build'])
    // each carries real .build JSON
    for (const f of files) expect(JSON.parse(f.json).name).toBeTruthy()
    // the levelling variant (1 node) has far fewer passives than the endgame one
    const endgame = JSON.parse(files[0]!.json).passives.length
    const levelling = JSON.parse(files[1]!.json).passives.length
    expect(levelling).toBeLessThan(endgame)
  })

  it('returns [] for no variants', () => {
    expect(buildVariantFiles(multi, [])).toEqual([])
  })
})
