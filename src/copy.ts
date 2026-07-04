// ════════════════════════════════════════════════════════════════════════════
// USER-FACING WORDING — the one place to edit the app's copy.
//
// Everything a reader sees that the CODE generates lives here: nav + taglines, the
// stepper, status/toast/help messages, button + placeholder text, and the conversion
// warning catalogue. Edit a string here and it changes everywhere it is shown.
//
// Parameterised messages (counts, names) are FUNCTIONS so interpolation stays correct —
// e.g. `copy.imp.loaded('x.xml', '2.1 KB')`. Pluralisation goes through `plural()`.
//
// NOT here (by design, so this file stays purely "copy" you can safely retype):
//   • The static shell's structural HTML  → index.html. (The FAQ Q&As ARE here — see `faq` below —
//     and render into index.html's [data-copy-faq] container at startup.)
//     The shell's SHORT labels (brand, nav, taglines, steps) are mirrored here and pushed
//     into the markup at startup by applyStaticCopy() via `data-copy` / `data-copy-html`.
//   • Accessibility attributes (aria-label/title)           → stay inline on the element.
//   • Game data names (passives, gems, stats, mods)         → DATA, not copy (src/data + humanizeId).
// ════════════════════════════════════════════════════════════════════════════
import { plural } from './ui/format'
import { escapeHtml } from './ui/escapeHtml'

// Item display labels shared verbatim by the items panel (detailsPanel) and the
// breakdown gear gallery (gearGallery) — spread into both `items` and `breakdown` so
// they stay a single source. (The differing keys, ilvlLine / emptyStamp vs empty, live
// on their own blocks.)
const itemLabels = {
  requiresLevel: (lvl: number) => `Requires <span class="itc-attr-c">Level ${lvl}</span>`,
  grants: 'Grants',
  grantWithLevel: (name: string, lvl: number) => `${name} (Lv ${lvl})`,
  previewStamp: (slot: string) => `${slot} · preview only`,
  noItemEquipped: 'No item equipped',
} as const

