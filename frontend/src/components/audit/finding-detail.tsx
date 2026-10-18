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
 * Only fields that exist in the wire type are shown. The location reads the
 * SAME shared friendly label the Findings card and the selected evidence
 * use (Page 9 · Paragraph 3); this component never derives a document-wide
 * paragraph number of its own, because that number is ambiguous on its own
 * and disagrees with every other surface. Without a rendered page mapping
 * the shared helper's historical fallback ("Document paragraph 65") is
 * shown instead — never a bare "Paragraph 65".

 */

import { Info, MapPin, ShieldCheck } from 'lucide-react'

import type { ReactNode } from 'react'
import { Badge } from '../ui/badge'
import { severityBadge } from '../../lib/audit/categories'
import { humanizeRuleCode, normalizeViolationSeverity } from '../../lib/audit/adapter'
import { friendlyRuleTitle } from '../../lib/friendly-finding'
import { ExpectedActualTable } from './expected-actual-table'
import { presentationFor } from '../../lib/audit/finding-presentation'
import type { Violation } from '../../types/api'
import type { ViolationSeverity } from '../../types/audit'
import { structuralStoryLabel } from '../../lib/audit/page-elements'

/**
 * What the reader should conclude about how this finding was produced.
 * Only scored severities were decided by an automated formatting check.
 */
function checkStatement(sev: ViolationSeverity): string {
  switch (sev) {
    case 'major':
    case 'minor':
      return 'Automated formatting check'
    case 'review':
      return 'Needs a person to check'
    default:
      return 'Severity not recognised'
  }
}

/**
 * Historical fallback when the shared location label is unavailable.
 *
 * Without a rendered physical-page mapping the document-wide paragraph
 * index is the only honest identity. It is prefixed "Document" so it can
 * never be confused with the on-page paragraph number that the
 * "Page N · Paragraph M" label carries.
 */
function documentParagraphLabel(v: Violation): string | null {
  const loc = v.location as Record<string, unknown> | null
  const n = loc?.paragraph_index
  if (typeof n !== 'number' || n < 0) return null
  return `Document paragraph ${n + 1}`
}

