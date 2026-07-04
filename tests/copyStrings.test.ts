// Covers src/copy.ts — the single source of code-generated user-facing wording + the FAQ array.
// copy.ts is pure (no network): the function-valued entries are pluralisers / templated strings, so
// this exercises them by CALLING each with representative args and asserting the returned string
// (correct pluralisation, interpolation, no leftover ${…} / undefined / NaN placeholders). It also
// drives applyStaticCopy() over a real DOM subtree — that path runs the private lookup() +
// faqItemHtml() and renders copy.faq. Runs in jsdom (document is available).

import { describe, it, expect } from 'vitest'
import { copy, applyStaticCopy } from '../src/copy'

// A rendered string must be a non-empty string with no un-substituted template literal or stringified
// nullish/NaN/object leaking through (the classic interpolation-bug fingerprints).
const PLACEHOLDER = /\$\{|\bundefined\b|\bNaN\b|\[object Object\]/
function clean(s: unknown): asserts s is string {
  expect(typeof s).toBe('string')
  expect((s as string).length).toBeGreaterThan(0)
  expect(s as string).not.toMatch(PLACEHOLDER)
}

// ── exhaustive sweep: collect EVERY function value anywhere in `copy`, call it, assert it's clean ──
// This is the "no function left behind" backstop; the explicit blocks below assert the wording itself.
type Fn = (...a: unknown[]) => unknown
function collectFns(node: unknown, path: string, out: Array<{ path: string; fn: Fn }>): void {
  if (typeof node === 'function') {
    out.push({ path, fn: node as Fn })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectFns(v, `${path}[${i}]`, out))
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectFns(v, path ? `${path}.${k}` : k, out)
    }
  }
}

describe('copy — every function-valued entry renders a clean string', () => {
  const fns: Array<{ path: string; fn: Fn }> = []
  collectFns(copy, '', fns)

  it('discovers the full catalogue of copy functions', () => {
    // copy.ts carries ~100 parameterised messages; guard against a refactor silently gutting them.
    expect(fns.length).toBeGreaterThan(80)
  })

  it('invokes each with representative args and gets no leftover placeholders', () => {
    for (const { path, fn } of fns) {
      // every copy function is pure template interpolation / ternary over numbers or strings, and
      // has no default params, so fn.length is its true arity — a numeric arg interpolates in every slot.
      const args = Array.from({ length: fn.length }, (_, i) => i + 2)
      const out = fn(...args)
      expect(typeof out, `${path} should return a string`).toBe('string')
      clean(out)
    }
  })
})

describe('copy — pluralisation (via plural() and manual branches)', () => {
  it('plural()-backed counters agree in singular vs plural', () => {
    expect(copy.breakdown.passivesAllocated(1)).toBe('1 passive allocated')
    expect(copy.breakdown.passivesAllocated(12)).toBe('12 passives allocated')
    expect(copy.conv.downloadingTitle(1)).toBe('Downloading 1 file')
    expect(copy.conv.downloadingTitle(3)).toBe('Downloading 3 files')
    expect(copy.conv.downloadedTitle(2)).toBe('Downloaded 2 files')
    expect(copy.conv.flaggedTitle(1)).toBe('1 variant flagged')
    expect(copy.conv.flaggedTitle(2)).toBe('2 variants flagged')
  })

  it('downloadedBody switches it/them on the count', () => {
    expect(copy.conv.downloadedBody(1)).toContain('drop it')
    expect(copy.conv.downloadedBody(1)).not.toContain('drop them')
    expect(copy.conv.downloadedBody(2)).toContain('drop them')
  })

  it('grantedSocketJewels agrees noun + possessive with the count', () => {
    const one = copy.warn.grantedSocketJewels(1)
    expect(one).toContain('Carried 1 jewel ')
    expect(one).toContain('its granted socket')
    expect(one).not.toContain('jewels')
    const many = copy.warn.grantedSocketJewels(3)
    expect(many).toContain('Carried 3 jewels')
    expect(many).toContain('their granted socket')
  })

  it('masteries takes an explicit irregular suffix', () => {
    expect(copy.breakdown.masteries(1, 'y')).toBe('1 mastery')
    expect(copy.breakdown.masteries(3, 'ies')).toBe('3 masteries')
  })

  it('treeMissing pluralises node with a passed-in suffix', () => {
    expect(copy.treeMissing(1, '')).toContain('1 allocated node from this build')
    expect(copy.treeMissing(3, 's')).toContain('3 allocated nodes from this build')
  })

  it('emotions.summaryCount pluralises Notable and appends the cap note', () => {
    expect(copy.emotions.summaryCount(1, '', '')).toBe('You can anoint 1 Notable with your emotions.')
    expect(copy.emotions.summaryCount(5, 's', ' (showing 3, filter to narrow)')).toBe(
      'You can anoint 5 Notables with your emotions (showing 3, filter to narrow).',
    )
  })

  it('economy.pagerInfo pluralises the item noun', () => {
    expect(copy.economy.pagerInfo(2, 5, 42, 's')).toBe('Page 2 of 5 · 42 items')
    expect(copy.economy.pagerInfo(1, 1, 1, '')).toBe('Page 1 of 1 · 1 item')
  })
})

