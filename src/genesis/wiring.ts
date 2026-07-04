// ── genesis-page wiring — planning-only editor for the 0.5 Breach/Chayula crafting tree ("Brequel") ──
// Extracted from main.ts (structural refactor — behaviour/output unchanged). The near-identical twin of
// atlas/wiring.ts: five independent crafting sub-trees; plans share by '#genesis=<nodes>' but can never
// be exported to a .build (no Genesis fields). Mounting stays lazy (the canvas measures its host).
//
// All genesis state + listeners + the lazy mount live here, behind wireGenesis(deps). It returns the
// router entry point (ensureGenesis) and a deferred boot-plan loader. The host's DOM elements + the
// shared copyText + the "open the genesis route" callback come in through `deps`.
import type { TreeView } from '../tree/index'
import { encodeAtlasPlan, decodeAtlasPlan } from '../atlas/share'
import { escapeHtml } from '../ui/escapeHtml'
import { toastHtml } from '../ui/toast'
import { copy } from '../copy'

/** The DOM hosts + shared callbacks the genesis wiring needs (owned by main.ts's bootstrap). */
export interface GenesisWiringDeps {
  els: {
    genesisMount: HTMLDivElement
    genesisCounts: HTMLDivElement
    genesisFit: HTMLButtonElement
    genesisReset: HTMLButtonElement
    genesisShare: HTMLButtonElement
    genesisBg: HTMLInputElement
    /** Share-link decode feedback (aria-live) — filled on a damaged '#genesis=' payload. */
    genesisNote: HTMLElement
  }
  /** Shared clipboard helper (the legacy-fallback copy from main.ts). */
  copyText: (text: string) => Promise<boolean>
  /** Switch the app to the Genesis route (mounts the host visible) — used by the boot-plan path. */
  openGenesisRoute: () => void
}

export interface GenesisWiring {
  /** Load + mount the Genesis tree once (memoised on the in-flight promise); the router awaits this. */
  ensureGenesis: () => Promise<TreeView>
  /** Apply a shared '#genesis=' link, if present. Call AFTER ensureGenesis is in scope for the router. */
  loadBootPlan: () => void
}

