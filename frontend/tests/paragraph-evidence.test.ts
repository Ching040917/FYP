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
  findBlockWindows,
  classifyOverlayLifecycle,
  AMBIGUOUS_REGION_MESSAGE,
  DOCUMENT_ROOT_NO_OVERLAY_MESSAGE as ROOT_MSG,
} from '../src/lib/pdf/paragraph-evidence.ts'
import { evidenceFamily, REGION_UNAVAILABLE_MESSAGE } from '../src/lib/pdf/formatting-highlight.ts'
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

test('AuditPage derives overlays from a single writer keyed on selection and mapping', () => {
  // Single-writer contract: only the derivation effect resolves overlays.
  assert.match(PAGE, /const applyOverlay = useCallback\(\(violation: Violation\)/)
  assert.match(PAGE, /applyOverlay\(paragraphSel\)/)
  assert.match(PAGE, /overlayGenRef\.current \+= 1/)
  assert.doesNotMatch(PAGE, /applyOverlay\(sel\)/)
  assert.doesNotMatch(PAGE, /applyOverlay\(violation\)/)
})

test('AuditPage clears stale overlays on selection change before resolving', () => {
  assert.match(PAGE, /overlaySelRef\.current !== paragraphSel\.id/)
})

// ---------------------------------------------------------------------------
// evidence-identity validation (A–I): text alone never proves a paragraph
// ---------------------------------------------------------------------------

const HEADING = 'References'
const ENTRY_A = 'Quinn, A. (2019). First entry text here.'
const ENTRY_B = 'Reyes, B. (2021). Second entry text here.'

test('A simple unique heading resolves a heading envelope', () => {
  const pg = testPage(1, [INTRO, HEADING, ENTRY_A])
  const b = bundleOf(
    [pg.def],
    [{ index: 0, text: INTRO }, { index: 1, text: HEADING }, { index: 2, text: ENTRY_A }],
    [[0, 1], [1, 1], [2, 1]],
  )
  const r = resolveParagraphEvidence(
    { id: 'h', ruleCode: 'REFERENCE_HEADING_TEXT', location: { paragraph_index: 1 } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.ok(r.pageRects.length > 0)
  assert.ok(r.pageRects.every((rect) => rect.page === 1))
})

test('B table content before the heading does not shift paragraph identity', () => {
  // Rendered table text sits between the body paragraph and the heading;
  // the heading word is unique, so the envelope still resolves.
  const items = [
    ...paraItems(INTRO, 700),
    ...paraItems('Smith 2020', 660),
    ...paraItems('Doe 2019', 640),
    ...paraItems(HEADING, 600),
    ...paraItems(ENTRY_A, 560),
  ]
  const def: PageText = { pageNumber: 1, lines: [], headerFooterLines: new Set(), items, pageWidth: 595, pageHeight: 842 }
  const b = bundleOf(
    [def],
    [{ index: 8, text: INTRO }, { index: 9, text: HEADING }, { index: 10, text: ENTRY_A }],
    [[8, 1], [9, 1], [10, 1]],
  )
  const r = resolveParagraphEvidence(
    { id: 'np', ruleCode: 'REFERENCE_SECTION_NEW_PAGE', location: { paragraph_index: 9 } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.ok(r.pageRects.length > 0)
  assert.ok(r.pageRects.every((rect) => rect.page === 1))
  // The envelope sits on the heading line, not on the table lines above.
  const midY = (r.pageRects[0].y + r.pageRects[0].height / 2) * 842
  assert.ok(midY < 640 && midY > 560, `envelope centers on heading line, got y=${midY}`)
})

test('B2 heading word repeated in table text without order proof stays truthful', () => {
  const items = [
    ...paraItems(INTRO, 700),
    ...paraItems('References cited', 660),
    ...paraItems(HEADING, 600),
    ...paraItems(ENTRY_A, 560),
  ]
  const def: PageText = { pageNumber: 1, lines: [], headerFooterLines: new Set(), items, pageWidth: 595, pageHeight: 842 }
  // No neighbor blocks: the heading word occurs twice with no order proof.
  const b = bundleOf([def], [{ index: 9, text: HEADING }], [[9, 1]])
  const r = resolveParagraphEvidence(
    { id: 'np2', ruleCode: 'REFERENCE_SECTION_NEW_PAGE', location: { paragraph_index: 9 } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.deepEqual(r.pageRects, [])
  assert.equal(r.ambiguous, true)
  assert.equal(r.message, AMBIGUOUS_REGION_MESSAGE)
})

test('C hanging-indent entry resolves over the entry, not a nearby label line', () => {
  const entry = 'Smith, J. (2020). Entry text here.'
  const decoy = 'Expected ACA result: check entry.'
  const items = [...paraItems(entry, 660), ...paraItems(decoy, 620)]
  const def: PageText = { pageNumber: 1, lines: [], headerFooterLines: new Set(), items, pageWidth: 595, pageHeight: 842 }
  const b = bundleOf(
    [def],
    [{ index: 6, text: INTRO }, { index: 7, text: entry }],
    [[6, 1], [7, 1]],
  )
  // The window provably starts at the entry's first word, past the decoy.
  const wins = findBlockWindows(items, entry, new Set(), 0, items.length - 1, 3)
  assert.equal(wins.length, 1)
  assert.equal(items[wins[0].start].str, 'Smith,')
  const r = resolveParagraphEvidence(
    { id: 'hi', ruleCode: 'REFERENCE_HANGING_INDENT', location: { paragraph_index: 7, occurrences: 2, paragraph_indexes: [7, 8] } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.ok(r.pageRects.length > 0)
  const midY = (r.pageRects[0].y + r.pageRects[0].height / 2) * 842
  assert.ok(midY > 620, `envelope centers on the entry line, got y=${midY}`)
})

test('C2 divergent rendered text with a decoy prefix match is rejected, never drawn', () => {
  // Rendered entry lost its punctuation; a short surviving prefix also
  // occurs in the decoy line. Full containment fails everywhere: no guess.
  const rendered = 'Smith J (2020) Entry text here'
  const decoy = 'Expected ACA result: Smith, J. entry.'
  const items = [...paraItems(rendered, 660), ...paraItems(decoy, 620)]
  const def: PageText = { pageNumber: 1, lines: [], headerFooterLines: new Set(), items, pageWidth: 595, pageHeight: 842 }
  const b = bundleOf(
    [def],
    [{ index: 6, text: INTRO }, { index: 7, text: 'Smith, J. (2020). Entry text here.' }],
    [[6, 1], [7, 1]],
  )
  const r = resolveParagraphEvidence(
    { id: 'hi2', ruleCode: 'REFERENCE_HANGING_INDENT', location: { paragraph_index: 7 } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.deepEqual(r.pageRects, [])
  assert.equal(r.message, REGION_UNAVAILABLE_MESSAGE)
})

test('D duplicate identical entries select the primary occurrence by rank', () => {
  const dup = 'Quinn, A. (2019). Same entry here.'
  const before = 'Body before entries here.'
  const after = 'Body after entries here.'
  const items = [...paraItems(before, 700), ...paraItems(dup, 660), ...paraItems(dup, 620), ...paraItems(after, 580)]
  const def: PageText = { pageNumber: 1, lines: [], headerFooterLines: new Set(), items, pageWidth: 595, pageHeight: 842 }
  const blocks = [
    { index: 4, text: before },
    { index: 5, text: dup },
    { index: 6, text: dup },
    { index: 7, text: after },
  ]
  const b = bundleOf([def], blocks, [[4, 1], [5, 1], [6, 1], [7, 1]])
  const first = resolveParagraphEvidence(
    { id: 'd1', ruleCode: 'REFERENCE_DUPLICATE', location: { paragraph_index: 5, entry_count: 2, paragraph_indexes: [5, 6] } },
    b,
  )
  const second = resolveParagraphEvidence(
    { id: 'd2', ruleCode: 'REFERENCE_DUPLICATE', location: { paragraph_index: 6, entry_count: 2, paragraph_indexes: [5, 6] } },
    b,
  )
  assert.ok(first.pageRects.length > 0 && second.pageRects.length > 0)
  const mid = (rs: { y: number; height: number }[]) => (rs[0].y + rs[0].height / 2) * 842
  assert.ok(Math.abs(mid(first.pageRects) - 665) < 20, 'primary duplicate centers on the first occurrence')
  assert.ok(Math.abs(mid(second.pageRects) - 625) < 20, 'second duplicate centers on the second occurrence')
  assert.ok(mid(first.pageRects) > mid(second.pageRects), 'rank order preserved')
})

test('D3 surplus identical occurrences beyond the group count stay truthful', () => {
  const dup = 'Quinn, A. (2019). Same entry here.'
  const items = [...paraItems(dup, 660), ...paraItems(dup, 620), ...paraItems(dup, 580)]
  const def: PageText = { pageNumber: 1, lines: [], headerFooterLines: new Set(), items, pageWidth: 595, pageHeight: 842 }
  const b = bundleOf(
    [def],
    [{ index: 5, text: dup }, { index: 6, text: dup }],
    [[5, 1], [6, 1]],
  )
  const r = resolveParagraphEvidence(
    { id: 'd3', ruleCode: 'REFERENCE_DUPLICATE', location: { paragraph_index: 5, entry_count: 2, paragraph_indexes: [5, 6] } },
    b,
  )
  assert.deepEqual(r.pageRects, [])
  assert.equal(r.ambiguous, true)
  assert.equal(r.message, AMBIGUOUS_REGION_MESSAGE)
})

test('E empty paragraphs cause no drift and no crash', () => {
  const pg = testPage(1, [INTRO, ENTRY_A, ENTRY_B])
  const b = bundleOf(
    [pg.def],
    [{ index: 3, text: '' }, { index: 4, text: INTRO }, { index: 5, text: '' }, { index: 6, text: ENTRY_A }, { index: 7, text: ENTRY_B }],
    [[4, 1], [6, 1], [7, 1]],
  )
  const r = resolveParagraphEvidence(
    { id: 'e', ruleCode: 'REFERENCE_NOT_CITED', location: { paragraph_index: 6 } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.ok(r.pageRects.length > 0)
  const empty = resolveParagraphEvidence(
    { id: 'e0', ruleCode: 'REFERENCE_NOT_CITED', location: { paragraph_index: 5 } },
    b,
  )
  assert.deepEqual(empty.pageRects, [])
})

test('G long wrapped entry yields one multi-line envelope over the target only', () => {
  const words = 'Quinn, A. (2019). A very long reference entry that wraps across several visual lines here.'.split(' ')
  const items = [...words.slice(0, 5).map((w, i) => word(w, 50 + i * 40, 660)), ...words.slice(5, 10).map((w, i) => word(w, 50 + i * 40, 640)), ...words.slice(10).map((w, i) => word(w, 50 + i * 40, 620))]
  const def: PageText = { pageNumber: 1, lines: [], headerFooterLines: new Set(), items, pageWidth: 595, pageHeight: 842 }
  const full = words.join(' ')
  const b = bundleOf([def], [{ index: 4, text: full }], [[4, 1]])
  const r = resolveParagraphEvidence(
    { id: 'g', ruleCode: 'REFERENCE_HANGING_INDENT', location: { paragraph_index: 4 } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.equal(r.pageRects.length, 1)
  assert.ok(r.pageRects[0].height * 842 > 40, 'envelope spans all three visual lines')
})

test('I same target across structurally different documents stays correct-or-truthful', () => {

  const plain = testPage(2, [ENTRY_A])
  const plainBundle = bundleOf([plain.def], [{ index: 4, text: ENTRY_A }], [[4, 2]])
  const tabledItems = [...paraItems('Smith 2020', 700), ...paraItems(ENTRY_A, 660)]
  const tabled: PageText = { pageNumber: 3, lines: [], headerFooterLines: new Set(), items: tabledItems, pageWidth: 595, pageHeight: 842 }
  const tabledBundle = bundleOf([tabled], [{ index: 4, text: ENTRY_A }], [[4, 3]])
  for (const [bundle, page] of [[plainBundle, 2], [tabledBundle, 3]] as const) {
    const r = resolveParagraphEvidence(
      { id: 'i', ruleCode: 'REFERENCE_NOT_CITED', location: { paragraph_index: 4 } },
      bundle,
    )
    if (r.pageRects.length > 0) {
      assert.ok(r.pageRects.every((rect) => rect.page === page), 'overlay only on the mapped page')
    } else {
      assert.ok(r.message !== null, 'truthful message when identity unprovable')
    }
  }
})

test('window starts at the target, never at a preceding paragraph (left-overshoot guard)', () => {
  // Real-doc regression: the heading item follows a body paragraph whose
  // accumulated text also covers the target. The window must start at the
  // heading item itself, or anchor bounds exclude the true paragraph.
  const items = [...paraItems('Body text before here.', 700), ...paraItems('References', 660)]
  const wins = findBlockWindows(items, 'References', new Set(), 0, items.length - 1, 3)
  assert.equal(wins.length, 1)
  assert.equal(items[wins[0].start].str, 'References')
})

test('header/footer glyphs never join evidence geometry', () => {  const items = [...paraItems(ENTRY_A, 660)]
  const hf = new Set([0, 1])
  const def: PageText = { pageNumber: 1, lines: [], headerFooterLines: new Set(), headerFooterItemIndices: hf, items, pageWidth: 595, pageHeight: 842 }
  const b = bundleOf([def], [{ index: 4, text: ENTRY_A }], [[4, 1]])
  const r = resolveParagraphEvidence(
    { id: 'hf', ruleCode: 'REFERENCE_NOT_CITED', location: { paragraph_index: 4 } },
    b,
  )
  // 'Quinn,' and 'A.' are header-flagged: full containment fails truthfully.
  assert.deepEqual(r.pageRects, [])
  assert.ok(r.message !== null)
})

// ---------------------------------------------------------------------------
// overlay lifecycle states (Phase 2): transient waits never persist failure
// ---------------------------------------------------------------------------

const life = (over: Record<string, unknown> = {}) =>
  classifyOverlayLifecycle({
    hasSelection: true,
    isParagraphTarget: true,
    previewRendered: true,
    mappingReady: true,
    pagesReady: true,
    hasRects: false,
    ambiguous: false,
    hasMessage: false,
    ...over,
  } as Parameters<typeof classifyOverlayLifecycle>[0])

test('1 selection before mapping ready waits; re-resolution follows readiness', () => {
  assert.equal(life({ mappingReady: false }), 'waiting_for_mapping')
  assert.equal(life({ mappingReady: true }), 'unavailable')
})

test('2 selection before PageText ready waits for page text', () => {
  assert.equal(life({ pagesReady: false }), 'waiting_for_page_text')
})

test('3 temporary failure never becomes a cached permanent state', () => {
  // Waiting inputs carry no rects and no message, yet classify as waiting —
  // never as unavailable.
  assert.equal(life({ mappingReady: false, hasRects: false, hasMessage: false }), 'waiting_for_mapping')
  assert.equal(life({ pagesReady: false, hasRects: false, hasMessage: false }), 'waiting_for_page_text')
})

test('4-7 resolved/unavailable/ambiguous/idle classification', () => {
  assert.equal(life({ hasRects: true }), 'resolved')
  assert.equal(life({ ambiguous: true }), 'ambiguous')
  assert.equal(life({ hasMessage: true }), 'unavailable')
  assert.equal(life({ hasRects: false, ambiguous: false, hasMessage: false }), 'unavailable')
  assert.equal(life({ hasSelection: false }), 'idle')
  assert.equal(life({ isParagraphTarget: false }), 'idle')
  assert.equal(life({ previewRendered: false }), 'idle')
})

test('8 rapid switching: classifier is a pure function of current inputs only', () => {
  // No history, no cache: the same waiting input always yields waiting,
  // regardless of any previous resolved result.
  assert.equal(life({ mappingReady: false }), 'waiting_for_mapping')
  assert.equal(life({ hasRects: true }), 'resolved')
  assert.equal(life({ mappingReady: false }), 'waiting_for_mapping')
})

// ---------------------------------------------------------------------------
// real-data regressions (owner documents, synthetic analogues — no fixture
// text, authors, or indexes from owner files are embedded below)
// ---------------------------------------------------------------------------

test('consolidated finding overlays its persisted primary, never a nearby correct entry', () => {
  // Analogue of the live dispute: a correctly formatted control entry sits
  // immediately before a group of violating paragraphs. The finding's
  // persisted primary is the first violating paragraph — the overlay must
  // cover it, never the nearby correct entry.
  const control = 'Complete control entry with correct formatting applied here.'
  const bad = 'Violating entry missing the required formatting value here.'
  const items = [...paraItems(control, 660), ...paraItems(bad, 620), ...paraItems(bad, 580)]
  const def: PageText = { pageNumber: 1, lines: [], headerFooterLines: new Set(), items, pageWidth: 595, pageHeight: 842 }
  const b = bundleOf(
    [def],
    [{ index: 4, text: control }, { index: 5, text: bad }, { index: 6, text: bad }],
    [[4, 1], [5, 1], [6, 1]],
  )
  const r = resolveParagraphEvidence(
    { id: 'prim', ruleCode: 'REFERENCE_HANGING_INDENT', location: { paragraph_index: 5, occurrences: 2, paragraph_indexes: [5, 6] } },
    b,
  )
  assert.equal(r.kind, 'paragraph')
  assert.ok(r.pageRects.length > 0)
  const midY = (r.pageRects[0].y + r.pageRects[0].height / 2) * 842
  assert.ok(midY < 660 && midY > 580, `envelope centers on the persisted primary, got y=${midY}`)
})

test('repeated identical citation falls back to the finding paragraph, never a guessed span', () => {
  // Analogue of the live Garcia case: the same citation string occurs in
  // the finding paragraph and in another paragraph on the page. The span
  // tier must decline; the paragraph tier must cover the finding's OWN
  // paragraph only.
  const para = 'Checking effort can be reduced (Quinn, 2019) argues the study.'
  const other = 'Another paragraph mentions the same source (Quinn, 2019) here.'
  const items = [...paraItems(para, 660), ...paraItems(other, 620)]
  const def: PageText = { pageNumber: 1, lines: [], headerFooterLines: new Set(), items, pageWidth: 595, pageHeight: 842 }
  const b = bundleOf([def], [{ index: 2, text: para }, { index: 3, text: other }], [[2, 1], [3, 1]])
  const span = resolveCitationHighlight(
    { id: 'q', ruleCode: 'CITATION_MISMATCH', message: "Citation 'Quinn (2019)' was found in text.", actualValue: '(Quinn, 2019)', location: { paragraph_index: 2 } },
    b,
  )
  assert.deepEqual(span.rects, null, 'ambiguous span is never guessed')
  const fb = resolveParagraphEvidence(
    { id: 'q', ruleCode: 'CITATION_MISMATCH', location: { paragraph_index: 2 } },
    b,
  )
  assert.ok(fb.pageRects.length > 0)
  const midY = (fb.pageRects[0].y + fb.pageRects[0].height / 2) * 842
  assert.ok(midY > 620, `fallback covers the finding paragraph, got y=${midY}`)
})

test('paragraph fallback is visually distinguishable from an exact span', () => {
  // The fallback label names the rule + paragraph location; it never
  // reuses the bare citation span text as its label.
  const r = resolveParagraphEvidence(
    { id: 'q', ruleCode: 'CITATION_MISMATCH', location: { paragraph_index: 1 } },
    base,
  )
  assert.ok(r.pageRects.length > 0)
  assert.ok(!(r.label ?? '').startsWith('(Quinn, 2019)'), `fallback label names paragraph evidence: ${r.label}`)
  assert.ok((r.label ?? '').includes('Page 1'))
})
