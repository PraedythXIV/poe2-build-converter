# PoE2 Build Converter — PoB2 → `.build`

A **completely offline** tool that converts a **Path of Building 2** export into a Path of Exile 2
**Build Planner** (`.build`) file you can import in-game. Paste a PoB2 code (or upload the decoded
XML), get a spec-correct `.build` you drop into your game folder.

It does what poe.ninja's beta export does **plus items** — uniques become `unique_name`, rares/magic
become readable stat-priority guidance.

> This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

## Why "offline"?

Everything runs in your browser with **zero network access** — the built `index.html` is a single
self-contained file (no server, no backend, no telemetry). The passive/gem/unique lookup tables are
**vendored into the bundle at build time** (see [Data](#updating-the-data-per-patch)). Your build
data never leaves your machine.

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

## What gets converted

| Build part | Source (PoB2 XML) | `.build` output |
|---|---|---|
| Ascendancy | `<Spec ascendancyInternalId>` | `ascendancy` (verbatim, e.g. `Monk1`) |
| Passives | `<Spec nodes>` (numeric) | `passives[]` ids via GGG tree lookup; weapon-set tagging; jewel-socket notes |
| Skills | `<Skill><Gem gemId>` | `skills[]` with `support_skills[]` — gem ids pass through **verbatim** |
| Items | `<Items>` + `<ItemSet>` | `inventory_slots[]` — uniques → `unique_name`, rares/magic → guidance text, each with a `level_interval` (`[item LevelReq, 100]`) |

Run `npm run emit-sample` to generate a local `examples/sample.build` from the test fixture — handy
for eyeballing real output (git-ignored, not committed).

## Limitations (v1)

- **Meta / ascendancy skill gems** are emitted as-is, mirroring poe.ninja; GGG's spec notes the
  importer may treat them specially.
- **Weapon-set passive tagging** is best-effort; verify multi-weapon-set builds in-game.
- **Jewels** can't be *placed* by the `.build` format, so each socketed jewel is noted as text on its
  passive node instead.
- **Weapon-swap and a few exotic slots** have no Build Planner equivalent and are skipped (you'll see
  a note).
- **Rare-item mods** round-trip as free guidance text only — the `.build` format has no structured
  mod fields.
- **Gem levels/quality** aren't carried — the `.build` format conveys *which* gems, not their levels.
- Auto-granted skills (from items/tree) and weapon-swap gear are intentionally excluded so the output
  reflects what you actually socketed/equipped.
- **Slot ids cross-checked against real poe.ninja + Mobalytics exports (PoE2 0.5):** gear uses
  `Weapon1`/`Offhand1`/`Helm1`/…, weapon swap uses `Weapon2`/`Offhand2`, flasks are `Flask1` (slot_x
  0 = life, 1 = mana), charms are `Charm1` (slot_x 0/1/2). Charms 4–6 (a future addition) aren't
  mapped yet — PoB doesn't export those slots until they exist.
- **Skill groups** are emitted like poe.ninja: one entry per socket group (first gem = the skill, all
  other gems become `support_skills`), and tree-/item-granted skills are skipped.
- The format is **GGG "v1 / experimental"** and may change; treat output as a strong draft and
  confirm in-game.

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
