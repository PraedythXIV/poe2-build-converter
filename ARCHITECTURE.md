# Architecture

How the app — the PoB2 → `.build` converter core, plus the planner panels built around it — is built,
and why. The authoritative `.build` format spec lives in GGG's
[Build Planner developer docs](https://www.pathofexile.com/developer/docs/game#buildplanner);
this doc covers _our_ pipeline, data sources, and the non-obvious decisions.

> This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

## Goal & non-goals

Convert a build the user **already exported** — a **Path of Building 2** export code/XML (PoB2, or
poe.ninja's "Export to PoB" button) — into a spec-correct PoE2 `.build` file. Pure local conversion.

- **No third-party API for conversion.** Everything runs client-side; lookup data is vendored into the
  bundle at build time. The shipped app is a multi-file, content-hashed, code-split `dist/` static
  bundle whose conversion/tree/stats/audit/tier paths make no third-party calls — the only network it
  issues is loading its own same-origin bundled assets.
- **Not a simulator.** The `.build` format carries no computed stats (no DPS/EHP), so neither do we —
  we map structure + guidance text only.

## Pipeline

```
PoB2 code ──decode──► XML ──parse──► PobBuild ──map──► Build ──emit──► .build (JSON)
 (base64+zlib)                          │                │
                                        │                ├─ mapPassives  (numeric node id -> PassiveSkills id)
                                        │                ├─ mapSkills    (socket group -> skill + supports)
                                        │                └─ mapItems     (slot -> inventory_id, items)
                                        └─ Spec(nodes), Skills(gems), Items(slots)
```

Source lives in [`src/convert/`](src/convert/): `decode` → `parsePob` → `mapPassives`/`mapSkills`/
`mapItems` → `emit`, orchestrated by `index.ts`. Parsing and the parsed model now live in
[`src/pob/`](src/pob/) — `parse.ts` plus a **lossless, full-fidelity** `model.ts` (with `itemText.ts`,
`raw.ts`, `index.ts`) that is the single source of truth every panel renders from (it carries the
`<PlayerStat>` snapshot, config sets, notes, and the multi-spec / skill-set / item-set axes).
`src/convert/parsePob.ts` and `src/convert/types.ts` are kept as thin re-export shims into `src/pob/`
for import stability.

### 1. Decode

PoB2 export code = URL-safe base64 → zlib inflate → UTF-8 XML rooted at `<PathOfBuilding2>`. Raw XML
is accepted as-is. PoB1 (`<PathOfBuilding>`) is rejected with a clear message.

### 2. Parse

Parsing uses the browser-native `DOMParser('text/xml')` — zero-dependency and correct in every browser
— and now lives in [`src/pob/parse.ts`](src/pob/parse.ts), producing the lossless `src/pob/model.ts`
build model. From the XML we read the **active** passive `<Spec>` (CSV of numeric node ids, `ascendancyInternalId`,
`WeaponSet1/2` node lists, jewel `<Sockets>`), the **active** `<SkillSet>`'s socket groups (each a
`<Skill>` with ordered `<Gem>`s), and the **active** `<ItemSet>`'s equipped items (PoB stores each as
its in-game copy/paste text — rarity, name, base, `LevelReq`, mods).

### 3. Map

- **Passives** — each numeric node id → its `PassiveSkills` string id (e.g. `35426` → `strength89`)
  via the bundled GGG tree table. Ascendancy nodes and jewel sockets come through naturally; nodes in
  a `WeaponSetN` list get `weapon_set: N`; a socketed jewel is noted as `additional_text` on its node.
- **Skills** — one `skills[]` entry per socket group, **matching poe.ninja exactly**: the group's
  first gem is the `id`, every other gem (even a second active) goes in `support_skills`, verbatim.
  Gem ids **pass through unchanged** — PoB2 already stores each gem's full GGG `Metadata/Items/Gem(s)/…`
  path, the exact string the `.build` format wants, so skills need _no_ name→id lookup; we only
  _validate_ against the gem table (warn, never rewrite). That deliberately preserves GGG's intermixed
  singular/plural `Gem`/`Gems` spelling — mixed _within a single build_ — because normalizing it would
  break the importer. Tree-/item-granted groups (`source="…"`) are skipped.
