// ── atlas-page wiring (B2) — planning-only editor, mounted when its route is first shown ────
// Extracted from main.ts (structural refactor — behaviour/output unchanged). Plans are shareable by
// link ('#atlas=<share payload>' in the URL hash) but can never be exported to a .build — the format
// has no atlas fields. Mounting stays lazy: nothing renders until the Atlas destination is opened
// (the route is shown, or a shared hash forces it on boot), because the canvas measures its host and
// would mount blank inside a hidden route.
//
// All atlas state + listeners + the lazy mount live here, behind wireAtlas(deps). It returns the one
// entry point the router needs (ensureAtlas) and runs the '#atlas=' boot-plan loader. The host's DOM
// elements + the shared copyText + the "open the atlas route" callback come in through `deps` — this
// module never reaches back into main.ts's state.
import type { TreeView } from '../tree/index'
import { encodeAtlasPlan, decodeAtlasPlan, encodeMasteryChoices, decodeMasteryChoices } from './share'
import { encodeMasters, decodeMasters } from './mastersShare'
import { escapeHtml } from '../ui/escapeHtml'
import { toastHtml } from '../ui/toast'
import type { MastersApi, Master } from './masters'
import type { StatsPanelHandle, ExtraStatsSource } from './statsPanel'
import atlasMastersData from '../data/atlasMasters.json'
import { copy } from '../copy'

/** The DOM hosts + shared callbacks the atlas wiring needs (owned by main.ts's bootstrap). */
export interface AtlasWiringDeps {
  els: {
    atlasMount: HTMLDivElement
    atlasCounts: HTMLDivElement
    atlasMastersCounts: HTMLDivElement
    atlasFit: HTMLButtonElement
    atlasReset: HTMLButtonElement
    atlasShare: HTMLButtonElement
    atlasBg: HTMLInputElement
    /** Share-link decode feedback (aria-live) — filled on a damaged '#atlas=' payload. */
    atlasNote: HTMLElement
  }
  /** Shared clipboard helper (the legacy-fallback copy from main.ts). */
  copyText: (text: string) => Promise<boolean>
  /** Switch the app to the Atlas route (mounts the host visible) — used by the boot-plan path. */
  openAtlasRoute: () => void
}

export interface AtlasWiring {
  /** Load + mount the Atlas tree once (memoised on the in-flight promise); the router awaits this. */
  ensureAtlas: () => Promise<TreeView>
  /** Apply a shared '#atlas=' link, if present. Call AFTER ensureAtlas is in scope for the router —
   *  the boot path opens the Atlas route, which itself calls ensureAtlas (avoids the TDZ of the
   *  original module-level ordering, where the boot loader ran last). */
  loadBootPlan: () => void
}

