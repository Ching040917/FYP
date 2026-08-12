/**
 * Static audit preview — Landing-only, purely presentational illustration
 * of the Audit Workspace layout.
 *
 * Contains example data only: no API calls, no hooks, no live audit state,
 * no interactive controls. It exists so visitors understand what a report
 * looks like without a backend.
 */

import { CheckCircle2, AlertTriangle, XCircle, Quote, ShieldCheck, FileText, Ruler, ListTree } from 'lucide-react'
import { Badge } from '../ui/badge'

const CATEGORY_ROWS = [
  { label: 'Typography', verdict: 'warning' as const, detail: '1 minor finding' },
  { label: 'Page layout', verdict: 'fail' as const, detail: '1 major finding' },
  { label: 'Heading hierarchy', verdict: 'warning' as const, detail: '1 minor finding' },
  { label: 'Captions', verdict: 'pass' as const, detail: 'No findings' },
]

const VERDICT_ICON = { pass: CheckCircle2, warning: AlertTriangle, fail: XCircle } as const
const VERDICT_TONE = {
  pass: 'text-success',
  warning: 'text-warning',
  fail: 'text-destructive',
} as const

export function StaticAuditPreview() {
  return (
    <section
      aria-label="Product preview"
      className="rounded-md border border-border bg-card"
    >
      {/* Example-data disclaimer */}
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Product preview — example data, not your document
        </p>
      </div>

      {/* Document identity */}
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <div className="break-words text-sm font-medium text-foreground">thesis_draft.docx</div>
            <div className="font-mono text-[11px] text-muted-foreground">Example document</div>
          </div>
        </div>
        <div className="text-right">
          <div className="flex items-baseline justify-end gap-1.5">
            <span className="font-mono text-section-title text-foreground">76</span>
            <span className="text-[13px] text-muted-foreground">/100</span>
          </div>
          <div className="flex items-center justify-end gap-1.5 text-[13px] text-warning">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Review required
          </div>
        </div>
      </div>

      {/* Category verdicts */}
      <ul className="divide-y divide-border border-y border-border">
        {CATEGORY_ROWS.map((row) => {
          const Icon = VERDICT_ICON[row.verdict]
          return (
            <li key={row.label} className="flex items-center justify-between gap-3 px-4 py-2">
              <span className="flex min-w-0 items-center gap-2.5">
                <Icon className={`h-4 w-4 shrink-0 ${VERDICT_TONE[row.verdict]}`} aria-hidden="true" />
                <span className="text-sm text-foreground">{row.label}</span>
              </span>
              <span className="text-[13px] text-muted-foreground">{row.detail}</span>
            </li>
          )
        })}
      </ul>

      {/* Formatting findings */}
      <div className="space-y-3 px-4 py-3">
        <h3 className="text-component-title text-foreground">Formatting findings</h3>
        <div className="rounded-md border border-border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Ruler className="h-4 w-4 text-destructive" aria-hidden="true" />
            <span className="text-sm font-medium text-foreground">Left margin</span>
            <Badge variant="outline" className="h-4 px-1.5 text-[11px] leading-none border-destructive/40 bg-destructive/10 text-destructive">
              Major
            </Badge>
          </div>
          <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Expected</dt>
              <dd className="mt-0.5 text-sm text-foreground">1.5 inches</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Actual</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-foreground">1.0 inch</dd>
            </div>
          </dl>
        </div>
        <div className="rounded-md border border-border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <ListTree className="h-4 w-4 text-warning" aria-hidden="true" />
            <span className="text-sm font-medium text-foreground">Heading hierarchy</span>
            <Badge variant="outline" className="h-4 px-1.5 text-[11px] leading-none border-warning/40 bg-warning/10 text-warning">
              Minor
            </Badge>
          </div>
          <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Expected</dt>
              <dd className="mt-0.5 text-sm text-foreground">Heading 1 followed by Heading 2</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Actual</dt>
              <dd className="mt-0.5 font-mono text-[13px] text-foreground">Heading 1 followed by Heading 3</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* AI-assisted suggestion */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-component-title text-foreground">AI-assisted suggestions</h3>
          <Badge variant="outline" className="border-ai-assisted/40 bg-ai-assisted/10 text-ai-assisted">
            <Quote className="mr-1 h-3 w-3" aria-hidden="true" /> AI-assisted
          </Badge>
        </div>
        <p className="mt-2 text-sm leading-[21px] text-foreground">
          A citation-shaped phrase in paragraph 12 could not be matched to a reference pattern.
        </p>
        <p className="mt-1 text-[13px] leading-[19px] text-muted-foreground">
          <span className="font-medium text-ai-assisted">Suggestion: </span>
          verify the in-text citation against APA style manually before submission.
        </p>
      </div>

      {/* Local processing statement */}
      <div className="flex items-start gap-2 border-t border-border px-4 py-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
        <p className="text-[13px] leading-[19px] text-muted-foreground">
          Example report shown only. Real reports are produced by processing your document
          locally; the original file is never modified.
        </p>
      </div>
    </section>
  )
}
