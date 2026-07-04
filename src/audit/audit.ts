// C3 — static per-build audit. Pure rules over a BuildSummary (structure + PoB's exported
// PlayerStat snapshot). No DOM, no recomputation: every finding only restates what the export
// itself says — this is a static audit of a PoB snapshot, not a simulation.
//
// Game facts used (PoE2 0.x, verified 2026-06):
// - All resistances (fire/cold/lightning/chaos) cap at 75% by DEFAULT; the cap can be raised (hard
//   max 90%) or lowered by mods. PoB does not export the per-character max, but it DOES export the
//   EFFECTIVE (already-capped) resist plus a "<El>ResistOverCap" stat (= the total above the cap),
//   so a resist sitting at its cap always reads OverCap > 0 whatever that cap is. We use OverCap as
//   the authoritative "is it capped" signal and treat 75% only as the default reference for a
//   genuinely-uncapped resist — so a raised/lowered cap is never mis-audited. Source:
//   https://www.poe2wiki.net/wiki/Resistance
// - Chaos Inoculation: maximum life becomes 1 and the character is immune to chaos damage.
//   Source: https://www.poewiki.net/wiki/poe2wiki:Chaos_Inoculation and
//   https://game8.co/games/Path-of-Exile-2/archives/497386
// - Charms: 3 charm slots maximum; belts grant 1 by default, more via belt affixes ("+1/+2 Charm
//   Slots"). Source: https://game8.co/games/Path-of-Exile-2/archives/491177
// - Supports: since patch 0.3.0 the same support gem MAY be used on several different skills
//   (https://www.sportskeeda.com/mmo/path-exile-2-support-gem-rule-change-0-3-poe2-third-edict),
//   so we only flag duplicates WITHIN one link — a skill never benefits from two copies of the
//   same support.

import type { BuildSummary } from '../convert/summarize'

export interface AuditFinding {
  level: 'good' | 'info' | 'warn' | 'error'
  code: string
  title: string
  detail: string
}

// 75 is only the DEFAULT cap reference; the actual capped/uncapped state per element is read from
// PoB's exported "<El>ResistOverCap" (a raised/lowered cap reads OverCap > 0 — see header note).
const DEFAULT_RES_CAP = 75
const ELEMENTS = ['Fire', 'Cold', 'Lightning'] as const
/** Canonical gear slots a finished build is expected to fill (weapon 2 / swaps are optional). */
const CANONICAL_SLOTS = [
  'Weapon 1',
  'Helmet',
  'Body Armour',
  'Gloves',
  'Boots',
  'Belt',
  'Amulet',
  'Ring 1',
  'Ring 2',
] as const

const fmt = (v: number): string => Math.round(v).toLocaleString('en-US')

