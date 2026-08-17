/**
 * Formatting evidence highlight tests (Build 7) — pure logic.
 *
 * Run-level (FONT_CONSISTENCY / FONT_SIZE): exact text highlight only with
 * unambiguous run text evidence; otherwise paragraph-level marker with a
 * truthful message. Paragraph-level (ALIGNMENT / LINE_SPACING / SPACE_BEFORE
 * / SPACE_AFTER / HEADING_HIERARCHY): enclosing region from the mapped
 * paragraph's real line rectangles, one region per page portion.
 * Never guesses; never switches to Extracted Text when page mapping exists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveFormattingHighlight,
  paragraphRegion,
  enclose,
  evidenceFamily,
  evidenceBarOffsetPx,
  evidenceBarHeight,
  EVIDENCE_BAR_METRICS,
  RUN_FALLBACK_MESSAGE,
  REGION_UNAVAILABLE_MESSAGE,
  FORMATTING_RULES,
  type FormattingHighlightResult,
} from '../src/lib/pdf/formatting-highlight.ts'
import { normalizeText, type PageText, type TextItemLike } from '../src/lib/pdf/paragraph-mapping.ts'
import type { BlockMapping } from '../src/lib/pdf/paragraph-mapping.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const item = (str: string, x: number, y: number, width = str.length * 5): TextItemLike => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width,
  height: 10,
})

function page(pageNumber: number, items: TextItemLike[], width = 595, height = 842): PageText {
  return {
    pageNumber,
    lines: [],
    headerFooterLines: new Set(),
    items,
    pageWidth: width,
    pageHeight: height,
  }
}

function bundle(pages: PageText[], blocks: Array<{ index: number; text: string }>, pageOf: (i: number) => number) {
  const byIndex = new Map<number, BlockMapping>()
  for (const b of blocks) {
    byIndex.set(b.index, { index: b.index, pageNumber: pageOf(b.index), pageRange: null, paragraphOnPage: 1, confidence: 'exact' })
  }
  return { byIndex, pages, blocks }
}

const finding = (id: string, ruleCode: string, paragraphIndex: number, runIndex?: number) => ({
  id,
  ruleCode,
  location: runIndex !== undefined ? { paragraph_index: paragraphIndex, run_index: runIndex } : { paragraph_index: paragraphIndex },
})

const BODY = 'The quick brown fox jumps over the lazy dog near the river bank.'

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

test('evidenceFamily classifies rules correctly', () => {
  for (const rule of FORMATTING_RULES) assert.equal(evidenceFamily(rule), 'formatting')
  assert.equal(evidenceFamily('CITATION_MISMATCH'), 'citation')
  assert.equal(evidenceFamily('TABLE_CAPTION_MISSING'), 'none')
  assert.equal(evidenceFamily(null), 'none')
})

// ---------------------------------------------------------------------------
// run-level
// ---------------------------------------------------------------------------

test('run-level without run text on single-line paragraph → exact full-line highlight', () => {
  const pages = [page(1, [item(BODY, 100, 700)])]
  const b = bundle(pages, [{ index: 2, text: BODY }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'FONT_SIZE', 2, 0), b)
  assert.equal(r.kind, 'run') // single visible line = single text unit
  assert.equal(r.message, null)
  assert.equal(r.label, 'Font size · Paragraph 3, Run 1')
})

test('run-level without run text on multi-line paragraph → paragraph fallback', () => {
  const pages = [page(1, [item('First half of the paragraph.', 100, 700), item('Second half continues.', 100, 680)])]
  const text = 'First half of the paragraph. Second half continues.'
  const b = bundle(pages, [{ index: 2, text }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'FONT_SIZE', 2, 0), b)
  assert.equal(r.kind, 'paragraph')
  assert.ok(r.pageRects.length === 1)
  assert.equal(r.message, RUN_FALLBACK_MESSAGE)
  assert.equal(r.label, 'Font size · Paragraph 3, Run 1')
})

test('run-level with exact run text highlights only that run', () => {
  const pages = [page(1, [item(BODY, 100, 700)])]
  const b = bundle(pages, [{ index: 2, text: BODY }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'FONT_CONSISTENCY', 2, 1), b, 'quick brown fox')
  assert.equal(r.kind, 'run')
  assert.equal(r.message, null)
  assert.ok(r.pageRects.length === 1)
})

test('run text split across TextItems still matches', () => {
  const pages = [page(1, [item('quick', 100, 700), item(' brown', 130, 700)])]
  const b = bundle(pages, [{ index: 0, text: 'quick brown fox' }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'FONT_SIZE', 0, 0), b, 'quick brown')
  assert.equal(r.kind, 'run')
  assert.ok(r.pageRects.length === 1)
})

test('repeated ambiguous run text falls back to paragraph marker', () => {
  const pages = [page(1, [item('alpha beta and alpha beta again', 100, 700)])]
  const b = bundle(pages, [{ index: 0, text: 'alpha beta and alpha beta again' }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'FONT_SIZE', 0, 0), b, 'alpha beta')
  assert.equal(r.kind, 'paragraph') // ambiguous → paragraph fallback, never a guessed run
  assert.equal(r.message, RUN_FALLBACK_MESSAGE)
})

test('empty run text falls back to paragraph marker', () => {
  const pages = [page(1, [item(BODY, 100, 700)])]
  const b = bundle(pages, [{ index: 0, text: BODY }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'FONT_SIZE', 0, 2), b, '  ')
  assert.equal(r.kind, 'paragraph') // explicitly empty evidence is not eligible
  assert.equal(r.message, RUN_FALLBACK_MESSAGE)
})

test('image-only/empty paragraph has no region → truthful message', () => {
  const pages = [page(1, [item(BODY, 100, 700)])]
  const b = bundle(pages, [{ index: 3, text: '' }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'FONT_SIZE', 3, 0), b)
  assert.equal(r.kind, 'paragraph')
  assert.equal(r.pageRects.length, 0)
  assert.equal(r.message, REGION_UNAVAILABLE_MESSAGE)
})

// ---------------------------------------------------------------------------
// paragraph-level
// ---------------------------------------------------------------------------

test('alignment finding gets one enclosing paragraph region', () => {
  const pages = [page(1, [item(BODY, 100, 700)])]
  const b = bundle(pages, [{ index: 0, text: BODY }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'ALIGNMENT', 0), b)
  assert.equal(r.kind, 'paragraph')
  assert.equal(r.message, null)
  assert.ok(r.pageRects.length === 1)
  const rect = r.pageRects[0]
  // envelope covers the whole line with padding
  assert.ok(rect.width > (BODY.length * 5) / 595)
})

test('multi-line paragraph envelope spans all lines', () => {
  const p = page(1, [
    item('First line of the paragraph.', 100, 700),
    item('Second line continues.', 100, 680),
    item('Third line ends.', 100, 660),
  ])
  const text = 'First line of the paragraph. Second line continues. Third line ends.'
  const b = bundle([p], [{ index: 0, text }], () => 1)
  const r = paragraphRegion(b, 0)!
  assert.ok(r && r.length === 1)
  const h = r[0].height * 842
  assert.ok(h > 30, `envelope must cover 3 lines, got ${h}px`) // 3 lines ≈ 60pt
})

test('paragraph spanning two pages marks both portions', () => {
  const p1 = page(1, [item('Start of the long paragraph that', 100, 700)])
  const p2 = page(2, [item('continues on the next page here.', 100, 700)])
  const text = 'Start of the long paragraph that continues on the next page here.'
  const b = bundle([p1, p2], [{ index: 0, text }], () => 1)
  const r = paragraphRegion(b, 0)!
  assert.ok(r && r.length === 2, 'one region per page portion')
  assert.deepEqual(r.map((x) => x.page).sort(), [1, 2])
})

test('duplicate paragraph text → no region, truthful message', () => {
  const pages = [page(1, [item('repeat me please.', 100, 700)]), page(2, [item('repeat me please.', 100, 700)])]
  const b = bundle(pages, [{ index: 0, text: 'repeat me please.' }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'SPACE_BEFORE', 0), b)
  assert.equal(r.kind, 'paragraph')
  assert.equal(r.pageRects.length, 0)
  assert.equal(r.message, REGION_UNAVAILABLE_MESSAGE)
})

test('unavailable paragraph geometry keeps Rendered Pages decision', () => {
  // no mapping → kind 'none' (Extracted Text is genuinely the fallback)
  const pages = [page(1, [item(BODY, 100, 700)])]
  const b = { byIndex: new Map<number, BlockMapping>(), pages, blocks: [{ index: 0, text: BODY }] }
  const r = resolveFormattingHighlight(finding('f1', 'LINE_SPACING', 0), b)
  assert.deepEqual(r, { kind: 'none', pageRects: [], label: null, message: null })
})

test('space before/after and heading hierarchy are paragraph-level', () => {
  const pages = [page(1, [item('Chapter One', 100, 700)])]
  const blocks = [{ index: 0, text: 'Chapter One' }]
  const b = bundle(pages, blocks, () => 1)
  for (const rule of ['SPACE_BEFORE', 'SPACE_AFTER', 'HEADING_HIERARCHY', 'LINE_SPACING']) {
    const r = resolveFormattingHighlight(finding('f1', rule, 0), b)
    assert.equal(r.kind, 'paragraph', rule)
    assert.ok(r.pageRects.length === 1, rule)
  }
})

test('labels use user-facing names and one-based identity', () => {
  const pages = [page(1, [item(BODY, 100, 700)])]
  const b = bundle(pages, [{ index: 5, text: BODY }], () => 1)
  const run = resolveFormattingHighlight(finding('f1', 'FONT_SIZE', 5, 1), b)
  assert.equal(run.label, 'Font size · Paragraph 6, Run 2')
  const para = resolveFormattingHighlight(finding('f2', 'ALIGNMENT', 5), b)
  assert.equal(para.label, 'Alignment · Paragraph 6')
})

test('enclose pads and clamps the envelope', () => {
  const rects = [
    { page: 1, x: 0.1, y: 0.2, width: 0.4, height: 0.02 },
    { page: 1, x: 0.15, y: 0.22, width: 0.5, height: 0.02 },
  ]
  const e = enclose(rects, 595, 842)!
  assert.ok(e.x < 0.1 && e.y < 0.2) // padded outward
  assert.ok(e.x + e.width > 0.65 && e.y + e.height > 0.24)
  assert.ok(e.x >= 0 && e.y >= 0 && e.width <= 1 && e.height <= 1)
  assert.equal(enclose([], 595, 842), null)
})

test('findings sharing a paragraph reuse the same mapping page', () => {
  const pages = [page(1, [item('other content', 100, 700)]), page(2, [item(BODY, 100, 700)])]
  const blocks = [{ index: 3, text: BODY }]
  const b = bundle(pages, blocks, (i) => (i === 3 ? 2 : 1))
  const r1 = resolveFormattingHighlight(finding('a', 'FONT_SIZE', 3, 0), b)
  const r2 = resolveFormattingHighlight(finding('b', 'ALIGNMENT', 3), b)
  assert.ok(r1.pageRects.length >= 1 && r2.pageRects.length >= 1)
  assert.equal(r1.pageRects[0].page, 2)
  assert.equal(r2.pageRects[0].page, 2)
})

test('unmapped formatting finding yields none, never a fake page', () => {
  const pages = [page(1, [item(BODY, 100, 700)])]
  const b = bundle(pages, [{ index: 9, text: BODY }], (i) => (i === 9 ? 2 : 1))
  const r = resolveFormattingHighlight(finding('f1', 'ALIGNMENT', 9), b)
  assert.equal(r.kind, 'none')
})

// ---------------------------------------------------------------------------
// evidence-bar presentation (shared by exact-run and paragraph overlays)
// ---------------------------------------------------------------------------

test('evidence bar sits 4px left of the text rectangle with a visible gap', () => {
  // rect.x = 0.2 of a 595px-wide canvas → text starts at 119px
  const left = evidenceBarOffsetPx(0.2, 595)
  assert.equal(left, 119 - 4)
})

test('evidence bar gap is scale-invariant (pixel-based)', () => {
  // same normalized rect at 100% and 200% zoom — gap stays 4 CSS px
  const at100 = evidenceBarOffsetPx(0.2, 595)
  const at200 = evidenceBarOffsetPx(0.2, 1190)
  assert.equal(at200 - at100, 0.2 * 595) // only the text position scales
  assert.equal(at100, 0.2 * 595 - 4)
  assert.equal(at200, 0.2 * 1190 - 4)
})

test('near the page left edge the bar clamps instead of disappearing', () => {
  assert.equal(evidenceBarOffsetPx(0.001, 595), 0) // gap reduced, bar visible
  assert.equal(evidenceBarOffsetPx(0, 595), 0)
  assert.equal(evidenceBarOffsetPx(0.05, 595), 0.05 * 595 - 4) // normal gap resumes
})

test('no bar offset can be negative (no clipped marker)', () => {
  for (const x of [0, 0.0001, 0.0067, 0.5, 1]) {
    assert.ok(evidenceBarOffsetPx(x, 595) >= 0)
  }
  // canvas not yet sized: fall back to a positive gap
  assert.equal(evidenceBarOffsetPx(0.2, 0), 4)
})

test('evidence bar uses explicit translateY independent of zoom rounding', () => {
  assert.equal(EVIDENCE_BAR_METRICS.translateYPx, 3)
  assert.equal(EVIDENCE_BAR_METRICS.topInsetPx, 2)
  assert.equal(EVIDENCE_BAR_METRICS.bottomInsetPx, 3)
  assert.equal(EVIDENCE_BAR_METRICS.widthPx, 3)
})

test('evidence bar height is highlight height minus insets, floored positive', () => {
  // normal case: 20% height minus 5px
  assert.equal(evidenceBarHeight(20), 'max(3px, calc(20% - 5px))')
  // short highlight: floor keeps the marker visible and inside the box
  assert.equal(evidenceBarHeight(0.1), 'max(3px, calc(0.1% - 5px))')
  assert.ok(evidenceBarHeight(50).includes('- 5px'))
})

test('every formatting branch resolves pageRects with a bar-eligible kind', () => {
  // exact run, single-line shortcut, paragraph fallback, multi-line, and
  // cross-page all produce pageRects (each rendered with background + bar)
  const p1 = page(1, [item('Single line title here.', 100, 700)])
  const p2 = page(2, [item('Cross page part one that', 100, 700)])
  const p3 = page(3, [item('continues onto page three.', 100, 700)])
  const multi = page(4, [item('Line one.', 100, 700), item('Line two.', 100, 680)])
  const pages = [p1, p2, p3, multi]
  const crossText = 'Cross page part one that continues onto page three.'
  const multiText = 'Line one. Line two.'
  const cases = [
    { blocks: [{ index: 0, text: 'Single line title here.' }], pageOf: () => 1, rule: 'FONT_SIZE', para: 0 },
    { blocks: [{ index: 1, text: crossText }], pageOf: (i) => (i === 1 ? 2 : 1), rule: 'SPACE_AFTER', para: 1 },
    { blocks: [{ index: 2, text: multiText }], pageOf: () => 4, rule: 'ALIGNMENT', para: 2 },
  ]
  for (const c of cases) {
    const b = bundle(pages, c.blocks, c.pageOf)
    const r = resolveFormattingHighlight(finding('f1', c.rule, c.para), b)
    assert.ok(['run', 'paragraph'].includes(r.kind), `${c.rule} → ${r.kind}`)
    assert.ok(r.pageRects.length >= 1, `${c.rule} needs an overlay`)
  }
})

// ---------------------------------------------------------------------------
// single-line shortcut + header exclusion + chip invariant
// ---------------------------------------------------------------------------

test('single-line Title paragraph gets an exact full-title highlight', () => {
  const title = 'Academic Compliance Auditor'
  const pages = [page(1, [item(title, 90, 700)])]
  const b = bundle(pages, [{ index: 0, text: title }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'FONT_SIZE', 0, 0), b)
  assert.equal(r.kind, 'run') // complete paragraph text = the single visible line
  assert.equal(r.message, null)
  assert.equal(r.pageRects.length, 1)
})

test('multi-line paragraph does not take the single-line shortcut', () => {
  const pages = [page(1, [item('First line of a long paragraph.', 100, 700), item('Second line still continues.', 100, 680)])]
  const text = 'First line of a long paragraph. Second line still continues.'
  const b = bundle(pages, [{ index: 0, text }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'FONT_SIZE', 0, 0), b)
  assert.equal(r.kind, 'paragraph')
  assert.equal(r.message, RUN_FALLBACK_MESSAGE)
})

test('repeated header line does not poison paragraph evidence', () => {
  // 'Academic Compliance Auditor' repeats in the running header AND the
  // title — only the HEADER ITEM (index 0) is excluded positionally, so
  // the title stays unambiguous.
  const title = 'Academic Compliance Auditor'
  const pages = [
    {
      pageNumber: 1,
      lines: [{ text: normalizeText(title), y: 780 }],
      headerFooterLines: new Set([normalizeText(title)]),
      headerFooterItemIndices: new Set([0]),
      items: [
        item(title, 90, 780), // header
        item(title, 90, 700), // title paragraph
      ],
      pageWidth: 595,
      pageHeight: 842,
    },
  ]
  const b = bundle(pages, [{ index: 0, text: title }], () => 1)
  const r = resolveFormattingHighlight(finding('f1', 'FONT_SIZE', 0, 0), b)
  assert.equal(r.kind, 'run')
  assert.equal(r.pageRects.length, 1)
  assert.equal(r.message, null)
})

test('citation matching also excludes repeated header lines', async () => {
  const { matchCitationOnPage } = await import('../src/lib/pdf/citation-highlight.ts')
  const pages = [
    {
      pageNumber: 1,
      lines: [{ text: normalizeText('Garcia (2018)'), y: 780 }],
      headerFooterLines: new Set([normalizeText('Garcia (2018)')]),
      headerFooterItemIndices: new Set([0]),
      items: [
        item('Garcia (2018)', 90, 780), // header repeat
        item('Garcia (2018) argues', 90, 700), // body citation
      ],
      pageWidth: 595,
      pageHeight: 842,
    },
  ]
  const r = matchCitationOnPage(pages[0], 'Garcia (2018)')
  assert.ok(r && r.length === 1, 'header occurrence must be excluded')
})

test('chip never appears without an overlay or a limitation message', () => {
  // whenever the mapping exists, resolveFormattingHighlight returns either
  // pageRects or a truthful message — never an empty, silent result.
  const pages = [page(1, [item(BODY, 100, 700)])]
  const cases = [
    { blocks: [{ index: 0, text: BODY }], pageOf: () => 1, rule: 'ALIGNMENT', para: 0 },
    { blocks: [{ index: 1, text: '' }], pageOf: () => 1, rule: 'FONT_SIZE', para: 1 },
    { blocks: [{ index: 2, text: BODY }], pageOf: (i) => (i === 2 ? 2 : 1), rule: 'SPACE_BEFORE', para: 2 },
    { blocks: [{ index: 3, text: 'never on any page' }], pageOf: () => 1, rule: 'LINE_SPACING', para: 3 },
  ]
  for (const c of cases) {
    const b = bundle(pages, c.blocks, c.pageOf)
    const r = resolveFormattingHighlight(finding('f1', c.rule, c.para), b)
    assert.ok(['none', 'paragraph', 'run'].includes(r.kind), `${c.rule} kind`)
    if (r.kind !== 'none') {
      assert.ok(r.pageRects.length > 0 || r.message !== null, `${c.rule}: overlay or message required`)
      if (r.pageRects.length === 0) assert.ok(r.message !== null)
    }
  }
})
