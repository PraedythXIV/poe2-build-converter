// THE single HTML-escaping helper for the string-rendered UI (every panel + main.ts import this).
// One source of truth for a security-relevant transform — never re-fork it inline.
export function escapeHtml(s: string): string {
  // also escapes quotes — call sites interpolate into HTML attributes (data-code, aria-label, etc.)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
