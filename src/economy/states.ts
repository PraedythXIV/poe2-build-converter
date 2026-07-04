// Shared loading / empty / error renderers for the economy panels — the vendored library
// skeleton (#13 sk-) and empty-state (#235 es-) surfaces, kept in ONE place so the browse panel
// and the exchange view render identical states. Pure HTML strings; every value is escaped.
import { copy } from '../copy'
import { escapeHtml } from '../ui/escapeHtml'

/** Skeleton loading rows (component #13 `sk-`) wrapped in an aria-live status with an sr-only label
 *  (the bones themselves are decorative). Replaces the bare "Loading…" paragraph. */
export function skeletonLoading(label: string, n = 6): string {
  const rows = Array.from({ length: n }, (_, i) => {
    const w = 52 + ((i * 17) % 38) // varied 52–90% bar widths so it reads as content, not a grid
    return `<div class="sk-row"><span class="sk-ico"></span><span class="sk-line" style="width:${w}%"></span><span class="sk-badge"></span></div>`
  }).join('')
  return `<div class="ec-loading-sk" role="status"><span class="sr-only">${escapeHtml(label)}</span><div class="sk-list">${rows}</div></div>`
}

/** Pagination chevrons for the vendored #224 pg- prev/next icb buttons (browse + exchange pagers). */
export const PG_PREV_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>'
export const PG_NEXT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'

const GLYPH_SEARCH =
  '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8 11h6"/></svg>'
const GLYPH_ALERT =
  '<svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'

/** Empty / error state (component #235 `es-`). `results` = no matches (warning tint), `error` = load
 *  failure (danger tint). Replaces the bare `.ec-loading.err` / `.ec-empty` text. */
export function emptyState(variant: 'results' | 'error', title: string, desc: string): string {
  const glyph = variant === 'error' ? GLYPH_ALERT : GLYPH_SEARCH
  return (
    `<div class="es es--${variant} ec-state" role="status">` +
    `<div class="es-glyph" aria-hidden="true">${glyph}</div>` +
    `<h3 class="es-title">${escapeHtml(title)}</h3>` +
    `<p class="es-desc">${escapeHtml(desc)}</p></div>`
  )
}

/** Load-error state from a thrown error message. */
export function errorState(message: string): string {
  return emptyState('error', copy.economy.loadErrorTitle, message)
}
