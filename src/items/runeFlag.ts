// Single source of truth for the PoB "(rune)" granted-stat flag the parser appends to a
// soul-core / rune-granted mod line ("+40 to maximum Life (rune)"). Shared by the item details
// overlay (detailsPanel.ts) and the gear gallery card (gearGallery.ts) so both classify rune
// lines identically — case-insensitive and trailing-space tolerant.
export const RUNE_FLAG_RE = /\s*\(rune\)\s*$/i