- **Items** — PoB slot → `.build` inventory id, with `slot_x` for the grid inventories:
  - Gear: `Weapon1`/`Offhand1` (set 1), `Weapon2`/`Offhand2` (swap), `Helm1`, `BodyArmour1`,
    `Gloves1`, `Boots1`, `Amulet1`, `Ring1`/`Ring2`, `Belt1`.
  - Belt row (flasks + charms) is one `Flask1` inventory: `slot_x` 0 = life flask, 1 = mana flask,
    2/3/4 = the three charms (verified in-game — a `Charm1` id renders nothing in the Build Planner).
  - Uniques → `unique_name`; rares/magic → `additional_text` guidance; each item gets a
    `level_interval` of `[item LevelReq, 100]`.

### 4. Emit

Assemble the `Build` object and `JSON.stringify` it (4-space, matching GGG's example). A light schema
check appends diagnostics (warnings) rather than throwing.

**Diagnostics over silent magic** — every lossy or uncertain step (skipped nodes, unknown gem ids,
best-effort weapon-set tags, unmapped slots, unverified unique names) emits a `Warning`
surfaced in the UI. The tool never silently drops or invents data; if it can't be sure, it says so.

**Multi-build export (Variants)** — a single PoB export that carries multiple tree specs / skill sets /
item sets can be converted into several `.build` files in one gesture. `convertVariant()`
(`src/convert/index.ts`) runs the same `convertPob` pipeline once per selected `(tree spec, skill set,
item set)` tuple (`VariantSelection`); `src/convert/variantsUi.ts` drives the picker;
`src/export/builds.ts` turns the N selections into N filesystem-safe, de-duplicated `.build` files for a
single download; and `src/export/loadouts.ts` auto-seeds the variant list from PoB's loadout titles (a
faithful reimplementation of PoB's `SyncLoadouts`, since PoB recomputes loadouts from set titles rather
than storing them).

## Data sources (vendored, version-pinned, refreshed per patch — all our own pipeline)

Generated into [`src/data/`](src/data/) by the scripts under [`scripts/`](scripts/). The app imports
them as modules, so the conversion path makes **zero** network calls at runtime.

| Need                                                                 | Source                                                                            | Built by                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| passive numeric → `PassiveSkills` id, ascendancy ids                 | GGG `poe2-skilltree-export` `data.json` (tag-pinned)                              | `fetch-data.mjs`                                                                |
| tree render graph (x/y, edges + arc centres, kinds, stats) + sprites | same export + its `assets/`                                                       | `build-tree-graph.mjs`                                                          |
| gem id ↔ display name/type                                           | own datamine: `BaseItemTypes` + `SkillGems`                                       | `fetch-data.mjs`                                                                |
| unique names                                                         | own datamine: `Words` (wordlist 6)                                                | `fetch-data.mjs`                                                                |
| affix tiers (pattern → tier ladder, rolls, ilvl)                     | own datamine: `Mods`/`ModType`/`Stats` + `.csd` stat descriptions                 | `build-mod-tiers.mjs`                                                           |
| atlas tree graph                                                     | own datamine: `AtlasSkillGraph.psg` (own decoder) + `PassiveSkills`               | `decode-psg.mjs` + `build-atlas-graph.mjs`                                      |
| atlas-master nodes + icons/portraits (Doryani · Hilda · Jado …)      | own datamine: atlas-master tables + art                                           | `build-atlas-masters.mjs` (+ `build-atlas-master-icons.mjs` / `-portraits.mjs`) |
| Genesis (0.5 Breach/Chayula) crafting-tree graph                     | own datamine: `ChayulaTreePassiveSkillGraph.psg` (same decoder) + `PassiveSkills` | `build-genesis-graph.mjs`                                                       |
| Genesis womb-keystone crafting/reward tooltip content                | own datamine: Wombgift → reward mapping                                           | `build-genesis-crafting.mjs`                                                    |
| emotion mods/recipes + icons (anoint · jewel · waystone)             | own datamine: distilled-emotion item + mod tables                                 | `build-emotions.mjs`                                                            |

The datamine runs against **GGG's patch CDN** via [`pathofexile-dat`](https://github.com/SnosMe/poe-dat-viewer)
(MIT, devDependency): `patch-version.mjs` asks GGG's own PoE2 patch server for the live build
(`patch.pathofexile2.com:13060`, a 2-byte handshake), `extract-tables.mjs` pulls the tables/files into
the gitignored `_workbench/data-extract/`, and the builders prune them into compact vendored JSON. One command —
`npm run data:refresh` — runs the whole loop with fail-loud invariant gates (counts can never silently
regress); `.github/workflows/data-refresh.yml` is the authored (not yet enabled) 6-hourly automation
that opens a PR when the patch or tree export changes. The `.psg` decoder is gate-checked against
ground truth: re-deriving the **character** tree's positions from its `.psg` reproduces GGG's baked
x/y for 5,150/5,150 nodes within 1 world unit, which is what licenses the same math for the atlas
(no official atlas export exists). The data is GGG's; we extract/refresh it, we don't relicense it
(see [LICENSE](LICENSE) + [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)).

