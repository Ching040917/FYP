/**
 * Findings list — master pane of the Audit Workspace master-detail layout.
 * Shared with Dashboard (Build 4 owns the Dashboard-specific restyle).
 *
 * Findings are structured ruled rows, not elevated cards: 1px rules,
 * restrained radii, no shadows. Every row is a real <button> (Tab +
 * Enter/Space), has a visible focus treatment, and marks selection with an
 * explicit check indicator + aria-pressed — never color alone.
 *
 * Scroll presentation (scroll-boundary build):
 *  - the title, count, filters, and status line stay fixed above the list;
 *  - ONLY the finding rows scroll (native container, one restrained 6px
 *    scrollbar, horizontal overflow hidden so no orientation/overflow
 *    scrollbar can appear);
 *  - a subtle top shadow appears when content is above, a bottom fade when
 *    content is below — each hidden at its own boundary;
 *  - the list has comfortable top/bottom padding so rows never touch the
 *    container edges;
 *  - severity is a short rounded marker inside each row — no continuous
 *    stripe that could read as connecting unrelated rows.
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

  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [canScrollUp, setCanScrollUp] = React.useState(false)
  const [canScrollDown, setCanScrollDown] = React.useState(false)
  // Reliable visible range only — set by IntersectionObserver over rows.
  const [visibleRange, setVisibleRange] = React.useState<{ first: number; last: number } | null>(null)

  const updateBoundaries = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollUp(el.scrollTop > 4)
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 4)
  }, [])

  // Recompute boundary flags when the list changes size/height.
  React.useEffect(() => {
    updateBoundaries()
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(updateBoundaries)
    ro.observe(el)
    return () => ro.disconnect()
  }, [filtered.length, updateBoundaries])

  // Track which rows are actually visible (reliable range or nothing).
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .map((e) => Number((e.target as HTMLElement).dataset.index))
          .sort((a, b) => a - b)
        if (visible.length > 0) {
          setVisibleRange({ first: visible[0] + 1, last: visible[visible.length - 1] + 1 })
        } else {
          setVisibleRange(null)
        }
      },
      { root: el, threshold: 0 },
    )
    for (const row of el.querySelectorAll<HTMLElement>('[data-index]')) io.observe(row)
    return () => io.disconnect()
  }, [filtered])

  const statusLine =
    filtered.length > 0
      ? visibleRange
        ? `Showing ${visibleRange.first}–${visibleRange.last} of ${filtered.length} findings`
        : `${filtered.length} findings · Scroll to review all`
      : null

  return (
    // Bounded flex column: h-full + min-h-0 + overflow-hidden. Without the
    // full chain the list region takes content height and gets clipped by
    // the pane instead of scrolling (regression: "list cannot scroll").
    <Card className={cn('border-border bg-card flex h-full min-h-0 flex-col overflow-hidden', className)}>
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
        {statusLine && (
          <p className="pt-2 text-xs text-muted-foreground" aria-live="polite">
            {statusLine}
          </p>
        )}
      </CardHeader>

      {/* flex flex-col is the missing link in the height chain: without it
          the scroll container's flex-1 below resolves to nothing and the
          list grows to content height instead of the bounded pane height. */}
      <CardContent className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        {/* Scroll-boundary indicators — hidden at their own boundary. */}
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-10 h-4 rounded-t-md bg-gradient-to-b from-black/10 to-transparent transition-opacity motion-reduce:transition-none',
            canScrollUp ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-card to-transparent transition-opacity motion-reduce:transition-none',
            canScrollDown ? 'opacity-100' : 'opacity-0',
          )}
        />

        {/* Only rows scroll — one restrained vertical scrollbar, no horizontal. */}
        <div
          ref={scrollRef}
          onScroll={updateBoundaries}
          className="scrollbar-thin min-h-[360px] overflow-y-auto overflow-x-hidden lg:min-h-0 lg:flex-1"
        >
          {filtered.length === 0 ? (
            <div className="flex h-32 items-center justify-center px-4 text-xs text-muted-foreground">
              No findings match the current filter.
            </div>
          ) : (
            <ul className="divide-y divide-border px-2 pb-6 pt-4">
              {filtered.map((e, index) => {
                const selected = selectedId === e.id
                return (
                  <li key={e.id} data-index={index}>
                    <button
                      type="button"
                      onClick={() => onSelect?.(e)}
                      aria-pressed={selected}
                      className={cn(
                        'flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50',
                        selected ? 'bg-selected' : 'hover:bg-muted',
                      )}
                    >
                      {/* Severity marker — contained within the row, never a
                          continuous line across rows. */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'mt-1.5 h-7 w-1 shrink-0 rounded-full',
                          e.severity === 'major' ? 'bg-destructive' : 'bg-warning',
                        )}
                      />
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
                          <span className="mt-1.5 line-clamp-2 block break-words font-mono text-[11px] leading-[18px] text-muted-foreground">
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
        </div>
      </CardContent>
    </Card>
  )
}
