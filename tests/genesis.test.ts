// Genesis Tree ("Brequel") — graph integrity, the live editable view, and the crafting reference.
// Geometry/stat correctness is gated upstream by scripts/build-genesis-graph.mjs; these tests pin
// the contracts the UI relies on (5 disconnected subtrees, root seeding, share round-trip, data join).

import { describe, it, expect } from 'vitest'
import { mountGenesisTree, genesisGraph, genesisRootIds, GENESIS_SUBTREES } from '../src/genesis/index'
import type { TreeView } from '../src/tree/index'
import { wombTooltipHtml } from '../src/genesis/crafting'
import { encodeAtlasPlan, decodeAtlasPlan } from '../src/atlas/share'
import { collectStats } from '../src/atlas/statsPanel'
import craftingData from '../src/data/genesisCrafting.json'
import genesisIcons from '../src/data/genesisIcons.json'

describe('genesis graph data', () => {
  it('has exactly 5 subtrees, each rooted at its Womb keystone (the seed)', () => {
    expect(GENESIS_SUBTREES).toHaveLength(5)
    const ids = GENESIS_SUBTREES.map((s) => s.id).sort()
    expect(ids).toEqual(['Amulets', 'Belts', 'Breachstones', 'Currency', 'Rings'])
    for (const sub of GENESIS_SUBTREES) {
      const root = genesisGraph.nodes[sub.root]
      expect(root, `root ${sub.root} for ${sub.id}`).toBeDefined()
      expect(root!.keystone).toBe(true) // the Womb IS the start/seed
      expect(root!.subTree).toBe(sub.id)
    }
  })

  it('flags exactly 5 Womb seed ids (one per subtree) and drops the StartNodes', () => {
    const roots = genesisRootIds()
    expect(roots).toHaveLength(5)
    expect(new Set(roots).size).toBe(5)
    expect(roots.every((id) => genesisGraph.nodes[id]?.keystone === true)).toBe(true)
    // the StartNode leaves are gone — no node is named "...StartNode"
    expect(Object.values(genesisGraph.nodes).some((n) => /StartNode/i.test(n.id))).toBe(false)
  })

  it('tags every node with a known subtree', () => {
    const subIds = new Set(GENESIS_SUBTREES.map((s) => s.id))
    for (const node of Object.values(genesisGraph.nodes)) {
      expect(subIds.has(node.subTree)).toBe(true)
    }
  })

  it('packs an icon rect for every distinct node icon path', () => {
    const icons = genesisIcons as unknown as Record<string, unknown>
    const distinct = [
      ...new Set(
        Object.values(genesisGraph.nodes)
          .map((n) => n.icon)
          .filter(Boolean),
      ),
    ]
    expect(distinct.length).toBeGreaterThan(0)
    for (const path of distinct) {
      expect(icons[path], `icon sheet missing ${path}`).toBeDefined()
    }
  })

  it('gives the 5 Womb keystones the real socket art, never the blank placeholder', () => {
    const wombs = Object.values(genesisGraph.nodes).filter((n) => n.keystone)
    expect(wombs).toHaveLength(5)
    for (const w of wombs) {
      expect(w.icon).toMatch(/inventoryslot/i) // the real Breach-tree womb egg/socket
      expect(w.iconUncropped).toBe(true)
      expect(w.icon).not.toMatch(/masteryblank/i) // no placeholder
    }
    // no node anywhere keeps the blank placeholder icon
    for (const n of Object.values(genesisGraph.nodes)) expect(n.icon).not.toMatch(/masteryblank/i)
  })

  it('leaves no resolvable stat as a raw "stat_id = value" fallback line', () => {
    const RAW = /^[a-z][a-z0-9_]*(?:_%)? = -?\d/
    for (const node of Object.values(genesisGraph.nodes)) {
      for (const s of node.stats) expect(RAW.test(s), `raw stat on ${node.id}: ${s}`).toBe(false)
    }
  })

  it('is 5 disconnected components — each subtree paths only from its own root', () => {
    const adj = new Map<string, string[]>()
    for (const id of Object.keys(genesisGraph.nodes)) adj.set(id, [])
    for (const e of genesisGraph.edges) {
      adj.get(String(e.from))?.push(String(e.to))
      adj.get(String(e.to))?.push(String(e.from))
    }
    const seen = new Set<string>()
    const components: string[] = []
    for (const start of Object.keys(genesisGraph.nodes)) {
      if (seen.has(start)) continue
      const subs = new Set<string>()
      const stack = [start]
      while (stack.length) {
        const x = stack.pop()!
        if (seen.has(x)) continue
        seen.add(x)
        subs.add(genesisGraph.nodes[x]!.subTree)
        for (const y of adj.get(x) ?? []) if (!seen.has(y)) stack.push(y)
      }
      // every connected component belongs to exactly one subtree
      expect(subs.size).toBe(1)
      components.push([...subs][0]!)
    }
    expect(components.sort()).toEqual(['Amulets', 'Belts', 'Breachstones', 'Currency', 'Rings'])
  })
})

