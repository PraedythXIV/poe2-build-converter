// The deep-link boot gate is a THREE-file string contract with no compiler check:
// (1) the index.html <head> script sets data-boot-route from the hash BEFORE first paint,
// (2) styles.css paints the gated route up-front (`html[data-boot-route='atlas'] #route-atlas …`),
// (3) main.ts drops the attribute after routing. Silent breakage of any leg would permanently hide
// the Convert route or reinstate the deep-link CLS the gate exists to prevent — so pin each leg.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8')

/** The head boot script's body (the only inline non-module script in index.html). */
function bootScript(): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(HTML)
  if (!m) throw new Error('boot-gate script not found in index.html')
  return m[1]!
}

/** Run the real script body against a stubbed location + a fresh fake documentElement. */
function runBootScript(hash: string): string | null {
  const attrs = new Map<string, string>()
  const doc = {
    documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) },
  }
  new Function('location', 'document', bootScript())({ hash }, doc)
  return attrs.get('data-boot-route') ?? null
}

describe('boot-gate contract — legs 2+3: the CSS override and the main.ts release', () => {
  it('styles.css paints the gated routes up-front and main.ts drops the attribute after routing', () => {
    const css = readFileSync(join(ROOT, 'src', 'styles.css'), 'utf8')
    // the gate hides the default route while a gated one is booting…
    expect(css).toMatch(/html\[data-boot-route\]\s+#route-convert\s*\{\s*display:\s*none/)
    // …and force-shows the gated route (the !important must beat the [hidden] display:none guard)
    expect(css).toMatch(/html\[data-boot-route='atlas'\]\s+#route-atlas[^{]*\{\s*display:\s*block\s*!important/)
    expect(css).toMatch(/html\[data-boot-route='genesis'\][^{]*#route-genesis[^{]*\{[^}]*!important/)
    // main.ts must RELEASE the gate after routing, or tab navigation stays pinned forever
    const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8')
    expect(main).toContain(`removeAttribute('data-boot-route')`)
  })
})

describe('boot-gate contract — leg 1: the head script', () => {
  it('gates exactly the two canvas routes, payload hashes included, and nothing else', () => {
    expect(runBootScript('#atlas')).toBe('atlas')
    expect(runBootScript('#genesis')).toBe('genesis')
    expect(runBootScript('#atlas=AAAA.BBBB')).toBe('atlas') // share payloads gate on the pre-'=' segment
    expect(runBootScript('#genesis=AAAA')).toBe('genesis')
    // JS-populated routes are empty at first paint — gating them would EXPOSE growth as CLS
    expect(runBootScript('#emotions')).toBeNull()
    expect(runBootScript('#prices')).toBeNull()
    expect(runBootScript('#faq')).toBeNull()
    expect(runBootScript('#convert')).toBeNull()
    expect(runBootScript('')).toBeNull()
    expect(runBootScript('#nonsense')).toBeNull()
  })
})