export function wireAtlas(deps: AtlasWiringDeps): AtlasWiring {
  const { els, copyText } = deps

  let atlasView: TreeView | null = null
  let atlasViewPending: Promise<TreeView> | null = null
  let mastersApi: MastersApi | null = null
  let atlasStatsHandle: StatsPanelHandle | null = null
  const ATLAS_MASTERS = (atlasMastersData as { masters: Master[] }).masters

  // Atlas-master picks persist locally (planner-only state, like the bg toggle) and ride the
  // '#atlas=' share link in a separate '.<code>' segment (the node codec is numeric-id-only).
  const ATLAS_MASTERS_KEY = 'poe2.atlasMasters'
  function persistMasters(state: Record<string, string[]>): void {
    try {
      const code = encodeMasters(state, ATLAS_MASTERS)
      if (code) localStorage.setItem(ATLAS_MASTERS_KEY, code)
      else localStorage.removeItem(ATLAS_MASTERS_KEY)
    } catch {
      /* private mode / storage disabled — picks still apply for this session */
    }
  }
  function loadMastersPref(): Record<string, string[]> | null {
    try {
      const code = localStorage.getItem(ATLAS_MASTERS_KEY)
      return code ? decodeMasters(code, ATLAS_MASTERS) : null
    } catch {
      return null
    }
  }
  /** Read the masters API through a function so callers get its real `MastersApi | null` type
      (it's assigned inside ensureAtlas, which top-level control-flow analysis can't see). */
  const currentMasters = (): MastersApi | null => mastersApi
  /** Enable Share/Reset when EITHER the tree or the masters drawer holds a user pick. */
  function refreshAtlasButtons(): void {
    const treeTotal = atlasView ? atlasSelection(atlasView.getAllocated()).length : 0
    const has = treeTotal > 0 || (mastersApi?.total() ?? 0) > 0
    els.atlasShare.disabled = !has
    els.atlasReset.disabled = !has
  }

  // The 6 atlasRoot "start" nodes are allocated by default and never count toward the total —
  // they're the free seeds every sub-tree paths from. The user's selection = allocated minus these.
  // Populated when the Atlas module first loads (code-split: atlasGraph only downloads on first open).
  let ATLAS_STARTS = new Set<string>()
  const atlasSelection = (allocated: ReadonlySet<string>): string[] =>
    [...allocated].filter((id) => !ATLAS_STARTS.has(id))

  // per-tree counters (General + the precursor subtrees), mirroring the in-game atlas breakdown. Every
  // non-start node belongs to one subtree: mechanic nodes carry node.subTree, the rest = General.
  // The LIST is DATA-DRIVEN (built in ensureAtlas from atlasGraph.subTrees), so a new subtree's counter
  // auto-appears; only these per-mechanic dot COLOURS are curated — they're GGG's canonical mechanic
  // identity hues (breach purple / ritual red / abyss green / incursion orange / delirium pale / expedition
  // blue). NO data source exists (verified 2026-06-26 against the live data): the start-point art
  // (UI_Image) is a uniform BRONZE precursor frame — its dominant hue is brown, NOT the mechanic colour —
  // and AtlasPassiveSkillSubTrees has no colour column (cols 7-9 are ClientStrings, 12 is the scale f32).
  // So deriving would be WRONG; a new subtree falls back to neutral grey until its canonical hue is added.
  const ATLAS_SUB_RGB: Record<string, string> = {
    general: 'var(--accent-rgb)',
    Breach: '167, 107, 255',
    Ritual: '214, 77, 90',
    Delirium: '180, 182, 190',
    Abyss: '92, 196, 106',
    Incursion: '232, 148, 58',
    Expedition: '74, 144, 226', // blue (added 4.5.4.1)
  }
  let atlasSubs: ReadonlyArray<{ key: string; label: string; rgb: string }> = []
  // Built when the Atlas module first loads (the loop + counter paint moved into ensureAtlas, so
  // atlasGraph + the master art stay out of the initial bundle).
  let atlasNodeSub = new Map<string, string>()
  let atlasTotals: Record<string, number> = {}
  /** Repaint the per-master point chips from the drawer's pick state. */
  function updateMasterCounts(state: Record<string, string[]>): void {
    for (const m of ATLAS_MASTERS) {
      const chip = els.atlasMastersCounts.querySelector<HTMLElement>(`.at-ct[data-master="${m.id}"]`)
      if (!chip) continue
      const n = state[m.id]?.length ?? 0
      chip.querySelector('.at-ct-n')!.textContent = String(n)
      chip.classList.toggle('at-ct--on', n > 0)
    }
  }

  /** Repaint the per-tree counters + gate the share/reset buttons on the (start-excluded) selection. */
  function updateAtlasCounts(allocated: ReadonlySet<string>): void {
    const per: Record<string, number> = {}
    for (const id of allocated) {
      const sub = atlasNodeSub.get(id)
      if (sub) per[sub] = (per[sub] ?? 0) + 1
    }
    for (const s of atlasSubs) {
      const n = per[s.key] ?? 0
      const chip = els.atlasCounts.querySelector<HTMLElement>(`.at-ct[data-sub="${s.key}"]`)
      if (!chip) continue
      chip.querySelector('.at-ct-n')!.textContent = String(n)
      chip.setAttribute('aria-label', `${s.label}: ${n} of ${atlasTotals[s.key] ?? 0} allocated`)
      chip.classList.toggle('at-ct--on', n > 0)
    }
    refreshAtlasButtons() // Share/Reset reflect tree + masters picks together
  }

  // Background-art (facade + subtree panels) visibility — user toggle, persisted across visits.
  // Off helps users who dislike the art or hit perf issues on weak GPUs.
  const ATLAS_BG_KEY = 'poe2.atlasBgVisible'
  function atlasBgPref(): boolean {
    try {
      return localStorage.getItem(ATLAS_BG_KEY) !== '0'
    } catch {
      return true
    }
  }
  els.atlasBg.checked = atlasBgPref()

  // Lazily load the Atlas module (+ masters + the shared stats panel) on first use, run the one-time
  // counter init that used to happen at module load, then mount. atlasGraph.json + the master art are
  // deferred out of the initial bundle — they only download when the Atlas tab is first opened.
  // Memoised on the in-flight PROMISE, not just the resolved view: the '#atlas=' boot fires ensureAtlas()
  // TWICE in the same tick — the route open AND the boot-plan loader below — and the resolved `atlasView`
  // isn't set until AFTER the dynamic-import await, so a value-only guard let BOTH calls reach
  // mountAtlasTree → the tree rendered twice (two canvases in #atlas-mount). Sharing one promise collapses
  // concurrent callers to a single mount. (ensureEconomy already uses this `??=` pattern.)
  function ensureAtlas(): Promise<TreeView> {
    if (atlasView) return Promise.resolve(atlasView)
    return (atlasViewPending ??= mountAtlasOnce())
  }

  async function mountAtlasOnce(): Promise<TreeView> {
    const [
      { mountAtlasTree, atlasRootIds, atlasGraph },
      { mountAtlasMasters, MASTER_ACCENT, allocatedMasterStats },
      { mountAtlasStats },
    ] = await Promise.all([import('./index'), import('./masters'), import('./statsPanel')])
    // one-time init that used to run at module load (now deferred to the first Atlas open)
    ATLAS_STARTS = new Set(atlasRootIds())
    atlasNodeSub = new Map<string, string>()
    atlasTotals = {}
    for (const [id, node] of Object.entries(atlasGraph.nodes)) {
      if (node.atlasRoot) continue // the 6 starts are free + uncounted
      const sub = node.subTree ?? 'general'
      atlasNodeSub.set(id, sub)
      atlasTotals[sub] = (atlasTotals[sub] ?? 0) + 1
    }
    // counter list is DATA-DRIVEN from the game subtree table (General first), so a new subtree (e.g.
    // Expedition) auto-gets its counter; colour from ATLAS_SUB_RGB with a neutral fallback.
    atlasSubs = [
      { key: 'general', label: 'General', rgb: ATLAS_SUB_RGB.general! },
      ...Object.keys(atlasGraph.subTrees).map((k) => ({ key: k, label: k, rgb: ATLAS_SUB_RGB[k] ?? '150, 150, 150' })),
    ]
    els.atlasCounts.innerHTML = atlasSubs
      .map(
        (s) =>
          `<span class="at-ct" data-sub="${escapeHtml(s.key)}" style="--ct-rgb: ${s.rgb}">` +
          `<i class="at-ct-dot" aria-hidden="true"></i>` +
          `<span class="at-ct-lbl">${escapeHtml(s.label)}</span> ` +
          `<b class="at-ct-n">0</b><span class="at-ct-sep">/</span>${atlasTotals[s.key] ?? 0}</span>`,
      )
      .join('')
    els.atlasMastersCounts.innerHTML = ATLAS_MASTERS.map(
      (m) =>
        `<span class="at-ct" data-master="${escapeHtml(m.id)}" style="--ct-rgb: ${MASTER_ACCENT[m.id] ?? '150, 150, 150'}">` +
        `<i class="at-ct-dot" aria-hidden="true"></i>` +
        `<span class="at-ct-lbl">${escapeHtml(m.id)}</span> ` +
        `<b class="at-ct-n">0</b><span class="at-ct-sep">/</span>${m.budget}</span>`,
    ).join('')
    updateAtlasCounts(new Set()) // initial 0/total labels

    atlasView = mountAtlasTree(els.atlasMount, { editable: true })
    atlasView.subscribe(updateAtlasCounts)
    atlasView.setBuild({ allocated: ATLAS_STARTS }) // each tree's start on by default
    atlasView.setBgVisible(atlasBgPref()) // apply the saved preference on first mount
    // Atlas-Masters flyout (planner-only, separate from the BFS tree) — mount once alongside.
    let masterExtra: ExtraStatsSource | undefined
    const mToggle = document.getElementById('atlas-masters-toggle')
    const mDrawer = document.getElementById('atlas-masters-drawer')
    if (mToggle && mDrawer) {
      mastersApi = mountAtlasMasters(mDrawer, mToggle)
      const saved = loadMastersPref() // restore last session's picks (share link overrides later)
      if (saved) mastersApi.setState(saved)
      mastersApi.subscribe((state) => {
        persistMasters(state)
        updateMasterCounts(state)
        refreshAtlasButtons()
      })
      updateMasterCounts(mastersApi.getState()) // paint the restored counts on first mount
      refreshAtlasButtons()
      // the allocated master keystones are real bonuses but aren't tree nodes — feed them to the
      // allocated-stats panel so it summarises the WHOLE atlas plan (tree + masters together).
      masterExtra = {
        collect: () => allocatedMasterStats(mastersApi?.getState() ?? {}),
        subscribe: (onChange) => mastersApi?.subscribe(() => onChange()),
      }
    }
    // Allocated-bonuses summary on the right (a toggleable flyout mirroring the masters drawer).
    const statsPanel = document.getElementById('atlas-stats-panel')
    const statsToggle = document.getElementById('atlas-stats-toggle')
    if (statsPanel && statsToggle) atlasStatsHandle = mountAtlasStats(statsPanel, statsToggle, atlasView, masterExtra)
    return atlasView
  }

  els.atlasBg.addEventListener('change', () => {
    const on = els.atlasBg.checked
    try {
      localStorage.setItem(ATLAS_BG_KEY, on ? '1' : '0')
    } catch {
      /* private mode / storage disabled — toggle still applies for this session */
    }
    void ensureAtlas().then((v) => v.setBgVisible(on))
  })

  els.atlasFit.addEventListener('click', () => void ensureAtlas().then((v) => v.fit()))
  els.atlasReset.addEventListener('click', () => {
    void ensureAtlas().then((v) => {
      v.setBuild({ allocated: ATLAS_STARTS })
      mastersApi?.setState({}) // clear all master picks back to none
      persistMasters({})
      updateMasterCounts({})
      atlasStatsHandle?.refresh() // drop the masters' bonuses from the summary too
      refreshAtlasButtons()
    })
  })

  els.atlasShare.addEventListener('click', async () => {
    // share only the user's picks — the always-on start nodes are re-added on load
    const view = await ensureAtlas() // also mounts the masters drawer
    const allocated = view.getAllocated()
    const payload = encodeAtlasPlan(atlasSelection(allocated))
    const mastersCode = mastersApi ? encodeMasters(mastersApi.getState(), ATLAS_MASTERS) : ''
    // only carry picks for masteries that are actually allocated (a dormant pick isn't shared)
    const choices = new Map([...view.getMasteryChoices()].filter(([id]) => allocated.has(id)))
    const choicesCode = encodeMasteryChoices(choices)
    const url = new URL(window.location.href)
    // '.'-delimited segments (outside the base64url alphabet): nodes . masters . mastery-choices.
    // Trailing empty segments are dropped so old links stay byte-identical.
    const segs = [payload, mastersCode, choicesCode]
    while (segs.length > 1 && !segs[segs.length - 1]) segs.pop()
    url.hash = `atlas=${segs.join('.')}`
    history.replaceState(null, '', url) // the address bar becomes the share link
    const ok = await copyText(url.href)
    els.atlasShare.textContent = ok ? copy.convert.copied : copy.convert.copyFailed
    setTimeout(() => (els.atlasShare.textContent = copy.convert.copyPlanLink), 1400)
  })

  // load-on-boot: a shared '#atlas=<nodes>[.<masters>[.<choices>]]' link opens the planner with the
  // decoded state. Each codec returns null on garbage — a mangled link boots the default plan, but
  // SAYS so (a silently-empty planner is indistinguishable from "my friend shared an empty plan").
  function loadBootPlan(): void {
    const atlasHashRaw = /^#atlas=(.*)$/.exec(window.location.hash)?.[1]
    const [nodeSeg = '', masterSeg = '', choiceSeg = ''] = atlasHashRaw != null ? atlasHashRaw.split('.') : []
    const atlasBootPlan = atlasHashRaw != null ? decodeAtlasPlan(nodeSeg) : null
    const mastersBootPlan = masterSeg ? decodeMasters(masterSeg, ATLAS_MASTERS) : null
    const choicesBootPlan = choiceSeg ? decodeMasteryChoices(choiceSeg) : null
    if (atlasHashRaw && !atlasBootPlan && !mastersBootPlan && !choicesBootPlan) {
      deps.openAtlasRoute() // the user followed an atlas link — show the planner, with the notice
      els.atlasNote.innerHTML = toastHtml('warn', copy.toast.warn, copy.share.damagedLink)
      return
    }
    els.atlasNote.innerHTML = '' // a readable link supersedes any earlier damaged-link notice
    if (atlasBootPlan || mastersBootPlan || choicesBootPlan) {
      deps.openAtlasRoute() // switch to the Atlas page (mounts the tree + masters now the host is visible)
      void ensureAtlas().then((view) => {
        view.setBuild({
          allocated: new Set([...ATLAS_STARTS, ...(atlasBootPlan ?? [])]), // starts + shared node picks
          masteryChoices: choicesBootPlan ?? undefined, // shared "select a bonus" picks
        })
        const api = currentMasters() // ensureAtlas() assigned it; read past CFA narrowing
        if (mastersBootPlan && api) {
          api.setState(mastersBootPlan) // shared master picks override the restored local ones
          persistMasters(mastersBootPlan)
          updateMasterCounts(mastersBootPlan)
          atlasStatsHandle?.refresh() // setState bypasses the user-change subscription — refresh the summary
        }
        refreshAtlasButtons()
      })
    }
  }

  return { ensureAtlas, loadBootPlan }
}