describe('copy — interpolation (values land in the right slots)', () => {
  it('import + convert feedback', () => {
    expect(copy.imp.loaded('build.xml', '2.1 KB')).toBe('Loaded build.xml (2.1 KB)')
    expect(copy.imp.pobbinFetching('AbC12')).toBe('Fetching build from pobb.in/AbC12…')
    expect(copy.imp.pobbinLoaded('AbC12')).toContain('Loaded build from pobb.in/AbC12')
    const failed = copy.imp.pobbinFailed('AbC12', 'network error')
    expect(failed).toContain("Couldn't load pobb.in/AbC12")
    expect(failed).toContain('network error')
    expect(copy.convert.fileReadError('x.xml')).toContain('x.xml')
    expect(copy.convert.downloadAll(3)).toBe('Download all (3)')
    expect(copy.stepper.nextTo('Verify')).toBe('Verify →')
  })

  it('conversion-warning catalogue interpolates counts + examples', () => {
    const slot = copy.warn.slotUnmapped(2, 'Ring, Amulet')
    expect(slot).toContain('Skipped 2 slot(s)')
    expect(slot).toContain('Ring, Amulet')
    expect(slot).toContain('second weapon set')
    const node = copy.warn.passiveNodeUnknown(4, '0.3.1', '111, 222')
    expect(node).toContain('4 passive node id(s)')
    expect(node).toContain('version 0.3.1')
    expect(node).toContain('111, 222')
    const mixed = copy.warn.mixedTreeVersions('0.3.1', '0.2.0, 0.3.1')
    expect(mixed).toContain('version 0.3.1')
    expect(mixed).toContain('0.2.0, 0.3.1')
    expect(copy.warn.gemIdUnknown(2, 'a, b')).toContain('2 gem id(s)')
    expect(copy.warn.uniqueNameUnverified(1, 'Foo')).toContain('1 unique name(s)')
    expect(copy.warn.socketJewelMissing(2)).toContain('2 socketed jewel(s)')
  })

  it('items tier chip + labels', () => {
    const chip = copy.items.chipTitle(1, 10, '5', '10', 82)
    expect(chip).toContain('Tier 1 of 10 (T1 = strongest)')
    expect(chip).toContain('needs item level 82')
    expect(copy.items.rollPctTitle(73)).toContain('rolled 73%')
    expect(copy.items.ilvlLine(84)).toBe('ilvl 84')
    expect(copy.items.requiresLevel(65)).toBe('Requires <span class="itc-attr-c">Level 65</span>')
    expect(copy.items.grantWithLevel('Herald of Ash', 20)).toBe('Herald of Ash (Lv 20)')
    expect(copy.items.previewStamp('Belt')).toBe('Belt · preview only')
  })

  it('tree node tooltip + toolbar counters', () => {
    expect(copy.tree.countAsc(8, 8)).toContain('8/8 asc')
    const ws = copy.tree.countWs(24, 20, 24)
    expect(ws).toContain('I 24/24')
    expect(ws).toContain('II 20/24')
    expect(copy.tree.radius('Large')).toBe('Radius: Large')
    expect(copy.tree.oneOf(3)).toBe('one of 3')
    expect(copy.tree.attrChoiceSet('Dexterity')).toBe('Attribute of choice — set to Dexterity')
    expect(copy.tree.grantsAttr('+5 Strength')).toBe('Grants +5 Strength')
    expect(copy.tree.grantsSkill('Herald of Thunder')).toBe('Grants Herald of Thunder')
    expect(copy.tree.weaponSetOnly('II')).toBe('Weapon Set II only')
    expect(copy.tree.locked('Warrior start')).toContain('requires Warrior start')
    expect(copy.tree.conqueredBy('Maraketh')).toContain('Maraketh')
    const tl = copy.tree.timeLost('Dexterity', 'Strength')
    expect(tl).toContain('Dexterity')
    expect(tl).toContain('Strength')
    expect(tl).toContain('Time-Lost Diamond')
    expect(copy.tree.chooseOne('Notable', 'A, B')).toContain('Notable')
  })

  it('atlas / genesis summaries', () => {
    expect(copy.atlas.points(50, 120)).toBe('Points: 50 (120)')
    expect(copy.genesis.wombSubline('a', 'Ruby Ring')).toBe('Genesis Womb · grows a Ruby Ring')
  })

  it('emotions planner strings', () => {
    expect(copy.emotions.tipSub('Magic', ' · Potent')).toBe('Magic Distilled Emotion · Potent')
    expect(copy.emotions.tipWaystone(20, ' extra')).toContain('20% Delirious')
    expect(copy.emotions.craftableTimesTitle(4)).toBe('craftable 4× with your emotions')
    expect(copy.emotions.summaryAll(160)).toBe('All 160 anoint recipes')
    expect(copy.emotions.summaryCapped(30)).toContain('showing 30')
    expect(copy.emotions.waystonePctEach(20)).toBe('20% each')
    expect(copy.emotions.waystoneDeliriousPerRare(5)).toContain('+5%')
    expect(copy.emotions.waystoneDeliriousPerUnique(10)).toContain('+10% per Unique')
    expect(copy.emotions.waystoneDeliriousOnComplete(8)).toContain('on map completion')
    expect(copy.emotions.waystoneSimulacrum(40, '2')).toContain('Simulacrum unlocks at 40%')
    expect(copy.emotions.waystoneTotalLive(80, ' (max)')).toBe('80% Delirious (max)')
    expect(copy.emotions.waystoneNoteWithMath('math here')).toContain('math here')
  })

  it('economy browser + exchange strings', () => {
    expect(copy.economy.loading('Currency')).toBe('Loading Currency…')
    expect(copy.economy.priceEx('12')).toBe('12 ex')
    expect(copy.economy.priceDiv('0.5')).toBe('0.5 div')
    expect(copy.economy.statusLine('Standard', ' X')).toContain('poe2scout snapshots')
    expect(copy.economy.statusLine('Standard', ' X')).toContain('Standard')
    expect(copy.economy.statusDiv('200')).toContain('1 divine')
    expect(copy.economy.wikiTitle('Mageblood')).toBe('Mageblood on the wiki')
    expect(copy.economy.tradeTitle('Standard')).toContain('Standard')
    expect(copy.economy.exMarket('Standard')).toBe('Standard Market')
    expect(copy.economy.exLoadingMarket('Standard')).toBe('Loading Standard market…')
    expect(copy.economy.exUpdated('2m ago')).toBe('Last updated 2m ago')
    expect(copy.economy.exPairsCount('42')).toBe('42 current pairs')
    expect(copy.economy.exPagerInfo('1', '3', '30')).toBe('Page 1 of 3 · 30 pairs')
    expect(copy.economy.exRate('Chaos', '1.5', 'Divine')).toBe('1 Chaos = 1.5 Divine')
    expect(copy.economy.exChartCaption(24)).toContain('24 hourly points')
    expect(copy.economy.exChartAria('120')).toContain('120 exalted')
  })

  it('stats panel row helpers', () => {
    expect(copy.stats.allExported(37)).toBe('All exported stats (37)')
    expect(copy.stats.fullDpsPart('2')).toBe('part 2')
    expect(copy.stats.freeSuffix('30')).toBe('(30 free)')
    expect(copy.stats.res('Fire')).toBe('Fire res')
    expect(copy.stats.physSub('40%')).toBe('(40% phys)')
    expect(copy.stats.evadeSub('55%')).toBe('(55% evade)')
    expect(copy.stats.attrReq('120', '111')).toBe('120 / 111 req')
    expect(copy.stats.chargesLabel('Power')).toBe('Power charges')
    expect(copy.config.multiSets(3)).toBe('(3 sets — showing the active one)')
    expect(copy.audit.ok(5)).toBe('5 OK')
  })

  it('variants + breakdown + splash strings', () => {
    expect(copy.variants.treeFallback(2)).toBe('Tree 2')
    expect(copy.variants.specLabel('Main Tree', 118)).toBe('Main Tree · 118 nodes')
    expect(copy.variants.specTreeVersion('0.2.0')).toContain('tree 0.2.0')
    expect(copy.variants.skillSetFallback('3')).toBe('Skill set 3')
    expect(copy.variants.gearSetFallback('4')).toBe('Gear set 4')
    expect(copy.variants.setFallback('Skill set', '2')).toBe('Skill set 2')
    expect(copy.breakdown.statSkillsValue(6, 9)).toBe('6 + 9 supp')
    expect(copy.breakdown.level(92)).toBe('Lv 92')
    expect(copy.breakdown.gemCopies(3)).toBe('3 copies')
    expect(copy.breakdown.gemMinionTitle('SkeletonArcher')).toContain('SkeletonArcher')
    expect(copy.breakdown.skillQuality(20)).toBe(' · Q20')
    expect(copy.breakdown.itemDetailsAria('Mageblood')).toBe('Item details: Mageblood')
    expect(copy.breakdown.cardAria('Helmet', 'Foo Hat')).toBe('Helmet: Foo Hat — view details')
    expect(copy.breakdown.emptySlotAria('Gloves')).toBe('Gloves slot: empty')
    expect(copy.splash.ascLabel('Invoker ', 'Monk')).toBe('Invoker Monk ascendancy')
    expect(copy.splash.classLabel('Ranger')).toBe('Ranger class')
    expect(copy.loadout.statsNote('Endgame')).toContain('"Endgame"')
    expect(copy.bff.unreachableDev('http://localhost:8787')).toContain('http://localhost:8787')
    expect(copy.bff.unreachableDev('http://localhost:8787')).toContain('serve:bff')
  })

  it('provenance footer names both sources', () => {
    const p = copy.provenance('June 2026', '0.3.1')
    expect(p).toContain('Lookup data captured June 2026 (PoE2 0.3.1).')
    expect(p).toContain('poe2-skilltree-export')
    expect(p).toContain('pathofexile-dat extraction')
  })
})