describe('mountGenesisTree (live editable view)', () => {
  /** Mount an editable view + pick a (womb, one-hop neighbour) pair off the graph — the shared
   *  setup for the cascade/auto-path/seed/codec tests. `allocateRoots` starts with the 5 wombs
   *  on (the seed tests) instead of empty. Caller destroys view + removes container. */
  function mountWithWombPair(allocateRoots = false): {
    container: HTMLElement
    view: TreeView
    roots: Set<string>
    womb: string
    neighbor: string
  } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = mountGenesisTree(container, { editable: true })
    const roots = new Set(genesisRootIds())
    const edge = genesisGraph.edges.find((e) => roots.has(String(e.from)) !== roots.has(String(e.to)))!
    const womb = roots.has(String(edge.from)) ? String(edge.from) : String(edge.to)
    const neighbor = womb === String(edge.from) ? String(edge.to) : String(edge.from)
    view.setBuild({ allocated: allocateRoots ? [...roots] : [] })
    return { container, view, roots, womb, neighbor }
  }

  it('starts with NOTHING allocated; each Womb is a toggleable root (allocate then deallocate)', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = mountGenesisTree(container, { editable: true })
    view.setBuild({ allocated: [] })
    expect(view.getAllocated().size).toBe(0) // nothing on by default — wombs are not auto-allocated

    const womb = genesisRootIds()[0]!
    view.toggle(womb) // a root: allocatable DIRECTLY, no path
    expect(view.getAllocated().has(womb)).toBe(true)
    view.toggle(womb) // and deallocatable (unlike an always-on seed)
    expect(view.getAllocated().has(womb)).toBe(false)
    expect(view.getAllocated().size).toBe(0)
    view.destroy()
    container.remove()
  })

  it('deallocating a Womb cascades its allocated subtree away', () => {
    const { container, view, womb, neighbor } = mountWithWombPair()
    view.toggle(womb)
    view.toggle(neighbor)
    expect(view.getAllocated().has(neighbor)).toBe(true)
    view.toggle(womb) // remove the root → its subtree is orphaned
    expect(view.getAllocated().has(neighbor)).toBe(false)
    expect(view.getAllocated().size).toBe(0)
    view.destroy()
    container.remove()
  })

  it('auto-paths from the Womb: allocating a subtree node with nothing on takes its Womb along the path', () => {
    const { container, view, womb, neighbor } = mountWithWombPair()
    expect(view.getAllocated().size).toBe(0)

    view.toggle(neighbor) // NO Womb allocated first — must auto-path from the Womb (a path-source)
    expect(view.getAllocated().has(neighbor)).toBe(true) // the node is taken
    expect(view.getAllocated().has(womb)).toBe(true) // and its Womb came along the auto-path
    expect(view.getAllocated().size).toBe(2) // only this Womb + node — the other 4 wombs stay off
    view.destroy()
    container.remove()
  })

  it('seeds the 5 roots and allocates a node adjacent to its subtree root', () => {
    const { container, view, neighbor } = mountWithWombPair(true) // wombs on; neighbor = one hop from a seed
    expect(view.getAllocated().size).toBe(5) // the 5 free starts

    view.toggle(neighbor)
    expect(view.getAllocated().has(neighbor)).toBe(true)
    view.toggle(neighbor) // cascade-deallocate
    expect(view.getAllocated().has(neighbor)).toBe(false)
    expect(view.getAllocated().size).toBe(5) // back to just the seeds
    view.destroy()
    container.remove()
  })

  it('round-trips a plan through the shared numeric share codec', () => {
    const { container, view, roots, neighbor } = mountWithWombPair(true)
    view.toggle(neighbor)

    const selection = [...view.getAllocated()].filter((id) => !roots.has(id))
    const code = encodeAtlasPlan(selection)
    const decoded = decodeAtlasPlan(code)
    expect(decoded).not.toBeNull()
    expect([...decoded!].sort()).toEqual(selection.sort())
    view.destroy()
    container.remove()
  })

  it('summarises GENESIS node stats in the stats panel (not the atlas graph)', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = mountGenesisTree(container, { editable: true })
    const roots = new Set(genesisRootIds())
    // find a non-root genesis node that actually carries stats, reachable from its root
    const statNodeId = Object.keys(genesisGraph.nodes).find(
      (id) => !roots.has(id) && (genesisGraph.nodes[id]!.stats?.length ?? 0) > 0,
    )!
    const expectedStat = genesisGraph.nodes[statNodeId]!.stats[0]!
    view.setBuild({ allocated: [...roots, statNodeId] })
    const stats = collectStats(view, genesisGraph.nodes as never)
    expect(stats).toContain(expectedStat) // genesis node's own stat is summarised
    view.destroy()
    container.remove()
  })
})