export function FindingDetail({
  violation,
  locationLabel,
}: {
  violation: Violation | null
  /**
   * Shared friendly location label ("Page 9 · Paragraph 3") — the same value
   * the Findings card and the selected-evidence chip read. Null when the
   * parent has none, in which case the historical document-paragraph
   * fallback below is used instead.
   */
  locationLabel?: string | null
}) {
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
  // One shared friendly location for every surface: the parent's label when
  // it exists, else the honest historical fallback. A bare "Paragraph 65"
  // is never rendered — it disagrees with the on-page number elsewhere.
  const location = structuralStoryLabel(v.location ?? {}) ?? locationLabel ?? documentParagraphLabel(v)
  const pres = presentationFor(v)
  const hasCitationEvidence = pres.evidence != null
  const hasEntryPreview = pres.entryPreview != null
  const hasMissingRequirement = pres.missingRequirement != null
  const hasHeadingSequence =
    pres.expectedHeadingSequence != null && pres.actualHeadingSequence != null

  // Secondary disclosure content: long supporting evidence that stays
  // reachable but collapsed, keeping the actionable sections on top.
  const secondarySections: ReactNode[] = []
  if (hasCitationEvidence) {
    secondarySections.push(
      <div key="citation" className="min-w-0">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Citation evidence
        </h3>
        <blockquote className="mt-1.5 whitespace-pre-wrap break-words rounded border-l-2 border-ai-assisted/40 bg-ai-assisted/5 px-3 py-2 font-serif text-sm leading-[21px] text-foreground">
          “{pres.evidence}”
        </blockquote>
      </div>,
    )
  }
  if (hasEntryPreview) {
    secondarySections.push(
      <div key="reference-entry" className="min-w-0">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Reference List entry
        </h3>
        <blockquote className="mt-1.5 whitespace-pre-wrap break-words rounded border-l-2 border-border bg-muted/40 px-3 py-2 text-sm leading-[21px] text-foreground">
          {pres.entryPreview}
        </blockquote>
      </div>,
    )
  }
  if (hasMissingRequirement) {
    secondarySections.push(
      <dl key="missing" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Missing requirement
          </dt>
          <dd className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm leading-[21px] text-foreground">
            {pres.missingRequirement}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Affected element
          </dt>
          <dd className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border pl-3 font-mono text-[13px] leading-[19px] text-foreground">
            {pres.affectedElement}
          </dd>
        </div>
      </dl>,
    )
  }
  if (hasHeadingSequence) {
    secondarySections.push(
      <dl key="heading" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Required heading sequence
          </dt>
          <dd className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border pl-3 font-mono text-[13px] leading-[19px] text-foreground">
            {pres.expectedHeadingSequence}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Current heading sequence
          </dt>
          <dd className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border pl-3 font-mono text-[13px] leading-[19px] text-foreground">
            {pres.actualHeadingSequence}
          </dd>
        </div>
      </dl>,
    )
  }

  return (
    <section
      id="finding-detail"
      aria-label="Finding detail"
      tabIndex={-1}
      className="scroll-mt-20 rounded-md focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <h2 className="text-section-title text-foreground">
        {friendlyRuleTitle(v.rule_code) ?? humanizeRuleCode(v.rule_code)}
      </h2>

      {/* No category badge here: the friendly title already names the rule,
          so "[Paragraph Typography]" beside it was duplicated meaning. The
          category still drives filters, summaries, counts and scoring. */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={severityBadge(normalizeViolationSeverity(v.severity)).className}
          title={severityBadge(normalizeViolationSeverity(v.severity)).scored
            ? undefined
            : 'Severity not recognised — not scored'}
        >
          {severityBadge(normalizeViolationSeverity(v.severity)).label}
        </Badge>
        {/* Only a scored deterministic check says so; Manual review and
            Unclassified findings need a person, and claiming an automated
            formatting check there would be false. */}
        <span className="inline-flex items-center gap-1.5 text-[13px] leading-[19px] text-muted-foreground">
          {severityBadge(normalizeViolationSeverity(v.severity)).scored ? (
            <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          ) : (
            <Info className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          )}
          {checkStatement(normalizeViolationSeverity(v.severity))}
        </span>
      </div>

      <dl className="mt-4 space-y-3">
        {location != null && (
          <div className="flex items-baseline gap-3">
            <dt className="w-28 shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Location
            </dt>
            {/* A long heading excerpt truncates safely, and the complete
                value stays reachable via the title attribute. */}
            <dd
              className="inline-flex min-w-0 items-center gap-1.5 text-sm text-foreground"
              title={location}
            >
              <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{location}</span>
            </dd>
          </div>
        )}
        {/* The Confirmed-issue sentence is omitted whenever a Current/Required
            comparison is shown below: for formatting rules it restates the
            same two values in prose, so both the title and the table would
            carry the finding. Rules with no value comparison keep it. */}
        {!(pres.expected != null || pres.actual != null) && (
          <div className="flex items-baseline gap-3">
            <dt className="w-28 shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Confirmed issue
            </dt>
            <dd className="text-sm leading-[21px] text-foreground">{pres.issue}</dd>
          </div>
        )}
      </dl>

      {/* Formatting findings: one Current → Required comparison, untruncated. */}
      {pres.expected != null || pres.actual != null ? (
        <div className="mt-4">
          <ExpectedActualTable expected={pres.expected ?? null} actual={pres.actual ?? null} />
        </div>
      ) : null}

      {/* Required action — the actionable sentence, kept near the top. */}
      {pres.requiredAction != null && (
        <div className="mt-4">
          <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Required action
          </h3>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-[21px] text-foreground">
            {pres.requiredAction}
          </p>
        </div>
      )}

      {secondarySections.length > 0 && (
        <details className="mt-4 rounded-md border border-border bg-card">
          <summary className="cursor-pointer select-none px-3 py-2 text-[13px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            Extended details
          </summary>
          <div className="space-y-4 border-t border-border p-3">
            {secondarySections}
          </div>
        </details>
      )}
    </section>
  )
}
