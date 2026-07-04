// Read-only render of the ACTIVE config set's inputs — the calc assumptions PoB exported (enemy level,
// boss flags, charges, conditions, …). Strictly informational: it explains *under what conditions* PoB's
// exported stats hold; we never recompute anything. Returns '' (hidden) when the build carries no config.
import { escapeHtml } from './escapeHtml'
import { humanizeId } from './humanize'
import configLabelsJson from '../data/configLabels.json'
import type { ConfigInput, PobBuild } from '../pob/model'
import { copy } from '../copy'

// PoB's OWN config-option wording (var -> label), vendored from ConfigOptions.lua by
// scripts/build-config-labels.mjs — so a raw key like "conditionEnemyIgnited" shows as PoB's real
// "Is the enemy Ignited?" (NOT a guessed camelCase-spacing). Unknown keys fall back to humanizeId.
const { _provenance: _configLabelsProvenance, ...CONFIG_LABELS } = configLabelsJson as unknown as Record<string, string>

/** Real PoB label for a config var, else a spaced fallback. The raw key stays in a `title` tooltip. */
function configLabel(name: string): string {
  return CONFIG_LABELS[name] ?? humanizeId(name)
}

function fmtValue(v: ConfigInput['value']): string {
  if (v.kind === 'boolean') return v.value ? copy.config.boolOn : copy.config.boolOff
  return v.value
}

export function renderConfigPanel(pob: PobBuild): string {
  // Honour the ACTIVE set: when PoB names one, show exactly that set (or nothing if it's missing) —
  // never silently fall back to another set's inputs. Only default to the first set when no id is named.
  const set = pob.activeConfigSetId ? pob.configSets.find((c) => c.id === pob.activeConfigSetId) : pob.configSets[0]
  const inputs = set?.inputs ?? []
  if (inputs.length === 0) return ''
  const rows = inputs
    .map((i) => {
      const cls = i.value.kind === 'boolean' ? (i.value.value ? 'cfg-on' : 'cfg-off') : 'cfg-val'
      // show PoB's real label; keep the raw PoB key in a tooltip so nothing is hidden
      const name = `<th scope="row" class="cfg-name" title="${escapeHtml(i.name)}">${escapeHtml(configLabel(i.name))}</th>`
      return `<tr>${name}<td class="${cls}">${escapeHtml(fmtValue(i.value))}</td></tr>`
    })
    .join('')
  const multi =
    pob.configSets.length > 1 ? ` <span class="cfg-note">${copy.config.multiSets(pob.configSets.length)}</span>` : ''
  return (
    `<section class="card" aria-labelledby="bc-config-hd">` +
    `<div class="card-hd" id="bc-config-hd" role="heading" aria-level="2">${copy.config.headerLabel} <span class="cfg-sub">${copy.config.headerSub}</span>${multi}</div>` +
    `<div class="card-body"><table class="bc-config">` +
    `<caption class="sr-only">${copy.config.caption}</caption><tbody>${rows}</tbody></table></div>` +
    `</section>`
  )
}
