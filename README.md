# PoE2 Build Converter — PoB2 import code → `.build`

A **completely offline** tool that converts a **Path of Building 2** export into a Path of Exile 2
**Build Planner** (`.build`) file you can import in-game. Paste a PoB2 import code (or upload the decoded
XML), get a spec-correct `.build` you drop into your game folder.

It converts the whole build in one pass — passives, skills, **and items**: uniques become
`unique_name`, while rares and magic items become readable stat-priority guidance. As you paste, a
live **Build contents** panel previews the character's gear, skills, and passives *before* you convert.

> This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

**Fully offline.** The built `index.html` is one self-contained file — no server, no backend, no
network calls. The passive/gem/unique lookup tables are vendored into the bundle at build time, so
your build data never leaves your machine.

## Use it

1. **Get a PoB2 export:**
   - In Path of Building 2: *Import/Export → Generate* (copies a code), **or**
   - On poe.ninja: open a character → **Export to Path of Building** (copies the same kind of code).
2. **Convert:** open the app (see below), paste the code (or upload the `.xml`), click **Convert**.
3. **Save:** click **Download .build** (or **Copy JSON**).
4. **Install:** drop the `.build` file here, and the game's File Watcher imports it automatically:
   - **Windows:** `Documents\My Games\Path of Exile 2\BuildPlanner`
   - **Steam Deck:** `…/steamapps/compatdata/2315204395/pfx/drive_c/users/steamuser/Documents/My Games/Path of Exile 2/BuildPlanner`

### Opening the app

