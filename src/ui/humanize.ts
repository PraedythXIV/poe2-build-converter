/**
 * Humanize a PoB internal identifier for DISPLAY by inserting spaces at camelCase and letter/digit
 * boundaries. This is pure FORMATTING of the raw token — NOT a renamed or resolved label — so it makes
 * no fabricated claim about the game's wording. Idempotent on already-spaced text. Callers should keep
 * the raw id available (e.g. a `title=` tooltip) so nothing is hidden.
 *
 * Use ONLY where the id IS essentially the name (e.g. a minion id "BearCompanion" -> "Bear Companion").
 * Do NOT use it to fake a human label for ids whose real wording differs (e.g. PoB config keys like
 * "conditionEnemyIgnited" -> "Is the enemy Ignited?") — resolve those from vendored data instead
 * (src/data/configLabels.json).
 *
 *   humanizeId("RaisedSkeletonWarriors") === "Raised Skeleton Warriors"
 *   humanizeId("CloseCombatSupportTwo")  === "Close Combat Support Two"
 */
export function humanizeId(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/([A-Za-z])(\d)/g, '$1 $2') // letter -> digit
    .replace(/(\d)([a-z])/g, '$1 $2') // digit -> lowercase letter (digit -> uppercase is the camelCase rule)
    .replace(/\s+/g, ' ') // collapse (also tidies already-spaced ids)
    .trim()
}
