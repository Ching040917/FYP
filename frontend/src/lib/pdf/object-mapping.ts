/**
 * Table/Figure page-mapping PoC (session-only, no persistence).
 *
 * Determines whether DOCX table_index / image_index map reliably to real
 * PDF pages WITHOUT guessing:
 *
 * Tables:
 *   1. semantic caption paragraph mapping (exact when label + object
 *      identity agree);
 *   2. unique table-cell text geometry (approximate; repeated cell text is
 *      never used alone);
 *   3. nearest mapped paragraphs before/after (missing captions; both
 *      boundaries must be consistent — same page, or adjacent pages for a
 *      spanning table → START page only);
 *   4. DOCX object order as context.
 *
 * Figures:
 *   1. semantic caption mapping (exact);
 *   2. host paragraph mapping (unavailable for image-only paragraphs);
 *   3. PDF image-paint operator order aligned with DOCX drawing order —
 *      repeated-position header/footer and decorative images are excluded
 *      and separately classified. Exact only when rels/drawing/op orders
 *      agree; counts matching alone never authorizes a claim.
 *
 * bbox is informational only and does not authorize production overlays.
 */
import { matchCitationOnPage, type CitationRect } from './citation-highlight.ts'
import { normalizeText, type BlockMapping, type PageText } from './paragraph-mapping.ts'
import { measurePdfText, type MeasureText } from './pdf-measure.ts'
import type { ImageOp } from './pdf-text-extract.ts'

export type ObjectConfidence = 'exact' | 'approximate' | 'unavailable'

export interface ObjectMappingResult {
  targetType: 'table' | 'figure'
  targetIndex: number
  pageNumber: number | null
  bbox: CitationRect | null
  confidence: ObjectConfidence
  evidenceMethod: string
  ambiguityReason: string | null
}

export interface CaptionMeta {
  text: string
  above: boolean
}

export interface TableMeta {
  index: number
  cells: string[][]
  caption: CaptionMeta | null
}

export interface FigureMeta {
  imageIndex: number
  hostParagraphIndex: number | null
  caption: CaptionMeta | null
  decorative: boolean
  inHeaderFooter: boolean
}

export type DocxOrderItem = { kind: 'paragraph' | 'table' | 'figure'; index: number }

