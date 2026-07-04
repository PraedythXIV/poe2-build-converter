// B1 — uniform-grid spatial hash for view culling (queryRect) and pointer hit-testing
// (nodeAt). Cell size ~400 world units ≈ 2 node diameters; rebuildable in O(n) whenever the
// displayed positions change (e.g. the ascendancy overlay moves its cluster).
//
// Ported from poe2-tools/poe2-build-planner `src/render/spatialIndex.ts` (MIT License,
// Copyright (c) 2026 theofbonin), generalized from numeric skill ids to string ids with the
// point positions carried inside the index — see THIRD-PARTY-NOTICES.md.

import type { WorldRect } from './viewport'

export interface SpatialPoint {
  id: string
  x: number
  y: number
}

export interface SpatialIndex {
  cellSize: number
  cells: Map<string, string[]>
  points: Map<string, SpatialPoint>
}

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`
}

export function buildSpatialIndex(points: Iterable<SpatialPoint>, cellSize = 400): SpatialIndex {
  const cells = new Map<string, string[]>()
  const byId = new Map<string, SpatialPoint>()
  for (const p of points) {
    byId.set(p.id, p)
    const key = cellKey(Math.floor(p.x / cellSize), Math.floor(p.y / cellSize))
    const bucket = cells.get(key)
    if (bucket) bucket.push(p.id)
    else cells.set(key, [p.id])
  }
  return { cellSize, cells, points: byId }
}

/** Ids of every indexed point whose cell intersects `rect` (slightly over-inclusive). */
export function queryRect(index: SpatialIndex, rect: WorldRect): string[] {
  const { cellSize, cells } = index
  const minCx = Math.floor(rect.minX / cellSize)
  const maxCx = Math.floor(rect.maxX / cellSize)
  const minCy = Math.floor(rect.minY / cellSize)
  const maxCy = Math.floor(rect.maxY / cellSize)
  const out: string[] = []
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      const bucket = cells.get(cellKey(cx, cy))
      if (bucket) out.push(...bucket)
    }
  }
  return out
}

/** Nearest indexed point to (wx, wy) within `radius` world units, or null. */
export function nodeAt(index: SpatialIndex, wx: number, wy: number, radius: number): string | null {
  const candidates = queryRect(index, { minX: wx - radius, minY: wy - radius, maxX: wx + radius, maxY: wy + radius })
  let best: string | null = null
  let bestDist = radius * radius
  for (const id of candidates) {
    const p = index.points.get(id)
    if (!p) continue
    const dx = p.x - wx
    const dy = p.y - wy
    const d = dx * dx + dy * dy
    if (d <= bestDist) {
      bestDist = d
      best = id
    }
  }
  return best
}