describe('genesis crafting reference', () => {
  const data = craftingData as unknown as {
    wombgifts: Array<{ item: string; reward: string; subTree: string; desc: string }>
    bases: Array<{ name: string; itemClass: string }>
  }

  it('maps each of the 5 wombgifts onto a real subtree', () => {
    expect(data.wombgifts).toHaveLength(5)
    const subIds = new Set(GENESIS_SUBTREES.map((s) => s.id))
    for (const w of data.wombgifts) {
      expect(subIds.has(w.subTree), `${w.item} -> ${w.subTree}`).toBe(true)
      expect(w.item).toMatch(/Wombgift$/)
      expect(w.desc).toMatch(/Genesis Tree/)
    }
    // every subtree is covered exactly once
    expect(data.wombgifts.map((w) => w.subTree).sort()).toEqual([...subIds].sort())
  })

  it('lists the special craftable bases', () => {
    expect(data.bases.length).toBeGreaterThanOrEqual(7)
    expect(data.bases.every((b) => b.name && b.itemClass)).toBe(true)
    // Graftblood/Fleshgraft curve was removed 2026-06-27 (Fleshgraft dropped from the game).
    expect((data as { graftblood?: unknown }).graftblood).toBeUndefined()
  })

  it('renders a womb tooltip with its Wombgift; the Ring womb also lists the ring bases', () => {
    const ring = data.wombgifts.find((w) => w.subTree === 'Rings')!
    const html = wombTooltipHtml('Rings', 'Ring Womb')!
    expect(html).toContain(ring.item) // the Wombgift name
    expect(html).toContain('Ring Womb')
    for (const b of data.bases.filter((b) => b.itemClass === 'Rings')) expect(html).toContain(b.name)
    // a body-armour base (Grasping Mail) must NOT appear on the ring womb
    for (const b of data.bases.filter((b) => b.itemClass !== 'Rings')) expect(html).not.toContain(b.name)
    // a subtree with no Wombgift falls back to the default tooltip (null)
    expect(wombTooltipHtml('Nope', 'X')).toBeNull()
  })
})
