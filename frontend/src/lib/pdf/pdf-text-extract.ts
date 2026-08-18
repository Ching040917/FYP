/**
 * PDF text extraction + shared pdfjs configuration.
 *
 * ONE pdfjs instance for the whole app: the viewer and the paragraph
 * mapper must use the same build and the same worker configuration, or
 * the mapper fails in the browser while working in Node tests (the legacy
 * build has no auto-configured worker there). Environment-aware:
 *   - Node (tests/fixtures): legacy build, fake worker — works headless;
 *   - Browser: standard build + the Vite worker asset, configured once.
 */
import {
  findRepeatedLines,
  normalizeText,
  reconstructLines,
  type PageText,
  type TextItemLike,
} from './paragraph-mapping.ts'

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null

export function getPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      if (typeof window === 'undefined') {
        const legacy = await import('pdfjs-dist/legacy/build/pdf.mjs')
        return legacy as typeof import('pdfjs-dist')
      }
      const main = await import('pdfjs-dist')
      if (!main.GlobalWorkerOptions.workerSrc) {
        const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        main.GlobalWorkerOptions.workerSrc = workerSrc
      }
      return main
    })()
  }
  return pdfjsPromise
}

// pdfjs workers (incl. the Node fake worker) are shared globals — serialize
// document operations so concurrent getDocument/getOperatorList calls never
// interleave worker messages.
let pdfQueue: Promise<unknown> = Promise.resolve()
function withPdfLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = pdfQueue.then(fn, fn)
  pdfQueue = run.catch(() => undefined)
  return run
}

// Reopening the SAME bytes after destroying the document crashes the Node
// fake worker (DataCloneError: leftover handlers collide). Share ONE
// document per bytes object for the lifetime of the process instead.
// PoC/test-only: the browser viewer opens its own document per render.
let sharedDocRef: Uint8Array | ArrayBuffer | null = null
let sharedDocPromise: Promise<any> | null = null

async function openDocument(pdfBytes: Uint8Array | ArrayBuffer) {
  if (sharedDocRef === pdfBytes && sharedDocPromise) return sharedDocPromise
  sharedDocRef = pdfBytes
  const pdfjsLib = await getPdfjs()
  sharedDocPromise = pdfjsLib.getDocument({ data: pdfBytes }).promise
  return sharedDocPromise
}

export async function extractPageText(pdfBytes: ArrayBuffer | Uint8Array): Promise<PageText[]> {
  return withPdfLock(async () => {
    const doc = await openDocument(pdfBytes)
    const raw: PageText[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      const items = content.items.filter(
        (it: { str?: unknown }): boolean => typeof it.str === 'string',
      ) as unknown as TextItemLike[]
      const viewport = page.getViewport({ scale: 1 })
      raw.push({
        pageNumber: n,
        lines: reconstructLines(items as TextItemLike[]),
        headerFooterLines: new Set(),
        items: items as TextItemLike[],
        pageWidth: viewport.width,
        pageHeight: viewport.height,
      })
    }
    const repeated = findRepeatedLines(raw)
    return raw.map((p) => {
      const excludedTexts = repeated.get(p.pageNumber) ?? new Set<string>()
      // Position-based exclusion: mark the ITEM INDICES of repeated lines
      // (matched by y), so body text that happens to equal a header phrase
      // survives.
      const excludedIndices = new Set<number>()
      if (excludedTexts.size > 0 && p.items && p.items.length > 0) {
        for (let i = 0; i < p.items.length; i++) {
          const it = p.items[i]
          const y = it.transform[5] ?? -1
          const line = p.lines.find((l) => l.text === normalizeText(it.str) && Math.abs(l.y - y) < 3)
          if (line && excludedTexts.has(line.text)) excludedIndices.add(i)
        }
      }
      return {
        ...p,
        headerFooterLines: excludedTexts,
        headerFooterItemIndices: excludedIndices,
      }
    })
  })
}

/** One image-paint occurrence from a page's operator list. */
export interface ImageOp {
  page: number
  /** Sequential index across ALL pages (operator order). */
  globalIndex: number
  /** Position within its page (operator order). */
  positionOnPage: number
  /** Image XObject name, when available (informational). */
  name: string | null
  /** CTM translation at paint time (informational, PDF units). */
  tx: number
  ty: number
}

/**
 * PoC support: walk every page's operator list, track the CTM through
 * transform/concatenateTransform operators, and record each
 * paintImageXObject occurrence. Order and position are the live evidence
 * for DOCX image-index alignment.
 */
export async function extractImageOpOrder(pdfBytes: ArrayBuffer | Uint8Array): Promise<ImageOp[]> {
  return withPdfLock(async () => {
    const pdfjsLib = await getPdfjs()
    const doc = await openDocument(pdfBytes)
    const out: ImageOp[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const { fnArray, argsArray } = await page.getOperatorList()
      let ctm = [1, 0, 0, 1, 0, 0]
      let position = 0
      for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i]
        const args = argsArray[i]
        if (fn === pdfjsLib.OPS.transform) {
          // cm: CTM = CTM × M(a,b,c,d,e,f)
          ctm = mulMatrix(ctm, args)
        } else if (fn === (pdfjsLib.OPS as Record<string, number>).concatenateTransform) {
          ctm = mulMatrix(args, ctm)
        } else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject) {
          out.push({
            page: n,
            globalIndex: out.length,
            positionOnPage: position++,
            name: typeof args[0] === 'string' ? args[0] : null,
            tx: ctm[4],
            ty: ctm[5],
          })
        }
      }
    }
    return out
  })
}