export function wireGenesis(deps: GenesisWiringDeps): GenesisWiring {
  const { els, copyText } = deps

  let genesisView: TreeView | null = null
  let genesisViewPending: Promise<TreeView> | null = null
  // Share-button "copied" feedback timer — cleared before re-arming so rapid clicks don't fire stale resets.
  let genesisShareResetId: ReturnType<typeof setTimeout> | null = null

  // The 5 StartNode roots are allocated by default + never counted — the free per-subtree seeds.
  // The 5 Wombs are allocatable ROOTS (not default-allocated) — the player chooses which to take, so
  // the whole allocated set (wombs included) is the shareable selection. Nothing is on by default.
  const genesisSelection = (allocated: ReadonlySet<string>): string[] => [...allocated]

  // PER-SUBTREE counters — one per "mini tree" (the 4 subtrees with allocatable nodes; the lone Breachstones
  // womb has none, so it's omitted). DATA-DRIVEN from genesisGraph.subTrees + GENESIS_SUBTREE_RGB. Populated
  // when the Genesis module first loads (code-split — only downloads when the Genesis tab is opened).
  let genesisNodeSub = new Map<string, string>() // countable (non-womb) node id -> subtree id; wombs excluded
  let genesisSubs: ReadonlyArray<{ key: string; label: string; rgb: string; total: number }> = []

  function refreshGenesisButtons(): void {
    const has = genesisView ? genesisSelection(genesisView.getAllocated()).length > 0 : false
    els.genesisShare.disabled = !has
    els.genesisReset.disabled = !has
  }
  function updateGenesisCounts(allocated: ReadonlySet<string>): void {
    const per: Record<string, number> = {}
    for (const id of allocated) {
      const sub = genesisNodeSub.get(id) // wombs aren't in the map -> excluded
      if (sub) per[sub] = (per[sub] ?? 0) + 1
    }
    for (const s of genesisSubs) {
      const n = per[s.key] ?? 0
      const chip = els.genesisCounts.querySelector<HTMLElement>(`.at-ct[data-sub="${s.key}"]`)
      if (!chip) continue
      chip.querySelector('.at-ct-n')!.textContent = String(n)
      chip.setAttribute('aria-label', `${s.label}: ${n} of ${s.total} nodes allocated`)
      chip.classList.toggle('at-ct--on', n > 0)
    }
    refreshGenesisButtons()
  }

  // Background-art (the carved facade) visibility — user toggle, persisted (mirrors the atlas toggle).
  const GENESIS_BG_KEY = 'poe2.genesisBgVisible'
  function genesisBgPref(): boolean {
    try {
      return localStorage.getItem(GENESIS_BG_KEY) !== '0'
    } catch {
      return true
    }
  }
  els.genesisBg.checked = genesisBgPref()

  // Lazily load the Genesis module (+ its crafting reference) on first use, run the one-time
  // counter/crafting paint that used to happen at module load, then mount. All of it is deferred out
  // of the initial bundle — genesisGraph.json only downloads when the Genesis tab is first opened.
  // Promise-memoised like ensureAtlas — the '#genesis=' boot path double-fires ensureGenesis() (route open +
  // boot loader) and a value-only guard would mount the tree twice (see ensureAtlas note).
  function ensureGenesis(): Promise<TreeView> {
    if (genesisView) return Promise.resolve(genesisView)
    return (genesisViewPending ??= mountGenesisOnce())
  }

  async function mountGenesisOnce(): Promise<TreeView> {
    const [{ mountGenesisTree, genesisGraph, GENESIS_SUBTREE_RGB }, { wombTooltipHtml }, { mountStatsPanel }] =
      await Promise.all([import('./index'), import('./crafting'), import('../atlas/statsPanel')])
    // one-time init that used to run at module load (now deferred to the first Genesis open). Map each
    // non-womb node to its subtree + tally per-subtree totals, then build a counter chip for every subtree
    // that HAS countable nodes — the 4 "mini trees" (the lone Breachstones womb has none → omitted).
    genesisNodeSub = new Map<string, string>()
    const genesisTotals: Record<string, number> = {}
    for (const [id, node] of Object.entries(genesisGraph.nodes)) {
      if (node.keystone) continue // wombs are free roots — never counted
      genesisNodeSub.set(id, node.subTree)
      genesisTotals[node.subTree] = (genesisTotals[node.subTree] ?? 0) + 1
    }
    genesisSubs = genesisGraph.subTrees
      .filter((s) => (genesisTotals[s.id] ?? 0) > 0)
      .map((s) => ({
        key: s.id,
        label: s.name,
        rgb: GENESIS_SUBTREE_RGB[s.id] ?? '150, 150, 150',
        total: genesisTotals[s.id] ?? 0,
      }))
    els.genesisCounts.innerHTML = genesisSubs
      .map(
        (s) =>
          `<span class="at-ct" data-sub="${escapeHtml(s.key)}" style="--ct-rgb: ${s.rgb}">` +
          `<i class="at-ct-dot" aria-hidden="true"></i>` +
          `<span class="at-ct-lbl">${escapeHtml(s.label)}</span> ` +
          `<b class="at-ct-n">0</b><span class="at-ct-sep">/</span>${s.total}</span>`,
      )
      .join('')
    updateGenesisCounts(new Set()) // initial 0/total labels

    genesisView = mountGenesisTree(els.genesisMount, {
      editable: true,
      // The 5 womb keystones show their Wombgift crafting reference (not the bare keystone name); the
      // Ring womb also lists the special ring bases. Non-womb nodes fall through to the default tooltip.
      tooltipOverride: (node) => {
        const gn = genesisGraph.nodes[node.id]
        return gn?.keystone ? wombTooltipHtml(gn.subTree, node.name) : null
      },
    })
    genesisView.subscribe(updateGenesisCounts)
    genesisView.setBuild({ allocated: [] }) // nothing on by default — the player takes each womb
    genesisView.setBgVisible(genesisBgPref()) // apply the saved background-art preference on first mount
    const statsPanel = document.getElementById('genesis-stats-panel')
    const statsToggle = document.getElementById('genesis-stats-toggle')
    if (statsPanel && statsToggle) {
      mountStatsPanel(statsPanel, statsToggle, genesisView, genesisGraph.nodes, {
        title: copy.genesis.statsTitle,
        empty: copy.genesis.statsEmpty,
      })
    }
    return genesisView
  }

  els.genesisBg.addEventListener('change', () => {
    const on = els.genesisBg.checked
    try {
      localStorage.setItem(GENESIS_BG_KEY, on ? '1' : '0')
    } catch {
      /* private mode / storage disabled — toggle still applies for this session */
    }
    void ensureGenesis().then((v) => v.setBgVisible(on))
  })

  els.genesisFit.addEventListener('click', () => void ensureGenesis().then((v) => v.fit()))
  els.genesisReset.addEventListener('click', () => {
    void ensureGenesis().then((v) => {
      v.setBuild({ allocated: [] })
      refreshGenesisButtons()
    })
  })
  els.genesisShare.addEventListener('click', async () => {
    const view = await ensureGenesis()
    const payload = encodeAtlasPlan(genesisSelection(view.getAllocated())) // numeric-id codec, shared with the atlas
    const url = new URL(window.location.href)
    url.hash = `genesis=${payload}`
    history.replaceState(null, '', url)
    const ok = await copyText(url.href)
    els.genesisShare.textContent = ok ? copy.convert.copied : copy.convert.copyFailed
    if (genesisShareResetId) clearTimeout(genesisShareResetId)
    genesisShareResetId = setTimeout(() => {
      els.genesisShare.textContent = copy.convert.copyPlanLink
      genesisShareResetId = null
    }, 1400)
  })

  // load-on-boot: a shared '#genesis=<nodes>' link opens the planner with the decoded plan. A
  // mangled link boots the default plan but SAYS so (same contract as the atlas twin).
  function loadBootPlan(): void {
    const genesisHashRaw = /^#genesis=(.*)$/.exec(window.location.hash)?.[1]
    const genesisBootPlan = genesisHashRaw != null ? decodeAtlasPlan(genesisHashRaw) : null
    if (genesisHashRaw && !genesisBootPlan) {
      deps.openGenesisRoute() // the user followed a genesis link — show the planner, with the notice
      els.genesisNote.innerHTML = toastHtml('warn', copy.toast.warn, copy.share.damagedLink)
      return
    }
    els.genesisNote.innerHTML = '' // a readable link supersedes any earlier damaged-link notice
    if (genesisBootPlan) {
      deps.openGenesisRoute()
      void ensureGenesis().then((v) => {
        v.setBuild({ allocated: genesisBootPlan }) // exactly the shared picks (wombs included)
        refreshGenesisButtons()
      })
    }
  }

  return { ensureGenesis, loadBootPlan }
}
