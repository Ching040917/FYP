/**
 * General paragraph-evidence contract — behavioral matrix (authoritative).
 *
 * Tier policy under test:
 * - Span tier: the four CITATION_* codes only, source-faithful snippet,
 *   single on-page occurrence, real pdf.js geometry.
 * - Paragraph tier: every other paragraph-scoped finding (all REFERENCE_*),
 *   via real line geometry. Long entry text never enters the span matcher.
 * - Root denial: missing_references_section === true → no overlay even
 *   with a valid paragraph_index.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolveCitationHighlight,
  CITATION_SPAN_CODES,
  DOCUMENT_ROOT_NO_OVERLAY_MESSAGE,
} from '../src/lib/pdf/citation-highlight.ts'
import {
  resolveParagraphEvidence,
  isDocumentLevelRoot,
  DOCUMENT_ROOT_NO_OVERLAY_MESSAGE as ROOT_MSG,
} from '../src/lib/pdf/paragraph-evidence.ts'
import { evidenceFamily } from '../src/lib/pdf/formatting-highlight.ts'
import { resolveFindingNavigation } from '../src/lib/pdf/finding-navigation.ts'
import type { BlockMapping, PageText, TextItemLike } from '../src/lib/pdf/paragraph-mapping.ts'

// ---------------------------------------------------------------------------
// synthetic bundle builders (no fixture filenames, authors, or prod indexes)
// ---------------------------------------------------------------------------

const word = (str: string, x: number, y: number): TextItemLike => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width: str.length * 5,
  height: 10,
})

function paraItems(text: string, y: number, x0 = 50): TextItemLike[] {
  let x = x0
  return text.split(' ').map((w) => {
    const it = word(w, x, y)
    x += w.length * 5 + 5
    return it
  })
}

function testPage(pageNumber: number, paras: string[]): { items: TextItemLike[]; def: PageText } {
  const items = paras.flatMap((p, i) => paraItems(p, 700 - i * 40))
  return {
    items,
    def: { pageNumber, lines: [], headerFooterLines: new Set(), items, pageWidth: 595, pageHeight: 842 },
  }
}

const BODY = 'See (Quinn, 2019) for detail.'
const INTRO = 'Introduction text here.'

const p1 = testPage(1, [INTRO, BODY])
const bundleOf = (
  pages: PageText[],
  blocks: { index: number; text: string }[],
  mapping: [number, number][],
) => ({
  pages,
  blocks,
  byIndex: new Map<number, BlockMapping>(
    mapping.map(([index, pageNumber]) => [
      index,
      { index, pageNumber, pageRange: null, paragraphOnPage: 1, confidence: 'exact' as const },
    ]),
  ),
})

const base = bundleOf([p1.def], [{ index: 0, text: INTRO }, { index: 1, text: BODY }], [[0, 1], [1, 1]])

const cit = (ruleCode: string, extra: Record<string, unknown> = {}) => ({
  id: `${ruleCode}-1`,
  ruleCode,
  message: "Citation 'Quinn (2019)' was found in text, but no matching entry was found.",
  actualValue: '(Quinn, 2019)',
  location: { paragraph_index: 1, ...(extra as object) },
})

// ---------------------------------------------------------------------------
// family routing (locked)
// ---------------------------------------------------------------------------

test('span tier admits exactly the four in-text citation codes', () => {
  assert.deepEqual(
    [...CITATION_SPAN_CODES].sort(),
    ['CITATION_MISMATCH', 'CITATION_REFERENCE_AMBIGUOUS', 'CITATION_REFERENCE_MISMATCH', 'CITATION_YEAR_SUFFIX_MISMATCH'].sort(),
  )
  for (const code of CITATION_SPAN_CODES) assert.equal(evidenceFamily(code), 'citation', code)
})

test('every REFERENCE_ code routes to the paragraph tier, never the span tier', () => {
  for (const code of [
    'REFERENCE_NOT_CITED',
    'REFERENCE_DUPLICATE',
    'REFERENCE_HEADING_TEXT',
    'REFERENCE_HEADING_BOLD',
    'REFERENCE_HEADING_ALIGNMENT',
    'REFERENCE_SECTION_NEW_PAGE',
    'REFERENCE_HANGING_INDENT',
    'REFERENCE_SPACE_BEFORE',
    'REFERENCE_SPACE_AFTER',
    'REFERENCE_FONT_FAMILY',
    'REFERENCE_FONT_SIZE',
    'REFERENCE_ALIGNMENT',
  ]) {
    assert.equal(evidenceFamily(code), 'reference', code)
    const r = resolveCitationHighlight(
      { id: 'x', ruleCode: code, message: 'm', actualValue: 'Quinn, A. (2019). Long entry text here.', location: { paragraph_index: 1 } },
      base,
    )
    assert.deepEqual(r, { rects: null, label: null, message: null }, `${code} never enters span matcher`)
  }
})

test('formatting and unrelated families are unchanged', () => {
  assert.equal(evidenceFamily('FONT_SIZE'), 'formatting')
  assert.equal(evidenceFamily('ALIGNMENT'), 'formatting')
  assert.equal(evidenceFamily('TABLE_CAPTION_MISSING'), 'none')
  assert.equal(evidenceFamily(null), 'none')
})

// ---------------------------------------------------------------------------
// span tier: the four citation codes
// ---------------------------------------------------------------------------

test('1 eligible per-citation mismatch yields an exact span overlay', () => {
  const r = resolveCitationHighlight(cit('CITATION_MISMATCH'), base)
  assert.ok(r.rects && r.rects.length > 0)
  assert.equal(r.label, '(Quinn, 2019)')
  assert.equal(r.message, null)
  for (const rect of r.rects) {
    assert.equal(rect.page, 1)
    assert.ok(rect.x >= 0 && rect.width > 0 && rect.x + rect.width <= 1.0001)
  }
})

test('2 year mismatch yields an exact span overlay', () => {
  const r = resolveCitationHighlight(cit('CITATION_REFERENCE_MISMATCH'), base)
  assert.ok(r.rects && r.rects.length > 0)
  assert.equal(r.label, '(Quinn, 2019)')
})

test('3 suffix mismatch yields an exact span overlay', () => {
  const r = resolveCitationHighlight(cit('CITATION_YEAR_SUFFIX_MISMATCH'), base)
  assert.ok(r.rects && r.rects.length > 0)
})

test('4 ambiguous citation may overlay the occurrence (manual review stays in Finding Details)', () => {
  const r = resolveCitationHighlight(cit('CITATION_REFERENCE_AMBIGUOUS'), base)
  assert.ok(r.rects && r.rects.length > 0)
})

// ---------------------------------------------------------------------------
// paragraph tier: reference entries, headings, formatting
// ---------------------------------------------------------------------------

test('5 uncited entry resolves to a paragraph envelope, never a span', () => {
  const entry = 'Quinn, A. (2019). Long uncited entry text here.'
  const pg = testPage(2, [entry])
  const b = bundleOf([pg.def], [{ index: 4, text: entry }], [[4, 2]])
  const r = resolveParagraphEvidence(
    { id: 'e1', ruleCode: 'REFERENCE_NOT_CITED', location: { paragraph_index: 4 } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.ok(r.pageRects.length > 0)
  assert.ok(r.pageRects.every((rect) => rect.page === 2))
  assert.ok((r.label ?? '').includes('Page 2'))
  assert.equal(r.message, null)
})

test('6 duplicate entry resolves to the primary paragraph only', () => {
  const entry = 'Quinn, A. (2019). Duplicated entry text here.'
  const pg = testPage(3, ['Other body text here.', entry])
  const b = bundleOf([pg.def], [{ index: 6, text: entry }], [[6, 3]])
  const r = resolveParagraphEvidence(
    { id: 'd1', ruleCode: 'REFERENCE_DUPLICATE', location: { paragraph_index: 6, entry_count: 2, paragraph_indexes: [5, 6] } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.ok(r.pageRects.length > 0)
  assert.ok(r.pageRects.every((rect) => rect.page === 3))
})

test('7 hanging-indent with multiple occurrences resolves to the first paragraph', () => {
  const entry = 'Quinn, A. (2019). Indent entry text here.'
  const pg = testPage(2, [entry])
  const b = bundleOf([pg.def], [{ index: 7, text: entry }], [[7, 2]])
  const r = resolveParagraphEvidence(
    { id: 'h1', ruleCode: 'REFERENCE_HANGING_INDENT', location: { paragraph_index: 7, occurrences: 3, paragraph_indexes: [7, 9, 11] } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.ok(r.pageRects.length > 0)
  assert.ok(r.pageRects.every((rect) => rect.page === 2))
})

test('8 heading finding resolves to a paragraph envelope', () => {
  const pg = testPage(4, ['References'])
  const b = bundleOf([pg.def], [{ index: 10, text: 'References' }], [[10, 4]])
  const r = resolveParagraphEvidence(
    { id: 't1', ruleCode: 'REFERENCE_HEADING_TEXT', location: { paragraph_index: 10 } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.ok(r.pageRects.length > 0)
  assert.ok((r.label ?? '').includes('Page 4'))
})

// ---------------------------------------------------------------------------
// root denial, legacy, missing geometry, cross-page, switching
// ---------------------------------------------------------------------------

test('root finding with a valid paragraph_index gets no overlay, only a truthful message', () => {
  const root = cit('CITATION_MISMATCH', { citation_count: 2, missing_references_section: true })
  assert.equal(isDocumentLevelRoot(root.location), true)
  assert.equal(ROOT_MSG, DOCUMENT_ROOT_NO_OVERLAY_MESSAGE)
  const span = resolveCitationHighlight(root, base)
  assert.deepEqual(span, { rects: null, label: null, message: DOCUMENT_ROOT_NO_OVERLAY_MESSAGE })
  const para = resolveParagraphEvidence({ id: root.id, ruleCode: root.ruleCode, location: root.location }, base)
  assert.equal(para.kind, 'none')
  assert.deepEqual(para.pageRects, [])
  assert.equal(para.message, DOCUMENT_ROOT_NO_OVERLAY_MESSAGE)
})

test('9 legacy message-only finding still resolves an overlay', () => {
  const narrPage = testPage(1, [INTRO, 'See Quinn (2019) for detail.'])
  const b = bundleOf(
    [narrPage.def],
    [{ index: 0, text: INTRO }, { index: 1, text: 'See Quinn (2019) for detail.' }],
    [[0, 1], [1, 1]],
  )
  const r = resolveCitationHighlight(
    { id: 'old', ruleCode: 'CITATION_MISMATCH', message: "Citation 'Quinn (2019)' was found in text.", actualValue: null, location: { paragraph_index: 1 } },
    b,
  )
  assert.ok(r.rects && r.rects.length > 0)
})

test('10 unmapped paragraph yields no overlay and text fallback navigation', () => {
  const r = resolveParagraphEvidence(
    { id: 'u1', ruleCode: 'REFERENCE_NOT_CITED', location: { paragraph_index: 99 } },
    base,
  )
  assert.equal(r.kind, 'none')
  assert.deepEqual(r.pageRects, [])
  const nav = resolveFindingNavigation({ id: 'u1', location: { paragraph_index: 99 } }, base.byIndex)
  assert.equal(nav.mode, 'text')
})

test('11 finding on another physical page resolves rects on that page', () => {
  const pg2 = testPage(2, [BODY])
  const b = bundleOf([p1.def, pg2.def], [{ index: 0, text: INTRO }, { index: 1, text: BODY }], [[0, 1], [1, 2]])
  const r = resolveCitationHighlight(cit('CITATION_MISMATCH'), b)
  assert.ok(r.rects && r.rects.length > 0)
  assert.ok(r.rects.every((rect) => rect.page === 2))
})

test('12 sequential resolutions are independent (no stale overlay state)', () => {
  const first = resolveCitationHighlight(cit('CITATION_MISMATCH'), base)
  const entry = 'Quinn, A. (2019). Long uncited entry text here.'
  const pg = testPage(2, [entry])
  const b = bundleOf([pg.def], [{ index: 4, text: entry }], [[4, 2]])
  const second = resolveParagraphEvidence(
    { id: 'e1', ruleCode: 'REFERENCE_NOT_CITED', location: { paragraph_index: 4 } },
    b,
  )
  const third = resolveCitationHighlight(cit('CITATION_MISMATCH'), base)
  assert.deepEqual(third, first)
  assert.ok(second.pageRects.length > 0)
})

// ---- secondary source guard: AuditPage wiring ----

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = readFileSync(resolve(ROOT, 'src/pages/AuditPage.tsx'), 'utf8')

test('AuditPage routes reference findings to the paragraph resolver with mutual clearing', () => {
  assert.match(PAGE, /evidenceKind === 'reference'/)
  assert.match(PAGE, /resolveParagraphEvidence\(findingLike, mappingBundle\)/)
  assert.match(PAGE, /clearCitationHighlight\(\)/)
  assert.match(PAGE, /clearFormattingHighlight\(\)/)
})
