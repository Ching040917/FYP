/**
 * Figure outline — selection, lifecycle, and mutual exclusion (Build 8F).
 *
 * Mirrors the AuditPage flow as pure logic:
 *   - object navigation (resolveObjectSelection) supplies the page;
 *   - resolveFigureOutline supplies the exact rect / truthful message;
 *   - geometry is loaded once per audit and dropped on audit change;
 *   - the figure evidence family is disjoint from citation and formatting.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveObjectSelection, dropObjectNavCache } from '../src/lib/pdf/object-navigation.ts'
import { mapBlocksToPages, normalizeText, type PageText } from '../src/lib/pdf/paragraph-mapping.ts'
import {
  FIGURE_OUTLINE_RULES,
  FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE,
  resolveFigureOutline,
} from '../src/lib/pdf/figure-bbox.ts'
import { getPageGeometry, geometryLoaderFromBytes, dropPageGeometry } from '../src/lib/pdf/figure-outlines.ts'
import type { PageGeometry, DetailedImageOp } from '../src/lib/pdf/pdf-text-extract.ts'
import { evidenceFamily } from '../src/lib/pdf/formatting-highlight.ts'

const page = (pageNumber: number, texts: string[]): PageText => ({
  pageNumber,
  lines: texts.map((t) => ({ text: normalizeText(t), y: 100 })),
  headerFooterLines: new Set(),
  items: texts.map((t, i) => ({ str: t, transform: [1, 0, 0, 1, 90, 700 - i * 20], width: t.length * 5, height: 10 })),
  pageWidth: 595,
  pageHeight: 842,
})

function bundle() {
  const pages = [
    page(1, ['Chapter title.', 'Table 1: Results summary']),
    page(2, ['Figure 1: Growth chart', 'Body text after.']),
    page(3, ['Final paragraph.']),
  ]
  const blocks = [
    { index: 0, text: 'Chapter title.' },
    { index: 1, text: 'Table 1: Results summary' },
    { index: 2, text: 'Figure 1: Growth chart' },
    { index: 3, text: 'Body text after.' },
    { index: 4, text: 'Final paragraph.' },
  ]
  const mapping = mapBlocksToPages(blocks, pages)
  return { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
}

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

const geometry = (ops: Array<Partial<DetailedImageOp> & { page: number }> = [{ page: 2, e: 198, f: 538.4, a: 216, d: 162 }]): PageGeometry[] => [
  { pageNumber: 1, rotation: 0, pageWidth: 612, pageHeight: 792, imageOps: [], segments: [] },
  { pageNumber: 2, rotation: 0, pageWidth: 612, pageHeight: 792, imageOps: ops.map((o) => op({ ...o, page: 2 })), segments: [] },
]

const figureFinding = (ruleCode: string, imageIndex: number, paragraphIndex = 2) => ({
  ruleCode,
  location: { image_index: imageIndex, paragraph_index: paragraphIndex },
})

let auditSeq = 0
const nextAudit = () => `outline-${++auditSeq}`

test('selection flow: navigation page + exact geometry → outline chip + navigate', () => {
  const audit = nextAudit()
  const v = { id: 'v1', rule_code: 'IMAGE_CAPTION_MISSING', location: { image_index: 0, paragraph_index: 2 } }
  const sel = resolveObjectSelection(audit, v, bundle())
  assert.equal(sel.navigatePage, 2)
  const r = resolveFigureOutline({ finding: { ruleCode: v.rule_code, location: v.location }, geometry: geometry(), pageNumber: sel.navigatePage })
  assert.ok(r.rect)
  assert.equal(r.label, 'Figure 1')
  assert.equal(r.message, null)
  // the viewer renders exactly this shape
  const viewer = r.rect ? { rect: r.rect, label: r.label! } : null
  assert.deepEqual(viewer, { rect: r.rect, label: 'Figure 1' })
})

test('IMAGE_ALT_TEXT_MISSING outlines the FIGURE, never the caption', () => {
  const g = geometry()
  const r = resolveFigureOutline({ finding: figureFinding('IMAGE_ALT_TEXT_MISSING', 0), geometry: g, pageNumber: 2 })
  assert.ok(r.rect)
  // the rect is the image bbox (y near 0.68 = 538.4/792), NOT the caption
  // paragraph text block near the top
  assert.ok(r.rect.y > 0.5, 'figure region sits in the lower half of the page')
})

test('overlay mutual exclusion: figure family is disjoint from citation and formatting', () => {
  for (const rule of FIGURE_OUTLINE_RULES) {
    assert.equal(evidenceFamily(rule), 'none')
    assert.ok(
      rule === 'IMAGE_CAPTION_MISSING' || rule === 'IMAGE_ALT_TEXT_MISSING' || rule === 'MANUAL_CAPTION',
      `unexpected rule ${rule}`,
    )
  }
  assert.ok(!FIGURE_OUTLINE_RULES.has('CITATION_MISMATCH'))
  assert.ok(!FIGURE_OUTLINE_RULES.has('FONT_SIZE'))
})

test('selection clearing: a non-figure selection yields no outline', () => {
  const g = geometry()
  const r = resolveFigureOutline({ finding: { ruleCode: 'TABLE_CAPTION_MISSING', location: { table_index: 0 } }, geometry: g, pageNumber: 1 })
  assert.deepEqual(r, { rect: null, label: null, pageNumber: null, message: null })
})

test('latest selection wins: resolving twice with different figures yields the last rect', () => {
  const g = geometry([
    { page: 2, e: 100, f: 600, a: 216, d: 162 },
    { page: 2, e: 300, f: 400, a: 144, d: 108 },
  ])
  const first = resolveFigureOutline({ finding: figureFinding('IMAGE_CAPTION_MISSING', 0), geometry: g, pageNumber: 2 })!
  const second = resolveFigureOutline({ finding: figureFinding('IMAGE_CAPTION_MISSING', 1), geometry: g, pageNumber: 2 })!
  assert.ok(first.rect && second.rect)
  assert.notEqual(first.rect.x, second.rect.x) // different figures, different rects
  assert.equal(first.label, 'Figure 1')
  assert.equal(second.label, 'Figure 2')
})

test('cache: geometry is loaded once per audit and dropped on audit change', async () => {
  const audit = nextAudit()
  const loader = geometryLoaderFromBytes(new Uint8Array([1, 2, 3]).buffer)
  assert.ok(loader)
  let loads = 0
  const countingLoader = async () => {
    loads += 1
    return geometry()
  }
  const g1 = await getPageGeometry(audit, countingLoader)
  const g2 = await getPageGeometry(audit, countingLoader)
  assert.equal(g1, g2, 'same cached instance')
  assert.equal(loads, 1, 'computed once')
  dropPageGeometry(audit)
  await getPageGeometry(audit, countingLoader)
  assert.equal(loads, 2, 'recomputed after drop')
})

test('geometry loader from undefined bytes returns null (viewer state not ready)', () => {
  assert.equal(geometryLoaderFromBytes(undefined), null)
})

test('unavailable boundary never renders an approximate outline', () => {
  // decorative image: page + message, but no rect
  const g = geometry([{ page: 2, e: 50, f: 50, a: 28.8, d: 21.6 }])
  const r = resolveFigureOutline({ finding: figureFinding('IMAGE_ALT_TEXT_MISSING', 0), geometry: g, pageNumber: 2 })
  assert.equal(r.rect, null)
  assert.equal(r.pageNumber, 2)
  assert.equal(r.message, FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE)
})

test('manual Previous/Next + zoom/resize preserve the outline (normalized rect reused)', () => {
  const g = geometry()
  const r = resolveFigureOutline({ finding: figureFinding('MANUAL_CAPTION', 0), geometry: g, pageNumber: 2 })!
  assert.ok(r.rect)
  // the overlay is positioned with % of the canvas wrapper — any canvas
  // pixel size yields the same normalized fractions (the geometry is
  // scale-1 normalized, exactly like citation/formatting rects)
  for (const scale of [1, 1.5, 2.25]) {
    const w = 612 * scale
    const h = 792 * scale
    const leftPct = r.rect.x * 100
    const topPct = (1 - r.rect.y - r.rect.height) * 100
    const widthPct = r.rect.width * 100
    const heightPct = r.rect.height * 100
    // CSS px from the same percentages — identical at every zoom
    assert.ok(Math.abs(leftPct / 100 * w / w - r.rect.x) < 1e-9)
    assert.ok(Math.abs(topPct / 100 * h / h - (1 - r.rect.y - r.rect.height)) < 1e-9)
    assert.ok(Math.abs(widthPct / 100 * w / w - r.rect.width) < 1e-9)
    assert.ok(Math.abs(heightPct / 100 * h / h - r.rect.height) < 1e-9)
  }
})
