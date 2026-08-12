/**
 * Finding detail — the evidence pane of the Audit Workspace master-detail
 * layout. Presents one deterministic violation with a rule-aware layout
 * instead of forcing every finding into the same Expected / Actual /
 * Guidance template.
 *
 * Presentation is keyed by existing rule codes (a narrow presentation
 * helper): formatting rules keep Expected + Actual plus a deterministic
 * actionable sentence; Citation Mismatch shows evidence, not an Actual
 * box; missing-caption/alt-text findings show Missing requirement +
 * Affected element + Required action; heading findings show expected vs
 * actual heading sequences. Unknown rules use a safe generic fallback.
 * Backend values are never modified, nothing unsupported is invented, and
 * sections with no meaningful information are omitted.
 *
 * Only fields that exist in the wire type are shown. The paragraph number
 * is derived from the parser's paragraph index — never presented as an
 * exact page location.
 */

import { MapPin, ShieldCheck } from 'lucide-react'
import { Badge } from '../ui/badge'
import { CATEGORY_LABELS } from '../../lib/audit/categories'
import { categoryForRuleCode, humanizeRuleCode } from '../../lib/audit/adapter'
import { ExpectedActualTable } from './expected-actual-table'
import { presentationFor } from '../../lib/audit/finding-presentation'
import type { Violation } from '../../types/api'

function paragraphNumber(v: Violation): number | null {
  const loc = v.location as Record<string, unknown> | null
  const n = loc?.paragraph_index
  return typeof n === 'number' && n >= 0 ? n + 1 : null
}

export function FindingDetail({ violation }: { violation: Violation | null }) {
  if (!violation) {
    return (
      <section
        aria-label="Finding detail"
        className="rounded-md border border-dashed border-border px-6 py-10 text-center"
      >
        <p className="text-sm text-muted-foreground">
          Select a finding from the list to inspect its evidence.
        </p>
      </section>
    )
  }

  const v = violation
  const category = categoryForRuleCode(v.rule_code)
  const para = paragraphNumber(v)
  const pres = presentationFor(v)

  return (
    <section
      id="finding-detail"
      aria-label="Finding detail"
      tabIndex={-1}
      className="scroll-mt-20 rounded-md focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <h2 className="text-section-title text-foreground">{humanizeRuleCode(v.rule_code)}</h2>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-border text-foreground">
          {CATEGORY_LABELS[category]}
        </Badge>
        <Badge
          variant="outline"
          className={
            v.severity === 'MAJOR'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-warning/40 bg-warning/10 text-warning'
          }
        >
          {v.severity === 'MAJOR' ? 'Major' : 'Minor'}
        </Badge>
        <span className="inline-flex items-center gap-1.5 text-[13px] leading-[19px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          Deterministic check
        </span>
      </div>

      <dl className="mt-4 space-y-3">
        {para != null && (
          <div className="flex items-baseline gap-3">
            <dt className="w-28 shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Location
            </dt>
            <dd className="inline-flex items-center gap-1.5 text-sm text-foreground">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              Paragraph {para}
            </dd>
          </div>
        )}
        <div className="flex items-baseline gap-3">
          <dt className="w-28 shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Specification
          </dt>
          <dd className="font-mono text-[13px] leading-[19px] text-foreground">{v.rule_code}</dd>
        </div>
        <div className="flex items-baseline gap-3">
          <dt className="w-28 shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Confirmed issue
          </dt>
          <dd className="text-sm leading-[21px] text-foreground">{pres.issue}</dd>
        </div>
      </dl>

      {/* Formatting findings: meaningful Expected + Actual kept side by side. */}
      {pres.expected != null || pres.actual != null ? (
        <div className="mt-4">
          <ExpectedActualTable expected={pres.expected ?? null} actual={pres.actual ?? null} />
        </div>
      ) : null}

      {/* Citation mismatch: evidence labelled as evidence, never as Actual. */}
      {pres.evidence != null && (
        <div className="mt-4">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Citation evidence
          </h3>
          <blockquote className="mt-1.5 whitespace-pre-wrap break-words rounded border-l-2 border-ai-assisted/40 bg-ai-assisted/5 px-3 py-2 font-serif text-sm leading-[21px] text-foreground">
            “{pres.evidence}”
          </blockquote>
        </div>
      )}

      {/* Missing caption / alt-text: Missing requirement + affected element. */}
      {pres.missingRequirement != null && (
        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Missing requirement
            </dt>
            <dd className="mt-1.5 rounded border border-border bg-input/20 px-3 py-2 text-sm leading-[21px] text-foreground">
              {pres.missingRequirement}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Affected element
            </dt>
            <dd className="mt-1.5 rounded border border-border bg-input/20 px-3 py-2 font-mono text-[13px] leading-[19px] text-foreground">
              {pres.affectedElement}
            </dd>
          </div>
        </dl>
      )}

      {/* Heading hierarchy: expected vs actual heading sequence. */}
      {pres.expectedHeadingSequence != null && pres.actualHeadingSequence != null && (
        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Expected heading sequence
            </dt>
            <dd className="mt-1.5 whitespace-pre-wrap break-words rounded border border-border bg-input/20 px-3 py-2 font-mono text-[13px] leading-[19px] text-foreground">
              {pres.expectedHeadingSequence}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Actual heading sequence
            </dt>
            <dd className="mt-1.5 whitespace-pre-wrap break-words rounded border border-border bg-input/20 px-3 py-2 font-mono text-[13px] leading-[19px] text-foreground">
              {pres.actualHeadingSequence}
            </dd>
          </div>
        </dl>
      )}

      {/* Required action — never a duplicate of the Expected value. */}
      {pres.requiredAction != null && (
        <div className="mt-4">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Required action
          </h3>
          <p className="mt-1.5 whitespace-pre-wrap break-words rounded border border-border bg-input/20 px-3 py-2 text-sm leading-[21px] text-foreground">
            {pres.requiredAction}
          </p>
        </div>
      )}
    </section>
  )
}
