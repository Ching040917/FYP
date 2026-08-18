/**
 * Exact Figure outline resolution tests (Build 8F).
 *
 * Pure logic: authoritative image_index → exact bbox only when identity,
 * page, document-wide body order, and finite geometry all agree. Covers
 * single/multiple figures per page, rotated + scaled geometry, page
 * boundary, repeated header logo exclusion, decorative exclusion, order
 * mismatch, unavailable geometry, and the "never approximate" rule.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIGURE_OUTLINE_RULES,
  FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE,
  resolveFigureOutline,
  classifyImageOp,
  bodyFigureOps,
  isRepeatedPosition,
  geometryForPage,
  type FigureOutlineResult,
} from '../src/lib/pdf/figure-bbox.ts'
import type { DetailedImageOp, PageGeometry } from '../src/lib/pdf/pdf-text-extract.ts'

const op = (partial: Partial<DetailedImageOp> & { page: number }): DetailedImageOp => ({
  globalIndex: 0,
  positionOnPage: 0,
  name: null,
  tx: 0,
  ty: 0,
  a: 216,
  b: 0,
  c: 0,
  d: 162,
  e: 198,
  f: 538.4,
  width: null,
  height: null,
  rotation: 0,
  ...partial,
})

const geometry = (pages: Array<{ page: number; ops?: Array<Partial<DetailedImageOp> & { page: number }>; width?: number; height?: number }>): PageGeometry[] =>
  pages.map((p) => ({
    pageNumber: p.page,
    rotation: 0,
    pageWidth: p.width ?? 612,
    pageHeight: p.height ?? 792,
    imageOps: (p.ops ?? []).map((o) => op({ ...o, page: p.page })),
    segments: [],
  }))

const finding = (ruleCode: string, imageIndex: number, extra: Record<string, unknown> = {}) => ({
  ruleCode,
  location: { image_index: imageIndex, paragraph_index: 3, ...extra },
})

const exact = (r: FigureOutlineResult): NonNullable<FigureOutlineResult['rect']> => {
  assert.ok(r.rect, `expected exact rect, got ${JSON.stringify(r)}`)
  return r.rect!
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

test('classifyImageOp: normal-size non-repeating paint is a body figure', () => {
  const g = geometry([{ page: 1, ops: [{ page: 1, e: 100, f: 200, a: 216, d: 162 }] }])
  assert.equal(classifyImageOp(g[0].imageOps[0], g), 'body')
})

test('classifyImageOp: repeated position across pages is a header logo, never body', () => {
  const g = geometry([
    { page: 1, ops: [{ page: 1, e: 99, f: 742, a: 60, d: 45 }] },
    { page: 2, ops: [{ page: 2, e: 99, f: 742, a: 60, d: 45 }] },
    { page: 3, ops: [{ page: 3, e: 99, f: 742, a: 60, d: 45 }] },
  ])
  for (const page of g) assert.equal(classifyImageOp(page.imageOps[0], g), 'header-logo')
  assert.equal(isRepeatedPosition(g[0].imageOps[0], g), true)
})

test('classifyImageOp: tiny paint is decorative, never body', () => {
  const g = geometry([{ page: 1, ops: [{ page: 1, e: 100, f: 200, a: 28.8, d: 21.6 }] }])
  assert.equal(classifyImageOp(g[0].imageOps[0], g), 'decorative')
})

test('bodyFigureOps excludes header logos and decorative paints', () => {
  const g = geometry([
    { page: 1, ops: [{ page: 1, e: 99, f: 742, a: 18, d: 13.7 }, { page: 1, e: 100, f: 500, a: 216, d: 162 }] },
    { page: 2, ops: [{ page: 2, e: 99, f: 742, a: 18, d: 13.7 }, { page: 2, e: 90, f: 400, a: 144, d: 108 }] },
    { page: 3, ops: [{ page: 3, e: 99, f: 742, a: 18, d: 13.7 }, { page: 3, e: 50, f: 50, a: 28.8, d: 21.6 }] },
  ])
  const body = bodyFigureOps(g)
  assert.equal(body.length, 2) // the two real figures
  assert.equal(body[0].page, 1)
  assert.equal(body[1].page, 2)
})

// ---------------------------------------------------------------------------
// exact resolution
// ---------------------------------------------------------------------------

test('exact bbox from authoritative image_index (body order agrees)', () => {
  const g = geometry([{ page: 2, ops: [{ page: 2, e: 198, f: 538.4, a: 216, d: 162 }] }])
  const r = resolveFigureOutline({ finding: finding('IMAGE_CAPTION_MISSING', 0), geometry: g, pageNumber: 2 })
  const rect = exact(r)
  assert.equal(r.label, 'Figure 1')
  assert.equal(r.pageNumber, 2)
  assert.equal(r.message, null)
  assert.ok(Math.abs(rect.x - 198 / 612) < 1e-6)
  assert.ok(Math.abs(rect.y - 538.4 / 792) < 1e-6)
  assert.ok(Math.abs(rect.width - 216 / 612) < 1e-6)
  assert.ok(Math.abs(rect.height - 162 / 792) < 1e-6)
})

test('multiple figures on one page resolve by operator order', () => {
  const g = geometry([
    {
      page: 2,
      ops: [
        { page: 2, e: 100, f: 600, a: 216, d: 162 },
        { page: 2, e: 300, f: 400, a: 144, d: 108 },
      ],
    },
  ])
  const r1 = resolveFigureOutline({ finding: finding('IMAGE_ALT_TEXT_MISSING', 0), geometry: g, pageNumber: 2 })
  const r2 = resolveFigureOutline({ finding: finding('IMAGE_ALT_TEXT_MISSING', 1), geometry: g, pageNumber: 2 })
  assert.equal(exact(r1).x, 100 / 612)
  assert.equal(exact(r2).x, 300 / 612)
  assert.equal(r1.label, 'Figure 1')
  assert.equal(r2.label, 'Figure 2')
})

test('rotated + scaled figure yields the transformed axis-aligned bbox', () => {
  // 45° rotation, scaled by 133.7 — corners transform through the FULL CTM
  const s = 133.7
  const rot = Math.PI / 4
  const g = geometry([
    { page: 3, ops: [{ page: 3, e: 300, f: 400, a: Math.cos(rot) * s, b: Math.sin(rot) * s, c: -Math.sin(rot) * s, d: Math.cos(rot) * s }] },
  ])
  const r = resolveFigureOutline({ finding: finding('IMAGE_CAPTION_MISSING', 0), geometry: g, pageNumber: 3 })
  const rect = exact(r)
  const half = (Math.SQRT2 * s) / 2
  assert.ok(Math.abs(rect.x - (300 - half) / 612) < 1e-6)
  assert.ok(Math.abs(rect.width - (Math.SQRT2 * s) / 612) < 1e-6)
})

test('figure near the page boundary stays inside 0..1', () => {
  const g = geometry([{ page: 1, ops: [{ page: 1, e: 0, f: 0, a: 40, d: 40 }] }])
  const r = resolveFigureOutline({ finding: finding('MANUAL_CAPTION', 0), geometry: g, pageNumber: 1 })
  const rect = exact(r)
  assert.ok(rect.x >= 0 && rect.y >= 0)
  assert.ok(rect.x + rect.width <= 1.0001 && rect.y + rect.height <= 1.0001)
})

test('repeated header logo is never outlined (page message, no rect)', () => {
  const g = geometry([
    { page: 1, ops: [{ page: 1, e: 99, f: 742, a: 60, d: 45 }] },
    { page: 2, ops: [{ page: 2, e: 99, f: 742, a: 60, d: 45 }] },
  ])
  const r = resolveFigureOutline({ finding: finding('IMAGE_CAPTION_MISSING', 0), geometry: g, pageNumber: 2 })
  assert.equal(r.rect, null)
  assert.equal(r.label, 'Figure 1')
  assert.equal(r.pageNumber, 2)
  assert.equal(r.message, FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE)
})

test('decorative image is unavailable, never outlined', () => {
  const g = geometry([{ page: 1, ops: [{ page: 1, e: 50, f: 50, a: 28.8, d: 21.6 }] }])
  const r = resolveFigureOutline({ finding: finding('IMAGE_CAPTION_MISSING', 0), geometry: g, pageNumber: 1 })
  assert.equal(r.rect, null)
  assert.equal(r.message, FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE)
})

test('order mismatch: image_index beyond the body-op count is unavailable', () => {
  // only one body paint in the whole document — image_index 1 has no
  // operator to map to → unavailable, never guessed
  const g = geometry([{ page: 2, ops: [{ page: 2, e: 100, f: 600, a: 216, d: 162 }] }])
  const r = resolveFigureOutline({ finding: finding('IMAGE_CAPTION_MISSING', 1), geometry: g, pageNumber: 2 })
  assert.equal(r.rect, null)
  assert.equal(r.label, 'Figure 2')
  assert.equal(r.message, FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE)
})

test('no geometry / no page → unavailable with truthful message', () => {
  const r1 = resolveFigureOutline({ finding: finding('IMAGE_CAPTION_MISSING', 0), geometry: null, pageNumber: 2 })
  assert.equal(r1.rect, null)
  assert.equal(r1.message, FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE)
  const r2 = resolveFigureOutline({ finding: finding('IMAGE_CAPTION_MISSING', 0), geometry: [], pageNumber: 2 })
  assert.equal(r2.rect, null)
  assert.equal(r2.message, FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE)
})

test('missing/negative image_index → no claim at all', () => {
  const g = geometry([{ page: 1, ops: [{ page: 1, e: 100, f: 200, a: 216, d: 162 }] }])
  assert.deepEqual(resolveFigureOutline({ finding: { ruleCode: 'IMAGE_CAPTION_MISSING', location: {} }, geometry: g, pageNumber: 1 }), { rect: null, label: null, pageNumber: null, message: null })
  assert.deepEqual(resolveFigureOutline({ finding: finding('IMAGE_CAPTION_MISSING', -1), geometry: g, pageNumber: 1 }), { rect: null, label: null, pageNumber: null, message: null })
})

test('non-figure rules never produce an outline', () => {
  const g = geometry([{ page: 1, ops: [{ page: 1, e: 100, f: 200, a: 216, d: 162 }] }])
  assert.deepEqual(resolveFigureOutline({ finding: finding('TABLE_CAPTION_MISSING', 0), geometry: g, pageNumber: 1 }), { rect: null, label: null, pageNumber: null, message: null })
  assert.deepEqual(resolveFigureOutline({ finding: finding('FONT_SIZE', 0), geometry: g, pageNumber: 1 }), { rect: null, label: null, pageNumber: null, message: null })
})

test('snake_case rule_code (raw API shape) resolves identically', () => {
  const g = geometry([{ page: 1, ops: [{ page: 1, e: 198, f: 538.4, a: 216, d: 162 }] }])
  const raw = resolveFigureOutline({ finding: { rule_code: 'IMAGE_ALT_TEXT_MISSING', location: { image_index: 0 } }, geometry: g, pageNumber: 1 })
  const like = resolveFigureOutline({ finding: finding('IMAGE_ALT_TEXT_MISSING', 0), geometry: g, pageNumber: 1 })
  assert.deepEqual(raw, like)
  assert.ok(raw.rect)
})

test('IMAGE_CAPTION_MISSING and IMAGE_ALT_TEXT_MISSING both outline the FIGURE', () => {
  const g = geometry([{ page: 2, ops: [{ page: 2, e: 198, f: 538.4, a: 216, d: 162 }] }])
  const cap = resolveFigureOutline({ finding: finding('IMAGE_CAPTION_MISSING', 0), geometry: g, pageNumber: 2 })
  const alt = resolveFigureOutline({ finding: finding('IMAGE_ALT_TEXT_MISSING', 0), geometry: g, pageNumber: 2 })
  assert.ok(cap.rect && alt.rect)
  assert.deepEqual(cap.rect, alt.rect) // both outline the figure, not the caption
})

test('figure MANUAL_CAPTION navigates + may outline the figure (not caption text)', () => {
  const g = geometry([{ page: 2, ops: [{ page: 2, e: 198, f: 538.4, a: 216, d: 162 }] }])
  const r = resolveFigureOutline({ finding: finding('MANUAL_CAPTION', 0), geometry: g, pageNumber: 2 })
  assert.ok(r.rect, 'figure manual caption may outline the figure')
  assert.equal(r.label, 'Figure 1')
})

test('geometry is finite and non-degenerate or unavailable (never approximate)', () => {
  const degenerate = geometry([{ page: 1, ops: [{ page: 1, e: 100, f: 200, a: 0, d: 0 }] }])
  const r = resolveFigureOutline({ finding: finding('IMAGE_CAPTION_MISSING', 0), geometry: degenerate, pageNumber: 1 })
  assert.equal(r.rect, null)
  assert.equal(r.message, FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE)
})

test('geometryForPage returns null when the page is absent', () => {
  const g = geometry([{ page: 1, ops: [] }])
  assert.equal(geometryForPage(g, 1)?.pageNumber, 1)
  assert.equal(geometryForPage(g, 2), null)
  assert.equal(geometryForPage(null, 1), null)
})
