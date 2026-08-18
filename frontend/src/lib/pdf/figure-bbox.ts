/**
 * Exact Figure outline resolution (Build 8F) — pure logic.
 *
 * Turns a Figure finding (IMAGE_CAPTION_MISSING / IMAGE_ALT_TEXT_MISSING /
 * figure-related MANUAL_CAPTION) into an EXACT overlay decision using the
 * verified PDF.js operator-list geometry:
 *
 *   - identity: authoritative `location.image_index` (backend rels order);
 *   - classification: repeated-position header/footer logos and decorative
 *     images are never body figures;
 *   - order agreement: the image_index must align with the DOCUMENT-WIDE
 *     body-paint order (header/decorative paints excluded), and the mapped
 *     paint's page must equal the object-navigation page. Counts matching
 *     alone never authorizes an exact outline;
 *   - geometry: complete CTM (save/restore stack semantics) transformed
 *     through the unit-square corners, scale-1 normalized, page-rotation
 *     aware (`figureBBoxFromOp`).
 *
 * The outline is rendered ONLY when identity is reliable AND the geometry
 * is finite and non-degenerate. Anything else — repeated header logo,
 * decorative image, order disagreement, no op, degenerate box — yields the
 * truthful page message and NEVER an approximate outline.
 */
import type { CitationRect } from './citation-highlight.ts'
import type { DetailedImageOp, PageGeometry } from './pdf-text-extract.ts'
import { figureBBoxFromOp } from './object-bbox.ts'

export const FIGURE_OUTLINE_RULES: ReadonlySet<string> = new Set([
  'IMAGE_CAPTION_MISSING',
  'IMAGE_ALT_TEXT_MISSING',
  'MANUAL_CAPTION',
])

/** Truthful message when the figure is on the page but no exact boundary. */
export const FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE =
  'The figure is on this page. Its exact boundary could not be marked.'

export interface FigureOutlineResult {
  /** Exact normalized bbox (0..1, bottom-left origin), or null. */
  rect: CitationRect | null
  /** Compact one-based label, e.g. `Figure 2`. */
  label: string | null
  /**
   * Page the figure is on (exact when `rect` is set; otherwise the mapped
   * page for navigation + the truthful boundary message).
   */
  pageNumber: number | null
  /** Truthful message when the exact boundary is unavailable. */
  message: string | null
}

export type FigureOutlineInput = {
  finding: {
    ruleCode?: string | null
    rule_code?: string | null
    location?: Record<string, unknown> | null
  }
  geometry: PageGeometry[] | null | undefined
  /** The page the object navigation resolved (one-based). */
  pageNumber: number | null
}

/** Geometry for a page, or null when absent. */
export function geometryForPage(
  geometry: PageGeometry[] | null | undefined,
  pageNumber: number,
): PageGeometry | null {
  if (!geometry) return null
  return geometry.find((g) => g.pageNumber === pageNumber) ?? null
}

export type ImageClassification = 'body' | 'header-logo' | 'decorative'

const MIN_FIGURE_WIDTH = 40
const MIN_FIGURE_HEIGHT = 40

/**
 * Classification of a single image paint:
 *   - decorative: tiny glyph-like paint (icon/logo/separator) — never a
 *     body figure;
 *   - header-logo: paint at the SAME position on several pages (running
 *     header/footer) — never a body figure;
 *   - body: a normal-size, non-repeating figure paint.
 */
export function classifyImageOp(
  op: DetailedImageOp,
  geometry?: PageGeometry[] | null,
): ImageClassification {
  const w = Math.abs(op.a)
  const h = Math.abs(op.d)
  if (w < MIN_FIGURE_WIDTH || h < MIN_FIGURE_HEIGHT) return 'decorative'
  if (geometry && isRepeatedPosition(op, geometry)) return 'header-logo'
  return 'body'
}

/**
 * Repeated-position detection: the paint appears at (essentially) the same
 * top-left translation across the document's pages (running header/footer
 * logo evidence — the fixture's logo repeats at the identical position on
 * every page).
 */
