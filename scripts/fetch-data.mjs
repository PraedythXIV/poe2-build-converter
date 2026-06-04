// Build-time data vendoring for the OFFLINE converter.
//
// Downloads the public datamined tables and PRUNES them to the minimum the app needs,
// writing compact JSON into src/data/. The shipped app imports these as modules and makes
// ZERO network calls at runtime. Re-run this on each PoE2 patch to refresh the lookups.
//
//   node scripts/fetch-data.mjs
//
// Sources (public, no auth; no LICENSE file -> we consume/refresh, we don't re-host as our own):
//   - GGG official passive tree:  grindinggear/poe2-skilltree-export/data.json
//   - repoe-fork PoE2 datamine:    repoe-fork.github.io/poe2/{skill_gems,uniques}.json
//
// This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'data')

const SOURCES = {
  tree: 'https://raw.githubusercontent.com/grindinggear/poe2-skilltree-export/main/data.json',
  gems: 'https://repoe-fork.github.io/poe2/skill_gems.json',
  uniques: 'https://repoe-fork.github.io/poe2/uniques.json',
}

const UA = 'poe2-build-converter data-vendor (offline build tool)'

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

function kb(obj) {
  return (Buffer.byteLength(JSON.stringify(obj)) / 1024).toFixed(0) + ' KB'
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const captured = new Date().toISOString().slice(0, 10)

  // ---- Passive tree: numeric node id -> PassiveSkills .build id string ----
  console.log('Fetching GGG passive tree...')
  const tree = await getJson(SOURCES.tree)
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
    throw new Error(`nodeMeta has ${orphans.length} node(s) absent from nodes[] (e.g. ${orphans.slice(0, 5).join(', ')})`)
  }

  const passivesOut = {
    _provenance: {
      source: SOURCES.tree,
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
  console.log('Fetching gem table...')
  const gemsRaw = await getJson(SOURCES.gems)
  /** @type {Record<string,{n:string,t:string}>} */
  const gems = {}
  for (const [id, e] of Object.entries(gemsRaw)) {
    if (!id.startsWith('Metadata/Items/Gem')) continue
    const display = e?.base_item?.display_name ?? e?.display_name ?? ''
    const type = e?.gem_type ?? ''
    gems[id] = { n: display, t: type }
  }

  // ---- Uniques: name -> base type (for unique_name validation + item guidance) ----
  console.log('Fetching uniques table...')
  let uniquesRaw
  try {
    uniquesRaw = await getJson(SOURCES.uniques)
  } catch (err) {
    console.warn('  uniques.json fetch failed, continuing without it:', err.message)
    uniquesRaw = {}
  }
  /** @type {Record<string,string>} name(lowercased) -> canonical display name */
  const uniqueNames = {}
  const collectUnique = (name, base) => {
    if (typeof name !== 'string' || !name.trim()) return
    uniqueNames[name.toLowerCase()] = name
  }
  // repoe uniques shape is uncertain across versions; handle the common forms defensively.
  if (Array.isArray(uniquesRaw)) {
    for (const u of uniquesRaw) collectUnique(u?.name ?? u?.display_name, u?.base ?? u?.item_class)
  } else if (uniquesRaw && typeof uniquesRaw === 'object') {
    for (const [k, v] of Object.entries(uniquesRaw)) {
      if (v && typeof v === 'object') collectUnique(v.name ?? v.display_name ?? k, v.base ?? v.item_class)
      else collectUnique(k)
    }
  }

  const provenance = {
    captured,
    sources: SOURCES,
    counts: {
      passiveNodes: withId,
      ascendancies: Object.keys(ascendancies).length,
      gems: Object.keys(gems).length,
      uniques: Object.keys(uniqueNames).length,
    },
    note: "This product isn't affiliated with or endorsed by Grinding Gear Games in any way.",
  }

  await writeFile(join(OUT, 'passives.json'), JSON.stringify(passivesOut))
  await writeFile(join(OUT, 'gems.json'), JSON.stringify(gems))
  await writeFile(join(OUT, 'uniques.json'), JSON.stringify(uniqueNames))
  await writeFile(join(OUT, 'provenance.json'), JSON.stringify(provenance, null, 2))

  console.log('\nVendored to src/data/:')
  console.log('  passives.json ', kb(passivesOut), `(${withId} nodes, ${Object.keys(ascendancies).length} ascendancies)`)
  console.log('  gems.json     ', kb(gems), `(${Object.keys(gems).length} gems)`)
  console.log('  uniques.json  ', kb(uniqueNames), `(${Object.keys(uniqueNames).length} uniques)`)
  console.log('  provenance.json')
  console.log('\nProvenance:', JSON.stringify(provenance.counts))
}

main().catch((e) => {
  console.error('fetch-data failed:', e)
  process.exit(1)
})
