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
        const task = pdfjs.getDocument({ data: bytes.slice(0) })
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
