/**
 * Table/Figure bounding-box PoC (session-only, no persistence, no overlays).
 *
 * Determines whether reliable NORMALIZED page-space bboxes can be produced
 * for identified Tables and Figures from PDF.js operator + text-item
 * evidence alone. Result model mirrors ObjectMappingResult:
 *   targetType / targetIndex / pageNumber / bbox (0..1, bottom-left origin)
 *   confidence: exact | approximate | unavailable
 *   evidenceMethod / ambiguityReason
 *
 * Figures: paintImageXObject with FULL CTM (save/restore stack semantics) →
 * transform the unit-square corners → axis-aligned page-space bbox →
 * viewport-rotation-aware normalization. Exact only when identity/order/
 * CTM agree; missing dimensions or degenerate CTM → unavailable. Uncertain
 * Figure boxes are NEVER downgraded to approximate production boxes.
 *
 * Tables: cell-text marker rectangles on the identified page clustered into
 * rows; ≥2 consistent rows required; stroke segment geometry (LibreOffice
 * draws borders as m/l/S segments) as independent corroboration:
 *   exact      — text cluster AND border frame independently agree;
 *   approximate— coherent text cluster, no operator evidence;
 *   unavailable— competing regions, insufficient rows, or conflicting
 *                cluster/frame geometry.
 * One cell or a caption alone is never sufficient; repeated cell text never
 * independently identifies a table; neighbouring tables stay separate.
 */
import { matchCitationOnPage, type CitationRect } from './citation-highlight.ts'
import type { DetailedImageOp, LineSegment } from './pdf-text-extract.ts'
import type { PageText } from './paragraph-mapping.ts'
import { measurePdfText, type MeasureText } from './pdf-measure.ts'

export type BBoxConfidence = 'exact' | 'approximate' | 'unavailable'

export interface ObjectBBox {
  targetType: 'table' | 'figure'
  targetIndex: number
  pageNumber: number | null
  bbox: CitationRect | null
  confidence: BBoxConfidence
  evidenceMethod: string
  ambiguityReason: string | null
}

// ---------------------------------------------------------------------------
// figure bbox
// ---------------------------------------------------------------------------

/**
 * Axis-aligned normalized bbox of an image paint.
 *
 * Corners of the unit square transformed by the FULL CTM (PDF convention:
 * x' = a·x + c·y + e, y' = b·x + d·y + f). The result is mapped through the
 * page viewport (rotation-aware) into display space (y down), then reported
 * bottom-left-origin normalized 0..1 — identical convention to the existing
 * text-item highlight rects. Returns null for degenerate/invalid CTM or
 * zero-area results (never a guessed box).
 */
