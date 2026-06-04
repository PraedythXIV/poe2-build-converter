# Architecture

How the converter is built and why. The authoritative `.build` format spec lives in GGG's
[Build Planner developer docs](https://www.pathofexile.com/developer/docs/game#buildplanner);
this doc covers *our* pipeline, data sources, and the non-obvious decisions.

> This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

## Goal & non-goals

Convert a build the user **already exported** — a **Path of Building 2** export code/XML (PoB2, or
poe.ninja's "Export to PoB" button) — into a spec-correct PoE2 `.build` file. Pure local conversion.

- **No runtime network / no third-party API.** Everything runs client-side; lookup data is vendored
  into the bundle at build time. The shipped `release/poe2-build-converter.html` is one self-contained
  file with zero network calls.
- **Not a simulator.** The `.build` format carries no computed stats (no DPS/EHP), so neither do we —
  we map structure + guidance text only.
- **Value over poe.ninja's own export:** items. poe.ninja omits gear; PoB2 carries it, so we populate
  `inventory_slots`.

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
`mapItems` → `emit`, orchestrated by `index.ts`.

### 1. Decode
PoB2 export code = URL-safe base64 → zlib inflate → UTF-8 XML rooted at `<PathOfBuilding2>`. Raw XML
is accepted as-is. PoB1 (`<PathOfBuilding>`) is rejected with a clear message.

### 2. Parse
From the XML we read the **active** passive `<Spec>` (CSV of numeric node ids, `ascendancyInternalId`,
`WeaponSet1/2` node lists, jewel `<Sockets>`), the **active** `<SkillSet>`'s socket groups (each a
`<Skill>` with ordered `<Gem>`s), and the **active** `<ItemSet>`'s equipped items (PoB stores each as
its in-game copy/paste text — rarity, name, base, `LevelReq`, mods).

### 3. Map
- **Passives** — each numeric node id → its `PassiveSkills` string id (e.g. `35426` → `strength89`)
  via the bundled GGG tree table. Ascendancy nodes and jewel sockets come through naturally; nodes in
  a `WeaponSetN` list get `weapon_set: N`; a socketed jewel is noted as `additional_text` on its node.
- **Skills** — one `skills[]` entry per socket group, **matching poe.ninja exactly**: the group's
  first gem is the `id`, every other gem (even a second active) goes in `support_skills`, verbatim.
  Gem ids pass through unchanged — including GGG's intermixed singular/plural `Metadata/Items/Gem(s)/`
  spelling, which must **never** be normalized. Tree-/item-granted groups (`source="…"`) are skipped.
- **Items** — PoB slot → `.build` inventory id, with `slot_x` for the grid inventories:
  - Gear: `Weapon1`/`Offhand1` (set 1), `Weapon2`/`Offhand2` (swap), `Helm1`, `BodyArmour1`,
    `Gloves1`, `Boots1`, `Amulet1`, `Ring1`/`Ring2`, `Belt1`.
  - Flasks: one `Flask1` inventory, `slot_x` 0 = life, 1 = mana.
  - Charms: one `Charm1` inventory, `slot_x` 0/1/2.
  - Uniques → `unique_name`; rares/magic → `additional_text` guidance; each item gets a
    `level_interval` of `[item LevelReq, 100]`.

### 4. Emit
Assemble the `Build` object and `JSON.stringify` it (4-space, matching GGG's example). A light schema
check appends diagnostics (warnings) rather than throwing.

## Data sources (vendored, version-pinned, refreshed per patch)

Generated into [`src/data/`](src/data/) by [`scripts/fetch-data.mjs`](scripts/fetch-data.mjs) — public,
no auth. The app imports them as modules, so it makes **zero** network calls at runtime.

| Need | Source |
|---|---|
| passive numeric → `PassiveSkills` id, ascendancy ids | GGG `grindinggear/poe2-skilltree-export` `data.json` |
| gem id ↔ display name (validation), unique names | `repoe-fork/poe2` (`skill_gems.json`, `uniques.json`) |

Node ids are only stable within a passive-tree version, so the data is keyed to a patch — re-run
`npm run fetch-data` and rebuild on each PoE2 patch. The data is GGG's (and a community datamine's);
we consume/refresh it, we don't relicense it (see [LICENSE](LICENSE)).

## How the slot/skill conventions were nailed down

These ids aren't in GGG's docs and untested community generators ship ids that don't import. We pinned
them two ways: (1) tiny probe `.build` files imported in the live client to see which ids the importer
accepts, and (2) cross-checking against real working exports from **poe.ninja** (skills) and
**Mobalytics** (items). Our output is structurally identical to those references for the same builds.

## The app (UI)

Beyond the engine, the page is a thin UI over the same offline pipeline:

- **Live preview** — on every input change, `summarizeSafe()` runs decode+parse only (no emit) and
  `renderContents()` paints a **Build contents** panel: character identity, a **gear gallery** of
  in-game-style item tooltips (the shared UI library's `itc-` card — rarity drives the hue; unequipped
  canonical slots render as muted pewter placeholders), plus skills and allocated passives. The ●/○
  markers flag what's saved to the `.build` vs preview-only.
- **Stepper** — a 4-step Import → Preview → Convert → Download indicator, derived purely from existing
  state (input present, preview shown, `last` result, error), not a separate state machine.
- **Marble background** — `src/bg/marble.ts` is a small WebGL wallpaper (ported from the UI library's
  `#219` shader): fixed, non-interactive, driven by a fixed red `--accent-rgb`, toggle-able (persisted
  in `localStorage`), and frozen under `prefers-reduced-motion`. It's a shader on a canvas — **entirely
  client-side**, so the "no network calls" guarantee is intact; the bundle still issues zero requests.

Everything is inlined into the single `index.html`; the only data is the vendored JSON.

## Build & verify

- `npm run build` → typecheck, bundle to one file (`vite-plugin-singlefile`, `modulePreload` off so
  there's no stray `fetch`), then copy to `release/poe2-build-converter.html`.
- `npm test` (vitest + jsdom) → converts the PoB2 fixture (`tests/fixtures/`) end-to-end and asserts
  the mapped passives/ascendancy/skills/items, plus a DOM "click Convert → render" wiring test.
- `npm run emit-sample` → regenerates a local `examples/sample.build` (git-ignored) for eyeballing.

## By design & caveats

By design — the `.build` format's intended mechanics (what the in-game importer reads), not shortfalls:

- Rare/magic items, item base stats, and jewels are carried as **guidance text** — the format has no
  structured mod fields, and jewels can't be *placed*, so each is noted on its passive node. Uniques
  carry by name.
- The format records *which* gems are socketed, not their levels/quality.
- `level_interval` is `[item LevelReq, level cap]` (a snapshot can't know when an item is replaced), so
  an item shows in-game from the level you can actually equip it.
- Weapon-swap/exotic slots and auto-granted (item-/tree-) skills have no Build Planner equivalent and
  are intentionally left out.
- Meta/ascendancy gems and skill groups are emitted as poe.ninja does (first gem in a group = the
  skill, the rest become `support_skills`).

Caveats — worth verifying:

- `weapon_set` passive tagging is best-effort — confirm multi-weapon-set builds in-game.
- Some PoB codes (e.g. copied from poe.ninja) omit items entirely — absent gear was never in the code.
- The format is GGG "v1 / experimental" and may change.
