// Read-only "full PoB data" inspector — a collapsible dump of the ENTIRE parsed PobBuild, so the
// losslessness is visible: anything src/pob keeps is inspectable here (notes, config, playerStatsRaw,
// item details, gem details, spec masteries, treeView, party, importInfo, rawSections, …). A power-user
// "show me everything PoB exported" view. Pure display — no editing, no recompute.
import { escapeHtml } from './escapeHtml'
import type { PobBuild } from '../pob/model'

/** PobBuild → a plain JSON-serialisable value (the `Map`s become objects).
 *  CONTRACT: this must flatten EVERY `Map`/`ReadonlyMap` reachable from PobBuild, else
 *  `JSON.stringify` silently serialises it to `{}` and the inspector loses that data. The only
 *  Maps today are `PobBuild.items` and `PobSpec.attributeChoices` — if a new Map field is added to
 *  PobBuild or PobSpec (see pob/model.ts), flatten it here too. */
function plain(build: PobBuild): unknown {
  const items = Object.fromEntries(build.items)
  const flatSpec = (s: PobBuild['spec']): unknown => ({
    ...s,
    attributeChoices: Object.fromEntries(s.attributeChoices),
  })
  return { ...build, items, spec: flatSpec(build.spec), specs: build.specs.map(flatSpec) }
}

export function renderPobInspector(build: PobBuild): string {
  let json: string
  try {
    json = JSON.stringify(plain(build), null, 2)
  } catch {
    // plain() flattens every Map and a PobBuild has no cycles, so this realistically never throws;
    // if it ever did, drop the inspector panel rather than crash the whole convert view.
    return ''
  }
  return (
    `<section class="card">` +
    `<details class="pob-inspector">` +
    `<summary>Full PoB data <span class="cfg-sub">— everything this build carries, verbatim (read-only)</span></summary>` +
    `<pre class="pob-inspector-json">${escapeHtml(json)}</pre>` +
    `</details></section>`
  )
}
