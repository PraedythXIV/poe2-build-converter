// C1 — stats display panel. Renders PoB's exported PlayerStat snapshot (BuildSummary.playerStats)
// as curated groups (Offence / Defence / Resistances / Survivability / Attributes / Charges) plus a
// collapsed "all exported stats" table. Pure HTML-string renderer, same pattern as main.ts panels.
// IMPORTANT: these are PoB's OWN numbers, captured at export time — we never recompute them.

import './statsPanel.css'
import { escapeHtml } from './escapeHtml'
import { copy } from '../copy'
import type { PobFullDpsSkill } from '../pob/model'

const C = copy.stats

// ── number formatting ────────────────────────────────────────────────────────
/** Integers get thousands separators; small numbers keep ≤2 decimals; big decimals round. */
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString('en-US')
  if (Math.abs(n) >= 100) return Math.round(n).toLocaleString('en-US')
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
function fmtPct(n: number): string {
  return `${fmtNum(n)}%`
}
/** Percent-like stat names, for the raw all-stats table (resists, chances, "Spec:…Inc" increases). */
function isPercentLike(key: string): boolean {
  return /(Chance|Resist|Percent|OverCap)$|^Spec:.*Inc$/.test(key)
}

// ── row / section builders ───────────────────────────────────────────────────
interface Row {
  label: string
  /** Pre-built value markup. Only numeric-derived strings + escaped text go in here. */
  html: string
}

function section(title: string, rows: Row[]): string {
  if (rows.length === 0) return ''
  const body = rows.map((r) => `<div class="sp-row"><dt>${escapeHtml(r.label)}</dt><dd>${r.html}</dd></div>`).join('')
  return `<section class="sp-group"><h3 class="sp-hd">${escapeHtml(title)}</h3><dl class="sp-rows">${body}</dl></section>`
}

/** "(N free)" reservation suffix, shown only when part of the pool is reserved. */
function freeSub(unreserved: number | undefined, total: number): string {
  if (unreserved === undefined || unreserved >= total) return ''
  const cls = unreserved < 0 ? 'sp-sub sp-bad' : 'sp-sub'
  return ` <span class="${cls}">${C.freeSuffix(fmtNum(unreserved))}</span>`
}

