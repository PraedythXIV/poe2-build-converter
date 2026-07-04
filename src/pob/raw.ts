// src/pob — raw-passthrough primitives + small typed-parse helpers for the lossless model.
// These are the losslessness floor: anything we don't model structurally is kept verbatim through
// `attrsOf` / `rawElement`, and the tri-state helpers distinguish `attr="nil"` from a missing attribute.

import type { ConfigInput, ConfigValue, RawAttrs, RawElement } from './model'

/** Every attribute of an element, verbatim. */
export function attrsOf(el: Element): RawAttrs {
  const out: RawAttrs = {}
  for (const a of Array.from(el.attributes)) out[a.name] = a.value
  return out
}

/** Only an element's OWN (direct) text nodes, trimmed — excludes any child-element text. */
function directText(el: Element): string {
  let s = ''
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 /* TEXT_NODE */) s += n.nodeValue ?? ''
  return s.trim()
}

/** An element we keep but don't model: tag + attrs + own-text + children, recursively. */
export function rawElement(el: Element): RawElement {
  return {
    tag: el.tagName,
    attrs: attrsOf(el),
    text: directText(el),
    children: Array.from(el.children).map(rawElement),
  }
}

/** Tri-state boolean: missing or "nil" → null; "false" → false; anything else → true. */
export function tri(v: string | null): boolean | null {
  return v == null || v === 'nil' ? null : v !== 'false'
}

/** String-or-null: missing or "nil" → null; otherwise the value verbatim. */
export function strOrNull(v: string | null): string | null {
  return v != null && v !== 'nil' ? v : null
}

/** Parse a `<Input>` / `<Placeholder>` element into a typed ConfigInput, or null if it has no name.
 *  Verbatim: numbers stay strings (precision / "inf"); strings keep their newlines. */
export function parseConfigInput(el: Element): ConfigInput | null {
  const name = el.getAttribute('name')
  if (!name) return null
  const b = el.getAttribute('boolean')
  const n = el.getAttribute('number')
  const s = el.getAttribute('string')
  let value: ConfigValue
  if (b != null) value = { kind: 'boolean', value: b === 'true' }
  else if (n != null) value = { kind: 'number', value: n }
  else value = { kind: 'string', value: s ?? '' }
  return { name, value }
}