function mulMatrix(m1: number[], m2: number[]): number[] {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ]
}

// ---------------------------------------------------------------------------
// BBox PoC: full page geometry (images with complete CTM + stroke segments)
// ---------------------------------------------------------------------------

/** Image paint with FULL placement evidence (BBox PoC). */
export interface DetailedImageOp extends ImageOp {
  /** Complete CTM at paint time, PDF user space. */
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
  /** Image pixel dimensions when the operator carries them. */
  width: number | null
  height: number | null
  /** Page rotation (degrees) from the scale-1 viewport. */
  rotation: number
}

/** A drawn STROKE segment in PDF user space (table-border evidence). */
export interface LineSegment {
  page: number
  x0: number
  y0: number
  x1: number
  y1: number
  horizontal: boolean
  vertical: boolean
}

export interface PageGeometry {
  pageNumber: number
  rotation: number
  pageWidth: number
  pageHeight: number
  imageOps: DetailedImageOp[]
  segments: LineSegment[]
}

/**
 * BBox PoC: walk every page's operator list with CORRECT save/restore CTM
 * stack semantics (LibreOffice emits `q cm ... Q` around clips and paints —
 * naive accumulation multiplies stale transforms and explodes the CTM).
 *
 * Records:
 *  - every image paint with its full CTM (a..f) and dimensions;
 *  - every STROKE path segment (constructPath with draw type = OPS.stroke):
 *    LibreOffice draws table borders as `m l S` line segments. Only
 *    horizontal/vertical segments ≥ 1pt are kept (border evidence); curves
 *    and clip paths (eoClip) are never treated as borders.
 */
export async function extractPageGeometry(pdfBytes: ArrayBuffer | Uint8Array): Promise<PageGeometry[]> {
  return withPdfLock(async () => {
    const pdfjsLib = await getPdfjs()
    const doc = await openDocument(pdfBytes)
    const out: PageGeometry[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const vp = page.getViewport({ scale: 1 })
      const { fnArray, argsArray } = await page.getOperatorList()
      const imageOps: DetailedImageOp[] = []
      const segments: LineSegment[] = []
      let ctm = [1, 0, 0, 1, 0, 0]
      const stack: number[][] = []
      let position = 0
      for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i]
        const args = argsArray[i] ?? []
        if (fn === pdfjsLib.OPS.save) {
          stack.push(ctm.slice())
        } else if (fn === pdfjsLib.OPS.restore) {
          ctm = stack.pop() ?? ctm
        } else if (fn === pdfjsLib.OPS.transform) {
          ctm = mulMatrix(ctm, args as number[])
        } else if (fn === (pdfjsLib.OPS as Record<string, number>).concatenateTransform) {
          ctm = mulMatrix(args as number[], ctm)
        } else if (fn === pdfjsLib.OPS.constructPath) {
          // draw type + flat [type, x, y, ...] segments (0=moveTo, 1=lineTo).
          // pdfjs 5.7 wraps the flat array as [{0:..,1:..,2:..,3:..}] (an
          // array-like object of length 1) — normalize before iterating.
          if (args[0] === pdfjsLib.OPS.stroke) {
            const wrapped = args[1]
            const flatObj = Array.isArray(wrapped) && wrapped.length === 1 ? wrapped[0] : wrapped
            if (flatObj && typeof flatObj === 'object') {
              const keys = Object.keys(flatObj).map(Number).sort((a, b) => a - b)
              for (let k = 2; k < keys.length; k++) {
                if (flatObj[keys[k]] !== 1) continue
                const px = flatObj[keys[k - 2]]
                const py = flatObj[keys[k - 1]]
                const sx = flatObj[keys[k + 1]]
                const sy = flatObj[keys[k + 2]]
                if (typeof px !== 'number' || typeof sx !== 'number') continue
                const x0 = ctm[0] * px + ctm[2] * py + ctm[4]
                const y0 = ctm[1] * px + ctm[3] * py + ctm[5]
                const x1 = ctm[0] * sx + ctm[2] * sy + ctm[4]
                const y1 = ctm[1] * sx + ctm[3] * sy + ctm[5]
                const len = Math.hypot(x1 - x0, y1 - y0)
                if (len < 1) continue
                const horizontal = Math.abs(y1 - y0) < len * 0.02
                const vertical = Math.abs(x1 - x0) < len * 0.02
                if (horizontal || vertical) {
                  segments.push({ page: n, x0, y0, x1, y1, horizontal, vertical })
                }
              }
            }
          }
        } else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject) {
          const w = typeof args[1] === 'number' ? args[1] : null
          const h = typeof args[2] === 'number' ? args[2] : null
          imageOps.push({
            page: n,
            globalIndex: imageOps.length,
            positionOnPage: position++,
            name: typeof args[0] === 'string' ? args[0] : null,
            tx: ctm[4],
            ty: ctm[5],
            a: ctm[0],
            b: ctm[1],
            c: ctm[2],
            d: ctm[3],
            e: ctm[4],
            f: ctm[5],
            width: w,
            height: h,
            rotation: vp.rotation,
          })
        }
      }
      out.push({ pageNumber: n, rotation: vp.rotation, pageWidth: vp.width, pageHeight: vp.height, imageOps, segments })
    }
    return out
  })
}
