// Helpers for the `.build` additional_text markup language.
//
// Markup wraps content as  <tag>{ ... }  and nests, e.g.  <m>{<red>{Strength +5}}.
// Supported tags (see GGG's docs, /developer/docs/game#buildplanner): fonts <r><b><i><u><s><m><l>,
// colors <red><orange><yellow><green><blue><indigo><violet><black><white><grey>
// <bronze><silver><gold><unique>, and custom <rgb(r, g, b)>.

export type Color =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'black'
  | 'white'
  | 'grey'
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'unique'

/** Braces are the markup delimiters; a stray one would corrupt the popup. Strip them from text. */
function safe(text: string): string {
  return text.replace(/[{}]/g, '')
}

/** Wrap text in a markup tag: wrap('grey', 'hi') -> "<grey>{hi}". */
function wrap(tag: string, text: string): string {
  return `<${tag}>{${text}}`
}

export function color(c: Color, text: string): string {
  return wrap(c, safe(text))
}

/** Join lines with the literal newline the format expects inside additional_text. */
export function lines(...parts: Array<string | null | undefined>): string {
  // Drop only null/undefined (omitted lines); a literal '' is kept as an intentional blank separator.
  return parts.filter((p): p is string => p != null).join('\n')
}
