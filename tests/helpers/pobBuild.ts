// Test factory for a full default PobBuild / PobConfigSet. Mock builds that don't spread a real
// parsePob() result use this so they stay valid as the lossless model grows — when a new field is
// added to PobBuild, only THIS file changes (not every mock site).
import type { PobBuild, PobItemSet, PobSpec } from '../../src/pob/model'
import type { SummaryItem } from '../../src/convert/summarize'

export function emptySpec(over: Partial<PobSpec> = {}): PobSpec {
  return {
    treeVersion: 'unknown',
    title: null,
    ascendancyInternalId: null,
    classId: null,
    nodes: [],
    weaponSet1: [],
    weaponSet2: [],
    sockets: [],
    attributeChoices: new Map(),
    ascendClassId: null,
    secondaryAscendClassId: null,
    classInternalId: null,
    url: null,
    masteryEffects: [],
    weaponSets: [],
    rawAttrs: {},
    ...over,
  }
}

export function emptyItemSet(id: string, title: string | null): PobItemSet {
  return { id, title, slots: [], useSecondWeaponSet: null, socketIdUrls: [] }
}

export function emptySummaryItem(over: Partial<SummaryItem> = {}): SummaryItem {
  return {
    slot: '',
    rarity: 'NORMAL',
    name: '',
    baseType: '',
    levelReq: 1,
    mods: [],
    runes: [],
    grantedSkills: [],
    itemLevel: null,
    quality: null,
    socketString: null,
    radius: null,
    limitedTo: null,
    defences: {},
    flags: [],
    parsedMods: [],
    implicits: [],
    inBuild: true,
    ...over,
  }
}

export function emptyPobBuild(over: Partial<PobBuild> = {}): PobBuild {
  const spec = emptySpec()
  return {
    className: null,
    ascendClassName: null,
    level: null,
    mainSocketGroup: null,
    playerStats: {},
    spec,
    skillGroups: [],
    items: new Map(),
    slots: [],
    specs: [spec],
    activeSpecIndex: 0,
    skillSets: [],
    activeSkillSetId: null,
    itemSets: [],
    activeItemSetId: null,
    configSets: [],
    viewMode: null,
    targetVersion: null,
    characterLevelAutoMode: null,
    playerStatsRaw: {},
    minionStats: {},
    buffs: null,
    fullDpsSkills: [],
    timelessData: null,
    activeConfigSetId: null,
    calcs: null,
    notes: null,
    notesHtml: null,
    treeView: null,
    importInfo: null,
    party: null,
    skillsOptions: {},
    itemsOptions: {},
    sectionOrder: [],
    rawSections: [],
    ...over,
  }
}
