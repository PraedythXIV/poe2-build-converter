// THE single inline-alert (`.alert`) markup builder. One alert vocabulary across the app — the
// import/convert notes, the warnings list, the audit rows and the download note all render through here
// instead of hand-building the same nested markup. (`.alert` info/warn/danger live in styles.css; the
// .success variant in auditPanel.css.) title + body are escaped; pass a code to stamp data-code on the row.
// NB: the class was `.ts-toast` — renamed off the `ts-` stem the component library reserves for its
// Toasts (#17); the app's surface is a FLUSH inline alert, not the library's drop-down banner.

import { escapeHtml } from './escapeHtml'

/** Severity levels that map to an alert skin. */
export type ToastLevel = 'error' | 'warn' | 'info' | 'good'

/** Severity → the `.alert` CSS modifier class. */
const TOAST_CLASS: Record<ToastLevel, string> = {
  error: 'danger',
  warn: 'warn',
  info: 'info',
  good: 'success',
}

/** Build one `.alert` row from a severity level (mapped to the CSS modifier class internally). */
export function toastHtml(level: ToastLevel, title: string, body: string, code?: string): string {
  const cls = TOAST_CLASS[level]
  const dataCode = code ? ` data-code="${escapeHtml(code)}"` : ''
  return (
    `<div class="alert ${cls}"${dataCode}><span class="alert-dot"></span>` +
    `<div class="alert-txt"><b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span></div></div>`
  )
}
