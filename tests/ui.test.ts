// Smoke test for the DOM wiring: load the real index.html body, boot main.ts, simulate a
// conversion, and assert the output renders. Runs in jsdom (vitest environment).

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const SAMPLE_XML = readFileSync(join(ROOT, 'tests', 'fixtures', 'pob2-build.xml'), 'utf8')

function bodyInnerHtml(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const inner = m ? m[1]! : html
  return inner.replace(/<script[\s\S]*?<\/script>/gi, '') // we import main.ts manually
}

describe('UI wiring', () => {
  beforeAll(async () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    document.body.innerHTML = bodyInnerHtml(html)
    await import('../src/main') // boots: wires listeners against the DOM above
  })

  it('converts the sample build via the Convert button and renders output', () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    const convertBtn = document.getElementById('convert') as HTMLButtonElement
    code.value = SAMPLE_XML
    convertBtn.click()

    const json = document.getElementById('json') as HTMLPreElement
    const status = document.getElementById('status') as HTMLElement
    const download = document.getElementById('download') as HTMLButtonElement
    const stats = document.getElementById('stats') as HTMLElement

    expect(status.dataset.state).toBe('done')
    expect(download.disabled).toBe(false)
    expect(stats.hidden).toBe(false)
    // output JSON (syntax-highlighted) contains the expected mapped values
    expect(json.textContent).toContain('Monk1')
    expect(json.textContent).toContain('Metadata/Items/Gems/SkillGemWhirlingAssault')
    expect(json.textContent).toContain('jewel_slot1979')
  })

  it('shows a helpful error for bad input without crashing', () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    const convertBtn = document.getElementById('convert') as HTMLButtonElement
    code.value = 'not a real code'
    convertBtn.click()

    const status = document.getElementById('status') as HTMLElement
    const warnings = document.getElementById('warnings') as HTMLElement
    expect(status.dataset.state).toBe('error')
    expect(warnings.textContent?.toLowerCase()).toContain('error')
  })
})
