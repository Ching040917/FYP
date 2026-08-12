/**
 * Findings list — master pane of the Audit Workspace master-detail layout.
 * Shared with Dashboard (Build 4 owns the Dashboard-specific restyle).
 *
 * Findings are structured ruled rows, not elevated cards: 1px rules, 3px
 * severity stripe, restrained radii, no shadows. Every row is a real
 * <button> (Tab + Enter/Space), has a visible focus treatment, and marks
 * selection with an explicit check indicator + aria-pressed — never color
 * alone.
 */

import * as React from 'react'
import {
  AlertOctagon,
  AlertTriangle,
  Check,
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
  className,
  categoryFilter,
  onCategoryFilterChange,
}: {
  result: Pick<AuditResult, 'physical_layout_errors'>
  selectedId?: string | null
  onSelect?: (e: LayoutError) => void
  className?: string
  /** Controlled category filter — shared with the category overview. */
  categoryFilter?: AuditCategory | 'all'
  onCategoryFilterChange?: (category: AuditCategory | 'all') => void
}) {
  const [severityFilter, setSeverityFilter] = React.useState<ViolationSeverity | 'all'>('all')
  const [localCategoryFilter, setLocalCategoryFilter] = React.useState<AuditCategory | 'all'>('all')

  const categoryFilterValue = categoryFilter ?? localCategoryFilter

  const handleCategoryChange = (value: string) => {
    const next = value as AuditCategory | 'all'
    if (onCategoryFilterChange) onCategoryFilterChange(next)
    else setLocalCategoryFilter(next)
  }

  const filtered = result.physical_layout_errors.filter((e) => {
    if (severityFilter !== 'all' && e.severity !== severityFilter) return false
    if (categoryFilterValue !== 'all' && e.category !== categoryFilterValue) return false
    return true
  })

  return (
    <Card className={cn('border-border bg-card flex flex-col', className)}>
      <CardHeader className="shrink-0 pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              Findings
            </CardTitle>
            <CardDescription>
              {result.physical_layout_errors.length} findings · select to inspect evidence
            </CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-2">
          <Filter className="h-3 w-3 text-muted-foreground" />
          <Select
            value={severityFilter}
            onValueChange={(v) => setSeverityFilter(v as ViolationSeverity | 'all')}
          >
            <SelectTrigger size="sm" className="w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="major">Major only</SelectItem>
              <SelectItem value="minor">Minor only</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={categoryFilterValue}
            onValueChange={handleCategoryChange}
          >
            <SelectTrigger size="sm" className="w-[160px] text-xs">
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
      <CardContent className="min-h-0 flex-1 overflow-hidden p-0">
        <ScrollArea className="scroll-area-audit min-h-[360px] px-1 pb-2 lg:h-full lg:min-h-0">
          {filtered.length === 0 ? (
            <div className="flex h-32 items-center justify-center px-4 text-xs text-muted-foreground">
              No findings match the current filter.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((e) => {
                const selected = selectedId === e.id
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => onSelect?.(e)}
                      aria-pressed={selected}
                      className={cn(
                        'flex w-full items-start gap-3 border-l-[3px] px-3 py-2.5 text-left transition-colors focus-visible:bg-muted',
                        e.severity === 'major' ? 'border-l-destructive' : 'border-l-warning',
                        selected ? 'bg-selected' : 'hover:bg-muted',
                      )}
                    >
                      {e.severity === 'major' ? (
                        <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                      ) : (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {e.title}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className="h-4 px-1.5 text-[11px] leading-none border-border text-muted-foreground font-mono"
                          >
                            ¶{e.position > 0 ? e.position : '?'}
                          </Badge>
                          <Badge
                            variant="outline"
                            className="h-4 px-1.5 text-[11px] leading-none border-border text-muted-foreground"
                          >
                            {CATEGORY_LABELS[e.category]}
                          </Badge>
                          <Badge
                            variant="outline"
                            className={cn(
                              'h-4 px-1.5 text-[11px] leading-none',
                              e.severity === 'major'
                                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                                : 'border-warning/40 bg-warning/10 text-warning',
                            )}
                          >
                            {e.severity === 'major' ? 'Major' : 'Minor'}
                          </Badge>
                        </span>
                        {e.snippet && (
                          <span className="mt-1.5 line-clamp-2 block font-mono text-[11px] leading-[18px] text-muted-foreground">
                            “{e.snippet}”
                          </span>
                        )}
                      </span>
                      {selected ? (
                        <Check className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