## How the slot/skill conventions were nailed down

These ids aren't in GGG's docs and untested community generators ship ids that don't import. We pinned
them two ways: (1) tiny probe `.build` files imported in the live client to see which ids the importer
accepts, and (2) cross-checking against real working exports from **poe.ninja** (skills) and
**Mobalytics** (items). Our output is structurally identical to those references for the same builds.

## The app (UI)

Beyond the engine, the page is a thin UI over the same client-side pipeline:

- **Live preview** — on every input change, `summarizeSafe()` runs decode+parse only (no emit) and
  `renderContents()` paints a **Build contents** panel: character identity, a **gear gallery** of
  in-game-style item tooltips (the shared UI library's `itc-` card — rarity drives the hue; unequipped
  canonical slots render as muted pewter placeholders), plus skills and allocated passives. The ●/○
  markers flag what's saved to the `.build` vs preview-only.
- **Stepper** — a 5-step Import → Verify breakdown → Passive tree → Variants → Convert indicator, derived
  purely from existing state (input present, preview shown, `last` result, error), not a separate state machine.
- **Watch mode (optional)** — a Chromium-desktop-only live file-watch (`src/watch/fileWatch.ts`, File
  System Access API, polling `File.lastModified` every ~700 ms) that re-runs the same client-side
  pipeline whenever the user's PoB build file changes on disk. Gated on `isFileWatchSupported()`;
  picking a file auto-switches the app into `watch` mode. Falls back to the paste-driven live preview
  where the API is unavailable.
- **Marble background** — `src/bg/marble.ts` is a small WebGL wallpaper (ported from the UI library's
  `#219` shader): fixed, non-interactive, driven by a fixed red `--accent-rgb`, toggle-able (persisted
  in `localStorage`), and frozen under `prefers-reduced-motion`. It's a shader on a canvas — **entirely
  client-side**, so the "no third-party calls" guarantee is intact; it issues no network requests.

- **Design system (vendored ui-component-library subset)** — the UI is built from a copied subset of the
  shared `ui-component-library`, kept in `src/vendor/uikit/`. It is now **CSS + JS** (no longer CSS-only):
  five `@import`ed stylesheets (`default → poe2 → motion → utilities → components.subset`) **plus**
  `behaviors.js` — the library's vanilla APG interaction layer (`mountBehaviors()`), the **first vendored
  JS**. The routing-coupled nav / input-mode tablists and the lock/error step-router keep their hand-rolled
  wiring in `main.ts` (the library's panel-owning `tabs`/`stepper` behaviors would bypass routing); the
  `dialog` + `accordion` behaviors ARE adopted. Component atoms adopted by class: `icb-` icon buttons,
  `ix-seg` segmented control, `ix-btn`, `in-field--search`, plus the data surfaces `dt-` (table base),
  `sk-` (skeleton loading), `es-` (empty/error state) for the economy panels (state logic in
  `src/economy/states.ts`). The **item overlay is ONE persistent modal** (`.idm` + `data-behavior="dialog"`):
  focus-trap + Escape + restore-to-opener; the opener card carries `aria-haspopup="dialog"` and the content
  is swapped per item. The **FAQ** is an APG accordion (button + `role="region"` panel, single-open). The
  look is a **token set, never a fork**: `poe2.css` is the single `--poe-*` source bridged onto the library
  contract + a skin axis (caps labels, gated glow, octagon CTA clip, gold corner-brackets via the shared
  `--corner-*` L-bracket primitive). App-specific semantic families live in the `styles.css` `[data-theme=
poe2]` block — the namespaced `--poe-craft-*` (item-mod affix/gem hues, each with an `-rgb` triple;
  "fractured" deliberately off the movable accent-gold) and `--tree-*`. Spacing rides the constrained
  `--space-*` scale (on-grid values tokenized); shadows use the tintable `rgba(var(--shadow-rgb), a)` form.
  Muted text (`--poe-ash-2`) is tuned to clear WCAG AA. Canvas trees are `role="img"` with a per-tree label
  - the allocated-stats panel as the text alternative; the page `<h1>` sits inside `<main aria-labelledby>`.
    The app's inline alert is `.alert` (renamed off the library's reserved `ts-` Toasts stem). The `.tb-underline`
    active-tab indicator animates **transform only** (translateX + scaleX) — composited; this fix was contributed
    back upstream to the library.

