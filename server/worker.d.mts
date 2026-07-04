// Hand-written declarations for server/worker.mjs so the vitest suite (strict TS) can
// import the worker without enabling allowJs project-wide. Keep in sync with worker.mjs.

/** Cloudflare-style env bindings (unused today; a KV binding would arrive here). */
export type WorkerEnv = Record<string, unknown>

declare const worker: {
  fetch(request: Request, env?: WorkerEnv): Promise<Response>
}
export default worker

/** Fixed unique-category allowlist — mirror of src/economy/client.ts UNIQUE_CATEGORIES
 *  (the drift guard in tests/economyClient.test.ts pins the two equal). */
export declare const UNIQUE_CATEGORIES: readonly string[]

/** Best-effort per-IP token bucket parameters. */
export declare const RATE_LIMIT: { capacity: number; windowMs: number }

/** Test hook: clears the TTL cache and the rate-limit buckets. */
export declare function resetState(): void
