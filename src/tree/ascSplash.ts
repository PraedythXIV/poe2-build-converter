// ── Phase 6 Agent C — class/ascendancy splash (DOM overlay over the tree canvas) ──
// Extracted from main.ts (structural refactor — behaviour/output unchanged). Builds the pure-string
// .itc-card painted next to #tree-mount: the class/ascendancy illustration WINDOWED out of the inlined
// class-art.webp (a background-image div, NOT the whole sheet) plus the ascendancy's intro flavour
// quote in GGG's own flavour colour.
//
// HONESTY/SECURITY: art only renders when an EXACT frame exists (two illustrations failed to
// decode — Sorceress base + Shaman — and have no frame; those degrade to a text-only card).
// flavourTextColour is sanitized to a 6-hex literal before it ever touches an inline style.
//
// The module is PURE (no DOM): renderAscSplash RETURNS { hidden, html } and main.ts applies it to
// #asc-splash. CLASS_NAME_TO_INDEX is encapsulated here (built once via ensureClassNameIndex from the
// code-split tree export, read by classIndexForName).
import classArtUrl from '../assets/tree/class-art.webp'
import classArtData from '../data/class-art.json'
import { escapeHtml } from '../ui/escapeHtml'
import { copy } from '../copy'
import type { loadGraph, TreeClassInfo } from './graph'

interface ArtFrame {
  x: number
  y: number
  w: number
  h: number
}
interface ClassArtTable {
  _atlas: { w: number; h: number }
  frames: Record<string, ArtFrame>
  byClass: Record<string, string>
  byAscendancy: Record<string, string>
}
const CLASS_ART = classArtData as unknown as ClassArtTable

// Class display name (as PoB / the tree export states it) → class index. Built lazily the first time
// the tree module loads — the tree (+ treeGraph) is code-split now, so listClasses isn't available at
// module init. Lowercased for a tolerant match against the build's className.
let CLASS_NAME_TO_INDEX: Map<string, number> | null = null

/** Build the class-name → index map once from the tree export (idempotent — the `??=` of the
 *  original). Call after the code-split tree graph loads, before classIndexForName. */
export function ensureClassNameIndex(classes: TreeClassInfo[]): void {
  CLASS_NAME_TO_INDEX ??= new Map<string, number>(classes.map((c) => [c.name.toLowerCase(), c.idx]))
}

/** Class index for a build's class name (the class-only fallback path), or null when unknown. */
export function classIndexForName(className: string | null): number | null {
  if (!className || !CLASS_NAME_TO_INDEX) return null
  return CLASS_NAME_TO_INDEX.get(className.trim().toLowerCase()) ?? null
}

/** Resolve the exact atlas frame for an art path (the shared null-safe lookup), or null when absent. */
function frameForPath(path: string | undefined): ArtFrame | null {
  return (path && CLASS_ART.frames[path]) || null
}
/** Resolve the exact atlas frame for a class index, or null when the art is unavailable. */
function classArtFrame(classIndex: number | null): ArtFrame | null {
  if (classIndex === null) return null
  return frameForPath(CLASS_ART.byClass[String(classIndex)])
}
/** Resolve the exact atlas frame for an ascendancy id, or null when the art is unavailable. */
function ascArtFrame(ascendancyId: string | null): ArtFrame | null {
  if (!ascendancyId) return null
  return frameForPath(CLASS_ART.byAscendancy[ascendancyId])
}

/** A windowed crop of the inlined atlas: a fixed-size box showing exactly one frame, scaled to
 *  `displayW`. Never renders the whole sheet — background-size scales the atlas, -position offsets it. */
function splashArtHtml(frame: ArtFrame, displayW: number): string {
  const s = displayW / frame.w
  const px = (n: number): string => `${(n * s).toFixed(1)}px`
  return (
    `<span class="asc-splash-art" aria-hidden="true" style="width:${displayW}px;height:${px(frame.h)};` +
    `background-image:url('${classArtUrl}');background-size:${px(CLASS_ART._atlas.w)} ${px(CLASS_ART._atlas.h)};` +
    `background-position:${px(-frame.x)} ${px(-frame.y)}"></span>`
  )
}

/** 6-hex sanitizer: returns a safe `#rrggbb` for CSS, or '' when the input isn't a clean hex
 *  triple (CSS-injection guard — never interpolate raw flavourTextColour into an inline style). */
function safeHexColour(raw: string | undefined): string {
  return raw && /^[0-9a-f]{6}$/i.test(raw) ? `#${raw.toLowerCase()}` : ''
}

/** What #asc-splash should show: `hidden` true ⇒ clear + hide; otherwise set innerHTML = `html`. */
export interface AscSplashResult {
  hidden: boolean
  html: string
}

/** Build (or clear) the splash for the current class/ascendancy. Degrades gracefully:
 *  asc+art / asc-only / class+art / class-only / nothing — and text-only when art is missing.
 *  Returns the markup for main.ts to apply (keeps the DOM write in the bootstrap, like the rest). */
export function renderAscSplash(
  className: string | null,
  ascendancyId: string | null,
  classIndex: number | null,
  graph: ReturnType<typeof loadGraph>,
): AscSplashResult {
  const asc = ascendancyId ? (graph.ascendancies.get(ascendancyId) ?? null) : null
  const ascName = asc?.name ?? null
  // pick the most specific art available: the ascendancy's, else the class's.
  const frame = ascArtFrame(ascendancyId) ?? classArtFrame(classIndex)

  // nothing identifiable → hide the overlay entirely. Identity comes from the class/ascendancy name;
  // art is supplementary, so an art-only frame with no name is NOT enough to show the card (it would
  // render an empty title). Matches the documented modes above — all of which carry a class or asc name.
  if (!className && !ascName) {
    return { hidden: true, html: '' }
  }

  const art = frame ? splashArtHtml(frame, 132) : ''
  // title line: "<Class> · <Ascendancy>" mirroring the existing identity label.
  const titleParts: string[] = []
  if (className) titleParts.push(`<span class="asc-splash-cls">${escapeHtml(className)}</span>`)
  if (ascName) titleParts.push(`<span class="asc-splash-asc">${escapeHtml(ascName)}</span>`)
  const title = titleParts.join('<i class="asc-splash-sep" aria-hidden="true"></i>')

  // the ascendancy intro quote, rendered whenever flavour text exists; GGG's flavour colour is applied
  // only when it's a clean 6-hex literal (otherwise the quote shows without a custom colour).
  let quote = ''
  const flav = asc?.flavourText
  const flavText = Array.isArray(flav) ? flav.join('\n') : (flav ?? '')
  if (flavText) {
    const hex = safeHexColour(asc?.flavourTextColour)
    const style = hex ? ` style="--asc-flav: ${hex}"` : ''
    // preserve the export's line breaks; every line is escaped before it touches the DOM.
    const lines = flavText
      .split('\n')
      .map((l) => escapeHtml(l))
      .join('<br />')
    quote = `<p class="asc-splash-quote"${style}>${lines}</p>`
  }

  const label = ascName
    ? copy.splash.ascLabel(ascName, className ? ` (${className})` : '')
    : copy.splash.classLabel(className ?? copy.splash.classFallback)
  const html =
    `<div class="itc-card itc-card--featured asc-splash-card" role="group" aria-label="${escapeHtml(label)}">` +
    (art ? `<div class="asc-splash-frame">${art}</div>` : '') +
    `<div class="asc-splash-body"><div class="asc-splash-title">${title}</div>${quote}</div>` +
    `</div>`
  return { hidden: false, html }
}
