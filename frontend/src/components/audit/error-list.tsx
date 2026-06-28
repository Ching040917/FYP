/**
 * Error list — left panel with severity/category filters + click-to-select.
 * ErrorDetail — right panel showing the selected violation's details.
 * Ported from reference_project/src/components/audit/error-list.tsx.
 */

import * as React from 'react'
import {
  AlertOctagon,
  AlertTriangle,
  ChevronRight,
  Filter,
  MapPin,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { ScrollArea } from '../ui/scroll-area'
import { cn } from '../../lib/utils'
import { CATEGORY_LABELS } from '../../lib/audit/categories'
import type {
  AuditCategory,
  AuditResult,
  LayoutError,
  ViolationSeverity,
} from '../../types/audit'

export function ErrorList({
  result,
  selectedId,
  onSelect,
}: {
  result: AuditResult
  selectedId?: string | null
  onSelect?: (e: LayoutError) => void
}) {
  const [severityFilter, setSeverityFilter] = React.useState<ViolationSeverity | 'all'>('all')
  const [categoryFilter, setCategoryFilter] = React.useState<AuditCategory | 'all'>('all')

  const filtered = result.physical_layout_errors.filter((e) => {
    if (severityFilter !== 'all' && e.severity !== severityFilter) return false
    if (categoryFilter !== 'all' && e.category !== categoryFilter) return false
    return true
  })

  return (
    <Card className="border-border bg-card flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              Document Errors
            </CardTitle>
            <CardDescription>
              {result.physical_layout_errors.length} findings · click to inspect
            </CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-2">
          <Filter className="h-3 w-3 text-muted-foreground" />
          <Select
            value={severityFilter}
            onValueChange={(v) => setSeverityFilter(v as ViolationSeverity | 'all')}
          >
            <SelectTrigger size="sm" className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="major">Major only</SelectItem>
              <SelectItem value="minor">Minor only</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={categoryFilter}
            onValueChange={(v) => setCategoryFilter(v as AuditCategory | 'all')}
          >
            <SelectTrigger size="sm" className="h-8 w-[160px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-0">
        <ScrollArea className="scroll-area-audit min-h-[360px] px-4 pb-4">
          {filtered.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
              No errors match the current filter.
            </div>
          ) : (
            <ul className="space-y-2">
              {filtered.map((e) => {
                const selected = selectedId === e.id
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => onSelect?.(e)}
                      className={cn(
                        'w-full rounded-md border bg-input/30 px-3 py-2.5 text-left transition-colors',
                        selected
                          ? 'border-primary/60 bg-primary/10'
                          : 'border-border hover:border-primary/40 hover:bg-input/50',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {e.severity === 'major' ? (
                            <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                          ) : (
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                          )}
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-foreground">
                              {e.title}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                              <Badge
                                variant="outline"
                                className="h-4 px-1.5 text-[10px] border-border text-muted-foreground font-mono"
                              >
                                ¶{e.position}
                              </Badge>
                              <Badge
                                variant="outline"
                                className="h-4 px-1.5 text-[10px] border-border text-muted-foreground"
                              >
                                {CATEGORY_LABELS[e.category]}
                              </Badge>
                              {e.severity === 'major' ? (
                                <Badge
                                  variant="outline"
                                  className="h-4 px-1.5 text-[10px] border-rose-500/30 bg-rose-500/10 text-rose-300"
                                >
                                  Major
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="h-4 px-1.5 text-[10px] border-amber-500/30 bg-amber-500/10 text-amber-300"
                                >
                                  Minor
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                        <ChevronRight
                          className={cn(
                            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                            selected && 'rotate-90 text-primary',
                          )}
                        />
                      </div>
                      {e.snippet && (
                        <div className="mt-2 line-clamp-2 font-mono text-[11px] text-muted-foreground">
                          “{e.snippet}”
                        </div>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

export function ErrorDetail({ error }: { error: LayoutError | null }) {
  if (!error) {
    return (
      <Card className="border-border bg-card flex items-center justify-center">
        <CardContent className="py-12 text-center">
          <div className="text-sm text-muted-foreground">
            Select an error from the left to inspect its details and suggested fix.
          </div>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold">{error.title}</CardTitle>
        <CardDescription>
          Paragraph {error.position} · {CATEGORY_LABELS[error.category]} ·{' '}
          {error.severity === 'major' ? 'Major violation' : 'Minor violation'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Detail</div>
          <p className="mt-1 text-sm text-foreground leading-relaxed">{error.detail}</p>
        </div>
        {error.snippet && (
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Document snippet</div>
            <pre className="mt-1 rounded-md border border-border bg-input/40 px-3 py-2 font-mono text-xs text-foreground overflow-x-auto">
              {error.snippet}
            </pre>
          </div>
        )}
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-emerald-300">Suggested fix</div>
          <p className="mt-1 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-foreground">
            {error.suggestion}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-border text-muted-foreground"
          onClick={() => navigator.clipboard?.writeText(error.suggestion)}
        >
          Copy suggestion
        </Button>
      </CardContent>
    </Card>
  )
}