/**
 * Document preview — read-only Evidence-Linked Document Preview (Build 8C.1).
 *
 * Renders structured paragraph blocks (DocumentBlock) returned by
 * GET /api/audit/{id}/document-blocks. Blocks are ordered by `block.order`
 * (a defensive copy — API data is never mutated), findings are mapped by
 * `block.index` (never array position), and headings come from
 * `block.heading_level` (never text prefixes).
 *
 * Findings are highlighted by severity:
 *   - MAJOR → left stripe + red tinted background
 *   - MINOR → left stripe + amber tinted background
 *
 * Blocks that carry findings are semantic buttons; clicking one selects its
 * first related finding. Blocks without findings remain non-interactive.
 * Selecting a finding scrolls the matching block into view, smooth only
 * when the user has not requested reduced motion.
 */
import * as React from 'react'
import { AlertOctagon, AlertTriangle, Check, FileText, Loader2, ScrollText } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { DocumentBlock, Violation } from '../../types/api'

export interface DocumentPreviewProps {
  blocks: DocumentBlock[] | null
  violations: Violation[]
  selectedViolationId: string | null
  isLoading: boolean
  /** True when the blocks endpoint failed — distinct from the historical null state. */
  loadError: boolean
  onSelectViolation: (id: string) => void
}

