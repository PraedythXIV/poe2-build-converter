// Hand-written declarations for decode-psg.mjs so the vitest suite (strict TS) can import
// the decoder directly. Keep in sync with the runtime exports.

export interface PsgConnection {
  target: number
  /** 0 or NO_ARC = straight; else |arc| = orbit index into ORBIT_RADII, sign = centre side. */
  arc: number
}

export interface PsgPassive {
  /** PassiveSkills.PassiveSkillGraphId (== GGG tree-export node key). */
  passiveId: number
  /** Node orbit index (0 = group centre), into ORBIT_RADII. */
  radius: number
  /** Slot on the orbit (== GGG tree-export orbitIndex). */
  position: number
  connections: PsgConnection[]
}

export interface PsgGroup {
  x: number
  y: number
  unk1: number
  unk2: number
  flag: number
  passives: PsgPassive[]
}

export interface PsgFile {
  version: number
  graphType: number
  slotsPerOrbit: number[]
  rootPassives: number[]
  groups: PsgGroup[]
}

export interface PsgFlatNode {
  passiveId: number
  groupIndex: number
  radius: number
  position: number
  x: number
  y: number
  connections: PsgConnection[]
}

export interface PsgVerifyReport {
  nodes: {
    total: number
    matched: number
    missing: number
    orbitMismatch: number
    withinTolerance: number
    worst: number
  }
  arcs: { total: number; centerWithinTolerance: number; noBakedCenter: number; worst: number }
  straight: { total: number; agree: number }
  tolerance: number
}

export declare const ORBIT_RADII: number[]
export declare const NO_ARC: number

export declare function decodePsg(buf: Buffer): PsgFile
export declare function nodePosition(
  group: { x: number; y: number },
  passive: { radius: number; position: number },
  slotsPerOrbit: number[],
): { x: number; y: number }
export declare function arcCenter(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  arc: number,
): { x: number; y: number } | null
export declare function flattenNodes(decoded: PsgFile): PsgFlatNode[]
export declare function verifyAgainstBaked(decoded: PsgFile, baked: unknown, tolerance?: number): PsgVerifyReport
