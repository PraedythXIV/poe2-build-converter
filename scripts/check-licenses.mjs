// License allowlist guard (zero-dependency).
//
// Fails (exit 1) if any INSTALLED dependency carries a license outside our permissive
// allowlist. This enforces the project rule from _workbench/Docs/asset-licenses.md:
//   "Copy code only from permissive (MIT/BSD/Apache/CC0). GPL/AGPL/no-license are off-limits."
// so a copyleft or unlicensed package can never silently enter the build.
//
//   node scripts/check-licenses.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// SPDX ids we accept (permissive / public-domain). Add only after verifying it's truly permissive.
const ALLOW = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Zlib',
  'Python-2.0',
  'WTFPL',
  'CC-BY-4.0',
])

// Explicit, reasoned overrides for a specific package whose metadata is wrong/missing
// but whose LICENSE file you have verified by hand. Keep each entry justified.
const EXCEPTIONS = {
  // 'some-pkg': 'verified MIT in its LICENSE file on 2026-06-06 (package.json omits the field)',
}

// Copyleft packages allowed ONLY as arm's-length BUILD-TIME tools (_workbench/Docs/asset-licenses.md §1:
// running a GPL tool is fine — its output isn't GPL; copying its code is not). Each entry is
// verified to be unreachable from the app: the guard fails if one ever appears in the runtime
// `dependencies` tree (it must only be reachable via devDependencies, i.e. never bundled).
const BUILD_TIME_ARMS_LENGTH = {
  'ooz-wasm':
    'GPL-3.0 Oodle decompressor, transitive dep of pathofexile-dat (devDependency); runs only ' +
    'during scripts/extract-tables.mjs data extraction; never imported by src/, never bundled. ' +
    'Verified 2026-06-12.',
  lightningcss:
    'MPL-2.0 CSS transformer/minifier, a dependency of vite@8 (devDependency — the Rolldown-era build ' +
    'tool); runs only during `vite build`, never imported by src/ and never in the shipped dist/ (only ' +
    'its minified-CSS OUTPUT ships, which is not MPL-licensed code). MPL-2.0 permits use as an unmodified ' +
    'build dependency. Owner-approved 2026-06-29 (Vite 8 upgrade). The per-platform native binaries ' +
    '(lightningcss-<platform>) share this status — matched by prefix below.',
}
// lightningcss ships its native core as per-platform binaries (lightningcss-win32-x64-msvc on Windows,
// lightningcss-linux-x64-gnu on the Linux CI, …); npm installs only the current host's. They are the same
// MPL-2.0 build-time tool as `lightningcss` above, so accept the whole `lightningcss-` family (still subject
// to the runtime-leak check below — any of them appearing in the runtime tree fails the guard).
const BUILD_TIME_ARMS_LENGTH_PREFIX = ['lightningcss-']

const NM = join(process.cwd(), 'node_modules')

function licenseString(p) {
  if (typeof p.license === 'string') return p.license
  if (p.license && typeof p.license === 'object' && p.license.type) return p.license.type
  if (Array.isArray(p.licenses))
    return p.licenses
      .map((l) => (typeof l === 'string' ? l : l && l.type))
      .filter(Boolean)
      .join(' OR ')
  return ''
}

// Accept simple SPDX expressions: "(MIT OR Apache-2.0)" ok if ANY operand allowed; "A AND B" needs ALL.
function isAllowed(expr) {
  if (!expr) return false
  const clean = expr.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
  if (ALLOW.has(clean)) return true
  if (/\bOR\b/i.test(clean)) return clean.split(/\bOR\b/i).some((t) => isAllowed(t.trim()))
  if (/\bAND\b/i.test(clean)) return clean.split(/\bAND\b/i).every((t) => isAllowed(t.trim()))
  if (/\bWITH\b/i.test(clean)) return isAllowed(clean.split(/\bWITH\b/i)[0].trim())
  return false
}

const pkgs = new Map() // name@version -> { name, version, license }
function record(dir) {
  try {
    const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (p.name)
      pkgs.set(`${p.name}@${p.version || '?'}`, { name: p.name, version: p.version, license: licenseString(p) })
  } catch {
    // no/malformed package.json in this dir — skip recording it, but still scan its nested deps below
  }
  scan(join(dir, 'node_modules')) // nested deps
}
function scan(nm) {
  let entries
  try {
    entries = readdirSync(nm, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    if (e.name.startsWith('@')) {
      const scope = join(nm, e.name)
      let subs
      try {
        subs = readdirSync(scope, { withFileTypes: true })
      } catch {
        continue
      }
      for (const s of subs) if (s.isDirectory()) record(join(scope, s.name))
    } else {
      record(join(nm, e.name))
    }
  }
}
scan(NM)

// Runtime dependency closure (what can end up in the shipped bundle): walk package.json
// `dependencies` only, from the project root. BUILD_TIME_ARMS_LENGTH entries must NOT be here.
function runtimeClosure() {
  const root = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  const seen = new Set()
  const queue = Object.keys(root.dependencies || {})
  while (queue.length) {
    const name = queue.pop()
    if (seen.has(name)) continue
    seen.add(name)
    try {
      const p = JSON.parse(readFileSync(join(NM, name, 'package.json'), 'utf8'))
      queue.push(...Object.keys(p.dependencies || {}))
    } catch {
      // dep not installed (optional/peer) or unreadable manifest — nothing to enqueue, keep walking
    }
  }
  return seen
}
const runtime = runtimeClosure()

const bad = []
for (const [key, info] of pkgs) {
  if (EXCEPTIONS[info.name] || EXCEPTIONS[key]) continue
  const armsLength =
    BUILD_TIME_ARMS_LENGTH[info.name] || BUILD_TIME_ARMS_LENGTH_PREFIX.some((p) => info.name.startsWith(p))
  if (armsLength) {
    if (runtime.has(info.name)) {
      bad.push({ ...info, license: `${info.license} — copyleft tool LEAKED into runtime dependencies` })
    }
    continue
  }
  if (!isAllowed(info.license)) bad.push(info)
}

console.log(`License guard: scanned ${pkgs.size} installed packages against the permissive allowlist.`)
if (bad.length) {
  console.error(`\n❌ ${bad.length} package(s) with a non-allowlisted / missing license:\n`)
  for (const b of bad.sort((a, b) => a.name.localeCompare(b.name))) {
    console.error(`   ${b.name}@${b.version}  →  ${b.license || '(no license field)'}`)
  }
  console.error(`\nAllowlist: ${[...ALLOW].join(', ')}`)
  console.error(
    `Policy: _workbench/Docs/asset-licenses.md — copy code only from permissive sources; GPL/AGPL/no-license are off-limits.`,
  )
  console.error(
    `If a package is genuinely permissive but mis-flagged, verify its LICENSE file and add it to EXCEPTIONS with a dated reason.`,
  )
  process.exit(1)
}
console.log('✅ All dependencies are permissively licensed.')