export function DocumentPreview({
  blocks,
  violations,
  selectedViolationId,
  isLoading,
  loadError,
  onSelectViolation,
}: DocumentPreviewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const blockRefs = React.useRef<Map<number, HTMLElement>>(new Map())

  // Defensive ordering: copy before sorting, never mutate API data.
  const orderedBlocks = React.useMemo(
    () => (blocks === null ? null : [...blocks].sort((a, b) => a.order - b.order)),
    [blocks],
  )

  // Findings keyed by document block index (paragraph_index), not array position.
  const indexedViolations = React.useMemo(() => {
    const map = new Map<number, Violation[]>()
    for (const v of violations) {
      const idx = getParagraphIndex(v)
      if (idx === null) continue
      const existing = map.get(idx) ?? []
      existing.push(v)
      map.set(idx, existing)
    }
    return map
  }, [violations])

  // Count how many findings reference blocks that exist.
  const locatableCount = React.useMemo(
    () => violations.filter((v) => getParagraphIndex(v) !== null && blocks !== null).length,
    [violations, blocks],
  )

  // Scroll into view when selection changes — resolve the block by index.
  React.useEffect(() => {
    if (!selectedViolationId || orderedBlocks === null) return
    const v = violations.find((vi) => vi.id === selectedViolationId)
    if (!v) return
    const idx = getParagraphIndex(v)
    if (idx === null) return
    if (!orderedBlocks.some((b) => b.index === idx)) return

    const el = blockRefs.current.get(idx)
    if (!el || !containerRef.current) return

    // Smooth scroll only when user has not requested reduced motion.
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'center',
    })
  }, [selectedViolationId, violations, orderedBlocks])

  if (isLoading) {
    return <PreviewSkeleton />
  }

  if (loadError) {
    return <PreviewLoadError />
  }

  if (blocks === null) {
    return <PreviewUnavailable />
  }

  if (blocks.length === 0) {
    return <PreviewEmpty />
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <h2 className="text-component-title text-foreground flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-primary" aria-hidden="true" />
          Document preview
        </h2>
        {locatableCount > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {locatableCount} finding{locatableCount > 1 ? 's' : ''} located in document
          </span>
        )}
      </header>

      <div
        ref={containerRef}
        role="region"
        aria-label="Document preview"
        className="relative overflow-y-auto rounded-md border border-border bg-card p-1 scrollbar-thin"
        style={{ maxHeight: '480px' }}
      >
        {orderedBlocks!.map((block) => {
          const viols = indexedViolations.get(block.index)
          const hasMajor = viols?.some((v) => v.severity === 'MAJOR')
          const hasMinor = viols?.some((v) => v.severity === 'MINOR')
          const isSelected = viols?.some((v) => v.id === selectedViolationId) ?? false
          const interactive = (viols?.length ?? 0) > 0

          const content = (
            <>
              {/* Metadata row — paragraph label left, finding status right.
                  Sits above the content with 8px clearance (mb-2). */}
              <div className="mb-2 flex w-full items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">
                  Paragraph {block.index + 1}
                </span>
                {viols && viols.length > 0 && (
                  <span className="flex flex-wrap items-center justify-end gap-1.5">
                    {hasMajor && <SeverityChip label="Major" major />}
                    {hasMinor && <SeverityChip label="Minor" major={false} />}
                    <span className="text-[11px] text-muted-foreground">
                      {viols.length} finding{viols.length > 1 ? 's' : ''}
                    </span>
                    {isSelected && (
                      <span className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                        <Check className="h-3 w-3" aria-hidden="true" />
                        Selected
                      </span>
                    )}
                  </span>
                )}
              </div>
              <BlockContent block={block} interactive={interactive} />
            </>
          )

          const blockClass = cn(
            // 16px horizontal / 12px vertical padding; restrained radius.
            'relative rounded-md px-4 py-3 transition-colors',
            // Finding blocks: 3px severity stripe + single semantic background.
            hasMajor && 'border-l-[3px] border-l-destructive bg-error/5',
            !hasMajor && hasMinor && 'border-l-[3px] border-l-warning bg-warning/5',
            !hasMajor && !hasMinor && 'border-l-[3px] border-l-transparent',
            // Selected: clear outline without a heavy double-border look.
            isSelected && 'ring-2 ring-primary',
            interactive && 'w-full text-left',
            'mb-3 last:mb-0',
          )

          // Blocks with findings are semantic buttons; others stay non-interactive.
          if (interactive) {
            return (
              <button
                key={block.index}
                type="button"
                ref={(el) => {
                  if (el) blockRefs.current.set(block.index, el)
                  else blockRefs.current.delete(block.index)
                }}
                data-block-index={block.index}
                onClick={() => onSelectViolation(viols![0].id)}
                aria-pressed={isSelected}
                className={cn(
                  blockClass,
                  'flex flex-col items-start',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card',
                )}
              >
                {content}
              </button>
            )
          }

          return (
            <div
              key={block.index}
              ref={(el) => {
                if (el) blockRefs.current.set(block.index, el)
                else blockRefs.current.delete(block.index)
              }}
              data-block-index={block.index}
              className={blockClass}
            >
              {content}
            </div>
          )
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        This preview shows extracted document content for finding location. Layout may differ from
        Microsoft Word.
      </p>
      <p className="text-[11px] text-muted-foreground">
        To reopen document previews from audit history, extracted document text is stored in the
        local audit database. The original Word file is not stored or modified.
      </p>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------- */

function getParagraphIndex(v: Violation): number | null {
  const loc = v.location as Record<string, unknown> | null
  const n = loc?.paragraph_index
  return typeof n === 'number' && n >= 0 ? n : null
}

/**
 * Renders block text. Valid document heading levels (1–6) use a labelled
 * heading role at the document's own level: aria-level preserves the
 * document hierarchy without leaking document headings into the route
 * heading outline (the page's h1 is the filename, its h2s are the page
 * sections). Interactive blocks use a span — heading elements are not valid
 * inside a <button>. Invalid or null heading levels render as plain
 * paragraphs. Headings are never inferred from text prefixes.
 */
function BlockContent({ block, interactive }: { block: DocumentBlock; interactive: boolean }) {
  const level = block.heading_level
  const isHeading = typeof level === 'number' && level >= 1 && level <= 6

  if (!isHeading) {
    return interactive ? (
      <span className="font-serif text-sm leading-[21px] text-foreground whitespace-pre-wrap break-words">
        {block.text}
      </span>
    ) : (
      <p className="font-serif text-sm leading-[21px] text-foreground whitespace-pre-wrap break-words">
        {block.text}
      </p>
    )
  }

  const headingProps = {
    role: 'heading',
    'aria-level': level,
    className: headingClass(level),
  } as const
  return interactive ? (
    <span {...headingProps}>{block.text}</span>
  ) : (
    <div {...headingProps}>{block.text}</div>
  )
}

function headingClass(level: number): string {
  const sizes: Record<number, string> = {
    1: 'text-lg',
    2: 'text-base',
    3: 'text-sm',
  }
  return cn('block font-semibold text-foreground', sizes[level] ?? 'text-sm')
}

function SeverityChip({ label, major }: { label: string; major: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium',
        major
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-warning/30 bg-warning/10 text-warning',
      )}
    >
      {major ? (
        <AlertOctagon className="h-3 w-3" aria-hidden="true" />
      ) : (
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      )}
      {label}
    </span>
  )
}

function PreviewSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">Loading document preview…</span>
      </div>
      <div className="space-y-2 rounded-md border border-border bg-card p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
            <div className="h-3 w-full rounded bg-muted animate-pulse" />
            <div className="h-3 w-5/6 rounded bg-muted animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}

function PreviewHeader() {
  return (
    <h2 className="text-component-title text-foreground flex items-center gap-2">
      <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      Document preview
    </h2>
  )
}

function PreviewUnavailable() {
  return (
    <div className="space-y-3">
      <PreviewHeader />
      <div className="rounded-md border border-dashed border-border bg-card px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          Preview unavailable — this audit predates document preview support.
        </p>
      </div>
    </div>
  )
}

function PreviewLoadError() {
  return (
    <div className="space-y-3">
      <PreviewHeader />
      <div className="rounded-md border border-dashed border-border bg-card px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          Document preview could not be loaded. The audit findings remain available.
        </p>
      </div>
    </div>
  )
}

function PreviewEmpty() {
  return (
    <div className="space-y-3">
      <PreviewHeader />
      <div className="rounded-md border border-dashed border-border bg-card px-4 py-6 text-center">
        <p className="text-sm text-muted-foreground">
          No paragraph blocks were extracted from this document.
        </p>
      </div>
    </div>
  )
}
