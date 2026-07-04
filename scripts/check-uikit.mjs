// Library-first guard (part of `npm run check:dedupe`): interactive UI must COMPOSE the vendored
// ui-component-library (src/vendor/uikit/) instead of hand-rolling a parallel component. Every
// <button>/<input>/<select>/<textarea>/<table> authored in index.html or a src/ HTML-string template
// must carry a library class (or match a dated EXCEPTION below). When this gate fails: reuse/extend
// the vendored component (ix-btn / icb / ix-seg / in-input / dt- / sk- / es- / itc- …) — do NOT add
// an exception without the owner's sign-off.
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

const ROOT = process.cwd()

// Class stems the vendored library subset provides (src/vendor/uikit/components.subset.css) + the
// app-shared `.alert` toast vocabulary (single source in ui/toast.ts). Prefix stems, tested against
// the whole tag so template interpolations (`class="itc-choice${on ? …}"`) still match.
const LIBRARY_RE =
  /class="[^"]*(?:ix-btn|ix-seg|icb|in-(?:input|field)|dt-|sk-|es-|tb-tab|sx-|itc-|idm|alert|pg-|ns-|dz-)/

// The 2026-07-02 migration pass (owner: "do all of it") moved every migratable control onto the
// vendored library (ix-seg segments, icb steppers, in-input fields, dt- sort headers + table bases,
// pg- pagination, ix-btn actions; dz- was already the vendored #29 drop chip). What remains below is
// each surviving exception with its DECIDED rationale — audited vs the FULL library (308 components).
// Do NOT add entries without the owner's sign-off; reuse/extend the library instead.
const EXCEPTIONS = [
  {
    re: /id="tab-(?:paste|upload|watch)"/,
    reason:
      'segment buttons INSIDE the vendored ix-seg container (#seg, index.html) — the tag-level scan cannot see parents; wiring stays hand-rolled because the library tabs behavior would own panels and break the step-router (CLAUDE.md)',
  },
  {
    re: /class="(?:ec-viewbtn|em-seg-btn)/,
    reason: 'segment buttons INSIDE an ix-seg container (same as tab-*: the container composes the library)',
  },
  {
    re: /type="file"[^>]*hidden/,
    reason: 'hidden native file input behind the vendored dz- (#29) drop chip — visually hidden, semantics only',
  },
  {
    re: /class="faq-hd"/,
    reason:
      'FAQ accordion header — composes the VENDORED accordion behavior (behaviors.js); only the class name is app-local',
  },
  {
    re: /class="itc-tip-act/,
    reason: 'pinned tree-tooltip actions extending the vendored itc- card vocabulary',
  },
  {
    re: /class="loadout-sel"|class="ec-rows-sel|class="var-(?:tree|skills|gear)/,
    reason:
      'DECIDED 2026-07-02: native <select> kept — the library ships NO select behavior (sl-/#326 is visual-only; behaviors.js has tabs/menu/dialog/accordion/combobox/otp/validate/stepper) and native selects win on a11y + mobile pickers; skin stays token-level',
  },
  {
    re: /class="var-name/,
    reason:
      'variant-row name field inside the var- grid (a plain compact text input; in-input sizing conflicts with the dense row — token-styled)',
  },
  {
    re: /class="at-toggle"|id="(?:atlas|genesis)-bg"|class="ttb-bg/,
    reason:
      'DECIDED 2026-07-02: native checkbox + label kept (correct semantics for a settings toggle; the library #3/#341 are button-switches — a semantic sidestep, not a gain); accent-color rides the token',
  },
  {
    re: /class="ttb-/,
    reason: 'canvas tree toolbar cluster (count/art) wired to the tree engine; search/fit DO compose in-input/ix-btn',
  },
  {
    re: /class="(?:am|as)-/,
    reason:
      'DECIDED 2026-07-02: the library #227 drawer is overlay off-canvas; the atlas masters/stats drawers are IN-STAGE panels (the tree must stay visible while picking) — different pattern, kept',
  },
  {
    re: /class="em-subtab/,
    reason:
      'DECIDED 2026-07-02: 2-line tile tabs (title + summary) — no library atom carries a two-line tab; ix-seg/#102 are single-line. Token-styled app molecule; roving tabindex via main.ts wireTablist',
  },
  {
    re: /class="ec-cat/,
    reason:
      'DECIDED 2026-07-02: in-card category list — the library #226 sidebar is an app-shell molecule (brand + collapse), wrong shape; #240 list rows are content rows, not nav buttons. Token-styled',
  },
  {
    re: /class="bc-config"|class="cmp-/,
    reason: 'read-only content tables (PoB config, FAQ compare) — description-list-ish content, not dt- data surfaces',
  },
]

const TAG_RE = /<(button|input|select|textarea|table)\b[^>]*>/g

function* walk(dir) {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name)
    if (e.isDirectory()) {
      if (!rel.includes('vendor') && !rel.includes('data') && !rel.includes('assets')) yield* walk(rel)
    } else if (extname(e.name) === '.ts') yield rel
  }
}

const files = ['index.html', ...walk('src')]
let failed = false
let scanned = 0
for (const f of files) {
  const text = readFileSync(join(ROOT, f), 'utf8')
  for (const m of text.matchAll(TAG_RE)) {
    scanned++
    const tag = m[0]
    if (/<input/.test(tag) && /type="(?:hidden|checkbox|radio)"/.test(tag)) continue // native toggles keep native semantics
    if (LIBRARY_RE.test(tag)) continue
    if (EXCEPTIONS.some((x) => x.re.test(tag))) continue
    console.error(
      `❌ ${relative(ROOT, join(ROOT, f))}: <${m[1]}> composed without a vendored uikit class:\n` +
        `   ${tag.slice(0, 160).replace(/\s+/g, ' ')}\n` +
        `   → reuse/extend the library component (ix-btn/icb/ix-seg/in-input/dt-/sk-/es-/itc-), or add a dated EXCEPTION in scripts/check-uikit.mjs with the owner's sign-off.`,
    )
    failed = true
  }
}

console.log(
  `uikit-reuse guard: ${scanned} interactive elements scanned across ${files.length} files, ${EXCEPTIONS.length} documented exceptions.`,
)
if (failed) process.exit(1)
console.log('✅ All interactive UI composes the vendored ui-component-library (or a documented exception).')
