/**
 * RenderedPreview — read-only PDF.js document viewer (Build 4, MVP).
 *
 * Renders one page at a time onto a canvas. The PDF bytes and load state
 * come from the PARENT (useRenderedPdf in AuditPage) so the viewer and the
 * finding-to-page mapper share the exact same response bytes and the same
 * pdfjs configuration — no duplicate fetches, no lifecycle races.
 *
 * States (from the parent) reported as fallback panels here:
 *   loading | available | historical | unavailable | corrupt | missing | error
 *
 * Resource discipline: the loading task, render tasks, and document are
 * released on unmount/replacement; obsolete renders are cancelled and a
 * sequence counter prevents stale canvases after rapid zoom/page changes.
 */
import * as React from 'react'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileQuestion,
  Info,
  Loader2,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { getPdfjs } from '../../lib/pdf/pdf-text-extract.ts'
import type { RenderedPdfState } from '../../hooks/use-rendered-pdf.ts'
import { cn } from '../../lib/utils'
import { PageCommandConsumer } from '../../lib/pdf/pending-navigation.ts'
import { evidenceBarOffsetPx, evidenceBarHeight, EVIDENCE_BAR_METRICS } from '../../lib/pdf/formatting-highlight.ts'

interface RenderedPreviewProps {
  /** PDF load state + bytes from the parent (shared with mapping). */
  pdf: RenderedPdfState | null
  /** Fill the parent region instead of a fixed max height (desktop split). */
  fitRegion?: boolean
  /**
   * Imperative page navigation from finding selection. `seq` must change
   * per request so repeated requests to the same page still apply.
   */
  pendingPage?: { page: number; seq: number } | null
  /** Exact citation highlight rects (normalized 0..1, one per visual line). */
  citationRects?: Array<{ page: number; x: number; y: number; width: number; height: number }> | null
  /** Accessible label for the highlight (citation evidence text). */
  citationLabel?: string | null
  /** Truthful message when exact highlighting failed (page still shown). */
  highlightMessage?: string | null
  /** Formatting evidence (Build 7): kind + per-page normalized rects. */
  formattingEvidence?: {
    kind: 'run' | 'paragraph'
    pageRects: Array<{ page: number; x: number; y: number; width: number; height: number }>
  } | null
  formattingLabel?: string | null
  formattingMessage?: string | null
  /** Table/Figure object navigation status (compact chip only). */
  objectStatus?: { label: string | null; message: string | null } | null
  /** Exact Figure outline (Build 8F): one normalized rect + compact label. */
  figureOutline?: {
    rect: { page: number; x: number; y: number; width: number; height: number }
    label: string
  } | null
  /** Truthful message when the exact Figure boundary is unavailable. */
  figureMessage?: string | null
  /** Margin section navigation status (compact chip only). */
  marginStatus?: { label: string | null; message: string | null } | null
  /** Margin page-edge marker (Build: Margin markers): side + section range. */
  marginMarker?: {
    side: 'left' | 'right' | 'top' | 'bottom'
    startPage: number
    endPage: number
    sectionNumber: number
  } | null
  /** Compact margin marker chip label (`Right margin · Section 1 · Pages 1–3`). */
  marginChipLabel?: string | null
}

const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP_IN = 1.25
const ZOOM_STEP_OUT = 0.8
const FALLBACK_MESSAGES: Record<Exclude<RenderedPdfState['status'], 'loading' | 'available' | 'idle'>, string> = {
  historical: 'Rendered preview is unavailable for this older audit.',
  unavailable: 'The page-rendered preview could not be created. The extracted-text preview remains available.',
  corrupt: 'The rendered preview is no longer available. The extracted-text preview remains available.',
  missing: 'The rendered preview is no longer available. The extracted-text preview remains available.',
  error: 'The rendered preview could not be loaded. The extracted-text preview remains available.',
}