All UI is bundled into the same code-split `dist/`; the only data is the vendored JSON, fetched as same-origin hashed assets.

## The planner panels (around the converter core)

All panels render from the same parsed model the converter uses — one source of truth, refreshed by
`updateContents()` on every input change:

- **Stats (`src/ui/statsPanel.ts`)** — displays the `<PlayerStat>` block PoB itself exports (~100
  stats). Deliberately **no calc engine**: the numbers are PoB's, a snapshot from export time, and
  the UI says so. Tree edits do _not_ recompute them (stated in the tree card).
- **Config / Notes / PoB inspector (`src/ui/configPanel.ts`, `notesPanel.ts`, `pobInspectorPanel.ts`)** —
  three read-only views straight off the lossless `src/pob` model: PoB's `<Config>` sets, the build's
  notes text, and a raw-model inspector that surfaces the full parsed PoB structure for verification.
- **Audit (`src/audit/audit.ts` → `src/ui/auditPanel.ts`)** — pure rules over structure + the stat
  snapshot (resist caps with CI awareness, unmet requirements, over-reservation, defensive layers,
  duplicate supports per link, item level gates, gear coverage). Game facts are cited inline; wording
  never claims more than a static snapshot can know.
- **Passive tree (`src/tree/`)** — Canvas2D renderer over the pruned GGG export: spatial-hash
  hit-testing, LOD tiers, batched edge strokes (arcs from export arc-centres), sprite atlases for
  node art, ascendancy overlay at the in-game panel offset. The character tree is a **read-only
  viewer** of the imported PoB tree (pan / zoom / hover / search / tooltips — it never edits): the
  viewer lists ids unknown to the current tree data as "missing"; conversion skips them from the
  `.build` (an unmapped numeric id has no `PassiveSkills` id to write) and reports the count in a
  `passive-node-unknown` warning. The shared `mountTree` engine
  still carries a full allocation editor (multi-source BFS seeded by class/ascendancy starts, cascade
  refunds, undo/redo) — used by the **editable atlas planner** below, not the character tree. The
  tooltip shows PoB-sourced per-node facts exactly: the attribute a generic node was set to
  (`<AttributeOverride>`) and weapon-set membership. Ported pieces (viewport/spatial/BFS shapes from
  `poe2-tools/poe2-build-planner`, conventions from `cvenzin/poe2-skilltree` — both MIT) carry
  attribution headers.
- **Atlas tree (`src/atlas/`)** — the same renderer + allocation engine over `atlasGraph.json`
  (573 nodes from our `.psg` decode), mounted **editable** as a planning-only tool: allocate atlas
  nodes and share a plan by link (`#atlas=` URL hash; codec in `src/atlas/share.ts`). A separate
  **atlas-master node picker** (`src/atlas/masters.ts` + `mastersShare.ts`, surfaced via the
  `atlas-masters-counts` panel) lets you allocate per-master nodes (Doryani / Hilda / Jado …), each
  with its own icons/portraits (`atlasMaster*.json`); those picks persist locally under
  `poe2.atlasMasters` and fold into the same `#atlas=` share link via `encodeMasters`/`decodeMasters`.
  The atlas is **non-exportable** by a _format fact_: `.build` v1 has no atlas fields (verified against
  the spec and real `.build` files), so an
  atlas plan can never live in a `.build`.
- **Genesis tree (`src/genesis/`)** — the same renderer + allocation engine over `genesisGraph.json`,
  our `.psg` decode of the 0.5 Breach/Chayula crafting tree (the "Genesis"/"Brequel" tree). It's
  **five disconnected subtrees** (Currency · Rings · Amulets · Belts · Breachstones), each seeded from
  its own "Womb" keystone root, so allocation in one subtree can never reach another. Node tooltips
  surface the womb-keystone crafting/reward reference (`src/genesis/crafting.ts` over
  `genesisCrafting.json`). Editable and link-shareable, but — like the atlas — **non-exportable by a
  format fact**: `.build` v1 has no Genesis fields.
