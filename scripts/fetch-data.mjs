// Build-time data vendoring for the OFFLINE converter.
//
// Prunes the vendored lookups to the minimum the app needs, writing compact JSON into
// src/data/. The shipped app imports these as modules and makes ZERO network calls at
// runtime. Re-run on each PoE2 patch (or `npm run data:refresh` for the whole pipeline).
//
//   node scripts/fetch-data.mjs [--ref <tree tag|sha>]
//
// Sources:
//   - passives.json: GGG official passive tree (grindinggear/poe2-skilltree-export data.json)
//   - gems.json:     OUR OWN datamine — _workbench/data-extract/tables/{BaseItemTypes,SkillGems}.json
//                    (run `npm run data:extract` first; produced by pathofexile-dat, MIT (c) SnosMe)
//   - uniques.json:  OUR OWN datamine — _workbench/data-extract/tables/Words.json, Wordlist 6
//
// This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT, DEFAULT_TREE_REF, TREE_REPO, argValue, getJson, treeRawUrl } from './lib.mjs'

const OUT = join(ROOT, 'src', 'data')
const TABLES = join(ROOT, '_workbench', 'data-extract', 'tables')

// SkillGems.GemType -> the `t` tag the app's lookups/tests rely on.
// Mapping verified by joining the datamine against the previous vendored data: every
// GemType 0 row was "active" (500), 1 "support" (642), 2 "spirit" (44) — zero conflicts.
const GEM_TYPE = { 0: 'active', 1: 'support', 2: 'spirit' }

// Unique item names live in Words rows with this Wordlist value (dat-spike.md §4).
const WORDLIST_UNIQUES = 6

async function readTable(name) {
  try {
    return JSON.parse(await readFile(join(TABLES, `${name}.json`), 'utf8'))
  } catch {
    throw new Error(`_workbench/data-extract/tables/${name}.json missing — run \`npm run data:extract\` first`)
  }
}