export function RenderedPreview({
  pdf,
  fitRegion = false,
  pendingPage = null,
  citationRects = null,
  citationLabel = null,
  highlightMessage = null,
  formattingEvidence = null,
  formattingLabel = null,
  formattingMessage = null,
  objectStatus = null,
  figureOutline = null,
  figureMessage = null,
  marginStatus = null,
  marginMarker = null,
  marginChipLabel = null,
}: RenderedPreviewProps) {
  const [pdfDoc, setPdfDoc] = React.useState<PDFDocumentProxy | null>(null)
  const [docLoading, setDocLoading] = React.useState(false)
  const [pageNum, setPageNum] = React.useState(1)
  const [numPages, setNumPages] = React.useState(0)
  // null = fit-to-width (recomputed from the container on demand)
  const [scale, setScale] = React.useState<number | null>(null)
  const [appliedScale, setAppliedScale] = React.useState<number | null>(null)
  const [renderFailed, setRenderFailed] = React.useState(false)
  const [fitTick, setFitTick] = React.useState(0)
  const [navAnnounce, setNavAnnounce] = React.useState<string | null>(null)

  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const loadingTaskRef = React.useRef<PDFDocumentLoadingTask | null>(null)
  const renderTaskRef = React.useRef<RenderTask | null>(null)
  const renderSeqRef = React.useRef(0)
  const fitWidthRef = React.useRef(0)
  // One-shot finding navigation: consumed commands never replay.
  const navConsumerRef = React.useRef(new PageCommandConsumer())

  const available = pdf?.status === 'available' && pdf.bytes !== undefined
  const status = pdf?.status ?? 'idle'

  // ---- Load the document from the shared bytes ----
  React.useEffect(() => {
    let cancelled = false
    const bytes = pdf?.status === 'available' ? pdf.bytes : undefined
    if (!bytes) {
      setPdfDoc(null)
      setNumPages(0)
      setPageNum(1)
      return
    }
    // PDF replaced: forget any consumed navigation command.
    navConsumerRef.current.reset()
    setDocLoading(true)
    setPdfDoc(null)
    setNumPages(0)
    setPageNum(1)
    setScale(null)
    setAppliedScale(null)
    setRenderFailed(false)

    const load = async () => {
      try {
        const pdfjs = await getPdfjs()
        // Never hand the shared cached buffer to pdf.js: it may transfer
        // (detach) it, breaking every other consumer. Make a fresh owned
        // copy; if the source is already detached/zero-length, fail quietly
        // (the parent reports 'corrupt'/'unavailable' — viewing stays intact).
        let owned: Uint8Array
        try {
          owned = new Uint8Array(bytes.slice(0))
        } catch {
          setPdfDoc(null)
          return
        }
        if (owned.byteLength === 0) {
          setPdfDoc(null)
          return
        }
        const task = pdfjs.getDocument({ data: owned })
        loadingTaskRef.current = task
        const doc = await task.promise
        if (cancelled) {
          doc.destroy()
          return
        }
        setPdfDoc(doc)
        setNumPages(doc.numPages)
      } catch {
        // Parent reports 'corrupt' when extraction fails too; stay quiet here.
      } finally {
        if (!cancelled) setDocLoading(false)
      }
    }
    void load()

    return () => {
      cancelled = true
      try {
        renderTaskRef.current?.cancel()
      } catch {
        /* already settled */
      }
      renderTaskRef.current = null
      try {
        loadingTaskRef.current?.destroy()
      } catch {
        /* already destroyed */
      }
      loadingTaskRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf?.status === 'available' ? pdf?.bytes : undefined])

  // ---- Fit-width on container resize (only while in fit mode) ----
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (scale === null) setFitTick((t) => t + 1)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [scale])

  // ---- Render the current page ----
  React.useEffect(() => {
    if (!pdfDoc) return
    let cancelled = false
    const seq = ++renderSeqRef.current

    const render = async () => {
      let page: PDFPageProxy
      try {
        page = await pdfDoc.getPage(pageNum)
      } catch {
        if (!cancelled) setRenderFailed(true)
        return
      }
      if (cancelled || seq !== renderSeqRef.current) return
      const canvas = canvasRef.current
      const container = containerRef.current
      if (!canvas || !container) return

      const base = page.getViewport({ scale: 1 })
      let s = scale
      if (s === null) {
        const width = container.clientWidth - 32 // padding
        if (width > 0) {
          if (width !== fitWidthRef.current) fitWidthRef.current = width
          s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, width / base.width))
        } else {
          s = 1
        }
      }
      const viewport = page.getViewport({ scale: s })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)

      // Cancel any obsolete render before starting a fresh one.
      try {
        renderTaskRef.current?.cancel()
      } catch {
        /* already settled */
      }
      const task = page.render({ canvas, viewport })
      renderTaskRef.current = task
      try {
        await task.promise
      } catch (err: any) {
        if (err?.name === 'RenderingCancelledException') return
        if (!cancelled) setRenderFailed(true)
        return
      }
      if (cancelled || seq !== renderSeqRef.current) return
      setRenderFailed(false)
      setAppliedScale(s)
    }
    void render()

    return () => {
      cancelled = true
    }
  }, [pdfDoc, pageNum, scale, fitTick])

  const zoomIn = () => setScale((cur) => Math.min(ZOOM_MAX, (cur ?? 1) * ZOOM_STEP_IN))
  const zoomOut = () => setScale((cur) => Math.max(ZOOM_MIN, (cur ?? 1) * ZOOM_STEP_OUT))
  const fitWidth = () => {
    fitWidthRef.current = 0
    setScale(null)
    setFitTick((t) => t + 1)
  }
  const nextPage = () => setPageNum((p) => Math.min(numPages, p + 1))
  const prevPage = () => setPageNum((p) => Math.max(1, p - 1))

  // Finding-to-page navigation: apply the command ONCE (seq-identified),
  // then manual controls own the page. Scroll only inside this pane,
  // announce through aria-live, respect reduced motion.
  React.useEffect(() => {
    if (!pdfDoc) return
    const target = navConsumerRef.current.consume(pendingPage, numPages)
    if (target === null || target === pageNum) return
    setPageNum(target)
    setNavAnnounce(`Navigated to page ${target} of ${numPages}`)
    const el = containerRef.current
    if (el) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
    }
  }, [pendingPage, pdfDoc, numPages, pageNum])

  // ---- Non-available states: fallback panel only ----
  if (!available) {
    const isIdle = status === 'idle'
    const message =
      pdf?.detail && !isIdle
        ? pdf.detail
        : FALLBACK_MESSAGES[status as Exclude<RenderedPdfState['status'], 'loading' | 'available' | 'idle'>]
    return (
      <div className="space-y-3" role="region" aria-label="Rendered document preview">
        {isIdle || status === 'loading' || docLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Loading rendered preview…
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-md border border-dashed border-border bg-card px-4 py-4">
            <FileQuestion className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm leading-[21px] text-muted-foreground">{message}</p>
          </div>
        )}
      </div>
    )
  }

  // ---- Available: toolbar + canvas ----
  const zoomLabel = appliedScale === null ? 'Fit width' : `${Math.round(appliedScale * 100)}%`
  return (
    <div className={cn('flex flex-col gap-2', fitRegion && 'h-full min-h-0')}>
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <ToolButton label="Previous page" disabled={pageNum <= 1} onClick={prevPage}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Next page" disabled={pageNum >= numPages} onClick={nextPage}>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </ToolButton>
          <p className="ml-1 text-[13px] tabular-nums text-muted-foreground">
            Page <span className="font-medium text-foreground">{pageNum}</span> of {numPages}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <ToolButton label="Zoom out" onClick={zoomOut}>
            <ZoomOut className="h-4 w-4" aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Zoom in" onClick={zoomIn}>
            <ZoomIn className="h-4 w-4" aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Fit to width" onClick={fitWidth}>
            <Maximize2 className="h-4 w-4" aria-hidden="true" />
          </ToolButton>
          <p className="ml-1 w-16 text-right text-[13px] tabular-nums text-muted-foreground">{zoomLabel}</p>
        </div>
      </div>

      {/* Compact selected-evidence chip — neutral surface, subtle border,
          icon + text (non-color indicator); ~30px tall, fits 375px. */}
      {citationRects && citationRects.length > 0 && citationLabel && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          Selected evidence
          <span className="font-medium text-destructive">: {citationLabel}</span>
        </span>
      )}
      {highlightMessage && (!citationRects || citationRects.length === 0) && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {highlightMessage}
        </span>
      )}

      {/* Compact formatting-evidence chip (Build 7) — neutral, amber accent. */}
      {formattingEvidence && formattingLabel && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          Selected evidence
          <span className="font-medium text-warning">: {formattingLabel}</span>
        </span>
      )}
      {formattingMessage && !formattingEvidence && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {formattingMessage}
        </span>
      )}

      {/* Compact Table/Figure object status (Build: object navigation). */}
      {objectStatus && objectStatus.label && !objectStatus.message && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          Selected object
          <span className="font-medium text-warning">: {objectStatus.label}</span>
        </span>
      )}
      {objectStatus && objectStatus.message && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {objectStatus.label ? `${objectStatus.label} · ` : ''}{objectStatus.message}
        </span>
      )}

      {/* Exact Figure outline chip (Build 8F) — compact amber evidence. */}
      {figureOutline && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          Selected figure
          <span className="font-medium text-warning">: {figureOutline.label}</span>
        </span>
      )}
      {figureMessage && !figureOutline && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {figureMessage}
        </span>
      )}

      {/* Margin section navigation chip (Build: Section page-range navigation). */}
      {marginChipLabel && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          Selected margin
          <span className="font-medium text-warning">: {marginChipLabel}</span>
        </span>
      )}
      {marginStatus && marginStatus.label && !marginChipLabel && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          Selected margin
          <span className="font-medium text-warning">: {marginStatus.label}</span>
        </span>
      )}
      {marginStatus && marginStatus.message && (
        <span className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] leading-[16px] text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {marginStatus.label ? `${marginStatus.label} · ` : ''}{marginStatus.message}
        </span>
      )}

      {/* Screen-reader status for page/zoom changes */}
      <p aria-live="polite" className="sr-only">
        Page {pageNum} of {numPages}, {zoomLabel}
      </p>
      {navAnnounce && (
        <p aria-live="polite" className="sr-only">
          {navAnnounce}
        </p>
      )}

      {/* Bounded internal scrolling; no page-level horizontal overflow */}
      <div
        ref={containerRef}
        className={cn(
          'overflow-auto rounded-md border border-border bg-input/30 p-4 scrollbar-thin',
          fitRegion ? 'min-h-0 flex-1' : 'max-h-[560px]',
        )}
      >
        <div className="flex min-h-full items-start justify-center">
          {/* Canvas wrapper: the overlay uses % of this box, so zoom,
              fit-width, and resize keep the highlight aligned. */}
          <div className="relative inline-block">
            <canvas
              ref={canvasRef}
              className="bg-white shadow-tonal-high"
              aria-label={`Document page ${pageNum}`}
            />
            {citationRects?.map((rect, i) =>
              rect.page === pageNum ? (
                <div
                  key={i}
                  aria-hidden="true"
                  className="pointer-events-none absolute"
                  style={{
                    left: `${rect.x * 100}%`,
                    top: `${(1 - rect.y - rect.height) * 100}%`,
                    width: `${rect.width * 100}%`,
                    height: `${rect.height * 100}%`,
                  }}
                >
                  {/* Very pale rose fill — no outline, no strikethrough. */}
                  <div className="absolute inset-0 rounded-[3px] bg-destructive/10" />
                  {/* 2px dark-red underline, ~2px BELOW the text box —
                      clears the glyph baseline and descenders. */}
                  <div
                    className="absolute bg-destructive"
                    style={{ top: 'calc(100% + 2px)', left: 0, right: 0, height: '2px', borderRadius: 1 }}
                  />
                </div>
              ) : null,
            )}
            {formattingEvidence?.pageRects.map((rect, i) => (
              <FormattingOverlayRect
                key={`fmt-${i}`}
                kind={formattingEvidence.kind}
                rect={rect}
                pageNum={pageNum}
                pageWidthPx={canvasRef.current?.width ?? 0}
              />
            ))}
            {figureOutline && figureOutline.rect.page === pageNum && (
              <FigureOutlineOverlay rect={figureOutline.rect} label={figureOutline.label} />
            )}
            {marginMarker && pageNum >= marginMarker.startPage && pageNum <= marginMarker.endPage && (
              <MarginEdgeMarker side={marginMarker.side} sectionNumber={marginMarker.sectionNumber} />
            )}
          </div>
        </div>
        {renderFailed && (
          <p className="mt-3 flex items-start gap-2 text-[13px] leading-[19px] text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
            This page could not be rendered. Try zooming or changing pages.
          </p>
        )}
      </div>

      <p className="text-[11px] leading-[16px] text-muted-foreground">
        This preview is a locally generated PDF copy of the uploaded document. The original Word file is
        not stored or modified.
      </p>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------- */

