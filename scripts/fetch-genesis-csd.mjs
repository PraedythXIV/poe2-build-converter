// Fetch the LIVE-patch general stat-description file as a Genesis stat-text SUPPLEMENT.
//
//   node scripts/fetch-genesis-csd.mjs   (npm run data:genesis-csd)
//
// Why: the Genesis ("Brequel") reward stats (e.g. brequel_reward_breachlord_sac_chance) were ADDED
// to Data/StatDescriptions/stat_descriptions.csd in a patch AFTER our pinned extraction (4.5.2.1.2),
// so our vendored copy lacks them and build-genesis-graph.mjs falls back to raw "stat_id = value"
// lines. .csd files are STRING-KEYED (stat-id -> text) and patch-stable, so the live-patch copy is a
// safe supplement: appended LAST in the build's lookup order, the pinned files still win for every
// stat they already resolve, and the live file only FILLS the new Brequel reward gaps.
//
// We fetch into a SEPARATE cache dir (.work/.cache-live) so the pinned 4.5.2.1.2 bundle cache that
// the rest of the pipeline relies on is never wiped (CdnBundleLoader.create rm -rf's its root when
// the patch dir is absent). Output: _workbench/data-extract/files/Data@StatDescriptions@stat_descriptions_live.csd
// (gitignored, like all of _workbench/data-extract/). Note: the two brequel_reward_*_jewel_catalyst_*_chance
// stats have NO description in ANY of the game's 587 .csd files (verified) — those stay raw, exact.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CdnBundleLoader, FileLoader } from '../node_modules/pathofexile-dat/dist/cli/bundle-loaders.js'
import { ROOT } from './lib.mjs'
import { probePatchServer } from './patch-version.mjs'

const SRC = 'data/statdescriptions/stat_descriptions.csd'
const OUT = join(ROOT, '_workbench', 'data-extract', 'files', 'Data@StatDescriptions@stat_descriptions_live.csd')

async function main() {
  console.log('Probing live PoE2 patch version...')
  const patch = (await probePatchServer()).patch
  console.log(`Fetching ${SRC} @ live patch ${patch} (Genesis stat-text supplement)`)
  const cache = join(ROOT, '_workbench', 'data-extract', '.work', '.cache-live') // SEPARATE — never touch the pinned cache
  const loader = await FileLoader.create(await CdnBundleLoader.create(cache, patch))
  const buf = Buffer.from(await loader.getFileContents(SRC))
  mkdirSync(join(ROOT, '_workbench', 'data-extract', 'files'), { recursive: true })
  writeFileSync(OUT, buf)
  console.log(`Wrote ${OUT}  ${(buf.length / 1024).toFixed(0)} KB`)
}

main().catch((e) => {
  console.error('fetch-genesis-csd failed:', e)
  process.exit(1)
})