export interface ObjectMapInput {
  byIndex: Map<number, BlockMapping>
  pages: PageText[]
  blocks: Array<{ index: number; text: string }>
  docxOrder: DocxOrderItem[]
  tables: TableMeta[]
  figures: FigureMeta[]
  /** DOCX body drawing order (image indices as they appear in document.xml). */
  drawingOrder: number[]
  /** DOCX relationship iteration order (the backend image_index source). */
  relsOrder?: number[]
  /** PDF.js paint-image operator order (live). */
  imageOps: ImageOp[]
  measure?: MeasureText
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const blockPage = (input: ObjectMapInput, blockIndex: number): number | null =>
  input.byIndex.get(blockIndex)?.pageNumber ?? null

const captionBlockPage = (input: ObjectMapInput, caption: CaptionMeta): number | null => {
  const block = input.blocks.find((b) => normalizeText(b.text) === normalizeText(caption.text))
  return block ? blockPage(input, block.index) : null
}

const labelAgrees = (caption: CaptionMeta, targetType: 'table' | 'figure', index: number): boolean => {
  const re = targetType === 'table' ? /^table\s+\d+/i : /^figure\s+\d+/i
  if (!re.test(caption.text.trim())) return false
  const n = Number.parseInt(caption.text.trim().split(/\s+/)[1], 10)
  return n === index + 1
}

/** Surrounding mapped paragraph pages around a docx position. */
function surroundingPages(
  input: ObjectMapInput,
  docxIndex: number,
): { before: number | null; after: number | null } {
  let before: number | null = null
  let after: number | null = null
  for (let i = docxIndex - 1; i >= 0; i--) {
    const item = input.docxOrder[i]
    if (item.kind === 'paragraph') {
      const p = blockPage(input, item.index)
      if (p !== null) {
        before = p
        break
      }
    }
  }
  for (let i = docxIndex + 1; i < input.docxOrder.length; i++) {
    const item = input.docxOrder[i]
    if (item.kind === 'paragraph') {
      const p = blockPage(input, item.index)
      if (p !== null) {
        after = p
        break
      }
    }
  }
  return { before, after }
}

function uniqueCellPage(input: ObjectMapInput, meta: TableMeta): { page: number | null; bbox: CitationRect | null } {
  for (const row of meta.cells) {
    for (const cell of row) {
      const text = cell.trim()
      if (!text) continue
      // cell text must appear on EXACTLY one page (doc-wide uniqueness)
      let hitPage: number | null = null
      let hitRects: CitationRect[] | null = null
      let ambiguous = false
      for (const page of input.pages) {
        const rects = matchCitationOnPage(page, text, page.pageWidth, page.pageHeight, input.measure ?? measurePdfText)
        if (rects && rects.length > 0) {
          if (hitPage !== null) {
            ambiguous = true
            break
          }
          hitPage = page.pageNumber
          hitRects = rects
        }
      }
      if (!ambiguous && hitPage !== null && hitRects && hitRects.length > 0) {
        const r = hitRects[0]
        return { page: hitPage, bbox: { page: hitPage, x: r.x, y: r.y, width: r.width, height: r.height } }
      }
    }
  }
  return { page: null, bbox: null }
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

export function mapTableObjects(input: ObjectMapInput): ObjectMappingResult[] {
  return input.tables.map((meta) => {
    const docxIndex = input.docxOrder.findIndex((i) => i.kind === 'table' && i.index === meta.index)
    const surroundings = docxIndex >= 0 ? surroundingPages(input, docxIndex) : { before: null, after: null }

    // 1. semantic caption (exact only when label + object identity agree)
    if (meta.caption) {
      const captionPage = captionBlockPage(input, meta.caption)
      const agree = labelAgrees(meta.caption, 'table', meta.index)
      if (captionPage !== null && agree) {
        // spanning table: caption page (usually the END for below-captions)
        // plus a consistent range → START page.
        if (
          surroundings.before !== null &&
          surroundings.after !== null &&
          surroundings.after === surroundings.before + 1
        ) {
          return result('table', meta.index, surroundings.before, null, 'exact',
            'caption+surroundings', null)
        }
        return result('table', meta.index, captionPage, null, 'exact', 'caption', null)
      }
      // caption exists but doesn't verify → fall through (never guess from it)
    }

    // 2. unique table-cell text (approximate)
    const cell = uniqueCellPage(input, meta)
    if (cell.page !== null) {
      return result('table', meta.index, cell.page, cell.bbox, 'approximate', 'cell-text', null)
    }

    // 3. surrounding mapped paragraphs (missing captions need BOTH sides)
    if (surroundings.before !== null && surroundings.after !== null) {
      if (surroundings.before === surroundings.after) {
        return result('table', meta.index, surroundings.before, null, 'approximate',
          'surrounding-paragraphs', null)
      }
      if (surroundings.after === surroundings.before + 1) {
        return result('table', meta.index, surroundings.before, null, 'approximate',
          'surrounding-paragraphs', null) // spanning → start page only
      }
      return result('table', meta.index, null, null, 'unavailable', 'surrounding-paragraphs',
        'inconsistent-surroundings')
    }
    return result('table', meta.index, null, null, 'unavailable',
      surroundings.before === null && surroundings.after === null ? 'no-evidence' : 'surrounding-paragraphs',
      surroundings.before === null || surroundings.after === null ? 'missing-boundary' : null)
  })
}

// ---------------------------------------------------------------------------
// figures
// ---------------------------------------------------------------------------

/** Repeated-position image ops (header/footer-like) — exclude from body order. */
function splitBodyOps(imageOps: ImageOp[]): { body: ImageOp[]; headerLike: ImageOp[] } {
  const posCount = new Map<string, number>()
  for (const op of imageOps) {
    const key = `${Math.round(op.tx)}:${Math.round(op.ty)}`
    posCount.set(key, (posCount.get(key) ?? 0) + 1)
  }
  const body: ImageOp[] = []
  const headerLike: ImageOp[] = []
  for (const op of imageOps) {
    const key = `${Math.round(op.tx)}:${Math.round(op.ty)}`
    if ((posCount.get(key) ?? 0) >= 2) headerLike.push(op)
    else body.push(op)
  }
  return { body, headerLike }
}

export function mapFigureObjects(input: ObjectMapInput): ObjectMappingResult[] {
  const { body: bodyOps } = splitBodyOps(input.imageOps)

  return input.figures.map((meta) => {
    // Excluded / separately classified: header or decorative images never
    // receive a body figure page.
    if (meta.decorative || meta.inHeaderFooter) {
      return result('figure', meta.imageIndex, null, null, 'unavailable',
        meta.inHeaderFooter ? 'excluded-header' : 'excluded-decorative',
        'not a body figure')
    }

    // 1. semantic caption (exact when label agrees)
    if (meta.caption) {
      const captionPage = captionBlockPage(input, meta.caption)
      if (captionPage !== null && labelAgrees(meta.caption, 'figure', meta.imageIndex)) {
        return result('figure', meta.imageIndex, captionPage, null, 'exact', 'caption', null)
      }
    }

    // 2. host paragraph mapping (image-only paragraphs are unmapped)
    if (meta.hostParagraphIndex !== null) {
      const page = blockPage(input, meta.hostParagraphIndex)
      if (page !== null) {
        return result('figure', meta.imageIndex, page, null, 'exact', 'host-paragraph', null)
      }
    }

    // 3. PDF image-paint operator order aligned with DOCX drawing order.
    // Order agreement (rels == drawings == ops) is REQUIRED; counts
    // matching alone never authorizes a claim.
    const posInDrawing = input.drawingOrder.indexOf(meta.imageIndex)
    if (posInDrawing < 0 || bodyOps.length !== input.drawingOrder.length) {
      return result('figure', meta.imageIndex, null, null, 'unavailable', 'image-op-order',
        'op-order-mismatch')
    }
    const op = bodyOps[posInDrawing]
    if (!op) {
      return result('figure', meta.imageIndex, null, null, 'unavailable', 'image-op-order',
        'op-order-mismatch')
    }
    // Order agreement is the SAFETY evidence: the backend image_index
    // sequence (rels order) must equal the DOCX drawing order, and the PDF
    // paint order must cover exactly the same body images. Counts matching
    // alone never authorizes an exact claim.
    const relsOrder = input.relsOrder ?? input.drawingOrder
    const orderAgreement =
      relsOrder.length === input.drawingOrder.length &&
      relsOrder.every((v, i) => v === input.drawingOrder[i]) &&
      bodyOps.length === input.drawingOrder.length
    return result('figure', meta.imageIndex, op.page, null,
      orderAgreement ? 'exact' : 'approximate', 'image-op-order',
      orderAgreement ? null : 'order-agreement-unverified')
  })
}

function result(
  targetType: 'table' | 'figure',
  targetIndex: number,
  pageNumber: number | null,
  bbox: CitationRect | null,
  confidence: ObjectConfidence,
  evidenceMethod: string,
  ambiguityReason: string | null,
): ObjectMappingResult {
  return { targetType, targetIndex, pageNumber, bbox, confidence, evidenceMethod, ambiguityReason }
}
