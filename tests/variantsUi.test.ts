import { describe, it, expect } from 'vitest'
import { renderVariantRows, defaultVariantRow } from '../src/convert/variantsUi'
import { convertVariant } from '../src/convert/index'
import { emptyPobBuild, emptySpec } from './helpers/pobBuild'

describe('variant spec labels', () => {
  it('appends each spec tree version to its label when the PoB mixes tree versions', () => {
    const s1 = emptySpec({ title: 'Main', treeVersion: '0_3', nodes: ['1'] })
    const s2 = emptySpec({ title: 'Levelling', treeVersion: '0_2', nodes: ['2'] })
    const pob = emptyPobBuild({ specs: [s1, s2], spec: s1 })
    const html = renderVariantRows(pob, [defaultVariantRow(pob, 1)])
    expect(html).toContain('tree 0_3')
    expect(html).toContain('tree 0_2')
  })
})

describe('convertVariant on a mixed-tree-version PoB', () => {
  it('emits a mixed-tree-versions warning', () => {
    const s1 = emptySpec({ title: 'Main', treeVersion: '0_3', nodes: [] })
    const s2 = emptySpec({ title: 'Levelling', treeVersion: '0_2', nodes: [] })
    const pob = emptyPobBuild({ specs: [s1, s2], spec: s1 })
    const r = convertVariant(pob, { specIndex: 0, skillSetId: '', itemSetId: '', name: 'Main' })
    expect(r.warnings.some((w) => w.code === 'mixed-tree-versions')).toBe(true)
  })
})