export function isRepeatedPosition(op: DetailedImageOp, geometry: PageGeometry[]): boolean {
  let count = 0
  for (const g of geometry) {
    for (const other of g.imageOps) {
      if (samePosition(other, op)) count += 1
    }
  }
  return count >= 2
}

function samePosition(a: DetailedImageOp, b: DetailedImageOp): boolean {
  return Math.abs(a.e - b.e) < 2 && Math.abs(a.f - b.f) < 2
}

/**
 * Document-wide body figure paints in operator order (header/decorative
 * paints excluded). The authoritative backend image_index counts body
 * images only, so this list is the operator-order counterpart of
 * image_index — order agreement between the two is what makes an index →
 * paint mapping exact.
 */
export function bodyFigureOps(geometry: PageGeometry[]): DetailedImageOp[] {
  const body: DetailedImageOp[] = []
  for (const g of geometry) {
    for (const op of g.imageOps) {
      if (classifyImageOp(op, geometry) === 'body') body.push(op)
    }
  }
  return body
}

/**
 * The body figure paint for an authoritative image_index, or null when the
 * order does not align (missing op / filtered ops disagree). This is the
 * SINGLE identity → operator mapping both page resolution and outline
 * resolution use, so they can never disagree.
 */
export function figureOpForIndex(
  geometry: PageGeometry[] | null | undefined,
  imageIndex: number,
): DetailedImageOp | null {
  if (!geometry || geometry.length === 0 || imageIndex < 0) return null
  return bodyFigureOps(geometry)[imageIndex] ?? null
}

/**
 * Resolve the figure's PAGE from its authoritative image_index via the
 * operator geometry. Returns the paint's real page — never the host
 * paragraph's page. Null when identity/order do not align (unavailable).
 */
export function figurePageForIndex(
  geometry: PageGeometry[] | null | undefined,
  imageIndex: number,
): number | null {
  return figureOpForIndex(geometry, imageIndex)?.page ?? null
}

/**
 * Exact outline resolution for one figure finding.
 *
 * Guards, in order:
 *   1. rule gate (figure outline rules only);
 *   2. authoritative identity (numeric image_index);
 *   3. document-wide order agreement: `figureOpForIndex(imageIndex)` must
 *      exist — otherwise the index → paint mapping is not exact;
 *   4. the operator's REAL page is authoritative for both pageNumber and
 *      the outline. When the caller's navigation page disagrees, the
 *      operator page wins (identity rule 9: never downgrade to the
 *      host-paragraph page);
 *   5. the paint is a body figure (header logos / decorative images were
 *      already excluded from `bodyFigureOps`);
 *   6. finite, non-degenerate geometry — otherwise unavailable.
 *
 * Never falls back to an approximate box: unavailable stays unavailable.
 */
export function resolveFigureOutline(input: FigureOutlineInput): FigureOutlineResult {
  const ruleCode =
    input.finding.ruleCode ?? (input.finding as { rule_code?: string | null }).rule_code ?? null
  if (!ruleCode || !FIGURE_OUTLINE_RULES.has(ruleCode)) {
    return { rect: null, label: null, pageNumber: null, message: null }
  }
  const imageIndex = (input.finding.location ?? {}).image_index
  if (typeof imageIndex !== 'number' || !Number.isInteger(imageIndex) || imageIndex < 0) {
    return { rect: null, label: null, pageNumber: null, message: null }
  }

  const label = `Figure ${imageIndex + 1}`
  if (!input.geometry || input.geometry.length === 0) {
    return { rect: null, label, pageNumber: input.pageNumber, message: FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE }
  }

  // The operator's real page is authoritative for the outline. The caller's
  // navigation page (host-paragraph derived) is never allowed to override
  // exact operator geometry.
  const op = figureOpForIndex(input.geometry, imageIndex)
  if (!op) {
    return { rect: null, label, pageNumber: input.pageNumber, message: FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE }
  }

  const page = geometryForPage(input.geometry, op.page)
  const rect = page ? figureBBoxFromOp(op, page.pageWidth, page.pageHeight) : null
  if (!rect) {
    return { rect: null, label, pageNumber: op.page, message: FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE }
  }
  return { rect, label, pageNumber: op.page, message: null }
}
