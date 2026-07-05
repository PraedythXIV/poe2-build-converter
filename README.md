# PoE 2 - Sweet Vision — your PoB2 build, in-game

[![CI](https://github.com/PraedythXIV/poe2-build-converter/actions/workflows/ci.yml/badge.svg)](https://github.com/PraedythXIV/poe2-build-converter/actions/workflows/ci.yml)
[![tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FPraedythXIV%2Fpoe2-build-converter%2Fbadges%2Ftests.json)](https://github.com/PraedythXIV/poe2-build-converter/actions/workflows/badges.yml)
[![codecov](https://codecov.io/github/PraedythXIV/poe2-build-converter/graph/badge.svg)](https://codecov.io/github/PraedythXIV/poe2-build-converter)
[![version](https://img.shields.io/github/package-json/v/PraedythXIV/poe2-build-converter?label=version&color=blue)](package.json)
[![game data](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FPraedythXIV%2Fpoe2-build-converter%2Fmain%2Fdata-version.json&query=%24.poe2Patch&label=game%20data&color=8a5fd0)](data-version.json)
[![license](https://img.shields.io/badge/license-MIT-gold)](LICENSE)

[![lighthouse perf](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FPraedythXIV%2Fpoe2-build-converter%2Fbadges%2Flighthouse-performance.json&logo=lighthouse&logoColor=white)](https://praedythxiv.github.io/poe2-build-converter/)
[![lighthouse a11y](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FPraedythXIV%2Fpoe2-build-converter%2Fbadges%2Flighthouse-accessibility.json&logo=lighthouse&logoColor=white)](https://praedythxiv.github.io/poe2-build-converter/)
[![lighthouse best practices](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FPraedythXIV%2Fpoe2-build-converter%2Fbadges%2Flighthouse-best-practices.json&logo=lighthouse&logoColor=white)](https://praedythxiv.github.io/poe2-build-converter/)
[![lighthouse seo](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FPraedythXIV%2Fpoe2-build-converter%2Fbadges%2Flighthouse-seo.json&logo=lighthouse&logoColor=white)](https://praedythxiv.github.io/poe2-build-converter/)

**Turn a Path of Building 2 build into a Path of Exile 2 Build Planner file — and plan everything around it.** Paste a PoB2 export and get a `.build` you can load in-game, a full preview of your gear, skills and passives, your tree on the game's own artwork, and planners for the Atlas, the Genesis tree, Delirium emotions and market prices — all in one page.

> This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

Everything runs **right in your browser** — nothing to install, and your build never leaves your device. The only online features are the opt-in market prices and pobb.in link import, and they only load when you use them.

## Getting your build in-game

1. Copy an export code from **Path of Building 2** (_Import/Export → Generate_), paste a **pobb.in** link — or use the filewatcher.
2. Click **Convert** and download your `.build` file.
3. Drop it in your BuildPlanner folder, or upload it at [pathofexile2.com/my-account/builds](https://pathofexile2.com/my-account/builds) — it shows up in the game's Build Planner.
   - **Windows:** `Documents\My Games\Path of Exile 2\BuildPlanner`
   - **Steam Deck:** `…/steamapps/compatdata/2315204395/pfx/drive_c/users/steamuser/Documents/My Games/Path of Exile 2/BuildPlanner`

The app is a static site — open the hosted version in any browser, and it just works. (Hosting it yourself is covered in [Development](#development).)

## What you can do

- **Convert whole builds in one pass** — passives, skills with their supports, and every equipped item: weapons, armour, rings, amulet, flasks, charms, weapon-swap sets and tree jewels.
- **Preview before you convert** — the moment you paste a valid code you see the character, an in-game-style gear gallery with rarity-framed tooltips, and the skills and passives it allocates. **●** means saved to the `.build`; **○** means preview only.
- **See your passive tree** — your imported tree drawn with the game's own artwork: pan, zoom, search, and hover any node for details. Weapon-set-specific nodes are tinted per set, and jewels show their radius rings.
- **Plan your Atlas** — allocate the endgame atlas tree just like in-game (it auto-paths for you), pick your Atlas Masters' keystones, and share the whole plan with a single link.
- **Plan your Genesis tree** — the Breach crafting tree, with tooltips showing what each Womb grows into. Editable and link-shareable like the Atlas.
- **Delirium emotions recipes** — enter the emotions you own and instantly see every amulet anoint you can make (hidden anoint-only notables included), plus what each emotion does on jewels and waystones.
- **Live market prices** — browse current prices and the currency exchange for the current league; it only loads when you ask.
- **Several loadouts? One click.** If your PoB carries multiple loadouts, each becomes its own `.build` file in a single download.
- **Know your gear's quality** — item mods show their tier with roll ranges, straight from the game's data. When a mod can't be matched exactly, you see nothing rather than a guess.
- **File watcher** — point the app at your PoB build file once (Chrome/Edge) and every save in Path of Building re-imports it automatically.
- **Your build's stats and a health check** — the ~100 stats PoB exported (DPS, EHP, resists…) shown verbatim, plus an honest audit: uncapped resists, unmet requirements, over-reserved spirit, missing gear and more.
- **A light theme** — toggle it in the header.

As always: the stats you see are Path of Building's own exported numbers — never recalculated, never approximated — and conversion happens entirely on your device.

## Good to know

- **Some PoB codes don't include every item.** A code copied from poe.ninja can leave items out — if a slot is empty in the preview, it was empty in the code too, not dropped by the conversion.
- **The `.build` format is deliberately lightweight** — rare and magic items travel as readable guidance text (it has no structured mod fields), jewels are noted on their passive node (they can't be *placed*), gem levels/quality aren't recorded, and weapon-swap weapons land in the format's second weapon set. That's the in-game format's design, not a conversion gap.
- The format is **GGG "v1 / experimental"** and may change — treat output as a strong draft and confirm in-game.
- More questions — a passive showing as "missing", the file not appearing in-game — are answered in the app's **FAQ** tab.

---

## Development

Build / test / data-pipeline issues live in **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**; how the pieces fit is in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

```bash
npm install
npm test            # vitest: engine, panels, tree, psg decoder, tiers, BFF (630 tests)
npm run test:coverage  # the same suite with v8 coverage (lcov + summary in coverage/)
npm run dev         # live dev server (http://localhost:5173)
npm run build       # typecheck + multi-file, content-hashed, code-split bundle -> dist/
npm run serve:bff   # local price proxy for the Market prices card (http://localhost:8787)
npm run check:compliance  # license allowlist + provenance guards
```

### Test coverage

Coverage, bundle size and test results are tracked on [Codecov](https://app.codecov.io/github/PraedythXIV/poe2-build-converter) — see the badge above for the current figure. Each region is a slice below — inner ring is the whole project, outer rings are folders then files; size = statements, colour = coverage.

[![coverage sunburst](https://codecov.io/github/PraedythXIV/poe2-build-converter/graphs/sunburst.svg)](https://app.codecov.io/github/PraedythXIV/poe2-build-converter)

The built `dist/` is a plain static site — serve it over http from any host (GitHub Pages / CF Pages); `file://` won't work (module scripts + asset fetches need an origin). The only backend is the optional, self-hostable price proxy (see [server/README.md](server/README.md)).

### How the conversion works

A `.build` file is plain JSON the game imports from your BuildPlanner folder. Generating one is an id-mapping problem, solved entirely client-side from bundled lookup tables:

1. **Decode** — a PoB2 export code is URL-safe base64 → zlib → XML (`<PathOfBuilding2>`); raw XML accepted directly.
2. **Parse** — read the active passive `<Spec>` (numeric node ids, ascendancy, weapon sets, jewel sockets), the active `<SkillSet>` socket groups, and the equipped `<ItemSet>` items.
3. **Map** — passives: numeric node id → `PassiveSkills` id via the bundled GGG tree table; skills: one entry per socket group (first gem = the skill, the rest = `support_skills`), gem ids passed through verbatim; items: PoB slot → inventory id (+ `slot_x` for the flask/charm grids), uniques → `unique_name`, rares → guidance text, each with a `level_interval`.
4. **Emit** — assemble the `Build` object and serialize it to a `.build` file.

Slot and skill conventions were verified against the in-game importer (probe files) and real working exports from poe.ninja and Mobalytics. The authoritative format spec is GGG's [Build Planner developer docs](https://www.pathofexile.com/developer/docs/game#buildplanner).

### Updating the game data (per patch)

All game data is refreshed by **our own pipeline** — no third-party datamine dependency:

```bash
npm run data:refresh   # probe GGG's patch server -> extract tables -> rebuild all vendored JSON
npm run build
```

Under the hood: `data:patch` asks **GGG's own PoE2 patch server** for the live build; `data:extract` pulls the needed tables/files from the patch CDN via [`pathofexile-dat`](https://github.com/SnosMe/poe-dat-viewer) (MIT); the tree / atlas / genesis / icon graph and mod-tier builders prune everything into `src/data/`. Invariant gates fail loud if a refresh would regress counts. Sources: GGG's official [`poe2-skilltree-export`](https://github.com/grindinggear/poe2-skilltree-export) (listed on their developer docs' Data Exports page) and GGG's own game files via the patch CDN — their data, our extraction; credits in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

### Project layout

```
src/convert/      decode -> parsePob -> mapPassives/mapSkills/mapItems -> emit -> summarize   (the engine, no DOM)
src/pob/          PoB2 XML model (parse, item text, raw passthrough)
src/tree/         Canvas2D tree renderer + the shared mountTree allocation engine
src/atlas/  src/genesis/   editable planners over mountTree (+ atlas #-share codec) — planning-only
src/emotions/     distilled-emotion planner (anoint / jewel / waystone)
src/items/        affix-tier matcher + chips + icon atlas + itc-card overlay
src/economy/      opt-in BFF client + price/exchange panel;  server/  the thin proxy (worker + dev shim)
src/audit/        build-audit rules;  src/ui/  shared HTML-string panels + helpers
src/export/       multi-loadout .build emit + PoB loadout recovery;  src/watch/  live PoB file-watch (Chromium)
src/data/  src/assets/    vendored JSON + packed webp (built offline by scripts/)
src/copy.ts       all user-facing wording + the FAQ;  src/main.ts  UI wiring;  src/styles.css  vendored uikit + theme
src/vendor/uikit/ CSS + JS subset of the shared ui-component-library (copied; behaviors.js = the APG interaction layer)
scripts/          data pipeline (patch probe, extraction, builders), psg decoder, QA, license/provenance guards
tests/            engine + panel + tree + psg + tier + BFF tests (375); fixtures in tests/fixtures/
```

Build output (`dist/`) is git-ignored; the app ships as a static site.