export function figureBBoxFromOp(
  op: DetailedImageOp,
  pageWidth: number,
  pageHeight: number,
): CitationRect | null {
  const det = op.a * op.d - op.b * op.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null
  const corners = ([
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as Array<[number, number]>).map(([x, y]) => [
    op.a * x + op.c * y + op.e,
    op.b * x + op.d * y + op.f,
  ] as [number, number])
  return normalizeCorners(corners, op.rotation, pageWidth, pageHeight, op.page)
}

/**
 * Map user-space corners through the viewport (rotation-aware) and
 * normalize to bottom-left-origin 0..1. For rotation 0 the user space IS
 * the bottom-left space, so the mapping is identity. For rotated pages the
 * pdfjs viewport mapping (display space, y down) is applied and the result
 * is flipped back to bottom-left semantics.
 */
export function normalizeCorners(
  corners: Array<[number, number]>,
  rotation: number,
  pageWidth: number,
  pageHeight: number,
  pageNumber: number,
): CitationRect | null {
  if (corners.length === 0) return null
  const rot = ((rotation % 360) + 360) % 360
  // rotated pages swap the visible width/height (pdfjs viewport semantics)
  const vw = rot === 90 || rot === 270 ? pageHeight : pageWidth
  const vh = rot === 90 || rot === 270 ? pageWidth : pageHeight
  let pts: Array<[number, number]>
  if (rot === 0) {
    pts = corners
  } else {
    pts = corners.map(([x, y]) => {
      switch (rot) {
        case 90:
          return [pageHeight - y, x] as [number, number]
        case 180:
          return [pageWidth - x, pageHeight - y] as [number, number]
        case 270:
          return [y, pageWidth - x] as [number, number]
        default:
          return [x, y] as [number, number]
      }
    })
  }
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  if (![x0, x1, y0, y1].every((v) => Number.isFinite(v))) return null
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return null
  return {
    page: pageNumber,
    x: x0 / vw,
    y: y0 / vh,
    width: w / vw,
    height: h / vh,
  }
}

// ---------------------------------------------------------------------------
// table bbox
// ---------------------------------------------------------------------------

export interface TableRegionInput {
  /** The already-identified table's page text (items carry geometry). */
  page: PageText
  pageWidth: number
  pageHeight: number
  /** PoC-only: unique cell texts of the identified table. */
  cellMarkers: string[]
  /** Stroke segments on this page (border evidence). */
  segments: LineSegment[]
  measure?: MeasureText
}

export interface TableRegionResult {
  bbox: CitationRect | null
  confidence: BBoxConfidence
  evidenceMethod: string
  ambiguityReason: string | null
}

const ROW_Y_TOLERANCE = 3
const FRAME_MARGIN = 24

/**
 * Build the table region from cell-marker text rects + border segments.
 * Exact requires the border frame and the text cluster to independently
 * agree; a coherent cluster without operator evidence is approximate;
 * conflicts, single rows, or missing markers are unavailable.
 */
export function tableRegion(input: TableRegionInput): TableRegionResult {
  const measure = input.measure ?? measurePdfText
  // 1. unique cell-marker rects on THIS page (repeated text is skipped —
  //    it cannot independently identify a table)
  const markerRects: CitationRect[] = []
  const seen = new Set<string>()
  for (const marker of input.cellMarkers) {
    const key = marker.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const r = matchCitationOnPage(input.page, key, input.pageWidth, input.pageHeight, measure)
    if (!r || r.length !== 1) continue // absent or repeated on this page
    markerRects.push(r[0])
  }
  if (markerRects.length === 0) {
    return unavailable('no-cell-evidence', 'no unique cell text on this page')
  }

  // 2. cluster into rows by y (bottom-edge tolerance)
  const rows: CitationRect[][] = []
  for (const rect of markerRects.sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r[0].y - rect.y) < ROW_Y_TOLERANCE / input.pageHeight)
    if (row) row.push(rect)
    else rows.push([rect])
  }
  if (rows.length < 2) {
    return unavailable('insufficient-rows', 'fewer than two consistent cell rows')
  }

  // 3. column alignment: the majority of rows must share the same x0
  //    column pattern (tolerance); merged cells may vary one row
  const patterns = new Map<string, number>()
  for (const row of rows) {
    const xs = [...new Set(row.map((r) => Math.round(r.x * input.pageWidth)))].sort((a, b) => a - b)
    const key = xs.join('|')
    patterns.set(key, (patterns.get(key) ?? 0) + 1)
  }
  const majority = Math.max(...patterns.values())
  if (majority < 2) {
    return unavailable('inconsistent-columns', 'rows do not share a consistent column pattern')
  }

  // 4. cluster region = union of marker rects (user space, bottom-left)
  const xs0 = markerRects.map((r) => r.x * input.pageWidth)
  const xs1 = markerRects.map((r) => (r.x + r.width) * input.pageWidth)
  const ys0 = markerRects.map((r) => r.y * input.pageHeight)
  const ys1 = markerRects.map((r) => (r.y + r.height) * input.pageHeight)
  const cx0 = Math.min(...xs0)
  const cx1 = Math.max(...xs1)
  const cy0 = Math.min(...ys0)
  const cy1 = Math.max(...ys1)

  // 5. border-frame evidence: segments LOCAL to the cluster. Cell text does
  //    NOT fill its cell (text-to-border gaps can be 50+ pt), so proximity
  //    is asymmetric per orientation:
  //      horizontal segment (fixed y): y must be near the cluster's y range
  //        AND its x span must meet the cluster's x range;
  //      vertical segment (fixed x): its y span must overlap the cluster's
  //        y range (the right border sits far from the last cell's text).
  //    Neighbouring tables sharing x-ranges are separated by their y
  //    extents; far-away frames never leak in. A contaminated frame still
  //    degrades to conflicting -> unavailable, never an exact box.
  const hSegs = input.segments.filter((s) => s.horizontal)
  const vSegs = input.segments.filter((s) => s.vertical)
  const overlapsX = (sx0: number, sx1: number) => sx1 >= cx0 - FRAME_MARGIN && sx0 <= cx1 + FRAME_MARGIN
  const overlapsY = (sy0: number, sy1: number) => sy1 >= cy0 - FRAME_MARGIN && sy0 <= cy1 + FRAME_MARGIN
  const hNear = hSegs.filter(
    (s) => s.y0 >= cy0 - FRAME_MARGIN && s.y0 <= cy1 + FRAME_MARGIN && overlapsX(Math.min(s.x0, s.x1), Math.max(s.x0, s.x1)),
  )
  const vNear = vSegs.filter((s) => overlapsY(Math.min(s.y0, s.y1), Math.max(s.y0, s.y1)))
  const hYs = [...new Set(hNear.map((s) => Math.round(s.y0 * 2) / 2))]
  const vXs = [...new Set(vNear.map((s) => Math.round(s.x0 * 2) / 2))]
  const hasFrame = hYs.length >= 2 && vXs.length >= 2

  const region: CitationRect = {
    page: input.page.pageNumber,
    x: cx0 / input.pageWidth,
    y: cy0 / input.pageHeight,
    width: (cx1 - cx0) / input.pageWidth,
    height: (cy1 - cy0) / input.pageHeight,
  }

  if (hasFrame) {
    const frameY0 = Math.min(...hYs)
    const frameY1 = Math.max(...hYs)
    const frameX0 = Math.min(...vXs)
    const frameX1 = Math.max(...vXs)
    const frame: CitationRect = {
      page: input.page.pageNumber,
      x: frameX0 / input.pageWidth,
      y: frameY0 / input.pageHeight,
      width: (frameX1 - frameX0) / input.pageWidth,
      height: (frameY1 - frameY0) / input.pageHeight,
    }
    // Text markers sit INSIDE cells, so the frame is typically larger than
    // the marker cluster: require the cluster to be covered by the frame
    // (>= 0.9) while the frame stays a plausible cell-margin extension
    // (<= 5x the cluster area) — a frame far off or only partially
    // overlapping is conflicting evidence, never an exact box.
    const coverage = rectCoverage(frame, region)
    const areaRatio = frame.width * frame.height / Math.max(1e-9, region.width * region.height)
    if (coverage >= 0.9 && areaRatio <= 5) {
      return { bbox: frame, confidence: 'exact', evidenceMethod: 'cell-text+frame', ambiguityReason: null }
    }
    return unavailable('conflicting-frame', `frame and text cluster disagree (coverage ${coverage.toFixed(2)}, ratio ${areaRatio.toFixed(2)})`)
  }
  return {
    bbox: region,
    confidence: 'approximate',
    evidenceMethod: 'cell-text',
    ambiguityReason: null,
  }
}

