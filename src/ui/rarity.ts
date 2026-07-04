// Single source of truth for rarity → #311 item-tooltip (itc-card) tiering. Used by the gear
// summary (main.ts), the item details panel (detailsPanel.ts), and the passive-tree jewel
// tooltip (tree/index.ts) so the rarity → colour mapping never drifts between them.

export type RarityKey = 'unique' | 'rare' | 'magic' | 'normal'

/** Collapse a PoB rarity string (NORMAL | MAGIC | RARE | UNIQUE | RELIC | …) to a tier key. */
export function rarityKey(rarity: string): RarityKey {
  const r = rarity.toUpperCase()
  return r === 'UNIQUE' || r === 'RELIC' ? 'unique' : r === 'RARE' ? 'rare' : r === 'MAGIC' ? 'magic' : 'normal'
}

/** The inline `--itc-tier` hue + rgb pair for a `--poe-<token>` colour token — the single source for
 *  the itc-card tier-variable template (callers compose it via `poeTierVars(rarityKey(x))`). */
export function poeTierVars(token: string): string {
  return `--itc-tier: var(--poe-${token}); --itc-tier-rgb: var(--poe-${token}-rgb);`
}