// ── the panel ────────────────────────────────────────────────────────────────
export function renderStatsPanel(stats: Record<string, number>, fullDps: PobFullDpsSkill[] = []): string {
  const keys = Object.keys(stats)
  if (keys.length === 0) return ''
  const v = (k: string): number | undefined => stats[k]
  const n = (k: string): number => stats[k] ?? 0

  // ── Offence ──
  const off: Row[] = []
  if (v('TotalDPS') !== undefined) off.push({ label: C.rows.totalDps, html: fmtNum(n('TotalDPS')) })
  if (n('FullDPS') > 0 && n('FullDPS') !== n('TotalDPS'))
    off.push({ label: C.rows.fullDps, html: fmtNum(n('FullDPS')) })
  const avg = v('CombinedAvg') ?? v('AverageDamage')
  if (avg !== undefined) off.push({ label: C.rows.avgDamage, html: fmtNum(avg) })
  // Speed is attacks/casts per second — fixed 2 decimals
  if (v('Speed') !== undefined)
    off.push({ label: C.rows.speed, html: `${n('Speed').toFixed(2)}<i class="sp-unit">/s</i>` })
  if (v('CritChance') !== undefined) off.push({ label: C.rows.critChance, html: fmtPct(n('CritChance')) })
  if (v('CritMultiplier') !== undefined)
    off.push({ label: C.rows.critMultiplier, html: `×${fmtNum(n('CritMultiplier'))}` })
  if (v('HitChance') !== undefined) off.push({ label: C.rows.hitChance, html: fmtPct(n('HitChance')) })
  if (n('TotalDotDPS') > 0) off.push({ label: C.rows.dotDps, html: fmtNum(n('TotalDotDPS')) })
  if (n('CullingDPS') > 0) off.push({ label: C.rows.cullingDps, html: fmtNum(n('CullingDPS')) })

  // ── Defence (Life always shown, even at 0 — e.g. CI builds sit at 1) ──
  const def: Row[] = []
  def.push({ label: C.rows.life, html: fmtNum(n('Life')) + freeSub(v('LifeUnreserved'), n('Life')) })
  if (n('EnergyShield') > 0) def.push({ label: C.rows.energyShield, html: fmtNum(n('EnergyShield')) })
  if (n('Mana') > 0) def.push({ label: C.rows.mana, html: fmtNum(n('Mana')) + freeSub(v('ManaUnreserved'), n('Mana')) })
  if (n('Spirit') > 0)
    def.push({ label: C.rows.spirit, html: fmtNum(n('Spirit')) + freeSub(v('SpiritUnreserved'), n('Spirit')) })
  if (n('Armour') > 0)
    def.push({
      label: C.rows.armour,
      html:
        fmtNum(n('Armour')) +
        (v('PhysicalDamageReduction') !== undefined
          ? ` <span class="sp-sub">${C.physSub(fmtPct(n('PhysicalDamageReduction')))}</span>`
          : ''),
    })
  if (n('Evasion') > 0)
    def.push({
      label: C.rows.evasion,
      html:
        fmtNum(n('Evasion')) +
        (v('EvadeChance') !== undefined ? ` <span class="sp-sub">${C.evadeSub(fmtPct(n('EvadeChance')))}</span>` : ''),
    })
  if (n('DeflectionRating') > 0)
    def.push({
      label: C.rows.deflection,
      html:
        fmtNum(n('DeflectionRating')) +
        (v('DeflectChance') !== undefined ? ` <span class="sp-sub">(${fmtPct(n('DeflectChance'))})</span>` : ''),
    })
  if (n('EffectiveBlockChance') > 0) def.push({ label: C.rows.blockChance, html: fmtPct(n('EffectiveBlockChance')) })
  if (n('EffectiveSpellBlockChance') > 0)
    def.push({ label: C.rows.spellBlock, html: fmtPct(n('EffectiveSpellBlockChance')) })

  // ── Resistances — always all four, colour-coded vs the 75% cap ──
  const res: Row[] = (
    [
      [C.rows.fire, 'FireResist'],
      [C.rows.cold, 'ColdResist'],
      [C.rows.lightning, 'LightningResist'],
      [C.rows.chaos, 'ChaosResist'],
    ] as const
  ).map(([label, key]) => {
    const val = n(key)
    const over = n(`${key}OverCap`)
    const cls = val >= 75 ? 'sp-good' : val >= 0 ? 'sp-mid' : 'sp-bad'
    const overTag = over > 0 ? `<i class="sp-over" title="overcap">+${fmtNum(over)}</i>` : ''
    return { label: C.res(label), html: `<span class="${cls}">${fmtPct(val)}</span>${overTag}` }
  })

  // ── Survivability — PoB's EHP + max-hit numbers (absent stats are simply skipped;
  //    the parser drops non-finite values like a CI build's "inf" chaos max hit) ──
  const sur: Row[] = []
  if (v('TotalEHP') !== undefined) sur.push({ label: C.rows.effectiveHp, html: fmtNum(n('TotalEHP')) })
  for (const [label, key] of [
    [C.rows.maxPhysHit, 'PhysicalMaximumHitTaken'],
    [C.rows.maxFireHit, 'FireMaximumHitTaken'],
    [C.rows.maxColdHit, 'ColdMaximumHitTaken'],
    [C.rows.maxLightningHit, 'LightningMaximumHitTaken'],
    [C.rows.maxChaosHit, 'ChaosMaximumHitTaken'],
  ] as const) {
    if (v(key) !== undefined) sur.push({ label, html: fmtNum(n(key)) })
  }

  // ── Attributes — flag "value / required" in danger colour when the requirement is unmet ──
  const attr: Row[] = []
  for (const a of ['Str', 'Dex', 'Int'] as const) {
    if (v(a) === undefined) continue
    const req = n(`Req${a}`)
    attr.push(
      req > n(a)
        ? {
            label: C.attr[a],
            html: `<span class="sp-bad" title="requirement not met">${C.attrReq(fmtNum(n(a)), fmtNum(req))}</span>`,
          }
        : { label: C.attr[a], html: fmtNum(n(a)) },
    )
  }

  // ── Charges — only sets the build can actually hold (max > 0) ──
  const chg: Row[] = []
  for (const c of ['Power', 'Frenzy', 'Endurance'] as const) {
    const max = n(`${c}ChargesMax`)
    if (max > 0) chg.push({ label: C.chargesLabel(c), html: `${fmtNum(n(`${c}Charges`))} / ${fmtNum(max)}` })
  }

  // ── Full DPS skills — PoB's per-skill breakdown summed into Full DPS. Verbatim PoB strings
  //    (never recomputed); the whole section self-hides when the build carries no Full-DPS rows. ──
  const fullDpsRows: Row[] = fullDps.map((r) => ({
    label: r.source || r.stat || '—',
    html:
      escapeHtml(r.value) +
      (r.skillPart ? ` <span class="sp-sub">${C.fullDpsPart(escapeHtml(r.skillPart))}</span>` : ''),
  }))

  // ── the collapsed full table — every exported stat, alphabetical ──
  const allRows = [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((k) => {
      const val = stats[k]!
      const txt = isPercentLike(k) ? fmtPct(val) : fmtNum(val)
      return `<li><span class="sp-k">${escapeHtml(k)}</span><b class="sp-v">${txt}</b></li>`
    })
    .join('')

  return (
    `<div class="sp">` +
    `<p class="sp-cap">${C.caption}</p>` +
    `<div class="sp-grid">` +
    section(C.groups.offence, off) +
    section(C.groups.defence, def) +
    section(C.groups.resistances, res) +
    section(C.groups.survivability, sur) +
    section(C.groups.attributes, attr) +
    section(C.groups.charges, chg) +
    `</div>` +
    section(C.fullDpsSkillsTitle, fullDpsRows) +
    `<details class="sp-all"><summary>${C.allExported(keys.length)}</summary><ul class="sp-all-list">${allRows}</ul></details>` +
    `</div>`
  )
}
