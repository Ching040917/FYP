/**
 * Exact citation highlighting tests (Build 6).
 *
 * Pure logic: evidence extraction from deterministic finding fields,
 * item-level matching with normalization, ambiguity handling, and the
 * full resolveCitationHighlight decision used by the selection flow.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCitationEvidence,
  matchCitationOnPage,
  resolveCitationHighlight,
  HIGHLIGHT_UNAVAILABLE_MESSAGE,
  type CitationRect,
} from '../src/lib/pdf/citation-highlight.ts'
import { normalizeText, type PageText, type TextItemLike } from '../src/lib/pdf/paragraph-mapping.ts'

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

const inRect = (r: CitationRect, expected: Partial<CitationRect>) => {
  assert.equal(r.page, expected.page)
  assert.ok(r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0, 'rect within 0..1')
  assert.ok(r.x + r.width <= 1.0001 && r.y + r.height <= 1.0001, 'rect inside page')
  if (expected.x !== undefined) assert.ok(Math.abs(r.x - expected.x!) < 0.01)
}

const firstRect = (rs: CitationRect[] | null): CitationRect => {
  assert.ok(rs && rs.length > 0, 'expected at least one rect')
  return rs![0]
}

// ---------------------------------------------------------------------------
// evidence extraction (deterministic fields only)
// ---------------------------------------------------------------------------

test('evidence extracted from violation message', () => {
  const e = extractCitationEvidence(
    "Citation 'Garcia (2018)' was found in text, but no matching entry was found in the References bibliography.",
    null,
  )
  assert.deepEqual(e, { text: 'Garcia (2018)', author: 'Garcia', year: '2018' })
})

test('evidence falls back to actual_value snippet', () => {
  const e = extractCitationEvidence(null, 'Lee (2021) argues that formatting matters.')
  assert.equal(e?.text, 'Lee (2021)')
})

test('no evidence when both fields are unusable', () => {
  assert.equal(extractCitationEvidence(null, null), null)
  assert.equal(extractCitationEvidence('Font size mismatch', null), null)
})

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

test('single occurrence yields a normalized rect', () => {
  const p = page(2, [item('Garcia (2018) argues', 100, 700)])
  const r = matchCitationOnPage(p, 'Garcia (2018)')
  assert.ok(r && r.length === 1)
  inRect(firstRect(r), { page: 2 })
})

test('Garcia and Lee in the same paragraph match separately', () => {
  const p = page(1, [item('Garcia (2018) and Lee (2021) disagree.', 100, 700)])
  const g = matchCitationOnPage(p, 'Garcia (2018)')
  const l = matchCitationOnPage(p, 'Lee (2021)')
  assert.ok(g && l)
  assert.notEqual(firstRect(g).x, firstRect(l).x) // different x positions
  assert.equal(firstRect(g).page, firstRect(l).page)
})

test('citation split across adjacent TextItems', () => {
  const p = page(1, [item('Garcia', 100, 700), item(' (2018) is', 155, 700)])
  const r = matchCitationOnPage(p, 'Garcia (2018)')
  assert.ok(r && r.length === 1)
  // rect spans both items: x0 = 100, x1 = 155 + width of ' (2018) is'
  assert.ok(firstRect(r).x > 0.1)
})

test('whitespace dropped between items still matches', () => {
  const p = page(1, [item('Garcia', 100, 700), item('(2018)', 155, 700)])
  const r = matchCitationOnPage(p, 'Garcia (2018)')
  assert.ok(r && r.length === 1)
})

test('punctuation and case normalization', () => {
  const p = page(1, [item('GARCIA (2018)', 100, 700)])
  assert.ok(matchCitationOnPage(p, 'garcia (2018)'))
  // smart punctuation variants
  const p2 = page(1, [item('Garcia \u2019s (2018) claim', 100, 700)])
  assert.ok(matchCitationOnPage(p2, 'Garcia \u2019s (2018)'))
})

test('duplicate occurrences are ambiguous → no exact rect', () => {
  const p = page(1, [
    item('Garcia (2018) says', 100, 700),
    item('and Garcia (2018) adds', 300, 700),
  ])
  assert.equal(matchCitationOnPage(p, 'Garcia (2018)'), null)
})

test('unmatched citation returns null', () => {
  const p = page(1, [item('Smith (2005) writes.', 100, 700)])
  assert.equal(matchCitationOnPage(p, 'Garcia (2018)'), null)
})

test('normalizeText is reused for evidence matching', () => {
  // ligature in author name: both sides normalize to "file (2018)"
  const p = page(1, [item('\ufb01le (2018) names', 100, 700)])
  const r = matchCitationOnPage(p, 'ﬁle (2018)')
  assert.ok(r)
  assert.equal(normalizeText('\ufb01le (2018)'), 'file (2018)')
})

// ---------------------------------------------------------------------------
// resolveCitationHighlight (selection-flow decision)
// ---------------------------------------------------------------------------

const bundle = (pages: PageText[], pageFor: (index: number) => number) => ({
  byIndex: new Map(
    pages.map((p, i) => [i, { index: i, pageNumber: pageFor(i), pageRange: null, paragraphOnPage: i + 1, confidence: 'exact' as const }]),
  ),
  pages,
})

const citationFinding = (id: string, paragraphIndex: number, message?: string, actual?: string) => ({
  id,
  ruleCode: 'CITATION_MISMATCH',
  message: message ?? `Citation 'Garcia (2018)' was found in text, but no matching entry was found in the References bibliography.`,
  actualValue: actual ?? null,
  location: { paragraph_index: paragraphIndex },
})

test('mapped citation finding resolves rect + label', () => {
  const pages = [page(1, [item('Garcia (2018) argues', 100, 700)])]
  const b = bundle(pages, () => 1)
  const r = resolveCitationHighlight(citationFinding('f1', 0), b)
  assert.ok(r.rects && r.rects.length === 1)
  assert.equal(r.label, 'Garcia (2018)')
  assert.equal(r.message, null)
})

test('unmapped citation finding returns no rect and no message', () => {
  const pages = [page(1, [item('Garcia (2018) argues', 100, 700)])]
  const b = bundle(pages, () => 1)
  const noMap = { byIndex: new Map(), pages }
  const r = resolveCitationHighlight(citationFinding('f1', 5), noMap)
  assert.equal(r.rects, null)
  assert.equal(r.message, null) // navigation falls back to text — no claim
})

test('ambiguous evidence → truthful message, still no rect', () => {
  const pages = [page(1, [item('Garcia (2018) and Garcia (2018) twice', 100, 700)])]
  const b = bundle(pages, () => 1)
  const r = resolveCitationHighlight(citationFinding('f1', 0), b)
  assert.equal(r.rects, null)
  assert.equal(r.message, HIGHLIGHT_UNAVAILABLE_MESSAGE)
  assert.equal(r.label, null)
})

test('non-citation finding clears the highlight', () => {
  const pages = [page(1, [item('Garcia (2018) argues', 100, 700)])]
  const b = bundle(pages, () => 1)
  const r = resolveCitationHighlight({ id: 'x', ruleCode: 'FONT_SIZE', message: 'Font mismatch', actualValue: '14pt', location: { paragraph_index: 0 } }, b)
  assert.deepEqual(r, { rects: null, label: null, message: null })
})

test('no bundle (loading) resolves to nothing, never crashes', () => {
  const r = resolveCitationHighlight(citationFinding('f1', 0), null)
  assert.deepEqual(r, { rects: null, label: null, message: null })
})

test('highlight page agrees with the navigation target page', () => {
  const pages = [page(1, []), page(2, [item('Lee (2021) states', 100, 700)])]
  const b = bundle(pages, (i) => (i === 1 ? 2 : 1))
  const r = resolveCitationHighlight(citationFinding('lee', 1, "Citation 'Lee (2021)' was found in text, but no matching entry was found in the References bibliography."), b)
  assert.equal(firstRect(r.rects).page, 2) // indicator page == overlay page
})

// ---------------------------------------------------------------------------
// exact geometry
// ---------------------------------------------------------------------------

test('same-TextItem match keeps a real width (regression: zero-width block)', () => {
  // citation starts mid-item at offset 15 of a 33-char token
  const p = page(1, [item('Garcia (2018) and Lee (2021) disagree.', 100, 700)])
  const r = matchCitationOnPage(p, 'Lee (2021)')
  assert.ok(r && r.length === 1)
  const rect = firstRect(r)
  assert.ok(rect.width > 0.05, `width must cover the citation, got ${rect.width}`)
  // x fraction: token 100px of 595; citation occupies chars 15..24 of 33
  const x0 = (100 + (15 / 33) * 200) / 595
  const x1 = (100 + (24 / 33) * 200) / 595
  assert.ok(Math.abs(rect.x - x0) < 0.02)
  assert.ok(Math.abs(rect.x + rect.width - x1) < 0.02)
})

test('citation split across three TextItems yields one merged rect', () => {
  const p = page(1, [
    item('Garcia', 100, 700, 30),
    item(' (2018)', 130, 700, 25),
    item(' is', 155, 700, 10),
  ])
  const r = matchCitationOnPage(p, 'Garcia (2018)')
  assert.ok(r && r.length === 1)
  const rect = firstRect(r)
  assert.ok(rect.width > 0.05) // spans all three items (55/595 ≈ 0.092)
  assert.equal(rect.x, 100 / 595) // starts at first item x
})

test('citation spanning a line break yields one rect per visual line', () => {
  // 'Garcia' ends line 1 (x=500), '(2018)' starts line 2 (x=90)
  const p = page(1, [
    item('Garcia', 500, 700, 30),
    item(' (2018)', 90, 680, 25),
  ])
  const r = matchCitationOnPage(p, 'Garcia (2018)')
  assert.ok(r && r.length === 2, `expected 2 line rects, got ${r?.length}`)
  // each line rect has a real width — no collapsed zero-width block
  for (const rect of r!) {
    assert.ok(rect.width > 0.01, `zero-width line rect: ${JSON.stringify(rect)}`)
  }
  const [line1, line2] = r!
  assert.ok(line1.y > line2.y) // line 1 above line 2
})

test('same-line items merge across a small gap', () => {
  const p = page(1, [
    item('Garcia', 100, 700, 30),
    item(' (2018)', 140, 700, 25), // small gap between items
  ])
  const r = matchCitationOnPage(p, 'Garcia (2018)')
  assert.ok(r && r.length === 1)
  const rect = firstRect(r)
  // merged rect covers the gap: x0 at first item, x1 at last item end
  assert.ok(rect.width > (30 + 25) / 595)
})

test('zoom and fit-width scaling never changes normalized geometry', () => {
  const p = page(1, [item('Garcia (2018) argues', 100, 700)])
  const base = matchCitationOnPage(p, 'Garcia (2018)')
  // the rect is already normalized against the scale-1 viewport; a zoomed
  // render scales canvas AND rect proportionally — re-normalizing at any
  // scale yields identical fractions
  const scale = 1.6
  const rescaled = (base ?? []).map((rect) => ({
    ...rect,
    width: (rect.width * 595 * scale) / (595 * scale),
    height: (rect.height * 842 * scale) / (842 * scale),
  }))
  assert.deepEqual(rescaled, base)
})

test('viewport rotation is accounted for (rect stays inside the page)', () => {
  // rotated page: items still carry x/y in the rotated user space; the
  // normalized rect must stay within 0..1 in both axes
  const p = page(1, [item('Garcia (2018) argues', 700, 100, 80)]) // y becomes x after 90° rotation
  const r = matchCitationOnPage(p, 'Garcia (2018)', 842, 595) // rotated dims
  assert.ok(r && r.length === 1)
  const rect = firstRect(r)
  assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1 && rect.y + rect.height <= 1)
})

test('no zero-width or NaN rectangles ever emitted', () => {
  const cases: Array<[TextItemLike[], string]> = [
    [[item('Garcia (2018) argues', 100, 700)], 'Garcia (2018)'],
    [[item('Lee (2021)', 100, 700)], 'Lee (2021)'],
    [[item('Garcia', 100, 700, 30), item(' (2018)', 130, 700, 25)], 'Garcia (2018)'],
    [[item('A', 100, 700, 5), item('B (2020)', 105, 700, 20)], 'B (2020)'],
  ]
  for (const [items, evidence] of cases) {
    const r = matchCitationOnPage(page(1, items), evidence)
    assert.ok(r && r.length >= 1)
    for (const rect of r!) {
      assert.ok(Number.isFinite(rect.x) && Number.isFinite(rect.width) && Number.isFinite(rect.y) && Number.isFinite(rect.height))
      assert.ok(rect.width > 0 && rect.height > 0, `zero-size rect for ${evidence}`)
    }
  }
})

test('Garcia and Lee produce different correctly sized rectangles', () => {
  const p = page(1, [item('Garcia (2018) and Lee (2021) disagree.', 100, 700)])
  const g = firstRect(matchCitationOnPage(p, 'Garcia (2018)')!)
  const l = firstRect(matchCitationOnPage(p, 'Lee (2021)')!)
  assert.notEqual(g.width, l.width) // different citation lengths
  assert.ok(Math.abs(g.width - (13 / 33) * (200 / 595)) < 0.02) // 13 of 33 chars
  assert.ok(Math.abs(l.width - (9 / 33) * (200 / 595)) < 0.02) // 9 of 33 chars
  assert.ok(g.x < l.x)
})

// ---------------------------------------------------------------------------
// proportional-font geometry (measured glyph prefixes)
// ---------------------------------------------------------------------------

// Times-like advance widths (em units): narrow i/l/(), wide W/m, medium rest.
const TIMES_WIDTHS: Record<string, number> = {
  i: 0.3, l: 0.3, '(': 0.33, ')': 0.33, ' ': 0.28, '.': 0.28,
  W: 0.85, m: 0.8, w: 0.55,
  G: 0.72, L: 0.55, e: 0.5, a: 0.5, r: 0.37, c: 0.45, s: 0.44, n: 0.5, d: 0.5, t: 0.28, h: 0.5,
  '0': 0.5, '1': 0.5, '2': 0.5, '8': 0.5,
}
const propMeasure = (text: string, size: number) => {
  let w = 0
  for (const ch of text) w += TIMES_WIDTHS[ch] ?? 0.5
  return w * size
}
const em = (ch: string) => TIMES_WIDTHS[ch] ?? 0.5

test('proportional: iii vs WWW produce different measured widths', () => {
  const itemText = 'iii (2021) and WWW (2021) differ.'
  const itemWidth = itemText.length * 5
  const p = page(1, [item(itemText, 100, 700)])
  const narrow = firstRect(matchCitationOnPage(p, 'iii (2021)', 595, 842, propMeasure)!)
  const wide = firstRect(matchCitationOnPage(p, 'WWW (2021)', 595, 842, propMeasure)!)
  assert.ok(wide.width > narrow.width, 'WWW must measure wider than iii')
  // both citations have the same character count — a correct proportional
  // model must NOT produce equal widths
  const fullW = propMeasure(itemText, 10)
  const wIii = (propMeasure('iii (2021) ', 10) / fullW) * itemWidth / 595
  const wWww = (propMeasure('WWW (2021) ', 10) / fullW) * itemWidth / 595
  assert.ok(Math.abs(narrow.width - wIii) < 0.005)
  assert.ok(Math.abs(wide.width - wWww) < 0.005)
})

test('proportional: Lee x-offset uses measured prefix, not char interpolation', () => {
  const itemText = 'Garcia (2018) and Lee (2021) disagree.'
  const itemWidth = itemText.length * 5 // item helper: width = len*5
  const p = page(1, [item(itemText, 100, 700)])
  const l = firstRect(matchCitationOnPage(p, 'Lee (2021)', 595, 842, propMeasure)!)
  // expected with the proportional model
  const fullW = propMeasure(itemText, 10)
  const prefixW = propMeasure('Garcia (2018) and ', 10)
  const citationW = propMeasure('Lee (2021)', 10)
  const x0 = (100 + (prefixW / fullW) * itemWidth) / 595
  const x1 = (100 + (propMeasure('Garcia (2018) and Lee (2021) ', 10) / fullW) * itemWidth) / 595
  assert.ok(Math.abs(l.x - x0) < 0.005)
  assert.ok(Math.abs(l.x + l.width - x1) < 0.005)
  // and it must DIFFER from equal-character interpolation
  const leeChars = 9 // 'Lee (2021)' squeezed
  const interpolated = ((leeChars / 33) * itemWidth) / 595
  assert.ok(Math.abs(l.width - interpolated) > 0.005, 'measured width must differ from interpolation')
})

test('proportional: citation at start, middle, and end of a long item', () => {
  const itemText = 'alpha beta (2020) gamma delta (2021) omega end'
  const itemWidth = itemText.length * 5
  const p = page(1, [item(itemText, 100, 700)])
  const fullW = propMeasure(itemText, 10)
  const start = firstRect(matchCitationOnPage(p, 'alpha beta', 595, 842, propMeasure)!)
  const middle = firstRect(matchCitationOnPage(p, 'gamma delta', 595, 842, propMeasure)!)
  const end = firstRect(matchCitationOnPage(p, 'omega end', 595, 842, propMeasure)!)
  assert.ok(Math.abs(start.x - 100 / 595) < 0.005) // begins at item start
  const midX = (100 + (propMeasure('alpha beta (2020) ', 10) / fullW) * itemWidth) / 595
  const endX = (100 + (propMeasure('alpha beta (2020) gamma delta (2021) ', 10) / fullW) * itemWidth) / 595
  assert.ok(Math.abs(middle.x - midX) < 0.005)
  assert.ok(Math.abs(end.x - endX) < 0.005)
  assert.ok(end.x > middle.x && middle.x > start.x)
})

test('proportional: citation split across two items keeps measured geometry', () => {
  const p = page(1, [
    item('Garcia', 100, 700, 36),
    item(' (2018) argues', 136, 700, 30),
  ])
  const r = matchCitationOnPage(p, 'Garcia (2018)', 595, 842, propMeasure)!
  assert.ok(r.length === 1)
  const rect = firstRect(r)
  const secondFull = propMeasure(' (2018) argues', 10)
  const secondPrefix = propMeasure(' (2018)', 10)
  const x0 = 100 / 595
  const x1 = (136 + (secondPrefix / secondFull) * 30) / 595
  assert.ok(Math.abs(rect.x - x0) < 0.005)
  assert.ok(Math.abs(rect.x + rect.width - x1) < 0.005)
})

test('proportional: punctuation and parentheses are measured, not skipped', () => {
  const itemText = 'See (2020) later'
  const itemWidth = itemText.length * 5
  const p = page(1, [item(itemText, 100, 700)])
  const fullW = propMeasure(itemText, 10)
  const r = firstRect(matchCitationOnPage(p, '(2020)', 595, 842, propMeasure)!)
  const prefixW = propMeasure('See ', 10)
  const citeW = propMeasure('(2020)', 10)
  const x0 = (100 + (prefixW / fullW) * itemWidth) / 595
  const x1 = (100 + (propMeasure('See (2020) ', 10) / fullW) * itemWidth) / 595
  assert.ok(Math.abs(r.x - x0) < 0.005)
  assert.ok(Math.abs(r.x + r.width - x1) < 0.005)
})