export function auditBuild(s: BuildSummary): AuditFinding[] {
  const out: AuditFinding[] = []
  const ps = s.playerStats
  const has = (k: string): boolean => typeof ps[k] === 'number'
  const st = (k: string): number => ps[k] ?? 0
  const hasStats = Object.keys(ps).length > 0
  const isCI = s.keystones.includes('Chaos Inoculation')

  // ── no stats at all (hand-written / minimal XML) → say so, run structural rules only ──
  if (!hasStats) {
    out.push({
      level: 'info',
      code: 'no-stats',
      title: 'No PoB stats in this export',
      detail:
        'The export carries no PlayerStat block, so the stat-based checks (resists, reservations, defences) were skipped. Only structural checks ran — the audit is limited.',
    })
  }

  if (hasStats) {
    // ── elemental resists — capped state read from PoB's OverCap (authoritative for ANY cap value) ──
    const capped: string[] = []
    for (const el of ELEMENTS) {
      const key = `${el}Resist`
      if (!has(key)) continue
      const val = st(key)
      const over = st(`${key}OverCap`)
      if (val < 0) {
        out.push({
          level: 'error',
          code: `res-negative-${el.toLowerCase()}`,
          title: `${el} resistance is negative`,
          detail: `${el} resistance sits at ${fmt(val)}% — negative resistance amplifies ${el.toLowerCase()} damage taken. The default cap is ${DEFAULT_RES_CAP}%.`,
        })
      } else if (over > 0 || val >= DEFAULT_RES_CAP) {
        // Capped — at the default 75%, a raised cap (val > 75), or a lowered cap (val < 75 with
        // OverCap > 0). PoB's OverCap > 0 means the build is at its cap whatever its value, so the
        // resist is capped and never warned (fixes the false "short of cap" on a lowered-max build).
        capped.push(`${el} ${fmt(val)}%${over > 0 ? ` (+${fmt(over)} overcap)` : ''}`)
      } else {
        out.push({
          level: 'warn',
          code: `res-uncapped-${el.toLowerCase()}`,
          title: `${el} resistance below the ${DEFAULT_RES_CAP}% cap`,
          detail: `${el} resistance is ${fmt(val)}% — ${fmt(DEFAULT_RES_CAP - val)}% short of the ${DEFAULT_RES_CAP}% default cap. Every missing point is extra ${el.toLowerCase()} damage taken.`,
        })
      }
    }
    if (capped.length > 0) {
      out.push({
        level: 'good',
        code: 'res-capped',
        title:
          capped.length === ELEMENTS.length
            ? 'Elemental resistances capped'
            : `${capped.length} of 3 elemental resistances capped`,
        detail: `${capped.join(', ')}. Overcap is a buffer against resistance-lowering effects (curses, exposure).`,
      })
    }

    // ── chaos resist — same default cap; skipped entirely under CI (chaos-immune). OverCap means it
    //    sits at its (raised/lowered) cap, so only a genuinely-uncapped or negative value is flagged. ──
    if (!isCI && has('ChaosResist')) {
      const cv = st('ChaosResist')
      const cover = st('ChaosResistOverCap')
      if (cv < 0) {
        out.push({
          level: 'warn',
          code: 'chaos-negative',
          title: 'Chaos resistance is negative',
          detail: `Chaos resistance is ${fmt(cv)}%. Chaos resistance matters in PoE2 (it shares the ${DEFAULT_RES_CAP}% default cap), and negative values amplify chaos damage taken.`,
        })
      } else if (cover === 0 && cv < DEFAULT_RES_CAP) {
        out.push({
          level: 'info',
          code: 'chaos-uncapped',
          title: 'Chaos resistance below the cap',
          detail: `Chaos resistance is ${fmt(cv)}% (default cap ${DEFAULT_RES_CAP}%). Not urgent like elemental resists, but more is safer against chaos-heavy content.`,
        })
      }
    }

    // ── attribute requirements — PoB exports both the totals and the gear/gem requirements ──
    const unmet = (['Str', 'Dex', 'Int'] as const).filter((a) => has(`Req${a}`) && st(`Req${a}`) > st(a))
    if (unmet.length > 0) {
      out.push({
        level: 'error',
        code: 'attr-unmet',
        title: 'Attribute requirements not met',
        detail:
          unmet.map((a) => `${a} ${fmt(st(a))} < required ${fmt(st(`Req${a}`))}`).join(', ') +
          ' — per PoB, something in the build needs more attributes than the character has.',
      })
    }

    // ── reservation sanity ──
    // Spirit: only flag a NEGATIVE unreserved value (over-reserved). A build with 0 total spirit
    // but spirit gems present is deliberately skipped — we cannot tell reliably from a snapshot.
    if (has('SpiritUnreserved') && st('SpiritUnreserved') < 0) {
      out.push({
        level: 'error',
        code: 'spirit-overreserved',
        title: 'Spirit over-reserved',
        detail: `Spirit reservations exceed the available ${fmt(st('Spirit'))} spirit by ${fmt(-st('SpiritUnreserved'))} — the reserved skills cannot all be active at once as exported.`,
      })
    }
    if (has('LifeUnreserved') && st('LifeUnreserved') <= 0) {
      out.push({
        level: 'error',
        code: 'life-overreserved',
        title: 'Life fully reserved',
        detail: `Unreserved life is ${fmt(st('LifeUnreserved'))} — reservations consume the entire life pool.`,
      })
    }
    if (has('ManaUnreserved') && st('ManaUnreserved') < 0) {
      out.push({
        level: 'error',
        code: 'mana-overreserved',
        title: 'Mana over-reserved',
        detail: `Unreserved mana is ${fmt(st('ManaUnreserved'))} — mana reservations exceed the mana pool.`,
      })
    }

    // ── defensive layers inventory (meaningful = stat > 0 in the snapshot) ──
    const layers: string[] = []
    if (st('Armour') > 0) layers.push('armour')
    if (st('Evasion') > 0) layers.push('evasion')
    if (st('EnergyShield') > 0) layers.push('energy shield')
    if (st('EffectiveBlockChance') > 0) layers.push('block')
    if (st('DeflectionRating') > 0 || st('DeflectChance') > 0) layers.push('deflection')
    if (layers.length <= 1) {
      out.push({
        level: 'warn',
        code: 'layers-thin',
        title: 'Few defensive layers',
        detail:
          (layers.length === 0
            ? 'No mitigation layer (armour, evasion, energy shield, block, deflection) shows a non-zero value in the snapshot.'
            : `Only one defensive layer shows a non-zero value: ${layers[0]}.`) + ' Consider a second defensive layer.',
      })
    } else {
      out.push({
        level: 'info',
        code: 'layers',
        title: `Defensive layers: ${layers.length}`,
        detail: `Non-zero in the snapshot: ${layers.join(', ')}.`,
      })
    }

    // ── weakest max-hit — surfaced as information only (no invented threshold rule).
    //    Note: PoB exports "inf" for immune types (e.g. chaos under CI); the parser drops
    //    non-finite values, so immune types are naturally excluded here. ──
    const hits = (
      [
        ['physical', 'PhysicalMaximumHitTaken'],
        ['fire', 'FireMaximumHitTaken'],
        ['cold', 'ColdMaximumHitTaken'],
        ['lightning', 'LightningMaximumHitTaken'],
        ['chaos', 'ChaosMaximumHitTaken'],
      ] as const
    ).filter(([, key]) => has(key))
    if (hits.length > 0) {
      const weakest = hits.reduce((min, h) => (st(h[1]) < st(min[1]) ? h : min))
      out.push({
        level: 'info',
        code: 'weakest-hit',
        title: `Weakest hit type: ${weakest[0]}`,
        detail: `Per PoB's max-hit numbers, the smallest single hit this build survives is ${weakest[0]}: ${fmt(st(weakest[1]))}.`,
      })
    }
  }

  // ── CI context (structural: the keystone is read from the tree, so this also works
  //    without stats). Chaos-resistance checks above are suppressed when CI is present. ──
  if (isCI) {
    out.push({
      level: 'info',
      code: 'ci',
      title: 'Chaos Inoculation build',
      detail:
        'Life is fixed at 1 by design — Chaos Inoculation makes energy shield the real health pool and grants immunity to chaos damage, so chaos-resistance checks are skipped.',
    })
  }

  // ── skill links: the same support twice in ONE link does nothing extra ──
  for (const g of s.skills) {
    const seen = new Set<string>()
    const dups = new Set<string>()
    for (const sup of g.supports) {
      if (seen.has(sup)) dups.add(sup)
      seen.add(sup)
    }
    if (dups.size > 0) {
      out.push({
        level: 'warn',
        code: 'duplicate-supports',
        title: `Duplicate supports on ${g.main}`,
        detail: `${[...dups].join(', ')} appears more than once in the same link — a skill only benefits from one copy of a given support, so the duplicate adds nothing.`,
      })
    }
  }

  // ── items the character cannot equip at the build's level (gear + socketed tree jewels) ──
  if (s.level != null) {
    for (const it of [...s.items, ...s.jewels]) {
      if (it.levelReq > s.level) {
        out.push({
          level: 'warn',
          code: 'item-level',
          title: `${it.name} needs level ${it.levelReq}`,
          detail: `${it.name} (${it.slot}) requires level ${it.levelReq}, but the build is level ${s.level} — it cannot be equipped as exported.`,
        })
      }
    }
  }

  // ── gear coverage: canonical slots, flasks, charms ──
  const equipped = new Set(s.items.map((i) => i.slot.toLowerCase()))
  const missing = CANONICAL_SLOTS.filter((slot) => !equipped.has(slot.toLowerCase()))
  if (missing.length > 0) {
    out.push({
      level: 'info',
      code: 'gear-missing',
      title: `${missing.length} empty gear slot${missing.length > 1 ? 's' : ''}`,
      detail: `The export leaves these slots empty: ${missing.join(', ')}.`,
    })
  }

  const flasks = s.items.filter((i) => i.slot.toLowerCase().startsWith('flask'))
  const flaskText = (i: (typeof flasks)[number]): string => `${i.name} ${i.baseType}`
  // a CI build has 1 life, so a missing life flask is not worth flagging there
  const missingFlasks: string[] = []
  if (!isCI && !flasks.some((f) => /life flask/i.test(flaskText(f)))) missingFlasks.push('life')
  if (!flasks.some((f) => /mana flask/i.test(flaskText(f)))) missingFlasks.push('mana')
  if (missingFlasks.length > 0) {
    out.push({
      level: 'info',
      code: 'flasks',
      title: `No ${missingFlasks.join(' or ')} flask equipped`,
      detail: `The exported flask slots carry no ${missingFlasks.join(' or ')} flask.`,
    })
  }

  // 3 = the PoE2 charm-slot maximum. This is a game-rule constant: GGG ships no per-character
  // datamine field for it (the Affliction/belt tables carry no charm-slot cap), so — like the
  // passive-point caps — it stays a documented literal rather than a fabricated "data" value.
  const charms = s.items.filter((i) => i.slot.toLowerCase().startsWith('charm')).length
  if (charms < 3) {
    out.push({
      level: 'info',
      code: 'charms',
      title: `${charms} of up to 3 charms equipped`,
      detail:
        'PoE2 belts grant 1 charm slot by default and up to 3 with belt affixes — depending on the belt, there may be room for more charms.',
    })
  }

  return out
}
