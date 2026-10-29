/**
 * Findings list — master pane of the Audit Workspace master-detail layout.
 * Filters are controlled by AuditPage across its responsive workspace panes.
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
  Info,
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
import { CATEGORY_LABELS, severityBadge } from '../../lib/audit/categories'
import type { AuditResponse } from '../../types/api'
import type {
  AuditCategory,
  AuditResult,
  LayoutError,
  ViolationSeverity,
} from '../../types/audit'

/**
 * Severity filter options, built from `severityBadge` so the filter and the
 * badge can never drift apart. Labels are the bare badge labels — "All
 * severities", "Major", "Minor", "Manual review", "Unclassified" — because
 * the control itself is already labelled "Filter by severity".
 */
const SEVERITY_FILTER_OPTIONS: ReadonlyArray<{ value: ViolationSeverity; label: string }> = (
  ['major', 'minor', 'review', 'unknown'] as const
).map((sev) => ({ value: sev, label: severityBadge(sev).label }))

export function matchesFindingFilters(finding: LayoutError, severity: ViolationSeverity | 'all', category: AuditCategory | 'all') {
  return (severity === 'all' || finding.severity === severity) && (category === 'all' || finding.category === category)
}

export function ErrorList({
  result,
  selectedId,
  onSelect,
  className,
  categoryFilter,
  onCategoryFilterChange,
  severityFilter,
  onSeverityFilterChange,
  auditStatus,
  locationLabels,
  locatingId,
}: {
  result: Pick<AuditResult, 'physical_layout_errors'>
  selectedId?: string | null
  onSelect?: (e: LayoutError) => void
  className?: string
  /** Controlled category filter — shared with the category overview. */
  categoryFilter: AuditCategory | 'all'
  onCategoryFilterChange: (category: AuditCategory | 'all') => void
  severityFilter: ViolationSeverity | 'all'
  onSeverityFilterChange: (severity: ViolationSeverity | 'all') => void
  auditStatus: AuditResponse['status']
  /** User-facing location labels per finding id (Page N · Paragraph M). */
  locationLabels?: ReadonlyMap<string, string> | null
  /** Finding currently being located by the page mapper. */
  locatingId?: string | null
}) {
  const categoryFilterValue = categoryFilter
  const handleCategoryChange = (value: string) => onCategoryFilterChange(value as AuditCategory | 'all')
  const filtered = result.physical_layout_errors.filter((e) => matchesFindingFilters(e, severityFilter, categoryFilter))

  const scrollRef = React.useRef<HTMLDivElement>(null)
  const severityControlRef = React.useRef<HTMLButtonElement>(null)
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

  const totalFindings = result.physical_layout_errors.length
  const hiddenCount = totalFindings - filtered.length
  const findingNoun = (count: number) => count === 1 ? 'finding' : 'findings'
  const filtersActive = severityFilter !== 'all' || categoryFilterValue !== 'all'

  // Filtered-empty: the audit HAS findings, the filters just hide them all.
  // The count is truthful and the reset restores both controls to "All" —
  // it never reruns the audit and never alters the findings or the score.
  const resetFilters = () => {
    severityControlRef.current?.focus()
    onSeverityFilterChange('all')
    handleCategoryChange('all')
  }

  const statusLine =
    filtered.length > 0
      ? visibleRange
        ? `Showing ${visibleRange.first}–${visibleRange.last} of ${filtered.length} ${findingNoun(filtered.length)}`
        : `${filtered.length} ${findingNoun(filtered.length)} · Scroll to review all`
      : totalFindings > 0
        ? `Showing 0 of ${totalFindings} ${findingNoun(totalFindings)}`
        : null

  return (
    // Bounded flex column: h-full + min-h-0 + overflow-hidden. Without the
    // full chain the list region takes content height and gets clipped by
    // the pane instead of scrolling (regression: "list cannot scroll").
    <Card className={cn('border-border bg-card flex h-full min-h-0 flex-col overflow-hidden', className)}>
      <CardHeader className="shrink-0 pb-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <h2 className="flex items-center gap-2"><MapPin className="h-4 w-4 text-primary" aria-hidden="true" />Findings</h2>
            </CardTitle>
            <CardDescription>
              {totalFindings} {findingNoun(totalFindings)} · select to inspect evidence
            </CardDescription>
          </div>
        </div>
        {/* Severity and category controls. At a comfortable width they share
            one row; when the Findings panel gets narrow each control takes a
            full row of its own (flex-wrap + min-w) so nothing clips, no
            chevron overlaps, and the category dropdown stays fully visible.
            The filter icon stays a separate, aligned leading glyph. */}
        <div className="flex flex-wrap items-center gap-2 pt-1.5">
          <Filter className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Select
            value={severityFilter}
            onValueChange={(v) => onSeverityFilterChange(v as ViolationSeverity | 'all')}
          >
            <SelectTrigger
              ref={severityControlRef}
              size="sm"
              className="min-w-0 flex-1 basis-[8.5rem] text-xs focus-visible:ring-primary"
              aria-label="Filter by severity"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              {SEVERITY_FILTER_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={categoryFilterValue}
            onValueChange={handleCategoryChange}
          >
            <SelectTrigger
              size="sm"
              className="min-w-0 flex-1 basis-[10rem] text-xs focus-visible:ring-primary"
              aria-label="Filter by category"
            >
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
        {filtersActive && (
          <button type="button" onClick={resetFilters} className="self-start rounded text-xs font-medium text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            Clear filters
          </button>
        )}
        {statusLine && (
          <p className="pt-1 text-xs text-muted-foreground" aria-live="polite">
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
            totalFindings === 0 ? (
              // The audit genuinely found nothing — distinct wording, no
              // reset control, no hidden count.
              <div className="flex h-32 items-center justify-center px-4 text-center text-xs text-muted-foreground">
                {auditStatus === 'processing' ? 'Findings will appear as checks finish'
                  : auditStatus !== 'completed' ? 'No findings available from this incomplete audit'
                  : 'No compliance findings were detected.'}
              </div>
            ) : (
              <div className="flex h-32 flex-col items-center justify-center gap-1 px-4 text-center">
                <p className="text-xs text-muted-foreground">
                  {severityFilter !== 'all' && categoryFilterValue === 'all'
                    ? `No ${severityBadge(severityFilter).label} findings`
                    : 'No findings match these filters'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {severityFilter !== 'all' && categoryFilterValue === 'all'
                    ? `${hiddenCount} other ${findingNoun(hiddenCount)} ${hiddenCount === 1 ? 'is' : 'are'} hidden by the current filters.`
                    : `${hiddenCount} ${findingNoun(hiddenCount)} ${hiddenCount === 1 ? 'is' : 'are'} hidden.`}
                </p>
                {filtersActive && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="mt-1 rounded text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    {severityFilter !== 'all' && categoryFilterValue === 'all'
                      ? 'Show all findings'
                      : 'Reset filters'}
                  </button>
                )}
              </div>
            )
          ) : (
            <ul className="divide-y divide-border px-2 pb-4 pt-2">
              {filtered.map((e, index) => {
                const selected = selectedId === e.id
                const badge = severityBadge(e.severity)
                const location = locatingId === e.id ? 'Locating finding…' : locationLabels?.get(e.id)
                const occurrences = e.occurrences
                const comparison = e.comparison
                const evidence = e.evidencePreview || e.detail
                // The badges are decoration for a screen reader; the row's
                // accessible name is spelled out here so deleting the ¶ and
                // category badges never shrinks it.
                const accessibleName = [e.title, badge.label, location].filter(Boolean).join(', ')
                return (
                  <li key={e.id} data-index={index}>
                    <button
                      type="button"
                      onClick={() => onSelect?.(e)}
                      aria-pressed={selected}
                      aria-label={accessibleName}
                      className={cn(
                        'flex w-full items-start gap-2.5 border-l-2 px-3 py-2 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                        selected
                          ? 'border-l-finding-selected-indicator bg-finding-selected-bg text-finding-selected-title ring-1 ring-finding-selected-border'
                          : 'border-l-transparent hover:bg-muted/40',
                      )}
                    >
                      {/* Severity marker — contained within the row, never a
                          continuous line across rows. Always the measured
                          3:1 indicator token for this severity. */}
                      <span
                        aria-hidden="true"
                        className={cn('mt-1.5 h-7 w-1 shrink-0 rounded-full', badge.indicatorClassName)}
                      />
                      {e.severity === 'major' ? (
                        <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-severity-major-indicator" aria-hidden="true" />
                      ) : e.severity === 'minor' ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-severity-minor-indicator" aria-hidden="true" />
                      ) : (
                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-severity-review-indicator" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {e.title}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className={cn('h-4 px-1.5 text-[11px] leading-none', badge.className)}
                            title={e.severity === 'unknown' ? 'Severity not recognised — not scored' : undefined}
                          >
                            {badge.label}
                          </Badge>
                          {location && (
                            <span className="text-[11px] leading-none text-ink-muted">
                              {location}
                            </span>
                          )}
                          {occurrences && (
                            <span className="text-[11px] leading-none text-ink-muted">
                              {occurrences}
                            </span>
                          )}
                        </span>
                        {comparison && (
                          <span className="mt-1 block truncate text-[12px] leading-4 text-foreground">
                            {comparison}
                          </span>
                        )}
                        {!comparison && evidence && (
                          <span
                            className="mt-1 block truncate text-[11px] leading-4 text-ink-muted"
                            title={evidence}
                          >
                            {evidence}
                          </span>
                        )}
                      </span>
                      {selected ? (
                        <Check className="mt-1 h-4 w-4 shrink-0 text-finding-selected-indicator" aria-hidden="true" />
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
