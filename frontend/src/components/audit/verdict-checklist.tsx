/**
 * Verdict checklist — compact category overview for the Audit Workspace.
 *
 * Reads the backend's authoritative score breakdown (never recalculates
 * scoring). Renders a responsive grid of ruled cells, each showing:
 *   - category name (≥14px)
 *   - Pass / Warning / Fail (icon + text, never color alone)
 *   - major and minor finding counts
 *   - deduction in points
 *
 * Visual priority:
 *   - Fail: strongest emphasis (destructive tone)
 *   - Warning: secondary emphasis (warning tone)
 *   - Pass: muted but readable (success tone, no domination)
 *
 * Breakdown:
 *   - no deduction  → Pass
 *   - any MAJOR     → Fail
 *   - MINOR-only    → Warning
 *
 * The presentation-only 'unknown' category renders as "Other."
 */

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { CATEGORY_LABELS } from '../../lib/audit/categories'
import { normalizeScoreCategory } from '../../lib/audit/adapter'
import { cn } from '../../lib/utils'
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
  selectedCategory = null,
  onSelectCategory,
}: {
  breakdown: ScoreBreakdown[]
  /** Dashboard-only caption: verdicts are presentation-derived, not returned by the backend. */
  showDerivedNote?: boolean
  /** Controlled category filter (shared with Findings). */
  selectedCategory?: string | null
  /** When provided, each known category renders as a semantic button (aria-pressed). */
  onSelectCategory?: (category: string) => void
}) {
  if (breakdown.length === 0) return null
  const selectable = typeof onSelectCategory === 'function'

  return (
    <section aria-label="Category verdicts">
      <h2 className="text-component-title text-foreground">Category verdicts</h2>
      {showDerivedNote && (
        <p className="mt-0.5 text-[11px] leading-[16px] text-muted-foreground">
          Verdicts are derived on the client from the backend deduction values.
        </p>
      )}
      <ul
        className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4"
        role="list"
      >
        {breakdown.map((b) => {
          const verdict = verdictFor(b)
          const cat = normalizeScoreCategory(b.category)
          const label = cat === 'unknown' ? 'Other' : CATEGORY_LABELS[cat]
          const Icon = VERDICT_ICON[verdict]
          const selected = selectable && selectedCategory === b.category
          const cell = (
            <>
              {/* Top row: icon + category name */}
              <div className="flex items-center gap-2">
                <Icon
                  className={`h-4 w-4 shrink-0 ${VERDICT_TONE[verdict]}`}
                  aria-hidden="true"
                />
                <span className="truncate text-[14px] font-medium text-foreground">
                  {label}
                </span>
              </div>

              {/* Bottom row: status, counts, deduction */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] leading-[19px] text-muted-foreground">
                <span className={`font-medium ${VERDICT_TONE[verdict]}`}>
                  {VERDICT_LABEL[verdict]}
                </span>
                <span aria-hidden="true">·</span>
                {b.major > 0 && (
                  <span className="text-destructive" title={`${b.major} major findings`}>
                    {b.major}M
                  </span>
                )}
                {b.minor > 0 && (
                  <span className="text-warning" title={`${b.minor} minor findings`}>
                    {b.minor}m
                  </span>
                )}
                {b.major === 0 && b.minor === 0 && (
                  <span className="text-success">0</span>
                )}
                <span aria-hidden="true">·</span>
                {b.deduction > 0 ? (
                  <span className="font-mono text-foreground" title={`−${b.deduction} points deducted`}>
                    −{b.deduction}
                  </span>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </div>
            </>
          )

          if (selectable && cat !== 'unknown') {
            return (
              <li key={b.category} role="listitem">
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelectCategory(b.category)}
                  className={cn(
                    'flex w-full flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    selected
                      ? 'border-primary bg-primary/10 ring-1 ring-primary'
                      : 'border-border bg-card hover:bg-muted/40',
                  )}
                >
                  {cell}
                </button>
              </li>
            )
          }

          return (
            <li
              key={b.category}
              className="flex flex-col gap-1 rounded-md border border-border bg-card px-3 py-2.5"
              role="listitem"
            >
              {cell}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