/** IoU of two normalized rects (0..1). */
export function rectIoU(a: CitationRect, b: CitationRect): number {
  const ax0 = a.x
  const ay0 = a.y
  const ax1 = a.x + a.width
  const ay1 = a.y + a.height
  const bx0 = b.x
  const by0 = b.y
  const bx1 = b.x + b.width
  const by1 = b.y + b.height
  const ix0 = Math.max(ax0, bx0)
  const iy0 = Math.max(ay0, by0)
  const ix1 = Math.min(ax1, bx1)
  const iy1 = Math.min(ay1, by1)
  const iw = Math.max(0, ix1 - ix0)
  const ih = Math.max(0, iy1 - iy0)
  const inter = iw * ih
  const union = a.width * a.height + b.width * b.height - inter
  return union > 0 ? inter / union : 0
}

/** Fraction of `inner` covered by `outer` (0..1). */
export function rectCoverage(outer: CitationRect, inner: CitationRect): number {
  const ax0 = outer.x
  const ay0 = outer.y
  const ax1 = outer.x + outer.width
  const ay1 = outer.y + outer.height
  const ix0 = Math.max(ax0, inner.x)
  const iy0 = Math.max(ay0, inner.y)
  const ix1 = Math.min(ax1, inner.x + inner.width)
  const iy1 = Math.min(ay1, inner.y + inner.height)
  const iw = Math.max(0, ix1 - ix0)
  const ih = Math.max(0, iy1 - iy0)
  const area = inner.width * inner.height
  return area > 0 ? (iw * ih) / area : 0
}

function unavailable(evidenceMethod: string, ambiguityReason: string): TableRegionResult {
  return { bbox: null, confidence: 'unavailable', evidenceMethod, ambiguityReason }
}
