// Genesis Tree ("Brequel") CRAFTING REFERENCE data — the non-tree half of the feature.
// Joins the small Brequel crafting tables to BaseItemTypes/ItemClasses for exact display text.
//
//   node scripts/build-genesis-crafting.mjs   (npm run data:genesis-crafting)
//
// Inputs (_workbench/data-extract/tables/, from `npm run data:extract`):
//   BrequelFruitTypes      Wombgift base -> reward type (5)
//   BrequelFruitRewardTypes reward id/name/description (5)  — the "grows into a X" wording
//   BrequelCraftingItems   the special craftable item bases (7)
//   BaseItemTypes / ItemClasses  name + item-class joins
//
// Output: src/data/genesisCrafting.json — { _provenance, wombgifts, bases }
//   wombgifts:  [{ item, reward, subTree, desc }]   — which Wombgift grows which item, per subtree
//   bases:      [{ name, itemClass }]                — the special craftable bases
// (The Fleshgraft -> Graftblood storage curve was dropped 2026-06-27 — Fleshgraft removed from the game.)
// Encounter skills (BrequelEncounterSkills) are the Chayula boss-fight abilities, NOT crafting —
// deliberately excluded so the reference stays on-topic.

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT, kb, readExtractJson, runMain } from './lib.mjs'

const OUT = join(ROOT, 'src', 'data', 'genesisCrafting.json')
const T = (name) => readExtractJson(`tables/${name}.json`)

async function main() {
  const bases = T('BaseItemTypes')
  const itemClasses = T('ItemClasses')
  const fruitTypes = T('BrequelFruitTypes')
  const rewardTypes = T('BrequelFruitRewardTypes')
  const craftingItems = T('BrequelCraftingItems')
  // NOTE: BrequelItemResourceValues (Fleshgraft level -> Graftblood storage) is no longer read — the
  // Fleshgraft/Graftblood mechanic was dropped from the app (2026-06-27, per a recent patch). Not reading
  // it also keeps this build working if/when GGG removes the table.
  const meta = readExtractJson('extract-meta.json')

  const baseName = (idx) => bases[idx]?.Name ?? null
  const className = (idx) => {
    const cls = bases[idx] != null ? itemClasses[bases[idx].ItemClass] : null
    return cls ? cls.Name || cls.Id : null
  }

  // ── wombgifts: each Wombgift base grows into a reward item (per subtree) ──────────────────────
  const wombgifts = fruitTypes.map((ft) => {
    const reward = rewardTypes[ft.Reward]
    if (!reward) throw new Error(`fruit type ${ft.BaseItemType} has no reward row ${ft.Reward}`)
    const item = baseName(ft.BaseItemType)
    if (!item) throw new Error(`fruit type references unknown base item ${ft.BaseItemType}`)
    return {
      item, // e.g. "Lavish Wombgift"
      reward: reward.Name, // singular, e.g. "Currency" / "Ring" / "Amulet"
      subTree: reward.Id, // matches genesisGraph subTree ids (Currency/Rings/Amulets/Belts/Breachstones)
      desc: reward.Description, // "Can grow into a Currency item on the Genesis Tree"
    }
  })
  if (wombgifts.length !== 5) throw new Error(`expected 5 wombgifts, got ${wombgifts.length}`)

  // ── the special craftable bases ──────────────────────────────────────────────────────────────
  const craftBases = craftingItems.map((ci) => {
    const name = baseName(ci.BaseItemType)
    if (!name) throw new Error(`crafting item references unknown base ${ci.BaseItemType}`)
    return { name, itemClass: className(ci.BaseItemType) ?? '' }
  })

  const out = {
    _provenance: {
      source: `own pathofexile-dat extraction — Brequel* crafting tables + BaseItemTypes/ItemClasses @ ${meta.poe2Patch}`,
      captured: new Date().toISOString().slice(0, 10),
      note: 'Game data (c) Grinding Gear Games. Not affiliated with or endorsed by GGG.',
    },
    wombgifts,
    bases: craftBases,
  }
  const json = JSON.stringify(out)
  await mkdir(join(ROOT, 'src', 'data'), { recursive: true })
  await writeFile(OUT, json)
  console.log(`src/data/genesisCrafting.json  ${kb(Buffer.byteLength(json))}`)
  console.log(`  ${wombgifts.length} wombgifts, ${craftBases.length} craftable bases`)
  for (const w of wombgifts) console.log(`    ${w.item} -> ${w.reward} (${w.subTree})`)
}

runMain('build-genesis-crafting', main)
