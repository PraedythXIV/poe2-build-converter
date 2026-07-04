// Read-only render of a PoB build's NOTES (<Notes> text). PoB embeds colour codes — `^N` (a palette
// index 0–9) and `^xRRGGBB` (a hex colour) — which set the colour of the text that follows until the
// next code. We turn those into <span> colours and escape everything else. Verbatim: we never reflow
// or edit the notes, just colourise. Returns '' (hidden) when there are no notes.
import { escapeHtml } from './escapeHtml'
import { copy } from '../copy'

// PoB's classic ^0..^9 console palette, nudged a touch brighter so it reads on the dark theme.
const PALETTE = [
  '#000000',
  '#e23030',
  '#3fbf3f',
  '#5a7fff',
  '#e0c040',
  '#c060e0',
  '#40c8d0',
  '#e8e8e8',
  '#9a9a9a',
  '#5a5a5a',
]

export function renderNotesPanel(notes: string | null): string {
  if (!notes || !notes.trim()) return ''
  const parts: string[] = []
  let color = '' // '' = inherit the theme's text colour
  const push = (text: string): void => {
    if (!text) return
    const safe = escapeHtml(text)
    parts.push(color ? `<span style="color:${color}">${safe}</span>` : safe)
  }
  const re = /\^(x[0-9a-fA-F]{6}|[0-9])/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(notes)) !== null) {
    push(notes.slice(last, m.index))
    const code = m[1]! // "xRRGGBB" or a single digit — used only to derive `color`, never interpolated into HTML itself
    color = code[0] === 'x' ? `#${code.slice(1).toLowerCase()}` : (PALETTE[Number(code)] ?? '')
    last = re.lastIndex
  }
  push(notes.slice(last))
  return (
    `<section class="card" aria-labelledby="bc-notes-hd">` +
    `<div class="card-hd" id="bc-notes-hd" role="heading" aria-level="2">${copy.notes.headerLabel}</div>` +
    `<div class="card-body"><pre class="bc-notes">${parts.join('')}</pre></div>` +
    `</section>`
  )
}
