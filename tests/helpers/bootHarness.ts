// Shared boot scaffolding for the jsdom integration suites that mount the REAL index.html <body> +
// main.ts (ui.test / mainWiring.test / watchWiring.test). Each suite still owns its own beforeAll
// (boot hash, per-suite stubs) and assertions — only these fixture reads + the DOM-mount helpers are
// shared here so the three suites don't each re-declare them (jscpd 0-clone gate).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ROOT = process.cwd()
export const SAMPLE_XML = readFileSync(join(ROOT, 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')
export const LOADOUTS_XML = readFileSync(join(ROOT, 'tests', 'fixtures', 'pob-loadouts.xml'), 'utf8')

/** #id lookup, cast to the caller's element type. */
export const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

/** The index.html <body> inner markup with <script>s stripped (the suites import main.ts manually). */
function bodyInnerHtml(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const inner = m ? m[1]! : html
  return inner.replace(/<script[\s\S]*?<\/script>/gi, '')
}

/** Mount the real index.html <body> into the jsdom document so a suite can then import main.ts. */
export function mountIndexBody(): void {
  document.body.innerHTML = bodyInnerHtml(readFileSync(join(ROOT, 'index.html'), 'utf8'))
}