- **Emotions planner (`src/emotions/`)** — a reference/planning tool for Delirium _distilled emotions_,
  in three views mirroring the three in-game uses: **Amulet** (enter how many of each emotion you own →
  every Notable you can anoint right now and how many times, anointing being an ordered 3-emotion
  recipe), **Jewel** (emotion × jewel-colour outcome table, normal + Time-Lost), and **Waystone**
  (per-emotion Deliriousness % + map reward, with a combiner). Each emotion shows its in-game icon and
  reveals its mods on hover via the shared `.itc-card` tooltip. Pure lookups over vendored data —
  nothing computed, nothing exported.
- **Item tiers (`src/items/`)** — normalizes a mod line (numbers → `#`), looks it up in
  `modTiers.json`, and picks the tier bracket by roll value. T1 = strongest (the post-0.2.0 in-game
  convention). Unmatched/rune/unique lines get no chip — honesty over guesses.
- **Market prices (`src/economy/` + `server/`)** — the one online feature, strictly opt-in (zero
  network until _Load prices_). poe2scout and pobb.in send no CORS headers, so a thin BFF proxy is
  required: `server/worker.mjs` is a portable fetch-handler (Cloudflare-deployable; `server/dev.mjs`
  runs it locally) with a strict upstream allowlist, TTL caches, a polite identified User-Agent and
  per-IP rate limiting. An opt-in **Currency Exchange** view (`src/economy/exchange.ts`) — a faithful
  reimplementation of poe2scout's exchange/market page (cap + hourly volume + history chart + the
  ~2.8 MB trading-pair matrix, sorted/searched client-side) — is fetched once per league through the
  same BFF and processed client-side. GGG's official currency-exchange API (cxapi) needs an approved
  OAuth app and is documented as out-of-scope for now. Details: [server/README.md](server/README.md).

The tree/atlas graphs, tier table and sprite atlases (the bulk of the payload, several MB) are emitted
as content-hashed assets under `dist/assets` and fetched on demand from the app's own origin — so the
initial shell stays small and each asset caches independently, while conversion still makes no
third-party calls.

## Security

The converter handles untrusted input (a pasted build export), so every build-derived string reaches
the DOM via `textContent` or is HTML-escaped before any `innerHTML` — warnings, stats, and the JSON
syntax-highlighter all escape first, then wrap. No `eval`, no `innerHTML` of raw input; download
filenames are sanitised. The conversion path has no server and no secret material; the only backend is
the opt-in market-prices BFF (`server/`), which carries the upstream allowlist + rate limits and never
sees build data.

## Build & verify

- `npm run build` → typecheck, then `vite build` → a multi-file, content-hashed, code-split `dist/`
  (relative `base: './'` so it runs under any host/path; assets emitted under `dist/assets`). Serve it
  from any static host, or `npm run preview` locally over http.
- `npm test` (vitest + jsdom) → converts the PoB2 fixture (`tests/fixtures/`) end-to-end and asserts
  the mapped passives/ascendancy/skills/items, plus a DOM "click Convert → render" wiring test. (jsdom,
  not happy-dom: `parsePob`'s `DOMParser('text/xml')` needs real XML parsing, which happy-dom lacks.)

## By design & caveats

By design — the `.build` format's intended mechanics (what the in-game importer reads), not shortfalls:

- Rare/magic items, item base stats, and jewels are carried as **guidance text** — the format has no
  structured mod fields, and jewels can't be _placed_, so each is noted on its passive node. Uniques
  carry by name.
- The format records _which_ gems are socketed, not their levels/quality.
- `level_interval` is `[item LevelReq, level cap]` (a snapshot can't know when an item is replaced), so
  an item shows in-game from the level you can actually equip it.
- Weapon-swap weapons convert (they map to the format's second weapon set, `Weapon2`/`Offhand2`);
  exotic slots and auto-granted (item-/tree-) skills have no Build Planner equivalent and are
  intentionally left out.
- Meta/ascendancy gems and skill groups are emitted as poe.ninja does (first gem in a group = the
  skill, the rest become `support_skills`).

Caveats — worth verifying:

- `weapon_set` passive tagging is best-effort — confirm multi-weapon-set builds in-game.
- Some PoB codes (e.g. copied from poe.ninja) omit items entirely — absent gear was never in the code.
- The format is GGG "v1 / experimental" and may change.

---

**Working on this?** Build / test / data-pipeline snags (test failures after a refresh, the pipeline
scripts, the dev server, the compliance guards) are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md);
user-facing import questions live in the app's FAQ.
