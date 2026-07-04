// The nav / input-mode tab strips (main nav, emotions sub-nav, economy views, atlas master switch)
// are NAV-ONLY tablists: the app owns aria-selected + routing, so the panel-owning `tabs` behavior
// would break them. The ui-component-library now ships a `tablist` behavior for exactly this
// contract (backported from this app's wiring) — pin that the vendored copy carries it, so the
// hand-rolled main.ts clone can stay deleted.
import { describe, it, expect } from 'vitest'

const uikit = (await import('../src/vendor/uikit/behaviors')) as Record<string, unknown>
const tablist = uikit.tablist as ((root: HTMLElement) => void) | undefined

function mountStrip(orientation?: 'vertical'): { list: HTMLElement; activated: string[] } {
  document.body.innerHTML = ''
  const list = document.createElement('div')
  list.setAttribute('role', 'tablist')
  if (orientation) list.setAttribute('aria-orientation', orientation)
  const activated: string[] = []
  for (const [id, selected] of [
    ['a', true],
    ['b', false],
    ['c', false],
  ] as const) {
    const t = document.createElement('button')
    t.id = id
    t.setAttribute('role', 'tab')
    t.setAttribute('aria-selected', String(selected))
    // the APP owns activation: flip aria-selected + record, exactly like the real nav handlers
    t.addEventListener('click', () => {
      for (const x of list.querySelectorAll('[role="tab"]')) x.setAttribute('aria-selected', String(x === t))
      activated.push(id)
    })
    list.append(t)
  }
  document.body.append(list)
  return { list, activated }
}

describe('vendored uikit tablist (nav-only roving tab strips)', () => {
  it('ships the tablist behavior: arrows rove focus and activate via the tab’s own click handler', () => {
    expect(typeof tablist, 'vendored behaviors.js must export tablist — re-vendor from the library').toBe('function')
    const { list, activated } = mountStrip()
    tablist!(list)
    // mount-time rove: the selected tab is the single tab stop
    expect(document.getElementById('a')!.tabIndex).toBe(0)
    expect(document.getElementById('b')!.tabIndex).toBe(-1)
    document.getElementById('a')!.focus()
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    // focus roved, the APP's click handler did the activating, and the tab stop followed
    expect(document.activeElement?.id).toBe('b')
    expect(activated).toEqual(['b'])
    expect(document.getElementById('b')!.tabIndex).toBe(0)
  })
})
