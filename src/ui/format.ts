// Shared text-formatting helpers for the string-rendered UI. Pure (no DOM) — one home for the
// count/size wording that was otherwise re-spelled inline at every call site.

/** Count + noun with English plural: plural(1,'file') → "1 file", plural(3,'file') → "3 files".
 *  Pass an explicit plural form for irregulars (plural(2,'is','are')). */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}

/** Byte count → a compact "512 B" / "1.4 KB" / "2.0 MB" / "1.1 GB" readout (download size / paste length). */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
