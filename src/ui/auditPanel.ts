// C3 — audit panel renderer. Turns auditBuild() findings into the project's shared inline-alert
// vocabulary (.alert info/warn/danger from styles.css, plus a .success variant defined in
// auditPanel.css), grouped by severity with errors first and a one-line severity summary.

import './auditPanel.css'
import { escapeHtml } from './escapeHtml'
import { toastHtml } from './toast'
import { plural } from './format'
import { copy } from '../copy'
import type { AuditFinding } from '../audit/audit'

// severity rank: errors first, then warnings, notes, OK — drives both the summary order and the sort
const RANK: Record<AuditFinding['level'], number> = { error: 0, warn: 1, info: 2, good: 3 }

export function renderAuditPanel(findings: AuditFinding[]): string {
  if (findings.length === 0) return ''

  // severity summary, e.g. "1 issue · 2 warnings · 4 notes · 1 OK" (zero buckets are omitted)
  const counts = findings.reduce(
    (acc, f) => {
      acc[f.level]++
      return acc
    },
    { error: 0, warn: 0, info: 0, good: 0 },
  )
  const parts: string[] = []
  if (counts.error > 0) parts.push(plural(counts.error, copy.audit.nounIssue))
  if (counts.warn > 0) parts.push(plural(counts.warn, copy.audit.nounWarning))
  if (counts.info > 0) parts.push(plural(counts.info, copy.audit.nounNote))
  if (counts.good > 0) parts.push(copy.audit.ok(counts.good))

  // errors first; stable sort keeps each severity bucket in rule order
  const sorted = [...findings].sort((a, b) => RANK[a.level] - RANK[b.level])
  const rows = sorted.map((f) => toastHtml(f.level, f.title, f.detail, f.code)).join('')

  return (
    `<section class="ap" aria-label="Build audit">` +
    `<p class="ap-sum">${escapeHtml(parts.join(' · '))}</p>` +
    `<div class="ap-list">${rows}</div>` +
    `<p class="ap-cap">${copy.audit.caption}</p>` +
    `</section>`
  )
}
