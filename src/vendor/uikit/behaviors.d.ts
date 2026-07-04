// Hand-written type surface for the vendored js/behaviors.js (the parts the app uses).
// behaviors.js is plain JS (allowJs off), so this .d.ts gives the .ts importers their types.

/** The handle the `dialog` behavior attaches to its root element (`root._dialog`). */
export interface DialogControl {
  open(): void
  close(): void
}

/**
 * NAV-ONLY roving tablist (the app owns aria-selected/panels/routing): arrows (axis from
 * aria-orientation) + Home/End rove focus and activate via the tab's own click handler;
 * hidden/disabled tabs are skipped. Never writes aria-selected, never touches a panel.
 */
export function tablist(root: Element): void

/** Wire every `[data-behavior]` (+ `[data-dialog-open]` triggers) under `root`. Idempotent. */
export function mountBehaviors(root?: Document | Element): Document | Element

export default mountBehaviors
