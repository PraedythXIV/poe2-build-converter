// Decode a Path of Building 2 export code into its XML.
//
// Format (same envelope as PoB1, root differs):
//   URL-safe base64  ->  zlib/deflate inflate  ->  UTF-8 XML rooted at <PathOfBuilding2>
//
// We also accept raw XML directly (if the user pastes/uploads the decoded file), and
// tolerate codes embedded in a share URL (e.g. pobb.in / poe.ninja "pob2/..." links).

import { inflate, inflateRaw } from 'pako'

export class DecodeError extends Error {}

/** Heuristic: does this input look like already-decoded XML rather than a base64 code? */
export function looksLikeXml(input: string): boolean {
  const t = input.trimStart()
  return t.startsWith('<?xml') || t.startsWith('<PathOfBuilding')
}

/** Pull a base64 code out of a share URL or surrounding noise, if present. */
function extractCode(input: string): string {
  let s = input.trim()
  // If it's a URL, the code is usually the last path segment (or after a known prefix).
  const urlMatch = s.match(/[?&/=]([A-Za-z0-9\-_]{40,}={0,3})\s*$/)
  if (urlMatch && urlMatch[1]) return urlMatch[1]
  // Embedded in a share URL (e.g. "pob2://poeninja/<code>"): pick the LONGEST base64url-looking
  // segment — that's the code, not a short slug like "poeninja".
  if (/[/?&=#]/.test(s)) {
    const best = s
      .split(/[/?&=#]/)
      .filter((seg) => /^[A-Za-z0-9\-_]+={0,3}$/.test(seg))
      .sort((a, b) => b.length - a.length)[0]
    if (best) s = best
  }
  return s.replace(/\s+/g, '')
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new DecodeError('Input is not valid base64 — paste a Path of Building 2 export code, or the decoded XML.')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Read the root element tag name from XML (ignoring an optional `<?xml ?>` declaration). */
function rootTag(xml: string): string | null {
  const body = xml.replace(/^\s*<\?xml[^>]*\?>\s*/i, '')
  return body.match(/^<([A-Za-z0-9]+)[\s>]/)?.[1] ?? null
}

/** Decode a PoB2 export code to XML. If `input` is already XML, returns it (validated) unchanged. */
export function decodePobCode(input: string): string {
  let xml: string
  if (looksLikeXml(input)) {
    xml = input.trim()
  } else {
    const bytes = base64UrlToBytes(extractCode(input))
    try {
      // PoB uses a zlib stream (deflate + zlib header); pako.inflate handles that.
      xml = inflate(bytes, { to: 'string' })
    } catch {
      try {
        // Fallback for raw-deflate streams.
        xml = inflateRaw(bytes, { to: 'string' })
      } catch {
        throw new DecodeError('Could not decompress the code. Make sure it is a complete Path of Building 2 export code.')
      }
    }
    xml = xml.trim()
  }

  const tag = rootTag(xml)
  if (tag === 'PathOfBuilding') {
    throw new DecodeError('This looks like a Path of Building 1 (PoE1) code. This tool converts Path of Building 2 (PoE2) builds.')
  }
  return xml
}
