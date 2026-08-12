/**
 * Verdict checklist — chart-free category summary for the Audit Workspace.
 *
 * Reads the backend's authoritative score breakdown (never recalculates
 * scoring). Verdicts are derived from existing severity semantics:
 *   - no deduction      → Pass
 *   - any MAJOR finding → Fail
 *   - MINOR-only        → Warning
 * The repository defines no numeric per-category thresholds, so verdicts
 * come from the data model's own severity distinction, not invented scores.
 *
 * The presentation-only `unknown` category (Build 1.2) renders truthfully
 * as "Other" — never remapped to a known category.
 */

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { CATEGORY_LABELS } from '../../lib/audit/categories'
import { normalizeScoreCategory } from '../../lib/audit/adapter'
import type { ScoreBreakdown } from '../../types/api'

type Verdict = 'pass' | 'warning' | 'fail'

function verdictFor(b: ScoreBreakdown): Verdict {
  if (b.deduction <= 0) return 'pass'
  return b.major > 0 ? 'fail' : 'warning'
}

const VERDICT_ICON = {
  pass: CheckCircle2,
  warning: AlertTriangle,
  fail: XCircle,
} as const

const VERDICT_TONE = {
  pass: 'text-success',
  warning: 'text-warning',
  fail: 'text-destructive',
} as const

const VERDICT_LABEL = { pass: 'Pass', warning: 'Warning', fail: 'Fail' } as const

export function VerdictChecklist({
  breakdown,
  showDerivedNote = false,
}: {
  breakdown: ScoreBreakdown[]
  /** Dashboard-only caption: verdicts are presentation-derived, not returned by the backend. */
  showDerivedNote?: boolean
}) {
  if (breakdown.length === 0) return null

  return (
    <section aria-label="Category verdicts">
      <h2 className="text-component-title text-foreground">Category verdicts</h2>
      {showDerivedNote && (
        <p className="mt-0.5 text-[11px] leading-[16px] text-muted-foreground">
          Verdicts are derived on the client from the backend deduction values.
        </p>
      )}
      <ul className="mt-3 divide-y divide-border border-y border-border">
        {breakdown.map((b) => {
          const verdict = verdictFor(b)
          const cat = normalizeScoreCategory(b.category)
          const label = cat === 'unknown' ? 'Other' : CATEGORY_LABELS[cat]
          const Icon = VERDICT_ICON[verdict]
          return (
            <li key={b.category} className="flex items-center justify-between gap-3 py-2.5">
              <span className="flex min-w-0 items-center gap-2.5">
                <Icon className={`h-4 w-4 shrink-0 ${VERDICT_TONE[verdict]}`} aria-hidden="true" />
                <span className="truncate text-sm font-medium text-foreground">{label}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className={`text-sm font-medium ${VERDICT_TONE[verdict]}`}>
                  {VERDICT_LABEL[verdict]}
                </span>
                {verdict !== 'pass' && (
                  <span className="block text-[13px] leading-[19px] text-muted-foreground">
                    {b.major} major · {b.minor} minor · −{b.deduction} pts
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