export const copy = {
  // ── brand / header ──────────────────────────────────────────────────────────
  brand: {
    name: 'PoE 2 - <b>Sweet Vision</b>', // HTML (the gold-accented second half)
    quote: '“Standing on sweet business. The vision will not be hindered.”',
  },

  // ── top-level navigation tabs + each tab's one-line subtitle ─────────────────
  nav: {
    convert: '.build converter',
    atlas: 'Atlas planner',
    genesis: 'Genesis planner',
    emotions: 'Delirium emotions recipes',
    prices: 'Market prices',
    faq: 'FAQ',
  },
  tagline: {
    convert:
      'Turn a Path of Building 2 export into a Path of Exile 2 Build Planner <code>.build</code> file you can import in-game.',
    atlas: 'Plan a Path of Exile 2 Atlas passive tree, then share the exact plan with a link.',
    genesis: 'Plan the Genesis tree — its wombs and node choices, then share the exact plan with a link.',
    emotions: 'Plan emotion combinations for anoints, jewels, and waystones.',
    prices: 'Browse live Path of Exile 2 market prices and the currency exchange.',
    faq: 'Answers to common questions.',
  },

  // ── Convert flow: the 5-step stepper (label + sub-label per step). Single source —
  //    both the static stepper markup and main.ts's step navigation read these. ──
  steps: [
    { label: 'Import', sub: 'Paste or upload' },
    { label: 'Verify breakdown', sub: 'Check the build' },
    { label: 'Passive tree', sub: 'View your tree' },
    { label: 'Variants', sub: 'Per-loadout builds' },
    { label: 'Convert', sub: 'Build & download' },
  ],

  // ── stepper Back/Next nav (Back lives in index.html; Next is dynamic) ────────
  stepper: {
    next: 'Next →',
    nextTo: (label: string) => `${label} →`,
  },

  // ── static index.html shell labels pushed in by applyStaticCopy() at startup ──
  // (card headers, footer column headers, the convert loader, plain static buttons).
  shell: {
    cardImport: 'Import',
    cardBuildContents: 'Build contents',
    cardPassiveTree: 'Passive tree',
    cardVariants: 'Variants',
    cardConvert: 'Convert',
    cardAtlas: 'Atlas tree <span class="hd-tag">planner</span>', // HTML (carries the hd-tag pill)
    cardGenesis: 'Genesis tree <span class="hd-tag">planner</span>', // HTML
    cardEmotions: 'Distilled Emotions <span class="hd-tag">reference</span>', // HTML
    cardPrices: 'Market prices',
    cardFaq: 'Frequently asked questions',
    convertLoader: 'Converting…',
    footResources: 'Resources',
    footTools: 'Tools',
    footLore: 'Lore & Wiki',
    footWhereBuildGoes: 'Where the .build goes',
    footDisclaimer: 'Not affiliated with or endorsed by Grinding Gear Games.',
    btnClear: 'Clear',
    btnConvertAction: 'Convert',
    btnConvertReset: 'Reset',
    btnAtlasFit: 'Fit view',
    btnAtlasReset: 'Reset',
    btnGenesisFit: 'Fit view',
    btnGenesisReset: 'Reset',
  },

  // ── alert titles (the bold lead on a `.alert` row), by severity ───────────
  toast: { error: 'Error', warn: 'Warning', note: 'Note' },

  // ── shared plan links (atlas / genesis '#…=' payloads) ────────────────────────
  share: {
    damagedLink:
      'This share link couldn’t be read — it may be damaged, truncated, or from a newer version. ' +
      'Showing the default plan instead.',
  },

  // ── Import step — paste / upload / pobb.in link / file-watch feedback ─────────
  imp: {
    loaded: (name: string, size: string) => `Loaded ${name} (${size})`,
    pobbinFetching: (id: string) => `Fetching build from pobb.in/${id}…`,
    pobbinLoaded: (id: string) => `Loaded build from pobb.in/${id} — press Convert when ready.`,
    pobbinFailed: (id: string, detail: string) => `Couldn't load pobb.in/${id} — ${detail}`,
  },

  // ── Convert step — download + variant feedback ───────────────────────────────
  conv: {
    downloadingTitle: (n: number) => `Downloading ${plural(n, 'file')}`,
    downloadingBody: "Check your browser's Downloads. If it asks, allow multiple downloads.",
    // shown once the last staggered handoff is past (no browser API reports actual completion)
    downloadedTitle: (n: number) => `Downloaded ${plural(n, 'file')}`,
    downloadedBody: (n: number) =>
      `Now drop ${n > 1 ? 'them' : 'it'} into your BuildPlanner folder — or upload on pathofexile2.com (link below).`,
    flaggedTitle: (n: number) => `${plural(n, 'variant')} flagged`,
    flaggedBody: (files: string) => `${files} converted with errors — open it in PoB to check.`,
    nameNeededTitle: 'Name needed',
    nameNeededBody: 'Every variant needs a name before you can download.',
    noOutput: 'No output — fix the input and convert again.',
  },

  // ── conversion warning / error CATALOGUE — the user-facing MESSAGE text only (codes + levels stay
  //    at the call sites in src/convert/). Pure data: convert/ is DOM-free, and so is this file. ──
  warn: {
    // decode/parse errors (thrown, shown as the convert-failed toast)
    nothingToConvert: 'Nothing to convert — paste a Path of Building 2 code or upload an XML file.',
    notBase64: 'Input is not valid base64 — paste a Path of Building 2 export code, or the decoded XML.',
    decompressFailed: 'Could not decompress the code. Make sure it is a complete Path of Building 2 export code.',
    poe1Code: 'This looks like a Path of Building 1 (PoE1) code. This tool converts Path of Building 2 (PoE2) builds.',
    // emit / mapping warnings (collected into the warnings list)
    gemIdUnknown: (n: number, examples: string) =>
      `${n} gem id(s) were not in the vendored gem table (may be new/renamed); emitted verbatim. Examples: ${examples}.`,
    slotUnmapped: (n: number, slots: string) =>
      `Skipped ${n} slot(s) with no Build Planner equivalent: ${slots}. (Weapon-swap weapons DO convert — they map to the second weapon set.)`,
    uniqueNameUnverified: (n: number, examples: string) =>
      `${n} unique name(s) weren't found in the vendored uniques table; emitted as-is and may not match the in-game Words table. Examples: ${examples}.`,
    missingName: 'Build is missing a required `name`.',
    passiveIdFormat: (n: number, examples: string) => `${n} passive id(s) have an unexpected format: ${examples}.`,
    gemIdFormat: (n: number, examples: string) => `${n} gem id(s) don't look like a Metadata path: ${examples}.`,
    passiveNodeUnknown: (n: number, treeVersion: string, examples: string) =>
      `${n} passive node id(s) were not in the vendored tree (version ${treeVersion}) and were skipped. They may be from a newer/older tree — refresh the data (npm run fetch-data) or check the build's tree version. Examples: ${examples}.`,
    weaponSetTagging: 'This build uses weapon-set passives; weapon_set tagging is best-effort — verify in-game.',
    mixedTreeVersions: (v: string, versions: string) =>
      `This PoB carries passive trees from different tree versions (${versions}); this variant's tree is ` +
      `version ${v}. Specs from older versions may hit unknown-node skips — prefer re-exporting them on the current tree.`,
    socketJewelMissing: (n: number) =>
      `${n} socketed jewel(s) referenced an item not present in the export; the passive is mapped without its jewel note.`,
    grantedSocketJewels: (n: number) =>
      `Carried ${n} jewel${n === 1 ? '' : 's'} from Sinister Jewel Sockets (granted by Voices / the Zarokh's Gift anoint, not the tree) onto ${n === 1 ? 'its' : 'their'} granted socket — verify in-game after importing.`,
  },

  // ── stats panel (ui/statsPanel) — curated group + row labels for PoB's exported PlayerStat snapshot ──
  stats: {
    caption:
      'Stats are Path of Building&#39;s own numbers — a snapshot saved in the export, not recomputed and not live.',
    allExported: (n: number) => `All exported stats (${n})`,
    fullDpsSkillsTitle: 'Full DPS skills',
    fullDpsPart: (part: string) => `part ${part}`,
    groups: {
      offence: 'Offence',
      defence: 'Defence',
      resistances: 'Resistances',
      survivability: 'Survivability',
      attributes: 'Attributes',
      charges: 'Charges',
    },
    rows: {
      totalDps: 'Total DPS',
      fullDps: 'Full DPS (all skills)',
      avgDamage: 'Average damage',
      speed: 'Speed',
      critChance: 'Crit chance',
      critMultiplier: 'Crit multiplier',
      hitChance: 'Hit chance',
      dotDps: 'DoT DPS',
      cullingDps: 'Culling DPS',
      life: 'Life',
      energyShield: 'Energy shield',
      mana: 'Mana',
      spirit: 'Spirit',
      armour: 'Armour',
      evasion: 'Evasion',
      deflection: 'Deflection',
      blockChance: 'Block chance',
      spellBlock: 'Spell block',
      fire: 'Fire',
      cold: 'Cold',
      lightning: 'Lightning',
      chaos: 'Chaos',
      effectiveHp: 'Effective HP',
      maxPhysHit: 'Max physical hit',
      maxFireHit: 'Max fire hit',
      maxColdHit: 'Max cold hit',
      maxLightningHit: 'Max lightning hit',
      maxChaosHit: 'Max chaos hit',
    },
    freeSuffix: (n: string) => `(${n} free)`,
    res: (label: string) => `${label} res`,
    physSub: (pct: string) => `(${pct} phys)`,
    evadeSub: (pct: string) => `(${pct} evade)`,
    attrReq: (val: string, req: string) => `${val} / ${req} req`,
    attr: { Str: 'Str', Dex: 'Dex', Int: 'Int' },
    chargesLabel: (name: string) => `${name} charges`,
  },

  // ── config panel (ui/configPanel) — header + multi-set note for PoB's exported calc assumptions ──
  config: {
    headerLabel: 'Config',
    headerSub: "— PoB's calc assumptions",
    multiSets: (n: number) => `(${n} sets — showing the active one)`,
    boolOn: 'on',
    boolOff: 'off',
    caption: 'PoB calc-assumption inputs for the active config set (read-only).',
  },

  // ── build notes panel (ui/notesPanel) — colourised verbatim PoB <Notes> ──
  notes: {
    headerLabel: 'Build notes',
  },

  // ── audit panel (ui/auditPanel) — severity-summary nouns + the static-snapshot caption ──
  audit: {
    nounIssue: 'issue',
    nounWarning: 'warning',
    nounNote: 'note',
    ok: (n: number) => `${n} OK`,
    caption:
      'Static audit of the PoB export snapshot — it checks what the export states, it does not simulate the build.',
  },

  // ── item details + gear gallery (items/detailsPanel, main.ts gear cards) ──
  items: {
    chipTitle: (tier: number, count: number, min: string, max: string, ilvl: number) =>
      `Tier ${tier} of ${count} (T1 = strongest) — rolls ${min}–${max}, needs item level ${ilvl}`,
    tierApprox: 'Value is outside every roll range known for this item type — no exact tier to show',
    tierNoData: 'No affix-tier data for this line',
    tierUnknown: 'tier ?',
    // {tag} source-badge display labels (key = PoB tag id, value = label shown). Keys are NOT copy.
    tagLabel: {
      crafted: 'crafted',
      fractured: 'fractured',
      desecrated: 'desecrated',
      enchant: 'enchant',
      rune: 'rune',
      mutated: 'mutated',
      unscalable: 'unscalable',
      custom: 'custom',
    } as Record<string, string>,
    metaIlvl: 'ilvl',
    metaQuality: 'Q',
    metaSockets: 'Sockets',
    metaRadius: 'Radius',
    metaLimitedTo: 'Limited to',
    rollPctTitle: (pct: number) => `rolled ${pct}% of this mod's range (PoB's own value)`,
    noteUniqueFixed: 'Unique rolls are fixed ranges — affix tiers do not apply',
    noteTiersUnknown: 'Affix tiers unknown for this item',
    ...itemLabels,
    ilvlLine: (ilvl: number) => `ilvl ${ilvl}`,
    emptyStamp: 'Empty',
  },

  // ── passive tree (tree/index) — node-kind labels, the toolbar, and node-tooltip phrasing ──
  tree: {
    // node-kind sub-line labels (key = NodeKind id, value = label). Keys are NOT copy.
    kindLabel: {
      small: 'Passive',
      notable: 'Notable',
      keystone: 'Keystone',
      mastery: 'Mastery',
      jewel: 'Jewel Socket',
      ascStart: 'Ascendancy Start',
      classStart: 'Class Start',
    } as Record<string, string>,
    // toolbar fragment
    searchPlaceholder: 'Search nodes…',
    fit: 'Fit',
    fitTitle: 'Fit tree to view',
    nodes: 'nodes',
    countTitle: 'Allocated nodes',
    countWsTitle: 'Weapon-set passive points — Set I / Set II (24 each)',
    countAsc: (asc: number, cap: number) => `· ${asc}/${cap} asc`,
    countWs: (ws1: number, ws2: number, cap: number) => `· I ${ws1}/${cap} · II ${ws2}/${cap}`,
    artLabel: 'Art',
    artTitle: 'Show/hide the central class art (off can help performance)',
    canvasAria: 'Passive skill tree — read-only viewer. Allocated passives appear in the build breakdown above.',
    // node tooltip phrasing
    radius: (size: string) => `Radius: ${size}`,
    corrupted: 'Corrupted',
    oneOf: (n: number) => `one of ${n}`,
    allocated: 'Allocated',
    attrChoiceSet: (attr: string) => `Attribute of choice — set to ${attr}`,
    attrChoice: 'Attribute of choice',
    grantsAttr: (which: string) => `Grants ${which}`,
    convertsToWeaponPoints: 'Converts Passive Points to Weapon Set Skill Points',
    weaponSetOnly: (n: string) => `Weapon Set ${n} only`,
    grantsSkill: (name: string) => `Grants ${name}`,
    chooseOne: (label: string, alts: string) => `<b>Choose one</b> ${label}: ${alts}`,
    chooseOneOf: 'of',
    chooseOneAlso: '— also',
    locked: (prereqs: string) => `<b>Locked</b> — requires ${prereqs}`,
    conqueredBy: (faction: string) =>
      `Conquered by the ${faction} (faction node art shown is one-per-faction, not the seeded per-node art)`,
    timeLost: (from: string, to: string) => `Time-Lost Diamond: ${from} → ${to}`,
    selectBonus: 'Select a bonus — reallocatable at any time',
    removeNode: 'Remove node',
    close: 'Close',
  },

  // ── atlas (atlas/masters drawer + atlas/statsPanel summary) ──
  atlas: {
    points: (used: number, budget: number) => `Points: ${used} (${budget})`,
    clickToRemove: 'Click to remove',
    clickToAllocate: 'Click to allocate',
    noKeystones: 'No keystones allocated yet',
    statsTitle: 'Allocated Atlas Bonuses',
    statsEmpty: 'Allocate atlas-tree nodes or atlas-master keystones to see their combined bonuses here.',
    hideMasters: 'Hide Atlas Masters',
    canvasAria: 'Atlas passive tree. Click nodes to allocate; open Allocated Stats for the full list of bonuses.',
  },

  // ── genesis (genesis/crafting womb tooltips + the genesis allocated-stats labels used in main.ts) ──
  genesis: {
    specialRingBases: 'Special Ring bases',
    wombSubline: (article: string, reward: string) => `Genesis Womb · grows ${article} ${reward}`,
    statsTitle: 'Allocated Genesis Bonuses',
    statsEmpty: 'Allocate Genesis-tree nodes to see their combined bonuses here.',
    canvasAria: 'Genesis passive tree. Click nodes to allocate; open Allocated Stats for the full list of bonuses.',
  },

  // ── emotions planner (emotions/index) — tooltip, the three sub-views, tables + combiner ──
  emotions: {
    // hover tooltip
    tipSub: (rarity: string, potent: string) => `${rarity} Distilled Emotion${potent}`,
    tipPotent: ' · Potent',
    tipWaystoneHd: 'On a Waystone',
    tipWaystone: (pct: number, bonus: string) => `Players in Area are <b>${pct}% Delirious</b>${bonus}`,
    tipJewel: 'On a Jewel',
    tipJewelTimeLost: 'On a Time-Lost Jewel',
    tipPrefix: 'prefix',
    tipSuffix: 'suffix',
    tipFoot: 'Anoints amulet Notables — 3 emotions, in order, at the Withered Willow.',
    // amulet (inventory → craftable) view
    amuletLead:
      'Set how many of each emotion you own — the list shows every Notable you can <b>anoint</b> ' +
      'right now and how many times. Anointing uses <b>three emotions in a fixed order</b>; the recipe under each ' +
      'Notable shows that order.',
    adjustAll: 'Adjust all',
    reset: 'Reset',
    showAllRecipes: 'Show all recipes',
    hiddenOnly: 'Hidden anoints only',
    hiddenBadge: 'off-tree',
    hiddenBadgeTitle:
      "Hidden anoint — an exclusive Notable that isn't on the passive skill tree; obtainable only by " +
      'anointing an amulet (or via specific map modifiers).',
    filterNotables: 'Filter Notables…',
    noNotableMatch: 'No Notable matches.',
    craftableTimesTitle: (times: number) => `craftable ${times}× with your emotions`,
    summaryDefault: 'Set your emotions above to see craftable anoints.',
    summaryAll: (total: number) => `All ${total} anoint recipes`,
    summaryCount: (total: number, plurals: string, capped: string) =>
      `You can anoint ${total} Notable${plurals} with your emotions${capped}.`,
    summaryCapped: (max: number) => ` (showing ${max}, filter to narrow)`,
    // jewel (craft) view
    jewelLead:
      'Apply one emotion to a Jewel to add a guaranteed modifier (it replaces a random existing mod, ' +
      'like a Greater Essence). The four jewel bases roll different stats; <b>Time-Lost</b> jewels take the smaller ' +
      '"Ancient" rolls.',
    jewelNormal: 'Normal jewel',
    jewelTimeLost: 'Time-Lost jewel',
    jewelColEmotion: 'Emotion',
    jewelTableCaption: 'Modifier each Distilled Emotion adds to each jewel base.',
    jewelAffixP: 'P',
    jewelAffixS: 'S',
    jewelNotePrefix: ' prefix · ',
    jewelNoteSuffix: ' suffix',
    // sinister jewel sockets — where the emotion-instilled jewels actually go
    sinisterNoteHd: 'Sinister Jewel Sockets',
    sinisterNote:
      'A jewel instilled with a Liquid Emotion goes into a <b>Sinister Jewel Socket</b> — an extra socket ' +
      'beside your character, off the passive tree. These sockets take only <b>Rare or Magic</b> jewels (not ' +
      'Uniques), and being off the tree, radius / “nearby passive” effects never apply. You gain them from the ' +
      '<b>Voices</b> unique jewel (2–4 sockets) or the <b>Zarokh’s Gift</b> anoint (1 — Melancholy + Ferocity + ' +
      'Contempt, on the Amulet tab).',
    // waystone (instil) view
    waystoneLead:
      'Instil a non-corrupted Waystone with emotions to layer Delirium onto that map: monsters get ' +
      'tougher and deadlier, but drop more loot. Each emotion adds its own Deliriousness% and reward modifier, and ' +
      'the <b>same emotion can be applied more than once</b>. ' +
      '(Instilling does <b>not</b> stack with a Delirium Mirror — use one or the other.)',
    waystonePctEach: (pct: number) => `${pct}% each`,
    waystoneNoModifier: '<i>(no extra modifier)</i>',
    waystoneDeliriousPerRare: (n: number) => `+${n}% Delirious per Rare monster slain`,
    waystoneDeliriousPerUnique: (n: number) => `+${n}% per Unique`,
    waystoneDeliriousOnComplete: (n: number) => `+${n}% on map completion`,
    waystoneSimulacrum: (depth: number, waves: string) => `Simulacrum unlocks at ${depth}% (${waves} waves)`,
    waystoneSelected: 'Selected:',
    waystoneTotal: '0% Delirious',
    waystoneSumBonusEmpty: '— add emotions to combine',
    waystoneTotalLive: (pct: number, max: string) => `${pct}% Delirious${max}`,
    waystoneMax: ' (max)',
    waystoneNoteWithMath: (math: string) =>
      `A map's Deliriousness caps at <b>100%</b>. It also builds in-map: ${math}.`,
    waystoneNote: "A map's Deliriousness caps at <b>100%</b>.",
    // sub-nav tabs
    tabAmulet: 'Amulet',
    tabAmuletSub: 'Anoint a Notable',
    tabJewel: 'Jewel',
    tabJewelSub: 'Craft a modifier',
    tabWaystone: 'Waystone',
    tabWaystoneSub: 'Instil Delirium',
  },

  // ── economy (economy/panel browser + economy/exchange market view) ──
  economy: {
    // landing / intro
    intro:
      'Live PoE2 market data from the community tracker <b>poe2scout.com</b>, via this ' +
      'project&#39;s tiny price proxy (poe2scout blocks direct browser calls). Nothing is fetched until you open ' +
      'a section — conversion stays fully offline. Every number is a market <b>snapshot</b>, not an appraisal.',
    cardEconomyTitle: 'Economy',
    cardEconomyDesc: 'Browse every currency category — current prices, quantities and price-history sparklines.',
    cardEconomyLabel: 'Open economy →',
    cardExchangeTitle: 'Currency Exchange',
    cardExchangeDesc: 'Market cap, hourly volume, live exchange rates and the full trading-pair matrix.',
    cardExchangeLabel: 'Open exchange →',
    cardUniquesTitle: 'Unique Items',
    cardUniquesDesc: 'Priced unique items by category — weapons, armour, jewels, flasks and more.',
    cardUniquesLabel: 'Browse uniques →',
    // topbar
    overview: '← Overview',
    leagueLabel: 'League',
    leagueNone: '—',
    viewBrowse: 'Browse',
    viewExchange: 'Exchange', // short label so it fits the ix-seg segment (the landing card uses the full name)
    refresh: 'Refresh',
    // sidebar group headings
    currencyCategories: 'Currency categories',
    uniqueCategories: 'Unique categories',
    // table
    loading: (label: string) => `Loading ${label}…`,
    colItem: 'Item',
    colPrice: 'Price',
    colQuantity: 'Quantity',
    colHistory: 'History',
    colActions: 'Actions',
    noPricedItems: 'No priced items in this category.',
    noPricedItemsTitle: 'No priced items',
    loadErrorTitle: "Couldn't load prices",
    pagerInfo: (page: number, pages: number, total: number, plurals: string) =>
      `Page ${page} of ${pages} · ${total} item${plurals}`,
    rowsLabel: 'Rows ',
    pagePrev: 'Previous',
    pageNext: 'Next',
    priceEx: (n: string) => `${n} ex`,
    priceDiv: (n: string) => `${n} div`,
    // status / errors
    loadingLeague: 'Loading league…',
    noCurrentLeague: 'No current league returned by poe2scout.',
    statusLine: (league: string, div: string) => `${league}${div} — poe2scout snapshots`,
    statusDiv: (n: string) => ` · 1 divine ≈ ${n} ex`,
    errUnexpected: 'Unexpected error while loading prices.',
    // actions cell
    actionWiki: 'Wiki',
    actionTrade: 'Trade',
    wikiTitle: (name: string) => `${name} on the wiki`,
    tradeTitle: (league: string) => `Open the official ${league} trade site`,
    // ── currency exchange (economy/exchange) ──
    exLoadingMarket: (league: string) => `Loading ${league} market…`,
    exCouldNotLoad: 'Could not load the market.',
    exMarket: (league: string) => `${league} Market`,
    exUpdated: (when: string) => `Last updated ${when}`,
    exSnapshot: 'poe2scout exchange snapshot',
    exHourlyVolume: 'Hourly Volume',
    exMarketCap: 'Market Cap',
    exTradingPairs: 'Trading Pairs',
    exPairsCount: (n: string) => `${n} current pairs`,
    exSearchPairs: 'Search trading pairs',
    exColTradingPair: 'Trading Pair',
    exColExchangeRate: 'Exchange Rate',
    exColVolume: 'Volume',
    exNoPairsMatch: 'No trading pairs match your search.',
    exPagerInfo: (page: string, pages: string, total: string) => `Page ${page} of ${pages} · ${total} pairs`,
    exRate: (first: string, rate: string, second: string) => `1 ${first} = ${rate} ${second}`,
    exChartCaption: (n: number) => `Market cap &amp; hourly volume — ${n} hourly points`,
    exChartAria: (last: string) => `Market cap ${last} exalted over time`,
    exBaseExFallback: 'ex',
    exDefaultBaseCurrency: 'Exalted Orb',
  },

  // ── Convert-flow main.ts: status pill, output placeholder, download/copy, file-watch, breakdown ──
  status: { idle: 'Idle', converted: 'Converted', error: 'Error' },

  // extra Convert-step strings (beyond the imp/conv blocks above)
  convert: {
    jsonPlaceholder: 'Set any optional fields above, then click Convert.',
    defaultFilename: 'build.json',
    dzReset: 'Drop a .xml / code file, or click to choose',
    fileReadError: (name: string) => `Couldn't read ${name} — try another file`,
    pobbinUnexpected: 'Unexpected error.',
    downloadOne: 'Download .build',
    downloadAll: (n: number) => `Download all (${n})`,
    copyJson: 'Copy JSON',
    copied: 'Copied!',
    copyFailed: 'Copy failed',
    copyPlanLink: 'Copy plan link',
    unknownError: 'Unknown error.',
    // Bridge 2a — GGG's official upload/subscribe channel (docs "Via the Website", verified 2026-07-04);
    // trusted authored markup (data-copy-html), never user input.
    publishNote:
      '<b>Publish to PoE2:</b> upload your downloaded <code>.build</code> at ' +
      '<a href="https://pathofexile2.com/my-account/builds" target="_blank" rel="noopener noreferrer">pathofexile2.com/my-account/builds</a> ' +
      '— players who subscribe to it get the build auto-loaded in-game.',
  },

  // live PoB file-watch banner notes
  // BFF (prices / pobb.in proxy) connectivity errors — surfaced in three flows (prices, exchange, import)
  bff: {
    unreachableDev: (base: string) =>
      `Proxy unreachable at ${base} — start it with "npm run serve:bff" (see server/README.md).`,
    unreachable: 'The price/import proxy didn’t respond — check your connection or try again in a moment.',
  },

  watch: {
    reimported: 'Re-imported on save.',
    savedNotShown: 'Saved — switch the input mode to Watch to view it.',
    readError: 'Can’t read the file just now — it may have been saved mid-write. Still watching…',
    editAndSave: 'Edit in Path of Building and save to re-import.',
    noBuildYet: 'No build found in this file yet — save a build to it in Path of Building.',
  },

  // loadout view selector + the "stats are for the main loadout" note
  loadout: {
    statsNote: (name: string) =>
      `Showing the "${name}" loadout's gear, skills and tree. The stats below ` +
      `are the main loadout's — PoB only exports the active loadout's numbers.`,
  },

  // Variants step — row labels, previews, set fallbacks
  variants: {
    treeLabel: 'Tree',
    skillsLabel: 'Skills',
    gearLabel: 'Gear',
    namePlaceholder: 'Build name',
    treeFallback: (i: number) => `Tree ${i}`,
    specLabel: (title: string, nodes: number) => `${title} · ${nodes} nodes`,
    // appended per spec label ONLY when the PoB mixes specs from different tree versions, so the
    // user can see which variant sits on an old tree before converting it
    specTreeVersion: (v: string) => ` · tree ${v}`,
    skillSetFallback: (id: string) => `Skill set ${id}`,
    gearSetFallback: (id: string) => `Gear set ${id}`,
    setFallback: (kind: string, id: string) => `${kind} ${id}`,
    emptyDash: '—',
    skillSetKind: 'Skill set',
    gearSetKind: 'Gear set',
    defaultName: 'Build',
    moveUp: 'Move up',
    moveDown: 'Move down',
    removeVariant: 'Remove variant',
  },

  // Verify-breakdown — char line, gear gallery, skills/perks, conversion markers
  breakdown: {
    // Convert-step stat strip (Class/Level/Passives/Skills/Items/Tree)
    statClass: 'Class',
    statLevel: 'Level',
    statPassives: 'Passives',
    statSkills: 'Skills',
    statItems: 'Items',
    statTree: 'Tree',
    statSkillsValue: (skills: number, supports: number) => `${skills} + ${supports} supp`,
    inBuildTitle: 'Part of the build — saved to the .build',
    previewTitle: 'Preview only — not stored in the .build',
    mainSkillLabel: 'Main skill',
    level: (n: number) => `Lv ${n}`,
    sectionSkills: 'Skills',
    sectionPerks: 'Perks',
    subKeystones: 'Keystones',
    subAscendancy: 'Ascendancy',
    subNotables: 'Notables',
    noNotables: 'No notable passives allocated.',
    masteries: (n: number, plural: string) => `${n} master${plural}`,
    passivesAllocated: (n: number) => `${plural(n, 'passive')} allocated`, // "1 passive", "12 passives"
    gemCopies: (n: number) => `${n} copies`,
    gemCorrupt: 'Corrupted gem',
    gemCorruptLabel: 'corrupt',
    gemMinionTitle: (id: string) => `Summons (PoB id: ${id})`,
    skillMain: 'main',
    skillQuality: (q: number) => ` · Q${q}`,
    noItems: 'No items equipped.',
    otherGear: 'Other gear',
    treeJewels: 'Tree jewels',
    ...itemLabels,
    empty: 'Empty',
    itemDetailsAria: (name: string) => `Item details: ${name}`,
    closeDetails: 'Close item details',
    cardAria: (slot: string, name: string) => `${slot}: ${name} — view details`,
    emptySlotAria: (label: string) => `${label} slot: empty`,
    // gear groups (display slot labels, not game data/*.json)
    gearWeapons: 'Weapons',
    gearWeapon1: 'Weapon 1',
    gearWeapon2: 'Weapon 2',
    gearWeapon1Swap: 'Weapon 1 · Swap',
    gearWeapon2Swap: 'Weapon 2 · Swap',
    gearArmour: 'Armour',
    gearHelmet: 'Helmet',
    gearBodyArmour: 'Body Armour',
    gearGloves: 'Gloves',
    gearBoots: 'Boots',
    gearBelt: 'Belt',
    gearJewellery: 'Jewellery',
    gearAmulet: 'Amulet',
    gearRing1: 'Ring 1',
    gearRing2: 'Ring 2',
    gearFlasksCharms: 'Flasks & Charms',
    gearFlask1: 'Flask 1',
    gearFlask2: 'Flask 2',
  },

  // class/ascendancy splash + tree-missing note + provenance footer
  splash: {
    ascLabel: (asc: string, cls: string) => `${asc}${cls} ascendancy`,
    classLabel: (cls: string) => `${cls} class`,
    classFallback: 'Class',
  },
  treeMissing: (n: number, plural: string) =>
    `${n} allocated node${plural} from this build ` +
    `aren't in the current tree data (likely an older patch). They can't be converted either — ` +
    `the .build skips them (the conversion warning lists them). Re-exporting the build on the ` +
    `current tree avoids it.`,
  // No table counts here (owner 2026-07-04): end users don't need them and misread them as
  // game facts (e.g. the 1784-entry unique-name table ≠ the ~493 uniques the game has).
  provenance: (captured: string, patch: string) =>
    `Lookup data captured ${captured} (PoE2 ${patch}). ` +
    `Passive tree from GGG's poe2-skilltree-export; ` +
    `gem/unique/mod data from our own pathofexile-dat extraction of the game files.`,

  // ── FAQ (route-faq) — ADD / EDIT / DELETE a Q&A by editing this array; it's rendered into the page
  //    at startup. `q` is plain text (auto-escaped); `a` is trusted authored HTML (use <b>/<code>/<a>).
  //    Array order = order on the page. ──
  faq: [
    {
      q: `What does this tool do?`,
      a: `It turns a <b>Path of Building 2</b> export (the import code, or the raw XML) into a Path of Exile 2 <b>Build Planner</b> <code>.build</code> file you can load in-game — passives, skills, and gear in one pass. Around the converter you also get a build breakdown with affix-tier chips on your gear, a read-only tree viewer, editable <b>Atlas</b> and <b>Genesis</b> planners you can share by link, a <b>Delirium emotions</b> reference, and opt-in <b>market prices</b>.`,
    },
    {
      q: `Where do I get the PoB2 export code?`,
      a: `In Path of Building 2, use <b>Import/Export build → Generate</b> to copy the code. Many community sites also give you one — paste a <b>pobb.in</b> link directly and it's fetched for you, or grab a code from <b>poe.ninja</b>.`,
    },
    {
      q: `What is the Watch tab — and why can't I see it?`,
      a: `<b>Watch</b> lets you pick your PoB2 build file once; every time you hit save in Path of Building, the preview here re-imports it automatically. It needs the File System Access API, which only desktop <b>Chromium</b> browsers ship (Chrome, Edge, Brave…) — on Firefox or Safari the tab is hidden, so paste or upload instead.`,
    },
    {
      q: `Where do I put the .build file?`,
      a: `Drop it in your Build Planner folder — on Windows that's <code>Documents\\My Games\\Path of Exile 2\\BuildPlanner</code> (paths for Windows and Steam Deck are in the footer). It then shows up in the in-game planner. Alternatively, upload it on the official website at <a href="https://pathofexile2.com/my-account/builds" target="_blank" rel="noopener noreferrer">pathofexile2.com/my-account/builds</a> — you can upload your own <code>.build</code> files there, and builds you subscribe to on the site are loaded by the game automatically.`,
    },
    {
      q: `Why are some items missing from the breakdown?`,
      a: `A PoB import code doesn't always include every item — if a piece is missing here, it was missing from the code too (it's also absent in Path of Building). <b>Nothing is silently dropped</b>: everything in your code appears in the breakdown, and the few things the <code>.build</code> format can't carry (tree jewels as items, slots with no Build Planner equivalent) are flagged with a conversion warning or a "preview only" mark. Double-check the original build if a piece looks absent.`,
    },
    {
      q: `Can I edit the build before exporting?`,
      a: `No — the passive tree is shown <b>read-only</b> and always exports from your PoB code <b>unchanged</b>; the converter copies your build verbatim.`,
    },
    {
      q: `My PoB has several loadouts — can I convert them all at once?`,
      a: `Yes. Loadouts are recovered from your set titles (exactly as Path of Building matches them) and pre-fill the <b>Variants</b> step — each variant is one (tree, skills, items) pick that becomes its own <code>.build</code>. One click on <b>Download</b> saves every file, each named after its variant.`,
    },
    {
      q: `Why can't I export an atlas or Genesis plan?`,
      a: `The in-game Build Planner format has <b>no atlas or Genesis fields</b>, so those plans can't live in a <code>.build</code>. Both pages are planning-only — share a plan with <b>Copy plan link</b> instead (the link restores the exact plan).`,
    },
    {
      q: `Does this work offline? Is my data sent anywhere?`,
      a: `Conversion is <b>100% offline</b> — it runs entirely in your browser, so your build data never leaves your device. The only features that touch the network are <b>Market prices</b> and the <b>pobb.in</b> link import, and only when you explicitly use them.`,
    },
    {
      q: `Are the stats accurate?`,
      a: `The stats shown are <b>Path of Building's own exported snapshot</b> — they're never recomputed or approximated here. If a number looks off, it reflects the source export.`,
    },
    {
      q: `Why does a new or empty build show "1 passive allocated"?`,
      a: `The breakdown counts the <b>exact</b> nodes allocated in your imported tree. Every character tree includes its class <b>starting node</b> — the free root all paths grow from — so a build with nothing else allocated still counts that one. Path of Building's own points counter hides the start node; here we report your tree's allocated nodes <b>verbatim</b>, without reinterpreting them.`,
    },
    {
      q: `I saved the file but it doesn't show up in-game.`,
      a: `Check two things. The file must end in exactly <code>.build</code> — browsers and Windows' hidden extensions sometimes save it as <code>….build.txt</code>, so turn on file-extension display and rename if needed. And it must sit in your <code>Documents\\My Games\\Path of Exile 2\\BuildPlanner</code> folder (create it if missing). A correctly-named file there is picked up live — no restart required. (Or skip the folder entirely and upload it on the official website — see "Where do I put the .build file?" above.)`,
    },
    {
      q: `Why do some passives show as "missing"?`,
      a: `Your build was made on a different passive-tree <b>version</b> than the data bundled here, so those node ids aren't recognised. Unrecognised nodes <b>can't be written to the <code>.build</code></b> — there's no known id to write — so they are skipped and the conversion warning lists how many. Converting from a build exported on the current tree avoids it.`,
    },
    {
      q: `My main skill is missing after importing in-game.`,
      a: `If your main skill is a <b>meta or ascendancy gem</b>, the in-game Build Planner importer may not accept it — a format limitation, not a conversion error. A <b>socketed</b> gem is still written to the <code>.build</code> exactly as exported, so nothing is wrong with the file itself. (Skills granted automatically by your ascendancy or an item — rather than socketed — have no Build Planner equivalent and are left out.)`,
    },
    {
      q: `A unique item shows as plain text instead of the item.`,
      a: `Its name wasn't found in the bundled uniques list — usually a brand-new unique or a naming mismatch (the Convert step shows a warning listing the names it couldn't find). The name is <b>still written</b> to the <code>.build</code>; it just couldn't be validated here.`,
    },
    {
      q: `Why are my rares, jewels, or weapon-swap gear incomplete or missing?`,
      a: `The <code>.build</code> format is deliberately lightweight. It has <b>no structured mod fields</b>, so rare and magic items become readable guidance text (capped for length); <b>jewels can't be placed</b>, so each is noted on its passive node; and <b>weapon-swap weapons do convert</b> — they land in the format's second weapon set — while any other slot with no Build Planner equivalent is skipped with a note. That's the in-game format's design, not a conversion gap.`,
    },
    {
      q: `Which league are the market prices for?`,
      a: `Always the <b>current league</b> — picked automatically from the live league list every time you open or refresh the Prices tab, so a new league is followed without an update. Prices are point-in-time <b>snapshots</b> via poe2scout, not live appraisals, and nothing is fetched until you click one of the cards.`,
    },
    {
      q: `Is this affiliated with Grinding Gear Games?`,
      a: `No. This is an unofficial community tool, not affiliated with or endorsed by Grinding Gear Games. Game data is extracted from the game's own files; the passive tree comes from GGG's official <b>poe2-skilltree-export</b>, listed as a Data Export on their developer docs.`,
    },
  ],
} as const

