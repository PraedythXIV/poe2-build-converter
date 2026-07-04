// ── Jewel-radius geometry — the ONE source of truth for "is a node inside a socketed radius jewel's
// affected zone". Most radius jewels affect a DISC: `diameter` is the world size, so the radius is
// diameter / 2 and a node at (x,y) is inside when its squared distance to the socket centre is within
// (diameter/2)². Some jewels (e.g. "Controlled Metamorphosis", stat local_jewel_variable_ring_radius_value)
// instead affect a RING — the ANNULUS between an inner and outer radius (PassiveJewelRadii RingInner..
// RingOuter of the named size); a disc is just the special case innerDiameter = 0. This used to be
// copy-pasted in four places (the renderer's faction-icon override and conqueror tint, the tooltip
// layer, and a dead main.ts map); centralising it here stops those copies from drifting (the
// one-source-of-truth rule). Kept deliberately tiny + allocation-light so the renderer can call it
// inside its draw.

/** A socketed radius jewel reduced to its world-space affected band + an arbitrary payload (faction,
 *  tint, …). `rIn2` is the squared INNER radius (0 for a solid disc); `r2` is the squared OUTER radius. */
export interface RadiusDisc<T> {
  x: number
  y: number
  r2: number
  rIn2: number
  data: T
}

/** Minimal structural shape this module needs from a socketed jewel — avoids importing JewelInfo
 *  from render.ts (which would create an import cycle). `innerDiameter` set ⇒ ring (annulus) jewel. */
interface RadiusRingInfo {
  ring?: { diameter: number; innerDiameter?: number }
}

/** Collect the world-space affected band of every socketed radius jewel whose `pick` yields a non-null
 *  payload. `coordOf` maps a socket node id to its world coordinates (the band centre). Bands keep the
 *  socket iteration order, so "first matching socket wins" is just "first band that contains". */
export function collectRadii<I extends RadiusRingInfo, T>(
  sockets: ReadonlyMap<string, I>,
  coordOf: (socketId: string) => { x: number; y: number } | undefined,
  pick: (info: I) => T | null | undefined,
): RadiusDisc<T>[] {
  const discs: RadiusDisc<T>[] = []
  for (const [id, info] of sockets) {
    if (!info.ring) continue
    const data = pick(info)
    if (data == null) continue
    const c = coordOf(id)
    if (!c) continue
    const half = info.ring.diameter / 2
    const halfIn = (info.ring.innerDiameter ?? 0) / 2
    discs.push({ x: c.x, y: c.y, r2: half * half, rIn2: halfIn * halfIn, data })
  }
  return discs
}

/** True when the point (x,y) lies within the affected band: inside the outer radius and (for a ring
 *  jewel) outside the inner radius. A disc has rIn2 = 0, so this reduces to the plain disc test. */
export function inDisc<T>(d: RadiusDisc<T>, x: number, y: number): boolean {
  const dx = x - d.x
  const dy = y - d.y
  const d2 = dx * dx + dy * dy
  return d2 <= d.r2 && d2 >= d.rIn2
}

/** The payload of the FIRST band (socket order) that contains the point, else null. */
export function firstRadiusAt<T>(discs: readonly RadiusDisc<T>[], x: number, y: number): T | null {
  for (const d of discs) {
    if (inDisc(d, x, y)) return d.data
  }
  return null
}