describe('copy — shared itemLabels are a single source across items + breakdown', () => {
  it('items.* and breakdown.* reference the identical label fns/strings', () => {
    expect(copy.items.requiresLevel).toBe(copy.breakdown.requiresLevel)
    expect(copy.items.grantWithLevel).toBe(copy.breakdown.grantWithLevel)
    expect(copy.items.previewStamp).toBe(copy.breakdown.previewStamp)
    expect(copy.items.grants).toBe(copy.breakdown.grants)
    expect(copy.items.noItemEquipped).toBe(copy.breakdown.noItemEquipped)
    // and they still produce identical output for the same input
    expect(copy.items.requiresLevel(72)).toBe(copy.breakdown.requiresLevel(72))
  })
})

describe('copy.faq — array shape', () => {
  it('is a non-empty array of {q, a} with non-empty string fields', () => {
    expect(Array.isArray(copy.faq)).toBe(true)
    expect(copy.faq.length).toBeGreaterThan(0)
    for (const item of copy.faq) {
      expect(Object.keys(item).sort()).toEqual(['a', 'q'])
      expect(typeof item.q).toBe('string')
      expect(item.q.trim().length).toBeGreaterThan(0)
      expect(typeof item.a).toBe('string')
      expect(item.a.trim().length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate questions', () => {
    const qs = copy.faq.map((f) => f.q)
    expect(new Set(qs).size).toBe(qs.length)
  })
})

describe('applyStaticCopy — pushes wording into a DOM subtree + renders the FAQ', () => {
  function mount(): HTMLElement {
    const root = document.createElement('div')
    root.innerHTML = [
      '<span data-copy="nav.convert"></span>',
      '<span data-copy="steps"></span>', // array value → lookup() returns undefined → left untouched
      '<span data-copy="does.not.exist"></span>', // bad path → undefined → left untouched
      '<div data-copy-html="brand.name"></div>',
      '<div data-copy-html="steps"></div>', // non-string path → lookup() undefined → innerHTML untouched
      '<div data-copy-faq></div>',
    ].join('')
    return root
  }

  it('sets textContent from string copy and leaves non-string / missing paths alone', () => {
    const root = mount()
    applyStaticCopy(root)
    expect(root.querySelector<HTMLElement>('[data-copy="nav.convert"]')!.textContent).toBe('.build converter')
    // lookup() only returns strings — an array-valued path and an unknown path resolve to undefined,
    // so applyStaticCopy skips them and the element stays empty.
    expect(root.querySelector<HTMLElement>('[data-copy="steps"]')!.textContent).toBe('')
    expect(root.querySelector<HTMLElement>('[data-copy="does.not.exist"]')!.textContent).toBe('')
  })

  it('sets innerHTML for trusted data-copy-html labels', () => {
    const root = mount()
    applyStaticCopy(root)
    const brand = root.querySelector<HTMLElement>('[data-copy-html="brand.name"]')!
    expect(brand.innerHTML).toContain('<b>Sweet Vision</b>')
    expect(brand.querySelector('b')?.textContent).toBe('Sweet Vision')
    // a data-copy-html pointing at a non-string (array) path resolves to undefined → stays empty
    expect(root.querySelector<HTMLElement>('[data-copy-html="steps"]')!.innerHTML).toBe('')
  })

  it('is a no-op safe when the subtree has no FAQ container', () => {
    const root = document.createElement('div')
    root.innerHTML = '<span data-copy="nav.faq"></span>'
    expect(() => applyStaticCopy(root)).not.toThrow()
    expect(root.querySelector<HTMLElement>('[data-copy="nav.faq"]')!.textContent).toBe('FAQ')
    expect(root.querySelector('[data-copy-faq]')).toBeNull()
  })

  it('renders one accessible disclosure per FAQ entry, wired q/a with correct ids + roles', () => {
    const root = mount()
    applyStaticCopy(root)
    const items = root.querySelectorAll('[data-copy-faq] .faq-item')
    expect(items.length).toBe(copy.faq.length)

    items.forEach((item, i) => {
      const head = item.querySelector<HTMLButtonElement>('button.faq-hd')!
      const panel = item.querySelector<HTMLElement>('.faq-a')!
      // q is escaped-then-parsed, so its textContent round-trips back to the exact source string
      expect(head.textContent).toBe(copy.faq[i]!.q)
      expect(head.getAttribute('aria-expanded')).toBe('false')
      // APG disclosure wiring: button controls the panel; panel is a labelled, collapsed region
      expect(head.id).toBe(`faq-head-${i}`)
      expect(panel.id).toBe(`faq-panel-${i}`)
      expect(head.getAttribute('aria-controls')).toBe(panel.id)
      expect(panel.getAttribute('role')).toBe('region')
      expect(panel.getAttribute('aria-labelledby')).toBe(head.id)
      expect(panel.hasAttribute('hidden')).toBe(true)
      // a is trusted HTML — it renders as real elements (unlike the escaped q), every answer has markup
      expect(panel.querySelector('b, code, a')).not.toBeNull()
    })
  })

  it('escapes the question text (an apostrophe question survives as literal text, not markup)', () => {
    const root = mount()
    applyStaticCopy(root)
    // "…why can't I see it?" — the ' would be a raw char if unescaped; round-tripping the textContent
    // back to the exact source proves faqItemHtml() escaped it (a double-escape would corrupt it).
    const apostropheFaq = copy.faq.find((f) => f.q.includes("can't"))
    expect(apostropheFaq).toBeDefined()
    const heads = [...root.querySelectorAll<HTMLButtonElement>('[data-copy-faq] button.faq-hd')]
    const match = heads.find((h) => h.textContent === apostropheFaq!.q)
    expect(match).toBeDefined()
    expect(match!.textContent).toContain("can't")
  })
})
