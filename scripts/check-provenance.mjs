// Provenance / "don't copy from restricted sources" guard (zero-dependency).
//
// Backstop for the rule in _workbench/Docs/asset-licenses.md: we never copy code from copyleft
// (GPL/AGPL) or no-license sources. This script makes a slip catchable in CI:
//   (1) no denylisted (copyleft / no-license) package may appear as a dependency, and
//   (2) our source must contain none of the forbidden markers (distinctive identifiers
//       copied from a restricted source).
//
// Marker selection rules (how the list below was built — keep following them):
//   - Every marker was read DIRECTLY from the restricted repo's source on GitHub
//     (verified 2026-06-12) — never invented from memory.
//   - Markers are distinctive AUTHORSHIP artifacts: function/class/const names, protocol
//     sentinels, module names — strings that would only appear in our tree if their code
//     had been lifted.
//   - Markers must NOT be facts we legitimately reference: hostnames ("pobb.in",
//     "patch.pathofexile.com"), protocol byte values, game terms ("desecrated"),
//     GGG field names ("orbitRadii"), or names so natural we could coin them
//     independently (e.g. Psg* types in a .psg decoder, "ORBIT_RADII" tables).
//   - A marker that false-positives on our own code was badly chosen: replace it with a
//     more distinctive one from the same repo — never weaken the scan itself.
//
//   node scripts/check-provenance.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'

// npm package names that must NEVER be a dependency (copyleft / no-license).
// None of the restricted repos is on npm today; these are the names they (or a mirror)
// would plausibly publish under. Exact-match against dependencies + devDependencies.
const DENY_PACKAGES = [
  'pob-mcp', // ianderse/pob-mcp (GPL-3.0)
  'pob_wrapper',
  'pob-wrapper', // coldino/pob_wrapper (no license)
  'poeapi', // willroberts/poeapi (GPL-3.0)
  'pasteofexile', // Dav1dde/pasteofexile (AGPL-3.0)
  'juicejournal', // JuiceJournal/JuiceJournal (no license)
  'poe2dps', // chrisdfennell/poe2dps (no license)
  'poe-patch-update', // poe-tool-dev/poe-patch-update (no license)
  'poe_overlay',
  'poe-overlay',
  'xilehud', // XileHUD/poe_overlay (GPL-3.0)
  'ggpk-explorer', // juddisjudd/ggpk-explorer (GPL-3.0)
]

