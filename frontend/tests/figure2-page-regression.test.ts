/**
 * Figure 2 page/bbox regression (Caption Fixture 3 defect) — production flow.
 *
 * API-shaped fixture mirroring the confirmed browser defect:
 *   - a header logo paints on every page but must NEVER consume a body
 *     image_index position;
 *   - Figure 1 (image_index 0) and Figure 2 (image_index 1) both sit on
 *     Page 2 with distinct bboxes;
 *   - Figure 2's explanatory text flows onto Page 3 — the host paragraph
 *     maps to Page 3 and must NOT determine Figure 2's identity;
 *   - IMAGE_CAPTION_MISSING and IMAGE_ALT_TEXT_MISSING for image_index 1
 *     must reuse the SAME Page 2 mapping and the SAME exact bbox;
 *   - unavailable operator evidence stays unavailable — adjacent prose is
 *     never used to guess a page.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveObjectSelection, getObjectNavigation } from '../src/lib/pdf/object-navigation.ts'
import { mapBlocksToPages, normalizeText, type PageText } from '../src/lib/pdf/paragraph-mapping.ts'
import { resolveFigureOutline, figurePageForIndex, FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE } from '../src/lib/pdf/figure-bbox.ts'
import type { PageGeometry, DetailedImageOp } from '../src/lib/pdf/pdf-text-extract.ts'

const page = (pageNumber: number, texts: string[]): PageText => ({
  pageNumber,
  lines: texts.map((t) => ({ text: normalizeText(t), y: 100 })),
  headerFooterLines: new Set(),
  items: texts.map((t, i) => ({ str: t, transform: [1, 0, 0, 1, 90, 700 - i * 20], width: t.length * 5, height: 10 })),
  pageWidth: 595,
  pageHeight: 842,
})

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

/**
 * Caption Fixture 3 geometry:
 *   - page 1: header logo (60x45 at 99,742 — repeated on every page);
 *   - page 2: Figure 1 (216x162 at 198,538.4) then Figure 2 (144x108 at
 *     300,400);
 *   - page 3: logo only (explanatory text is TEXT, not an image op).
 * Body ops after exclusion = [Figure 1, Figure 2] — logo never consumes an
 * index, so image_index 0 → Figure 1, image_index 1 → Figure 2.
 */
function fixtureGeometry(): PageGeometry[] {
  const logo: Partial<DetailedImageOp> & { page: number } = { page: 1, e: 99, f: 742, a: 60, d: 45 }
  return [
    { pageNumber: 1, rotation: 0, pageWidth: 612, pageHeight: 792, imageOps: [op({ ...logo, page: 1 })], segments: [] },
    {
      pageNumber: 2,
      rotation: 0,
      pageWidth: 612,
      pageHeight: 792,
      imageOps: [
        op({ ...logo, page: 2 }),
        op({ page: 2, e: 198, f: 538.4, a: 216, d: 162 }), // Figure 1
        op({ page: 2, e: 300, f: 400, a: 144, d: 108 }), // Figure 2
      ],
      segments: [],
    },
    { pageNumber: 3, rotation: 0, pageWidth: 612, pageHeight: 792, imageOps: [op({ ...logo, page: 3 })], segments: [] },
  ]
}

/**
 * Paragraph bundle: the empty image-host paragraphs are unmapped (null);
 * Figure 2's explanatory text paragraph maps to Page 3 — this is the trap
 * the defect fell into (host page 3 ≠ figure page 2).
 */
function fixtureBundle(geometry: PageGeometry[]) {
  const pages = [
    page(1, ['Chapter One']),
    page(2, ['Figure 1: Growth chart']),
    page(3, ['Figure 2 explanatory text continues onto this page.']),
  ]
  const blocks = [
    { index: 0, text: 'Chapter One' },
    { index: 1, text: '' }, // image host 1 (unmapped)
    { index: 2, text: 'Figure 1: Growth chart' },
    { index: 3, text: '' }, // image host 2 (unmapped)
    { index: 4, text: 'Figure 2 explanatory text continues onto this page.' }, // maps to page 3
  ]
  const mapping = mapBlocksToPages(blocks, pages)
  return {
    byIndex: new Map(mapping.map((m) => [m.index, m])),
    pages,
    blocks,
    geometry,
  }
}

const violation = (ruleCode: string, imageIndex: number, paragraphIndex: number, id: string) => ({
  id,
  rule_code: ruleCode,
  severity: 'MINOR' as const,
  location: { image_index: imageIndex, paragraph_index: paragraphIndex },
  message: 'backend message',
  expected_value: null,
  actual_value: null,
})

let auditSeq = 0
const nextAudit = () => `cf3-${++auditSeq}`

test('CF3: Figure 1 and Figure 2 both map to Page 2 via operator order (logo excluded)', () => {
  const g = fixtureGeometry()
  const b = fixtureBundle(g)
  // header logo never consumes an index: image_index 0 = Figure 1, 1 = Figure 2
  assert.equal(figurePageForIndex(g, 0), 2)
  assert.equal(figurePageForIndex(g, 1), 2)

  const f1 = violation('IMAGE_CAPTION_MISSING', 0, 1, 'f1')
  const f2 = violation('IMAGE_CAPTION_MISSING', 1, 3, 'f2')
  const sel1 = resolveObjectSelection(nextAudit(), f1, b)
  const sel2 = resolveObjectSelection(nextAudit(), f2, b)
  assert.deepEqual(sel1.status, { label: 'Figure 1 · Page 2', message: null })
  assert.equal(sel1.navigatePage, 2)
  // THE DEFECT: host paragraph maps to page 3, but operator geometry wins
  assert.deepEqual(sel2.status, { label: 'Figure 2 · Page 2', message: null })
  assert.equal(sel2.navigatePage, 2)
})

