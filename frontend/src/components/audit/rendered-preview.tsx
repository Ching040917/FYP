/**
 * RenderedPreview — read-only PDF.js document viewer (Build 4, MVP).
 *
 * Loads the persisted rendered PDF from the secure endpoint
 * GET /api/audit/{audit_id}/rendered-preview and renders one page at a
 * time onto a canvas. This is a project-specific viewer built on the
 * PDF.js display APIs — not the stock PDF.js viewer.
 *
 * States reported upward via onStateChange:
 *   loading | available | historical | unavailable | corrupt | missing | error
 * The parent keeps the extracted-text preview as the automatic fallback
 * and hides this viewer only when it is truly available.
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
  Loader2,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { cn } from '../../lib/utils'
import { api } from '../../services/api'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export type RenderedPreviewState =
  | 'loading'
  | 'available'
  | 'historical'
  | 'unavailable'
  | 'corrupt'
  | 'missing'
  | 'error'

interface RenderedPreviewProps {
  auditId: string
  /** Reports the current load state to the parent (fallback decisions). */
  onStateChange?: (state: RenderedPreviewState) => void
  /** Fill the parent region instead of a fixed max height (desktop split). */
  fitRegion?: boolean
}

const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP_IN = 1.25
const ZOOM_STEP_OUT = 0.8
const FALLBACK_MESSAGES: Record<Exclude<RenderedPreviewState, 'loading' | 'available'>, string> = {
  historical: 'Rendered preview is unavailable for this older audit.',
  unavailable: 'The page-rendered preview could not be created. The extracted-text preview remains available.',
  corrupt: 'The rendered preview is no longer available. The extracted-text preview remains available.',
  missing: 'The rendered preview is no longer available. The extracted-text preview remains available.',
  error: 'The rendered preview could not be loaded. The extracted-text preview remains available.',
}

export function RenderedPreview({ auditId, onStateChange, fitRegion = false }: RenderedPreviewProps) {
  const [state, setState] = React.useState<RenderedPreviewState>('loading')
  const [fallbackDetail, setFallbackDetail] = React.useState<string | null>(null)
  const [pdfDoc, setPdfDoc] = React.useState<PDFDocumentProxy | null>(null)
  const [pageNum, setPageNum] = React.useState(1)
  const [numPages, setNumPages] = React.useState(0)
  // null = fit-to-width (recomputed from the container on demand)
  const [scale, setScale] = React.useState<number | null>(null)
  const [appliedScale, setAppliedScale] = React.useState<number | null>(null)
  const [renderFailed, setRenderFailed] = React.useState(false)
  const [fitTick, setFitTick] = React.useState(0)

  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const loadingTaskRef = React.useRef<PDFDocumentLoadingTask | null>(null)
  const renderTaskRef = React.useRef<RenderTask | null>(null)
  const renderSeqRef = React.useRef(0)
  const fitWidthRef = React.useRef(0)

  const report = React.useCallback(
    (s: RenderedPreviewState) => {
      setState(s)
      onStateChange?.(s)
    },
    [onStateChange],
  )

  // ---- Load the document once per audit ----
  React.useEffect(() => {
    let cancelled = false
    report('loading')
    setPdfDoc(null)
    setNumPages(0)
    setPageNum(1)
    setScale(null)
    setAppliedScale(null)
    setRenderFailed(false)
    setFallbackDetail(null)

    const load = async () => {
      const result = await api.getRenderedPreview(auditId)
      if (cancelled) return
      if (!result.ok) {
        const mapped = mapFailure(result.status, result.detail)
        setFallbackDetail(result.detail || FALLBACK_MESSAGES[mapped])
        report(mapped)
        return
      }
      let data: ArrayBuffer
      try {
        data = await result.blob.arrayBuffer()
      } catch {
        if (!cancelled) report('error')
        return
      }
      if (cancelled) return
      try {
        const task = pdfjsLib.getDocument({ data })
        loadingTaskRef.current = task
        const doc = await task.promise
        if (cancelled) {
          doc.destroy()
          return
        }
        setPdfDoc(doc)
        setNumPages(doc.numPages)
        report('available')
      } catch {
        if (!cancelled) report('corrupt')
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
  }, [auditId, report])

  // ---- Keep the parent in sync when state changes without a new audit ----
  React.useEffect(() => {
    onStateChange?.(state)
  }, [state, onStateChange])

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
    if (!pdfDoc || state !== 'available') return
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
  }, [pdfDoc, pageNum, scale, state, fitTick])

  const zoomIn = () => setScale((cur) => Math.min(ZOOM_MAX, (cur ?? 1) * ZOOM_STEP_IN))
  const zoomOut = () => setScale((cur) => Math.max(ZOOM_MIN, (cur ?? 1) * ZOOM_STEP_OUT))
  const fitWidth = () => {
    fitWidthRef.current = 0
    setScale(null)
    setFitTick((t) => t + 1)
  }
  const nextPage = () => setPageNum((p) => Math.min(numPages, p + 1))
  const prevPage = () => setPageNum((p) => Math.max(1, p - 1))

  // ---- Non-available states: fallback panel only ----
  if (state !== 'available') {
    const message = fallbackDetail || FALLBACK_MESSAGES[state as Exclude<RenderedPreviewState, 'loading' | 'available'>]
    return (
      <div className="space-y-3" role="region" aria-label="Rendered document preview">
        {state === 'loading' ? (
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

      {/* Screen-reader status for page/zoom changes */}
      <p aria-live="polite" className="sr-only">
        Page {pageNum} of {numPages}, {zoomLabel}
      </p>

      {/* Bounded internal scrolling; no page-level horizontal overflow */}
      <div
        ref={containerRef}
        className={cn(
          'overflow-auto rounded-md border border-border bg-input/30 p-4 scrollbar-thin',
          fitRegion ? 'min-h-0 flex-1' : 'max-h-[560px]',
        )}
      >
        <div className="flex min-h-full items-start justify-center">
          <canvas
            ref={canvasRef}
            className="bg-white shadow-tonal-high"
            aria-label={`Document page ${pageNum}`}
          />
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

function mapFailure(
  status: number,
  detail: string,
): Exclude<RenderedPreviewState, 'loading' | 'available'> {
  if (status === 404) return detail.includes('older audit') ? 'historical' : 'error'
  if (status === 409) return detail.includes('could not be created') ? 'unavailable' : 'corrupt'
  if (status === 410) return 'missing'
  return 'error'
}
