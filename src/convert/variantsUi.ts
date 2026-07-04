// ── Variants step UI (multi-`.build` export) ─────────────────────────────────
// Extracted from main.ts (structural refactor — behaviour/output unchanged). One PoB can hold several
// loadouts. Each row = one .build: a (tree spec, skill set, item set) tuple + a name. The user maps
// them, then downloads them all at once (N files to Downloads).
//
// These are the PURE pieces: the row model, the label helpers, and the rows-markup builder
// (`renderVariantRows` returns the HTML string main.ts assigns to #var-rows). The mutable `variants`
// state + the event listeners that reorder/rename/remove rows stay in main.ts (they're woven through
// the convert/download flow) — this module is a pure additive layer they call into.
import type { PobBuild } from './types'
import { escapeHtml } from '../ui/escapeHtml'
import { plural } from '../ui/format'
import { toastHtml } from '../ui/toast'
import { copy } from '../copy'

export interface VariantRow {
  id: number // stable key (survives reorders/removes; not the array index)
  name: string
  specIndex: number
  skillSetId: string
  itemSetId: string
}

/** A default row mapped to the build's ACTIVE loadout — the first row the user sees + the Add default.
 *  `id` is supplied by the caller (main.ts owns the stable-key sequence). */
export function defaultVariantRow(pob: PobBuild, id: number): VariantRow {
  const spec = pob.specs[pob.activeSpecIndex]
  return {
    id,
    name: (spec?.title || pob.className || copy.variants.defaultName).trim(),
    specIndex: pob.activeSpecIndex,
    skillSetId: pob.activeSkillSetId ?? pob.skillSets[0]?.id ?? '',
    itemSetId: pob.activeItemSetId ?? pob.itemSets[0]?.id ?? '',
  }
}

function specLabel(pob: PobBuild, i: number): string {
  const s = pob.specs[i]
  if (!s) return copy.variants.treeFallback(i + 1)
  const base = copy.variants.specLabel(s.title || copy.variants.treeFallback(i + 1), s.nodes.length)
  // surface each spec's tree version only when the PoB actually mixes versions — the common
  // single-version case stays clean
  const mixed = new Set(pob.specs.map((x) => x.treeVersion)).size > 1
  return mixed ? base + copy.variants.specTreeVersion(s.treeVersion) : base
}
function skillSetLabel(pob: PobBuild, id: string): string {
  const s = pob.skillSets.find((x) => x.id === id)
  return s ? s.title || copy.variants.skillSetFallback(s.id) : copy.variants.emptyDash
}
function itemSetLabel(pob: PobBuild, id: string): string {
  const s = pob.itemSets.find((x) => x.id === id)
  return s ? s.title || copy.variants.gearSetFallback(s.id) : copy.variants.emptyDash
}
export function variantPreview(pob: PobBuild, row: VariantRow): string {
  const nodes = pob.specs[row.specIndex]?.nodes.length ?? 0
  return `${plural(nodes, 'node')} · ${skillSetLabel(pob, row.skillSetId)} · ${itemSetLabel(pob, row.itemSetId)}`
}

/** The "name needed before download" warning toast — shown when any row name is blank. */
export const blankNote = toastHtml('warn', copy.conv.nameNeededTitle, copy.conv.nameNeededBody)

/** The pure rows markup for #var-rows: one editable row per variant (move/rename/spec/skills/gear +
 *  preview + remove). Caller assigns the result to els.varRows.innerHTML and toggles the surrounding
 *  empty/note state. */
export function renderVariantRows(pob: PobBuild, variants: readonly VariantRow[]): string {
  const treeOpts = (sel: number): string =>
    pob.specs
      .map((_, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${escapeHtml(specLabel(pob, i))}</option>`)
      .join('')
  const setOpts = (sets: ReadonlyArray<{ id: string; title: string | null }>, sel: string, kind: string): string =>
    sets
      .map(
        (s) =>
          `<option value="${escapeHtml(s.id)}"${s.id === sel ? ' selected' : ''}>${escapeHtml(s.title || copy.variants.setFallback(kind, s.id))}</option>`,
      )
      .join('')

  return variants
    .map((row, i) => {
      const blank = row.name.trim().length === 0
      return (
        `<div class="var-row${blank ? ' var-row--blank' : ''}" role="listitem" data-id="${row.id}">` +
        `<div class="var-move">` +
        `<button type="button" class="icb icb--xs var-up" aria-label="${copy.variants.moveUp}"${i === 0 ? ' disabled' : ''}>↑</button>` +
        `<button type="button" class="icb icb--xs var-down" aria-label="${copy.variants.moveDown}"${i === variants.length - 1 ? ' disabled' : ''}>↓</button>` +
        `</div>` +
        `<input class="var-name" type="text" value="${escapeHtml(row.name)}" placeholder="${copy.variants.namePlaceholder}" aria-label="Variant name" />` +
        `<label class="var-sel">${copy.variants.treeLabel}<select class="var-tree" aria-label="Tree spec">${treeOpts(row.specIndex)}</select></label>` +
        `<label class="var-sel">${copy.variants.skillsLabel}<select class="var-skills" aria-label="Skill set">${setOpts(pob.skillSets, row.skillSetId, copy.variants.skillSetKind)}</select></label>` +
        `<label class="var-sel">${copy.variants.gearLabel}<select class="var-gear" aria-label="Item set">${setOpts(pob.itemSets, row.itemSetId, copy.variants.gearSetKind)}</select></label>` +
        `<span class="var-preview">${escapeHtml(variantPreview(pob, row))}</span>` +
        `<button type="button" class="icb icb--xs var-remove" aria-label="${copy.variants.removeVariant}">✕</button>` +
        `</div>`
      )
    })
    .join('')
}