test('CF3: both Figure 2 findings (caption + alt-text) reuse the SAME page and bbox', () => {
  const g = fixtureGeometry()
  const b = fixtureBundle(g)
  const audit = nextAudit()
  const cap = violation('IMAGE_CAPTION_MISSING', 1, 3, 'cap')
  const alt = violation('IMAGE_ALT_TEXT_MISSING', 1, 3, 'alt')

  const capSel = resolveObjectSelection(audit, cap, b)
  const altSel = resolveObjectSelection(audit, alt, b)
  assert.equal(capSel.navigatePage, 2)
  assert.equal(altSel.navigatePage, 2)
  assert.deepEqual(capSel.status, altSel.status)

  // exact bbox identical for both rule codes
  const capRect = resolveFigureOutline({ finding: { ruleCode: cap.rule_code, location: cap.location }, geometry: g, pageNumber: capSel.navigatePage })
  const altRect = resolveFigureOutline({ finding: { ruleCode: alt.rule_code, location: alt.location }, geometry: g, pageNumber: altSel.navigatePage })
  assert.ok(capRect.rect && altRect.rect)
  assert.deepEqual(capRect.rect, altRect.rect)
  // Figure 2 bbox: 144x108 at (300,400) — distinct from Figure 1's 216x162
  assert.ok(Math.abs(capRect.rect.x - 300 / 612) < 1e-6)
  assert.ok(Math.abs(capRect.rect.y - 400 / 792) < 1e-6)
})

test('CF3: Figure 1 and Figure 2 bboxes remain distinct', () => {
  const g = fixtureGeometry()
  const r1 = resolveFigureOutline({ finding: { ruleCode: 'IMAGE_CAPTION_MISSING', location: { image_index: 0, paragraph_index: 1 } }, geometry: g, pageNumber: 2 })
  const r2 = resolveFigureOutline({ finding: { ruleCode: 'IMAGE_CAPTION_MISSING', location: { image_index: 1, paragraph_index: 3 } }, geometry: g, pageNumber: 2 })
  assert.ok(r1.rect && r2.rect)
  assert.equal(r1.label, 'Figure 1')
  assert.equal(r2.label, 'Figure 2')
  assert.notDeepEqual(r1.rect, r2.rect)
  assert.ok(r1.rect!.x < r2.rect!.x, 'Figure 1 left of Figure 2')
})

test('CF3: header logo does not shift body-image indexes (row label correct)', () => {
  const g = fixtureGeometry()
  const b = fixtureBundle(g)
  const audit = nextAudit()
  const nav = getObjectNavigation(audit, { ruleCode: 'IMAGE_CAPTION_MISSING', location: { image_index: 1, paragraph_index: 3 } }, b)
  assert.equal(nav.label, 'Page 2 · Figure 2') // not "Figure 3" (logo consumed no index)
  assert.equal(nav.chipLabel, 'Figure 2 · Page 2')
})

test('CF3: adjacent prose on Page 3 never overrides exact operator evidence', () => {
  // host paragraph 4 maps to page 3 (explanatory text); the operator page
  // (2) must win for both row label and navigation
  const g = fixtureGeometry()
  const b = fixtureBundle(g)
  const audit = nextAudit()
  const nav = getObjectNavigation(audit, { ruleCode: 'IMAGE_ALT_TEXT_MISSING', location: { image_index: 1, paragraph_index: 4 } }, b)
  assert.equal(nav.pageNumber, 2)
  assert.equal(nav.mode, 'rendered')
  assert.equal(nav.evidenceMethod, 'image-op-order')
})

test('CF3: unavailable operator evidence stays unavailable — never guessed from prose', () => {
  // image_index 5 has NO body op (only 2 body figures exist) → unavailable,
  // even though its host paragraph maps to a real page
  const g = fixtureGeometry()
  const b = fixtureBundle(g)
  const audit = nextAudit()
  const nav = getObjectNavigation(audit, { ruleCode: 'IMAGE_CAPTION_MISSING', location: { image_index: 5, paragraph_index: 4 } }, b)
  assert.equal(nav.pageNumber, null)
  assert.equal(nav.mode, 'stable')
  assert.ok(nav.label!.includes('Page unavailable'))
  const outline = resolveFigureOutline({ finding: { ruleCode: 'IMAGE_CAPTION_MISSING', location: { image_index: 5, paragraph_index: 4 } }, geometry: g, pageNumber: null })
  assert.equal(outline.rect, null)
  assert.equal(outline.pageNumber, null) // no page → no claim at all
})

test('CF3: Figure 1 behavior is unchanged when geometry disagrees with host page', () => {
  // even if Figure 1's host paragraph mapped to page 1, the operator page 2
  // must win (exact operator geometry has priority)
  const g = fixtureGeometry()
  const pages = [
    page(1, ['Chapter One', 'Figure 1 host prose that flows oddly']),
    page(2, ['Figure 1: Growth chart']),
    page(3, ['Figure 2 explanatory text continues onto this page.']),
  ]
  const blocks = [
    { index: 0, text: 'Chapter One' },
    { index: 1, text: 'Figure 1 host prose that flows oddly' }, // maps page 1
    { index: 2, text: 'Figure 1: Growth chart' },
    { index: 3, text: '' },
    { index: 4, text: 'Figure 2 explanatory text continues onto this page.' },
  ]
  const mapping = mapBlocksToPages(blocks, pages)
  const b = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks, geometry: g }
  const audit = nextAudit()
  const nav = getObjectNavigation(audit, { ruleCode: 'IMAGE_CAPTION_MISSING', location: { image_index: 0, paragraph_index: 1 } }, b)
  assert.equal(nav.pageNumber, 2)
  assert.equal(nav.label, 'Page 2 · Figure 1')
})
