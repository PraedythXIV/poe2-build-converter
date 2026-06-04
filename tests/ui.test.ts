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

    // stepper: a successful convert advances Import/Preview/Convert to done, Download is current
    const states = [...document.querySelectorAll('#stepper .sx-step')].map((s) => s.getAttribute('data-state'))
    expect(states).toEqual(['done', 'done', 'done', 'current'])
    expect(document.querySelectorAll('#stepper .sx-step')[3]!.getAttribute('aria-current')).toBe('step')

    // gear gallery: equipped items grouped into category sections of #311 tooltips
    const sections = document.querySelectorAll('#bc-gear .bc-gear-sec')
    expect(sections.length).toBeGreaterThan(1)
    expect(document.querySelectorAll('#bc-gear .bc-gear-grid .itc-card').length).toBeGreaterThan(0)
    // the fixture's unique belt resolves into a tier-tagged tooltip name
    const itemNames = [...document.querySelectorAll('#bc-gear .itc-name')].map((n) => n.textContent)
    expect(itemNames).toContain("Shavronne's Satchel")
    // canonical slots the build leaves empty (the fixture has no gloves) render placeholder cards
    expect(document.querySelectorAll('#bc-gear .itc-card--empty').length).toBeGreaterThan(0)
    expect(itemNames).toContain('Gloves') // the empty Gloves placeholder uses the slot label as its name
  })

  it('renders the build-contents preview with accessible, decorative ●/○ markers', () => {
    const code = document.getElementById('code') as HTMLTextAreaElement
    const convertBtn = document.getElementById('convert') as HTMLButtonElement
    code.value = SAMPLE_XML
    convertBtn.click() // convert() calls updateContents() synchronously (no debounce on this path)

    const contents = document.getElementById('contents') as HTMLElement
    expect(contents.hidden).toBe(false)
    // a11y: the section must NOT self-announce its whole subtree on every update
    expect(contents.hasAttribute('aria-live')).toBe(false)
    // a11y: columns are real labelled groups (a bare div would have its aria-label ignored)
    expect(document.getElementById('bc-perks')?.getAttribute('role')).toBe('group')
    // perks rendered, and every ●/○ tier marker is decorative (the legend explains them once)
    const perks = document.getElementById('bc-perks') as HTMLElement
    expect(perks.querySelectorAll('.bc-row').length).toBeGreaterThan(0)
    const markers = contents.querySelectorAll('.bc-tier')
    expect(markers.length).toBeGreaterThan(0)
    expect([...markers].every((m) => m.getAttribute('aria-hidden') === 'true')).toBe(true)
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

    // stepper flags the Convert step (index 2) as errored, not a later step
    const convertStep = document.querySelectorAll('#stepper .sx-step')[2]!
    expect(convertStep.classList.contains('sx-step--err')).toBe(true)
    expect(convertStep.getAttribute('data-state')).toBe('current')
  })
})