Download `poe2-build-converter.html` from the [**Releases**](../../releases/latest) page and open it
in any browser — one self-contained file, fully offline. To share it, just send that file. (Building
from source is covered in [Develop](#develop).)

> If a Chromium build refuses to run the inline script from `file://` (rare), run `npm run preview`
> or serve the file with any static server — no hosting required.

## Interface

The app walks you through four steps — **Import → Preview → Convert → Download** — shown as a progress
bar across the top.

- **Build contents preview.** The moment you paste a valid code, a panel previews the build *before*
  you convert: the character (class · ascendancy · level · main skill), an in-game-style **gear gallery**
  (each item a rarity-framed tooltip; unequipped slots shown as dim placeholders; weapon swaps and tree
  jewels included), and the **skills** and **passives** it allocates. The **●** marker means *saved to
  the `.build`*; **○** means *preview only*.
- **Ambient background.** An animated marble shader sits behind the app; toggle it on/off with the
  flame button in the header (your choice is remembered), and it freezes for `prefers-reduced-motion`.

## Features

- **Whole-build conversion in one pass** — passives, skills (with their supports), and every equipped item.
- **All your gear** — weapons, armour, rings, amulet, **flasks, charms**, plus weapon-swap sets and tree jewels.
- **Rich item data** — uniques by name; rares, magic items, base stats, jewels, and rune-granted stats
  carried as the in-game guidance text the Build Planner displays.
- **Level-aware items** — every item keeps its level requirement, so in the Build Planner it appears
  from the level you can actually equip it ((the tooltips for gear (the little blue icon you can hover over) simply won't show in your inventory until you meet the level requirement for each)).
- **Runes & soul-cores** named, with the stats they grant kept.
- **Named passives** — keystones, notables, and masteries by their real names, not slugs.
- **Per-weapon-set passives** — passives are tagged to the weapon set they belong to, so dual-weapon-set
  builds map across the right sets.
- **Live preview** — the whole build (gear gallery, skills, perks) shown before you convert.
- **Self-contained** — one HTML file to open or share; no install, no network.

## What gets converted

| Build part | Source (PoB2 XML) | `.build` output |
|---|---|---|
| Ascendancy | `<Spec ascendancyInternalId>` | `ascendancy` (verbatim, e.g. `Monk1`) |
| Passives | `<Spec nodes>` (numeric) | `passives[]` ids via GGG tree lookup; weapon-set tagging; jewel-socket notes |
| Skills | `<Skill><Gem gemId>` | `skills[]` with `support_skills[]` — gem ids pass through **verbatim** |
| Items | `<Items>` + `<ItemSet>` | `inventory_slots[]` — uniques → `unique_name`, rares/magic → guidance text, each with a `level_interval` (`[item LevelReq, 100]`) |

Run `npm run emit-sample` to generate a local `examples/sample.build` from the test fixture — handy
for eyeballing real output (git-ignored, not committed).

## By design

The Build Planner `.build` is a lightweight share format, so several things are carried as **guidance
text on purpose** — exactly what the in-game importer reads — rather than as structured fields. This is
intentional, not a shortfall:

- **Rare & magic items, item base stats, and tree jewels** become readable stat-priority guidance text
  (the format has no structured mod fields, and jewels can't be *placed* — so each is noted on its
  passive node). Uniques carry through by name.
- The format records *which* gems you socketed, not their **levels / quality**.
- **Weapon-swap and a few exotic slots**, and **auto-granted** (item-/tree-) skills, have no Build
  Planner equivalent and are intentionally left out (you'll see a note), so the output reflects what you
  actually equipped/socketed.
- **Meta / ascendancy gems** and **skill groups** are emitted the way poe.ninja does: one entry per
  socket group, first gem = the skill, the rest become `support_skills`.
- **Slot ids** were cross-checked against real poe.ninja + Mobalytics exports (PoE2 0.5): gear uses
  `Weapon1`/`Offhand1`/`Helm1`/…, weapon swap `Weapon2`/`Offhand2`, flasks `Flask1` (`slot_x` 0 = life,
  1 = mana), charms `Charm1` (`slot_x` 0/1/2). Charms 4–6 aren't mapped yet — PoB doesn't export those
  slots until they exist.

## Caveats

- **Some PoB codes don't include every item.** A code copied from poe.ninja (or another tool) can leave
  items out — if a slot is empty in the preview, it was empty in the code too (so it's also missing in
  Path of Building), not something the conversion dropped. Cross-check the original build if a piece
  looks absent.
- **Weapon-set passive tagging** is best-effort — verify multi-weapon-set builds in-game.
- The format is **GGG "v1 / experimental"** and may change — treat output as a strong draft and confirm
  in-game.

## Updating the data (per patch)

Passive/gem/unique ids change between PoE2 patches. Refresh the vendored lookups, then rebuild:

```bash
npm run fetch-data   # re-pulls + prunes GGG + repoe-fork data into src/data/
npm run build
```

Sources (public, no auth): GGG `grindinggear/poe2-skilltree-export` (passive ids, ascendancies) and
the `repoe-fork/poe2` datamine (gem + unique names). Neither ships a license; we consume/refresh
their data, we don't re-host it.

## Develop

```bash
npm install
npm test          # vitest: converter + UI-wiring tests (jsdom)
npm run dev       # live dev server
npm run build     # typecheck + bundle -> dist/index.html, copied to release/poe2-build-converter.html
```

## How it works

A `.build` file is plain JSON the game imports from your BuildPlanner folder. Generating one is mostly
an id-mapping problem, solved entirely offline from bundled lookup tables:

1. **Decode** — a PoB2 export code is URL-safe base64 → zlib → XML (`<PathOfBuilding2>`); raw XML is
   accepted directly.
2. **Parse** — read the active passive `<Spec>` (numeric node ids, ascendancy, weapon sets, jewel
   sockets), the active `<SkillSet>` socket groups, and the equipped `<ItemSet>` items.
3. **Map** — passives: numeric node id → `PassiveSkills` id via the bundled GGG tree table; skills:
   one entry per socket group (first gem = the skill, the rest = `support_skills`), gem ids passed
   through verbatim; items: PoB slot → inventory id (+ `slot_x` for the flask/charm grids), uniques →
   `unique_name`, rares → guidance text, each with a `level_interval`.
4. **Emit** — assemble the `Build` object and serialize it to a `.build` file.

The slot/skill conventions were verified against the in-game importer and real working exports from
poe.ninja and Mobalytics. See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full pipeline, data
sources, and design decisions. The authoritative format spec is GGG's
[Build Planner developer docs](https://www.pathofexile.com/developer/docs/game#buildplanner).

## Project layout

```
src/convert/      decode -> parsePob -> mapPassives/mapSkills/mapItems -> emit   (the engine)
src/data/         vendored, pruned lookup tables (generated by scripts/fetch-data.mjs)
src/main.ts       UI wiring;  src/styles.css  tokens + components from a shared UI library
scripts/          fetch-data (vendoring), emit-sample (QA), release (names the single file)
tests/            converter + UI-wiring tests, with the PoB2 fixture in tests/fixtures/
```

Build output (`dist/`, `release/`) is git-ignored; the single-file app ships via the Releases page.
