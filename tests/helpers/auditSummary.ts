// Shared audit-test fixtures: a full default BuildSummary factory (mirrors the summarize() shape so
// mocks stay valid as fields grow) and the byCode finding filter. Used by every suite that drives
// auditBuild() against synthetic summaries.
import type { BuildSummary } from '../../src/convert/summarize'
import type { AuditFinding } from '../../src/audit/audit'

/** Findings whose `code` equals `code` — the common assertion shorthand. */
export const byCode = (f: AuditFinding[], code: string): AuditFinding[] => f.filter((x) => x.code === code)

/** A minimal-but-complete BuildSummary; spread `over` to pin the fields a test cares about. */
export function makeSummary(over: Partial<BuildSummary> = {}): BuildSummary {
  return {
    className: 'Monk',
    ascendancy: null,
    level: 90,
    mainSkill: null,
    items: [],
    itemCount: 0,
    uniqueCount: 0,
    jewels: [],
    skills: [],
    keystones: [],
    notables: [],
    ascNotables: [],
    masteries: [],
    passiveCount: 0,
    playerStats: {},
    specNodes: [],
    ascendancyInternalId: null,
    ...over,
  }
}
