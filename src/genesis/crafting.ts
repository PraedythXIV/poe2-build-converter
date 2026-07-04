// Genesis Tree womb-keystone TOOLTIP content. The Wombgift → reward mapping (and the special Ring
// bases) used to live in a standalone "Crafting reference" card beside the tree; that card was removed
// 2026-06-27 — it's all shown on the womb tooltips now. This module renders just those tooltips, from
// the vendored genesisCrafting.json. (Graftblood/Fleshgraft was dropped from the game in a recent patch.)

import './genesis.css'
import { escapeHtml } from '../ui/escapeHtml'
import { GENESIS_SUBTREE_RGB } from './index'
import craftingData from '../data/genesisCrafting.json'
import { copy } from '../copy'

interface Wombgift {
  item: string
  reward: string
  subTree: string
  desc: string
}
interface CraftBase {
  name: string
  itemClass: string
}
interface GenesisCrafting {
  wombgifts: Wombgift[]
  bases: CraftBase[]
}

const data = craftingData as unknown as GenesisCrafting

/** A womb keystone's tooltip = its Wombgift reference, shown INSTEAD of the bare keystone name: the
 *  Wombgift → reward mapping + the "grows into a X" wording. The Ring womb additionally lists the
 *  special Ring item bases (itemClass "Rings" — NOT the Grasping MAIL body armour, which comes from a
 *  separate Breach recipe, not a womb). Returns null when `subTree` has no Wombgift (→ default tooltip). */
export function wombTooltipHtml(subTree: string, nodeName: string): string | null {
  const w = data.wombgifts.find((g) => g.subTree === subTree)
  if (!w) return null
  const rgb = GENESIS_SUBTREE_RGB[subTree] ?? '150, 150, 150'
  let body =
    `<div class="itc-mod itc-mod--bonus gc-womb-tip-map" data-tag="womb">` +
    `<b>${escapeHtml(w.item)}</b> <span class="gc-womb-arrow" aria-hidden="true">→</span> ${escapeHtml(w.reward)}</div>` +
    `<div class="itc-desc">${escapeHtml(w.desc)}</div>`
  if (subTree === 'Rings') {
    const rings = data.bases.filter((b) => b.itemClass === 'Rings').map((b) => b.name)
    if (rings.length) {
      body +=
        `<div class="itc-desc gc-womb-tip-baseshd"><b>${copy.genesis.specialRingBases}</b></div>` +
        `<ul class="gc-tip-bases">${rings.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    }
  }
  const article = /^[aeiou]/i.test(w.reward) ? 'an' : 'a'
  return (
    `<div class="itc-card gc-womb-tip" role="group" aria-label="${escapeHtml(nodeName)}" ` +
    `style="--itc-tier: rgb(${rgb}); --itc-tier-rgb: ${rgb}; --gc-rgb: ${rgb}">` +
    `<div class="itc-header"><span class="itc-name">${escapeHtml(nodeName)}</span>` +
    `<span class="itc-subline">${copy.genesis.wombSubline(article, escapeHtml(w.reward))}</span></div>` +
    `<div class="itc-body">${body}</div>` +
    `</div>`
  )
}
