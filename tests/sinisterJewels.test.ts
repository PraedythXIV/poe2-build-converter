// Sinister Jewel Sockets — extra jewel sockets granted in-game by uniques (Voices) or the Zarokh's Gift
// anoint, NOT by the passive tree, so their node ids never appear in PoB's <Spec nodes>. Pins the two
// fixes for a real owner build (Voices + Heart of the Well + Prism of Belief + 3 rare sinister jewels):
//   1. mapPassives must carry a jewel socketed in a granted (non-allocated) socket, not silently drop it.
//   2. the vendored tree must ship the resolved "Sinister Jewel Socket" name, not GGG's raw [tag|Display].

import { describe, it, expect } from 'vitest'
import { mapPassives } from '../src/convert/mapPassives'
import type { PobBuild, Warning } from '../src/convert/types'
import type { PobItem } from '../src/pob/model'
import { emptySpec } from './helpers/pobBuild'
import treeGraph from '../src/data/treeGraph.json'

// A real Sinister Jewel Socket node id (one of the five). Granted by Voices / Zarokh's Gift in-game.
const SINISTER_SOCKET = '62152'

describe('sinister jewel sockets', () => {
  it('carries a jewel from a granted (non-allocated) Sinister Jewel Socket instead of dropping it', () => {
    const pob = {
      spec: emptySpec({
        treeVersion: '0_5',
        nodes: [], // the sinister socket is NOT allocated — Voices/Zarokh grant it dynamically
        sockets: [{ nodeId: SINISTER_SOCKET, itemId: '7' }],
      }),
      items: new Map([['7', { name: 'Apocalypse Essence' } as unknown as PobItem]]),
    } as unknown as PobBuild

    const warnings: Warning[] = []
    const { passives } = mapPassives(pob, warnings)
    const carried = passives.find(
      (p) => typeof p !== 'string' && (p.additional_text ?? '').includes('Apocalypse Essence'),
    )
    expect(
      carried,
      'a jewel in a granted sinister socket must survive even though its node is unallocated',
    ).toBeDefined()
    expect(warnings.some((w) => w.code === 'granted-socket-jewels')).toBe(true)
  })

  it('ships resolved Sinister Jewel Socket names — no raw [tag|Display] markup', () => {
    const nodes = (treeGraph as { nodes: Record<string, { name?: string }> }).nodes
    expect(nodes[SINISTER_SOCKET]?.name).toBe('Sinister Jewel Socket')
    const withMarkup = Object.values(nodes).filter((n) => typeof n.name === 'string' && /\[[^\]]+\]/.test(n.name))
    expect(withMarkup, 'no node name should ship with unresolved [tag] markup').toHaveLength(0)
  })
})
