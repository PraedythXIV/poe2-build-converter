// Non-modal flyout open/close — the a11y contract shared by the atlas masters drawer and the
// allocated-stats panel: is-open class for the slide, aria-hidden + inert while closed (drops the
// content from the tab order + AT tree while it stays in layout), aria-expanded on the toggle,
// and focus handed back to the toggle on an explicit close.
// (Dedupe refactor while green: MOVED VERBATIM from the two identical setOpen functions in
// src/atlas/masters.ts and src/atlas/statsPanel.ts — the check:dedupe gate flagged the twin.
// Behavior covered by the existing inert/aria tests in atlasMasters.test.ts + atlasStats.test.ts.)

export function setFlyoutOpen(panel: HTMLElement, toggle: HTMLElement, open: boolean, restoreFocus = false): void {
  panel.classList.toggle('is-open', open)
  panel.setAttribute('aria-hidden', String(!open))
  panel.toggleAttribute('inert', !open) // closed: out of the tab order + a11y tree (stays in layout)
  toggle.setAttribute('aria-expanded', String(open))
  toggle.classList.toggle('is-open', open)
  if (!open && restoreFocus) toggle.focus() // hand focus back to the toggle on an explicit close
}
