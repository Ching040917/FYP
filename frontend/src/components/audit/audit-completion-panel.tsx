import { ArrowRight, CheckCircle2, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import type { AuditResult } from '../../types/audit'
import type { AuditCompletionSnapshot } from '../../lib/audit/audit-completion'

export type CompletionPanelModel =
  | { source: 'result'; value: AuditResult }
  | { source: 'snapshot'; value: AuditCompletionSnapshot }

function completionLine(result: AuditResult): string {
  return `Audit complete. Score: ${result.weighted_compliance_score}/100 for enabled checks \u00B7 ${result.major_count ?? 0} major \u00B7 ${result.minor_count ?? 0} minor`
}

function snapshotLine(s: AuditCompletionSnapshot): string {
  return `Audit complete. Score: ${s.score}/100 for enabled checks \u00B7 ${s.major_count} major \u00B7 ${s.minor_count} minor`
}

export interface CompletionPanelProps {
  model: CompletionPanelModel
  onViewAudit: (auditId: string) => void
  onDismiss: () => void
}

// Persistent success panel: shows the authoritative completion message + the
// exact completed-audit id (never derived from History ordering/filename) and
// a canonical `View audit` action to /audit/:auditId. Stays visible until
// dismissed, navigated, or replaced by a newer audit — not on an auto-dismiss
// timer. The optional `AuditResult` path is for the in-memory session; the
// persisted `AuditCompletionSnapshot` restores identically across reloads.
export function AuditCompletionPanel({ model, onViewAudit, onDismiss }: CompletionPanelProps) {
  const auditId = model.source === 'result' ? model.value.audit_id : model.value.audit_id
  const hasLink = typeof auditId === 'string' && auditId.length > 0
  const line =
    model.source === 'result' ? completionLine(model.value) : snapshotLine(model.value)

  return (
    <Card
      className="border-border bg-card"
      role="status"
      aria-live="polite"
      aria-label="Audit completed"
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="flex-1">{line}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
            aria-label="Dismiss completion message"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </CardTitle>
        <CardDescription className="break-words">
          The audit finished successfully. Open the report with the button below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {hasLink ? (
            <Button
              type="button"
              aria-label={`View audit ${auditId}`}
              className="w-full min-w-0 bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
              onClick={() => onViewAudit(auditId!)}
            >
              View audit
              <ArrowRight className="ml-2 h-4 w-4 shrink-0" aria-hidden="true" />
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              The full report link is unavailable for this audit record.
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="w-full border-border text-foreground sm:w-auto"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