function ToolButton({
  label,
  children,
  onClick,
  disabled = false,
}: {
  label: string
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card',
        'disabled:pointer-events-none disabled:opacity-40',
      )}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  )
}

/* ---------------------------------------------------------------------------
 * Shared formatting evidence overlay (exact-run AND paragraph-level).
 * One component for both branches: pale amber background aligned with the
 * exact text rectangle, plus ONE left evidence bar rendered as a SIBLING
 * (no negative-position clipping) with a fixed pixel gap from the first
 * glyph. Near the page's left edge the gap clamps so the bar stays inside
 * the page. Everything above the canvas, below interactive controls,
 * pointer-events: none.
 * --------------------------------------------------------------------------- */

function FormattingOverlayRect({
  kind,
  rect,
  pageNum,
  pageWidthPx,
}: {
  kind: 'run' | 'paragraph'
  rect: { page: number; x: number; y: number; width: number; height: number }
  pageNum: number
  pageWidthPx: number
}) {
  if (rect.page !== pageNum) return null
  const barLeftPx = evidenceBarOffsetPx(rect.x, pageWidthPx)
  const topPct = (1 - rect.y - rect.height) * 100
  const heightPct = rect.height * 100
  return (
    <>
      {/* Background — exact rectangle, rounded only here (never clips the bar). */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute rounded-[3px]',
          kind === 'run' ? 'bg-warning/15 border border-warning/50' : 'bg-warning/10 border border-warning/40',
        )}
        style={{
          left: `${rect.x * 100}%`,
          top: `${topPct}%`,
          width: `${rect.width * 100}%`,
          height: `${heightPct}%`,
        }}
      />
      {/* Evidence bar — sibling, fixed 4px gap; explicit translateY moves
          the marker BELOW the highlight top independently of zoom rounding;
          height = highlight minus 2px/3px insets, floored positive. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute w-[3px] rounded-full bg-warning"
        style={{
          left: `${barLeftPx}px`,
          top: `calc(${topPct}% + ${EVIDENCE_BAR_METRICS.topInsetPx}px)`,
          height: evidenceBarHeight(heightPct),
          transform: `translateY(${EVIDENCE_BAR_METRICS.translateYPx}px)`,
        }}
      />
    </>
  )
}

/* ---------------------------------------------------------------------------
 * Exact Figure outline overlay (Build 8F).
 *
 * Pale amber transparent region + thin amber outline + compact `Figure N`
 * label, positioned with % of the canvas wrapper — so zoom, fit-width,
 * resize, and rotation keep the outline aligned with the painted image.
 * pointer-events: none so it never intercepts page interaction; the label
 * sits ABOVE the region so it never covers the figure.
 * --------------------------------------------------------------------------- */

function FigureOutlineOverlay({
  rect,
  label,
}: {
  rect: { page: number; x: number; y: number; width: number; height: number }
  label: string
}) {
  const topPct = (1 - rect.y - rect.height) * 100
  return (
    <>
      {/* Pale amber region with thin amber border — 1px outline, inside bounds. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute rounded-[3px] border border-warning/70 bg-warning/10"
        style={{
          left: `${rect.x * 100}%`,
          top: `${topPct}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
        }}
      />
      {/* Compact label — pinned just above the region, never overlapping it. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute whitespace-nowrap rounded-sm bg-warning/90 px-1.5 py-0.5 font-mono text-[11px] leading-[14px] text-white"
        style={{
          left: `${rect.x * 100}%`,
          top: `calc(${topPct}% - 20px)`,
        }}
      >
        {label}
      </span>
    </>
  )
}

/* ---------------------------------------------------------------------------
 * Margin page-edge marker (Build: Margin markers).
 *
 * A calm, non-obstructive band along the AFFECTED page side — indicates
 * WHICH edge has a problem, never the measured margin width. Pale
 * translucent rose fill + restrained dark-red inner edge line (Major);
 * pointer-events none; positioned with % of the canvas wrapper so zoom,
 * fit-width, resize, and rotation keep it aligned. Decorative only — the
 * chip supplies the non-color meaning.
 * --------------------------------------------------------------------------- */

const MARGIN_MARKER_VERTICAL_WIDTH = 5 // CSS px
const MARGIN_MARKER_HORIZONTAL_HEIGHT = 6 // CSS px
const MARGIN_MARKER_EDGE = 2 // CSS px inner edge line

function MarginEdgeMarker({ side, sectionNumber }: { side: 'left' | 'right' | 'top' | 'bottom'; sectionNumber: number }) {
  const isVertical = side === 'left' || side === 'right'
  const base: React.CSSProperties = {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: 0,
  }
  if (isVertical) {
    base.width = MARGIN_MARKER_VERTICAL_WIDTH
    base.top = 0
    base.bottom = 0
    base[side] = 0
  } else {
    base.height = MARGIN_MARKER_HORIZONTAL_HEIGHT
    base.left = 0
    base.right = 0
    base[side] = 0
  }
  return (
    <>
      {/* Pale translucent rose band — never a saturated block. */}
      <div aria-hidden="true" className="bg-destructive/10" style={base} />
      {/* Restrained dark-red inner edge line along the page side. */}
      <div
        aria-hidden="true"
        className="bg-destructive/70"
        style={{
          ...base,
          ...(isVertical
            ? { width: MARGIN_MARKER_EDGE, left: side === 'left' ? 0 : undefined, right: side === 'right' ? 0 : undefined }
            : { height: MARGIN_MARKER_EDGE, top: side === 'top' ? 0 : undefined, bottom: side === 'bottom' ? 0 : undefined }),
        }}
      />
      {/* Screen-reader-only meaning (chip duplicates it visually). */}
      <span className="sr-only">Margin issue on the {side} edge of this page, Section {sectionNumber}</span>
    </>
  )
}
