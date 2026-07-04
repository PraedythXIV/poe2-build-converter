// Hand-written declarations for scripts/lib.mjs — ONLY the surface the strict-TS vitest suite
// imports (tests/pipelineGates.test.ts), same pattern as server/worker.d.mts and decode-psg.d.mts.
// The rest of lib.mjs is consumed by plain-.mjs pipeline scripts and needs no types; extend this
// file (keep in sync) if a test ever imports more.

/** Fail-loud dataset count gate: throws when `count` < `floor`; returns `count` otherwise. */
export declare function assertFloor(count: number, floor: number, what: string): number

/** No-fabrication guard: throws when `value` is falsy; returns the (truthy) value otherwise. */
export declare function mustResolve<T>(value: T | null | undefined, what: string): T