// ── static-shell wiring ────────────────────────────────────────────────────────
// Push the short shell labels above into the markup at startup. An element tagged
// `data-copy="nav.convert"` gets its textContent set; `data-copy-html="brand.name"`
// gets innerHTML (for the few labels that carry trusted inline markup like <b>/<code>).
// Keeps the wording in ONE place without giving up the static, SEO-friendly HTML shell.
function lookup(path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], copy)
  return typeof value === 'string' ? value : undefined
}

/** One FAQ accordion row (APG disclosure): a button head + a labelled panel, wired by the library
 *  `accordion` behavior on the .faq-list container. `q` (plain text) is escaped; `a` is trusted HTML. */
function faqItemHtml(item: { q: string; a: string }, i: number): string {
  const head = `faq-head-${i}`
  const panel = `faq-panel-${i}`
  return (
    `<div class="faq-item">` +
    `<h3 class="faq-q"><button type="button" class="faq-hd" id="${head}" aria-expanded="false" aria-controls="${panel}">${escapeHtml(item.q)}</button></h3>` +
    `<div class="faq-a" id="${panel}" role="region" aria-labelledby="${head}" hidden>${item.a}</div>` +
    `</div>`
  )
}

export function applyStaticCopy(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-copy]')) {
    const text = lookup(el.dataset.copy!)
    if (text !== undefined) el.textContent = text
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-copy-html]')) {
    const html = lookup(el.dataset.copyHtml!)
    if (html !== undefined) el.innerHTML = html // trusted authored copy only (never user input)
  }
  // FAQ list — rendered from copy.faq into the [data-copy-faq] container (one APG disclosure per
  // Q&A: button[aria-expanded] + role=region panel, wired by the vendored `accordion` behavior).
  const faqEl = root.querySelector<HTMLElement>('[data-copy-faq]')
  if (faqEl) faqEl.innerHTML = copy.faq.map(faqItemHtml).join('')
}