function kb(obj) {
  return (Buffer.byteLength(JSON.stringify(obj)) / 1024).toFixed(0) + ' KB'
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const captured = new Date().toISOString().slice(0, 10)
  const ref = argValue('--ref') ?? DEFAULT_TREE_REF
  const treeUrl = treeRawUrl(ref, 'data.json')

  // Patch + schema release of the datamine the gems/uniques come from.
  const extractMeta = JSON.parse(
    await readFile(join(ROOT, '_workbench', 'data-extract', 'extract-meta.json'), 'utf8').catch(() => {
      throw new Error('_workbench/data-extract/extract-meta.json missing — run `npm run data:extract` first')
    }),
  )

  // ---- Passive tree: numeric node id -> PassiveSkills .build id string ----
  console.log(`Fetching GGG passive tree (${TREE_REPO}@${ref})...`)
  const tree = await getJson(treeUrl)
  const nodes = tree.nodes || {}
  /** @type {Record<string,string>} numeric node id -> .build PassiveSkills id string (all nodes) */
  const passiveNodes = {}
  /** @type {Record<string,{name:string,kind:string,asc?:number}>} readable name + kind for NAMED nodes
   *  only (keystone/notable/mastery) so the preview can label perks; small nodes stay id-only. */
  const nodeMeta = {}
  let withId = 0
  for (const [numId, node] of Object.entries(nodes)) {
    if (node && typeof node.id === 'string' && node.id.length) {
      passiveNodes[numId] = node.id
      withId++
      const kind = node.isKeystone ? 'keystone' : node.isNotable ? 'notable' : node.isMastery ? 'mastery' : null
      if (kind && typeof node.name === 'string' && node.name) {
        nodeMeta[numId] = node.ascendancyId ? { name: node.name, kind, asc: 1 } : { name: node.name, kind }
      }
    }
  }
  // ascendancy id -> { name, class } from classes[].ascendancies
  /** @type {Record<string,{name:string,class:string}>} */
  const ascendancies = {}
  for (const cls of tree.classes || []) {
    for (const asc of cls.ascendancies || []) {
      if (asc && asc.id) ascendancies[asc.id] = { name: asc.name ?? '', class: cls.name ?? '' }
    }
  }
  // Invariant: every named node MUST also have a `.build` id in `nodes` — otherwise the preview could
  // mark a perk "● part of the build" that the converter can't actually emit. Fail the vendor run fast.
  const orphans = Object.keys(nodeMeta).filter((id) => !(id in passiveNodes))
  if (orphans.length) {
    throw new Error(
      `nodeMeta has ${orphans.length} node(s) absent from nodes[] (e.g. ${orphans.slice(0, 5).join(', ')})`,
    )
  }

  const passivesOut = {
    _provenance: {
      source: treeUrl,
      treeField: typeof tree.tree === 'string' ? tree.tree : undefined,
      captured,
      nodeCount: withId,
    },
    nodes: passiveNodes,
    nodeMeta,
    ascendancies,
  }

  // ---- Gems: gemId (Metadata path) -> { n: display name, t: type } ----
  // PoB gives us gemId verbatim, so this is only for VALIDATION + classification (meta) + UI names.
  // Join: SkillGems.BaseItemType is a row index into BaseItemTypes; the Id is kept VERBATIM
  // (the game mixes singular Metadata/Items/Gem/ and plural Metadata/Items/Gems/ paths).
  console.log('Building gem table from datamine...')
  const baseItems = await readTable('BaseItemTypes')
  const skillGems = await readTable('SkillGems')
  /** @type {Record<string,{n:string,t:string}>} */
  const gems = {}
  for (const gem of skillGems) {
    const base = baseItems[gem.BaseItemType]
    if (!base || !base.Id.startsWith('Metadata/Items/Gem')) continue
    const t = GEM_TYPE[gem.GemType]
    if (t === undefined) console.warn(`  WARN: unknown GemType ${gem.GemType} for ${base.Id}`)
    gems[base.Id] = { n: base.Name ?? '', t: t ?? '' }
  }

  // ---- Uniques: name -> canonical display name (for unique_name validation + guidance) ----
  // Text2 is the display spelling (e.g. "Wraeclast" vs internal "Wareclast"); fall back to Text.
  console.log('Building unique-name table from datamine...')
  const words = await readTable('Words')
  /** @type {Record<string,string>} name(lowercased) -> canonical display name */
  const uniqueNames = {}
  for (const word of words) {
    if (word.Wordlist !== WORDLIST_UNIQUES) continue
    const canonical = typeof word.Text2 === 'string' && word.Text2.trim() ? word.Text2 : word.Text
    if (typeof canonical !== 'string' || !canonical.trim()) continue
    if (/\[dnt\]/i.test(canonical)) continue // "[DNT]" = do-not-translate dev/placeholder rows — never ship
    uniqueNames[canonical.toLowerCase()] = canonical
  }

  // ---- Fail-loud gates (thresholds just under the 2026-06 live values) ----
  const counts = {
    passiveNodes: withId,
    ascendancies: Object.keys(ascendancies).length,
    gems: Object.keys(gems).length,
    uniques: Object.keys(uniqueNames).length,
  }
  for (const [k, v] of Object.entries(counts)) {
    if (!(v > 0)) throw new Error(`count gate: ${k} is ${v}`)
  }
  if (counts.passiveNodes < 4800)
    throw new Error(`count gate: only ${counts.passiveNodes} tree nodes (expected >= 4800)`)
  if (counts.gems < 1000) throw new Error(`count gate: only ${counts.gems} gems (expected >= 1000)`)
  if (counts.uniques < 1500) throw new Error(`count gate: only ${counts.uniques} uniques (expected >= 1500)`)

  const provenance = {
    captured,
    poe2Patch: extractMeta.poe2Patch,
    schema: extractMeta.schema,
    sources: {
      tree: treeUrl,
      gems: `own pathofexile-dat extraction (BaseItemTypes + SkillGems @ ${extractMeta.poe2Patch})`,
      uniques: `own pathofexile-dat extraction (Words, Wordlist ${WORDLIST_UNIQUES} @ ${extractMeta.poe2Patch})`,
    },
    counts,
    note: "This product isn't affiliated with or endorsed by Grinding Gear Games in any way.",
  }

  await writeFile(join(OUT, 'passives.json'), JSON.stringify(passivesOut))
  await writeFile(join(OUT, 'gems.json'), JSON.stringify(gems))
  await writeFile(join(OUT, 'uniques.json'), JSON.stringify(uniqueNames))
  await writeFile(join(OUT, 'provenance.json'), JSON.stringify(provenance, null, 2))

  console.log('\nVendored to src/data/:')
  console.log('  passives.json ', kb(passivesOut), `(${withId} nodes, ${counts.ascendancies} ascendancies)`)
  console.log('  gems.json     ', kb(gems), `(${counts.gems} gems)`)
  console.log('  uniques.json  ', kb(uniqueNames), `(${counts.uniques} uniques)`)
  console.log('  provenance.json')
  console.log('\nProvenance:', JSON.stringify(provenance.counts))
}

main().catch((e) => {
  console.error('fetch-data failed:', e)
  process.exit(1)
})