// Distinctive strings that would indicate code lifted from a restricted source.
// Each entry: { source, marker, reason }. All markers verified against the repo's
// actual files (path noted in `reason`) on 2026-06-12.
const FORBIDDEN_MARKERS = [
  // poe-tool-dev/poe-patch-update — no license. We reuse only its protocol FACTS
  // (host/port/handshake bytes) in scripts/patch-version.mjs; the C# itself is off-limits.
  {
    source: 'poe-tool-dev/poe-patch-update (no license)',
    marker: 'PatchNumFetcher',
    reason: 'C# class implementing the patch-server probe (src/PoeFetchLatestPatch/PatchNumFetcher.cs)',
  },
  {
    source: 'poe-tool-dev/poe-patch-update (no license)',
    marker: 'GetPatchNumberAsync',
    reason: 'method name on PatchNumFetcher',
  },
  {
    source: 'poe-tool-dev/poe-patch-update (no license)',
    marker: 'PoeFetchLatestPatch',
    reason: 'C# namespace / project name shared by every file in the repo',
  },
  {
    source: 'poe-tool-dev/poe-patch-update (no license)',
    marker: 'FetchPatchNumHttp',
    reason: 'Azure Function class name (FetchPatchNumHttp.cs)',
  },

  // Dav1dde/pasteofexile (pobb.in) — AGPL-3.0. We are a CLIENT of its /raw API only.
  {
    source: 'Dav1dde/pasteofexile (AGPL-3.0)',
    marker: 'PathOfBuildingExt',
    reason: 'Rust extension trait used throughout app/src/pob/summary.rs',
  },
  {
    source: 'Dav1dde/pasteofexile (AGPL-3.0)',
    marker: 'stat_at_least',
    reason: 'snake_case trait method from app/src/pob/summary.rs',
  },
  {
    source: 'Dav1dde/pasteofexile (AGPL-3.0)',
    marker: 'AscendancyOrClass',
    reason: 'shared model type (shared/src/model.rs)',
  },
  {
    source: 'Dav1dde/pasteofexile (AGPL-3.0)',
    marker: 'formatted_max_hit',
    reason: 'pob summary helper fn (app/src/pob/summary.rs)',
  },

  // JuiceJournal/JuiceJournal — no license. We read its GGG OAuth PKCE FLOW only.
  {
    source: 'JuiceJournal/JuiceJournal (no license)',
    marker: 'POE_REAUTH_REQUIRED',
    reason: 'error-code constant in backend/services/poeApiService.js',
  },
  {
    source: 'JuiceJournal/JuiceJournal (no license)',
    marker: 'clearPoeLink',
    reason: 'poeAuthService function name (backend/services/poeAuthService.js)',
  },
  {
    source: 'JuiceJournal/JuiceJournal (no license)',
    marker: 'tagPoeError',
    reason: 'error-wrapping helper in backend/services/poeApiService.js',
  },

  // willroberts/poeapi — GPL-3.0. Design reference for rate limiting only.
  { source: 'willroberts/poeapi (GPL-3.0)', marker: 'DefaultStashRateLimit', reason: 'exported Go const (client.go)' },
  {
    source: 'willroberts/poeapi (GPL-3.0)',
    marker: 'GetLatestStashID',
    reason: 'APIClient interface method (client.go)',
  },
  { source: 'willroberts/poeapi (GPL-3.0)', marker: 'DefaultNinjaHost', reason: 'exported Go const (client.go)' },

  // coldino/pob_wrapper — no license. Headless-PoB harness concept only.
  {
    source: 'coldino/pob_wrapper (no license)',
    marker: 'pobinterface',
    reason: 'Lua module table name (pob_wrapper/data/pobinterface.lua)',
  },
  {
    source: 'coldino/pob_wrapper (no license)',
    marker: '_pob_line_to_html',
    reason: 'Python helper in pob_wrapper/pob.py',
  },
  {
    source: 'coldino/pob_wrapper (no license)',
    marker: '!*>>>>>>>>>>>>*!',
    reason: 'START_MSG protocol sentinel in pob_wrapper/process_wrapper.py',
  },

  // ianderse/pob-mcp — GPL-3.0. Headless-PoB oracle pattern reference only.
  { source: 'ianderse/pob-mcp (GPL-3.0)', marker: 'PoBLuaApiClient', reason: 'bridge class in src/pobLuaBridge.ts' },
  {
    source: 'ianderse/pob-mcp (GPL-3.0)',
    marker: 'POB_API_STDIO',
    reason: 'env var its Lua bridge sets (src/pobLuaBridge.ts)',
  },
  {
    source: 'ianderse/pob-mcp (GPL-3.0)',
    marker: 'defensiveLayerSummary',
    reason: 'field of DefensiveAnalysis (src/defensiveAnalyzer.ts)',
  },

  // chrisdfennell/poe2dps — no license. Scoped-DPS approach concept only.
  { source: 'chrisdfennell/poe2dps (no license)', marker: 'rxGainExtra', reason: 'regex variable in script.js' },
  { source: 'chrisdfennell/poe2dps (no license)', marker: 'applyQualityToPhysical', reason: 'function in script.js' },
  {
    source: 'chrisdfennell/poe2dps (no license)',
    marker: 'matchedConsolidated',
    reason: 'item-parser local variable in script.js',
  },

  // XileHUD/poe_overlay — GPL-3.0. Learn-only.
  {
    source: 'XileHUD/poe_overlay (GPL-3.0)',
    marker: 'POE1_BASETYPE_CATEGORY_OVERRIDES',
    reason: 'const map in src/main/item-parser.ts',
  },
  {
    source: 'XileHUD/poe_overlay (GPL-3.0)',
    marker: 'OrganizedModifier',
    reason: 'exported interface in src/main/item-parser.ts',
  },

  // juddisjudd/ggpk-explorer — GPL-3.0. Arm's-length tool only.
  {
    source: 'juddisjudd/ggpk-explorer (GPL-3.0)',
    marker: 'GGPK_LOOSE_FILE_SENTINEL',
    reason: 'pub const in src/bundles/index.rs',
  },
  {
    source: 'juddisjudd/ggpk-explorer (GPL-3.0)',
    marker: 'path_enrichment',
    reason: 'bundles module name (src/bundles/path_enrichment.rs)',
  },
]

const ROOT = process.cwd()
const SCAN_DIRS = ['src', 'scripts', 'server', 'tests']
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.mts', '.cjs', '.css', '.html'])
// This file defines the markers, so it necessarily contains them — exclude it (only it).
const SELF = join('scripts', 'check-provenance.mjs')

let failed = false

// (1) dependency denylist
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
const deniedPresent = DENY_PACKAGES.filter((d) => d in deps)
if (deniedPresent.length) {
  console.error(`❌ Denylisted (copyleft / no-license) dependency present: ${deniedPresent.join(', ')}`)
  failed = true
}

// (2) forbidden-marker grep over our own source
function* walk(dir) {
  let entries
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const rel = join(dir, e.name)
    if (e.isDirectory()) yield* walk(rel)
    else if (EXTS.has(extname(e.name)) && rel !== SELF) yield rel
  }
}
let scanned = 0
const sources = new Set(FORBIDDEN_MARKERS.map((m) => m.source))
function checkFile(f) {
  scanned++
  let text
  try {
    text = readFileSync(join(ROOT, f), 'utf8')
  } catch {
    return
  }
  for (const { source, marker, reason } of FORBIDDEN_MARKERS) {
    if (text.includes(marker)) {
      console.error(`❌ Forbidden marker "${marker}" found in ${f}\n   from ${source} — ${reason}`)
      failed = true
    }
  }
}
for (const dir of SCAN_DIRS) {
  for (const f of walk(dir)) checkFile(f)
}
// repo-root files too (non-recursive): index.html carries real inline JS (the boot-gate script),
// and vite.config.ts is code like any other.
for (const e of readdirSync(ROOT, { withFileTypes: true })) {
  if (e.isFile() && EXTS.has(extname(e.name))) checkFile(e.name)
}

console.log(
  `Provenance guard: deps denylist (${DENY_PACKAGES.length} names), ` +
    `${FORBIDDEN_MARKERS.length} markers from ${sources.size} restricted sources, scanned ${scanned} files.`,
)
if (failed) {
  console.error(`\nPolicy: _workbench/Docs/asset-licenses.md §8 — restricted sources are learn-only; copy no code.`)
  process.exit(1)
}
console.log('✅ No denylisted dependency and no forbidden source markers.')
