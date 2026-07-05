// Branch-coverage tests for the gear gallery's pure renderer + its click/keydown wiring.
// renderGearGallery + wireGearGallery are exported; their engine deps are all exported pure
// functions (the same set panelsMiscCov already drives through renderItemDetails), so this file
// assembles a real `deps` object from them + a trivial colHead stub (a section-header formatter,
// not under test) and drives the renderer directly — no main.ts boot. Each test forces one
// uncovered branch and asserts a specific class / glyph / label (or its exact absence).

import { describe, it, expect, beforeEach } from 'vitest'
import { renderGearGallery, wireGearGallery, type GearGalleryDeps } from '../src/items/gearGallery'
import { domainForItem, annotateModLine } from '../src/items/detailsPanel'
import { groupSocketables, type BuildSummary } from '../src/convert/summarize'
import { rarityKey, poeTierVars } from '../src/ui/rarity'
import { itemArtHtml } from '../src/items/icons'
import { emptySummaryItem } from './helpers/pobBuild'
import { makeSummary } from './helpers/auditSummary'

const deps: GearGalleryDeps = {
  domainForItem,
  annotateModLine,
  groupSocketables,
  rarityKey,
  poeTierVars,
  itemArtHtml,
  colHead: (label, count) => `<h3 class="bc-col-head">${label} <b>${count}</b></h3>`,
}

const render = (s: BuildSummary): string => renderGearGallery(s, deps).html

/** Mount a live gallery + its wiring in the jsdom body; returns the container. The stub
 *  renderItemDetails stands in for main.ts's engine renderer (its output isn't under test). */
function mountGallery(s: BuildSummary): HTMLElement {
  const { html, detailItems } = renderGearGallery(s, deps)
  const el = document.createElement('div')
  el.id = 'bc-gear-test'
  el.innerHTML = html
  document.body.appendChild(el)
  wireGearGallery(el, {
    getDetailItems: () => detailItems,
    renderItemDetails: () => '<div class="idp-card">details</div>',
  })
  return el
}

describe('gearGallery — branch coverage', () => {
  beforeEach(() => {
    document.body.innerHTML = '' // fresh body per test so the singleton overlay never leaks across tests
  })

  // CLUSTER 102 — a granted skill with no level renders its bare name (never the "(Lv N)" form)
  it('renders a granted skill without a level as its bare name', () => {
    const html = render(
      makeSummary({
        items: [
          emptySummaryItem({ slot: 'helmet', name: 'Seer Helm', grantedSkills: [{ name: 'Frostbolt', level: null }] }),
        ],
      }),
    )
    expect(html).toContain('<span>Grants</span>')
    expect(html).toContain('Frostbolt')
    expect(html).not.toContain(' (Lv ') // the with-level branch is NOT taken
  })
  // CLUSTER 110 — an item with no mods, grants, or runes emits no itc-sep separator
  it('omits the itc-sep separator for an item with no mods, grants, or runes', () => {
    const html = render(makeSummary({ items: [emptySummaryItem({ slot: 'helmet', name: 'Plain Helm' })] }))
    expect(html).toContain('Plain Helm') // the card rendered
    expect(html).not.toContain('itc-sep') // nothing to separate → no <hr>
  })
  // CLUSTER 111/112/113 — an inBuild:false item (e.g. a jewel on an unallocated node) gets the preview stamp + ○
  it('stamps an inBuild:false item as a preview (○ marker, "preview only")', () => {
    const html = render(makeSummary({ jewels: [emptySummaryItem({ slot: 'Jewel', name: 'Preview Gem', inBuild: false })] }))
    expect(html).toContain('itc-stamp--preview')
    expect(html).toContain('preview only')
    expect(html).toContain('○')
    expect(html).not.toContain('●') // the in-build (filled) marker is NOT used
  })
  // CLUSTER 133 — an empty jewels list suppresses the whole Tree jewels section
  it('suppresses the Tree jewels section when there are no jewels', () => {
    const html = render(makeSummary({ items: [emptySummaryItem({ slot: 'helmet', name: 'Helm' })], jewels: [] }))
    expect(html).toContain('No item equipped') // the gallery rendered (empty placeholders present)
    expect(html).not.toContain('Tree jewels')
  })
  // CLUSTER 150 — a build with no weapon swap filters the swap slots out of the weapon group
  it('omits the weapon-swap slots when the build runs no swap set', () => {
    const html = render(makeSummary({ items: [emptySummaryItem({ slot: 'helmet', name: 'Helm' })] }))
    expect(html).toContain('Weapon 1') // canonical weapon placeholders still shown
    expect(html).not.toContain('Swap') // ...but no swap slots
  })
  // CLUSTER 177 — an item whose slot matches no group lands in the "Other gear" catch-all section
  it('surfaces an item with an unmatched slot in the Other gear section', () => {
    const html = render(makeSummary({ items: [emptySummaryItem({ slot: 'trinket', name: 'Mystery Trinket' })] }))
    expect(html).toContain('Other gear')
    expect(html).toContain('Mystery Trinket')
  })
  // CLUSTER 230 — a click on the scrim (target === backdrop) closes the open overlay
  it('closes the details overlay on a scrim click', () => {
    const el = mountGallery(makeSummary({ items: [emptySummaryItem({ slot: 'helmet', name: 'Clicky' })] }))
    ;(el.querySelector('.itc-card[data-di]') as HTMLElement).click()
    const overlay = document.querySelector('.idm-backdrop') as HTMLElement
    expect(overlay.hidden).toBe(false) // opened
    overlay.click() // target === overlay (the scrim) → close
    expect(overlay.hidden).toBe(true)
  })
  // CLUSTER 248/249/255 — a click that resolves to no card opens nothing (the null-card guards)
  it('opens no overlay for a click that lands off any gear card', () => {
    const el = mountGallery(makeSummary({ items: [emptySummaryItem({ slot: 'helmet', name: 'Clicky' })] }))
    el.click() // target = container, closest('.itc-card[data-di]') → null
    expect(document.querySelector('.idm-backdrop')).toBeNull()
  })
  // CLUSTER 258 — Space activates a card; any other key is ignored
  it('activates a card on Space but ignores other keys', () => {
    const el = mountGallery(makeSummary({ items: [emptySummaryItem({ slot: 'helmet', name: 'Clicky' })] }))
    const card = el.querySelector('.itc-card[data-di]') as HTMLElement
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(document.querySelector('.idm-backdrop')).toBeNull() // irrelevant key → nothing opens
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    const overlay = document.querySelector('.idm-backdrop') as HTMLElement
    expect(overlay).not.toBeNull()
    expect(overlay.hidden).toBe(false) // Space opened it
  })
  // CLUSTER 260 — Enter fired on the container (not a card) opens nothing (keydown null-hit guard)
  it('opens no overlay for Enter fired off any gear card', () => {
    const el = mountGallery(makeSummary({ items: [emptySummaryItem({ slot: 'helmet', name: 'Clicky' })] }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(document.querySelector('.idm-backdrop')).toBeNull()
  })
})
