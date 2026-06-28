/**
 * Citation tips panel — right panel showing AI-generated APA-7 fix tooltips.
 * When cloud mode is disabled, shows a locked state explainer so the user
 * understands why the panel is empty.
 * Ported from reference_project/src/components/audit/citation-tips.tsx.
 */

import { Quote, Lock, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../ui/card'
import { Badge } from '../ui/badge'
import { ScrollArea } from '../ui/scroll-area'
import { cn } from '../../lib/utils'
import type { AuditResult, CitationTip } from '../../types/audit'

export function CitationTips({
  result,
  cloudWasEnabled,
}: {
  result: AuditResult
  cloudWasEnabled: boolean
}) {
  const tips = result.ai_citation_tooltips

  return (
    <Card className="border-border bg-card flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Quote className="h-4 w-4 text-primary" />
              AI Citation Audit
            </CardTitle>
            <CardDescription>
              {cloudWasEnabled
                ? tips.length > 0
                  ? `${tips.length} APA issue${tips.length === 1 ? '' : 's'} detected`
                  : 'No APA issues detected'
                : 'Cloud AI mode was off — no citations scanned'}
            </CardDescription>
          </div>
          <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
            <Sparkles className="mr-1 h-3 w-3" /> APA 7
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-0">
        {!cloudWasEnabled ? (
          <LockedState />
        ) : tips.length === 0 ? (
          <EmptyState />
        ) : (
          <ScrollArea className="scroll-area-audit min-h-[360px] px-4 pb-4">
            <ul className="space-y-2">
              {tips.map((t, i) => (
                <li key={i}>
                  <CitationCard tip={t} />
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}

function CitationCard({ tip }: { tip: CitationTip }) {
  const confidenceClasses = {
    high: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    medium: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    low: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  } as const

  return (
    <div className="rounded-md border border-border bg-input/30 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
          <span className="font-mono">¶{tip.position < 1 ? '?' : tip.position}</span>
        </div>
        <Badge
          variant="outline"
          className={cn('h-4 px-1.5 text-[10px]', confidenceClasses[tip.confidence])}
        >
          {tip.confidence}
        </Badge>
      </div>
      {tip.text && (
        <pre className="mt-2 line-clamp-3 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
          “{tip.text}”
        </pre>
      )}
      <div className="mt-2 text-sm text-foreground">{tip.issue}</div>
      <div className="mt-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5 text-xs text-foreground">
        <span className="font-medium text-emerald-300">Fix: </span>
        {tip.fix}
      </div>
    </div>
  )
}

function LockedState() {
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-muted/40 text-muted-foreground">
        <Lock className="h-5 w-5" />
      </div>
      <div className="text-sm font-medium">Citation audit is locked</div>
      <p className="max-w-xs text-xs text-muted-foreground">
        Per the local-first privacy design (FR-5), the AI citation engine is disabled by
        default. Re-run the audit with the <span className="text-primary">Cloud AI</span> toggle
        on to enable APA 7 checks.
      </p>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30">
        <CheckCircle2 className="h-5 w-5" />
      </div>
      <div className="text-sm font-medium">No APA issues detected</div>
      <p className="max-w-xs text-xs text-muted-foreground">
        The AI engine scanned all citation-shaped paragraphs and found no APA 7th-edition
        formatting violations. Re-check manually if you have any concerns.
      </p>
    </div>
  )
}