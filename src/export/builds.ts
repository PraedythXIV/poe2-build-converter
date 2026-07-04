// Multi-`.build` export core (no DOM): turn a list of user-named variant selections into
// ready-to-download .build files with filesystem-safe, de-duplicated names. The actual download
// trigger (Blob -> <a download>) lives in main.ts and just loops over what this produces — one
// gesture, N files straight to the user's Downloads folder (no zip to extract).

import type { PobBuild, Warning } from '../convert/types'
import { convertVariant } from '../convert/index'
import type { VariantSelection } from '../convert/index'

export interface BuildFile {
  /** Safe, unique download filename ending in ".build". */
  filename: string
  /** Serialized .build JSON. */
  json: string
  /** Diagnostics from converting this variant. */
  warnings: Warning[]
}

// Characters illegal in Windows / macOS / Linux filenames. Space is legal (and kept); it is only
// tidied (runs collapsed, trailing trimmed) by safeStem below.
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g

/**
 * Turn a variant name into a safe filename STEM (no extension): illegal FS characters → '-',
 * runs of whitespace collapsed to one space, trailing dots/spaces stripped (Windows rejects
 * those). Empty after cleanup → "build".
 */
export function safeStem(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_FILENAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned.length ? cleaned : 'build'
}

/**
 * De-duplicate stems IN ORDER, suffixing collisions " (2)", " (3)", … The match is
 * case-insensitive because Windows/macOS filesystems are — "Boss" and "boss" would otherwise
 * overwrite one another in the Downloads folder. A generated suffix that itself collides with an
 * already-assigned name (e.g. a user-provided "name (2)") keeps incrementing until it is free, so
 * every returned filename is guaranteed unique.
 */
export function dedupeStems(stems: readonly string[]): string[] {
  const seen = new Map<string, number>()
  const taken = new Set<string>()
  return stems.map((stem) => {
    const key = stem.toLowerCase()
    let n = (seen.get(key) ?? 0) + 1
    let candidate = n === 1 ? stem : `${stem} (${n})`
    while (taken.has(candidate.toLowerCase())) {
      n += 1
      candidate = `${stem} (${n})`
    }
    seen.set(key, n)
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

/**
 * Filenames whose diagnostics deserve the user's eye before importing: warn level counts alongside
 * error (e.g. passive-node-unknown — dropped passives); info-only files stay quiet.
 */
export function flaggedFilenames(files: readonly Pick<BuildFile, 'filename' | 'warnings'>[]): string[] {
  return files.filter((f) => f.warnings.some((w) => w.level === 'error' || w.level === 'warn')).map((f) => f.filename)
}

/**
 * Convert every variant of an already-parsed build into a ready-to-download `.build` file with a
 * safe, unique name. Order is preserved; an empty list returns [].
 */
export function buildVariantFiles(pob: PobBuild, variants: readonly VariantSelection[]): BuildFile[] {
  const stems = dedupeStems(variants.map((v) => safeStem(v.name)))
  return variants.map((variant, i) => {
    const { json, warnings } = convertVariant(pob, variant)
    return { filename: `${stems[i]}.build`, json, warnings }
  })
}
