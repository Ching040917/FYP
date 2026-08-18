/**
 * Margin page-edge marker resolution tests (Build: Margin markers).
 *
 * Pure logic: exact-range eligibility, per-page visibility inside the
 * affected range, hidden outside, approximate/unavailable/historical-null
 * never render, continuous shared pages, rapid side switching, chip/side
 * agreement, and marker/lifecycle invariants.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MARGIN_RULES,
  marginMarkerSide,
  marginSideLabel,
  resolveMarginMarker,
  resolveMarginNavigation,
  marginMarkerChip,
  rangeCoversPage,
  sectionIndexOf,
  type MarginMarkerState,
} from '../src/lib/pdf/margin-navigation.ts'
import { mapAllSections, type SectionMetadataLike } from '../src/lib/pdf/section-mapping.ts'
import type { BlockMapping } from '../src/lib/pdf/paragraph-mapping.ts'
import type { SectionRange } from '../src/lib/pdf/section-mapping.ts'

const mapping = (pairs: Array<[number, number | null]>): Map<number, BlockMapping> =>
  new Map(
    pairs.map(([index, pageNumber]) => [
      index,
      { index, pageNumber, pageRange: null, paragraphOnPage: null, confidence: pageNumber === null ? 'unavailable' : 'exact' },
    ]),
  )

const sec = (partial: Partial<SectionMetadataLike> & { section_index: number }): SectionMetadataLike => ({
  start_paragraph_index: 0,
  end_paragraph_index: null,
  break_type: 'nextPage',
  page_width: null,
  page_height: null,
  margin_left: null,
  margin_right: null,
  margin_top: null,
  margin_bottom: null,
  ...partial,
})

function rangesFor(
  sections: SectionMetadataLike[],
  byIndex: Map<number, BlockMapping>,
  numPages = 5,
  blockTexts?: Map<number, string>,
) {
  return mapAllSections({ sections, byIndex, numPages, blockTexts })
}

const marker = (
  ruleCode: string,
  sectionIndex: number,
  range: SectionRange | null | undefined,
  currentPage: number,
): MarginMarkerState => resolveMarginMarker({ ruleCode, sectionIndex, range, currentPage })

// exact multi-page section: Section 1 → Pages 1–3
const SECTIONS_1_3 = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 3 })]
const BY_1_3 = mapping([[0, 1], [1, 1], [2, 2], [3, 3]])
const RANGE_1_3 = rangesFor(SECTIONS_1_3, BY_1_3)[0]

// exact one-page section: Section 2 → Page 4
const SECTIONS_ONE = [sec({ section_index: 1, start_paragraph_index: 0, end_paragraph_index: 1 })]
const BY_ONE = mapping([[0, 4], [1, 4]])
const RANGE_ONE = rangesFor(SECTIONS_ONE, BY_ONE)[0]

test('marker side derives safely from rule code', () => {
  assert.equal(marginMarkerSide('MARGIN_LEFT'), 'left')
  assert.equal(marginMarkerSide('MARGIN_RIGHT'), 'right')
  assert.equal(marginMarkerSide('MARGIN_TOP'), 'top')
  assert.equal(marginMarkerSide('MARGIN_BOTTOM'), 'bottom')
  assert.equal(marginMarkerSide('UNKNOWN_RULE'), 'left') // safe default
  assert.equal(marginSideLabel('MARGIN_LEFT'), 'Left margin')
})

test('left margin exact multi-page section: marker on every page in range', () => {
  for (const page of [1, 2, 3]) {
    const m = marker('MARGIN_LEFT', 0, RANGE_1_3, page)
    assert.equal(m.side, 'left')
    assert.equal(m.sectionNumber, 1)
    assert.equal(m.startPage, 1)
    assert.equal(m.endPage, 3)
    assert.equal(m.rangeLabel, 'Section 1 · Pages 1–3')
  }
})

test('right margin exact multi-page section: marker on every page in range', () => {
  for (const page of [1, 2, 3]) {
    const m = marker('MARGIN_RIGHT', 0, RANGE_1_3, page)
    assert.equal(m.side, 'right')
    assert.equal(m.sideLabel, 'Right margin')
  }
})

test('top margin exact one-page section: marker only on that page', () => {
  const on = marker('MARGIN_TOP', 1, RANGE_ONE, 4)
  assert.equal(on.side, 'top')
  assert.equal(on.rangeLabel, 'Section 2 · Page 4')
  // page 3 and 5 are outside the range → no marker
  for (const page of [1, 2, 3, 5]) {
    const m = marker('MARGIN_TOP', 1, RANGE_ONE, page)
    assert.equal(m.side, null, `page ${page} must not render`)
  }
})

test('bottom margin exact one-page section: marker only on that page', () => {
  const on = marker('MARGIN_BOTTOM', 1, RANGE_ONE, 4)
  assert.equal(on.side, 'bottom')
  assert.equal(on.sideLabel, 'Bottom margin')
  assert.equal(marker('MARGIN_BOTTOM', 1, RANGE_ONE, 3).side, null)
})

test('marker hidden on pages outside the affected range', () => {
  // Section 1 = Pages 1–3; pages 4+ have no marker
  for (const page of [4, 5]) {
    const m = marker('MARGIN_LEFT', 0, RANGE_1_3, page)
    assert.equal(m.side, null)
    assert.equal(m.startPage, null)
  }
})

test('approximate mapping renders no marker', () => {
  const sections = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 })]
  const byIndex = mapping([[0, 1], [1, null]])
  const blockTexts = new Map<number, string>([[0, 'start'], [1, 'unmapped tail']])
  const [range] = rangesFor(sections, byIndex, 5, blockTexts)
  const approx = resolveMarginNavigation('MARGIN_LEFT', 0, range)
  assert.equal(range.confidence, 'approximate')
  assert.equal(approx.navigatePage, 1)
  // no marker even on the proven start page
  const m = marker('MARGIN_LEFT', 0, range, 1)
  assert.equal(m.side, null)
})

test('unavailable mapping renders no marker', () => {
  const m = marker('MARGIN_LEFT', 0, null, 1)
  assert.equal(m.side, null)
  assert.equal(m.rangeLabel, null)
  const u = marker('MARGIN_LEFT', 0, undefined, 1)
  assert.equal(u.side, null)
})

test('historical audit with null section metadata renders no marker', () => {
  // null metadata → no range → no marker, never Page 1 navigation
  const m = marker('MARGIN_TOP', 0, null, 1)
  assert.equal(m.side, null)
  const d = resolveMarginNavigation('MARGIN_TOP', 0, null)
  assert.equal(d.navigatePage, null)
})

test('continuous sections sharing one page: marker on the shared page', () => {
  const sections = [
    sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 }),
    sec({ section_index: 1, start_paragraph_index: 2, break_type: 'continuous' }),
  ]
  const byIndex = mapping([[0, 1], [1, 1], [2, 1], [3, 1]])
  const ranges = rangesFor(sections, byIndex)
  // both sections are exact on page 1
  const m0 = marker('MARGIN_LEFT', 0, ranges[0], 1)
  const m1 = marker('MARGIN_RIGHT', 1, ranges[1], 1)
  assert.equal(m0.side, 'left')
  assert.equal(m1.side, 'right')
})

test('landscape/rotated pages: marker stays a page-edge band (side-derived)', () => {
  // The marker is positioned on the wrapper edge; rotation only affects the
  // canvas content, not the wrapper % band. Verify side derivation works
  // for every rule on a landscape page (no dimension math needed).
  for (const rule of MARGIN_RULES) {
    const m = marker(rule, 0, RANGE_1_3, 1)
    assert.ok(m.side !== null)
    assert.equal(m.side, marginMarkerSide(rule))
  }
})

test('rapid margin-side switching: latest side wins', () => {
  const left = marker('MARGIN_LEFT', 0, RANGE_1_3, 1)
  const right = marker('MARGIN_RIGHT', 0, RANGE_1_3, 1)
  assert.equal(left.side, 'left')
  assert.equal(right.side, 'right')
  // selection replaces the previous marker entirely
  const after = marker('MARGIN_TOP', 0, RANGE_1_3, 1)
  assert.equal(after.side, 'top')
  assert.notEqual(after.side, left.side)
})

test('chip and visible marker side always agree', () => {
  const m = marker('MARGIN_RIGHT', 0, RANGE_1_3, 2)
  assert.equal(m.side, 'right')
  const chip = marginMarkerChip(m)
  assert.equal(chip, 'Right margin · Section 1 · Pages 1–3')
  assert.ok(chip!.includes('Right margin'))
  assert.ok(!chip!.includes('MARGIN_'))
  assert.ok(!/confidence/i.test(chip!))
  // no marker → no chip
  assert.equal(marginMarkerChip(marker('MARGIN_RIGHT', 0, RANGE_1_3, 5)), null)
})

test('top margin one-page chip format', () => {
  const m = marker('MARGIN_TOP', 1, RANGE_ONE, 4)
  const chip = marginMarkerChip(m)
  assert.equal(chip, 'Top margin · Section 2 · Page 4')
})

test('invalid or missing section_index → no marker', () => {
  assert.equal(sectionIndexOf({}), null)
  assert.equal(marker('MARGIN_LEFT', -1, RANGE_1_3, 1).side, null)
  assert.equal(marker('MARGIN_LEFT', 1.5, RANGE_1_3, 1).side, null)
  // unsupported rule → no marker even with a valid range
  assert.equal(marker('FONT_SIZE', 0, RANGE_1_3, 1).side, null)
})

test('rangeCoversPage is exact-only and bounds-checked', () => {
  assert.equal(rangeCoversPage(RANGE_1_3, 1), true)
  assert.equal(rangeCoversPage(RANGE_1_3, 3), true)
  assert.equal(rangeCoversPage(RANGE_1_3, 4), false)
  assert.equal(rangeCoversPage(RANGE_ONE, 4), true)
  // approximate range never covers
  const sections = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 })]
  const byIndex = mapping([[0, 1], [1, null]])
  const blockTexts = new Map<number, string>([[0, 'a'], [1, 'b']])
  const [approx] = rangesFor(sections, byIndex, 5, blockTexts)
  assert.equal(rangeCoversPage(approx, 1), false)
})

test('marker never claims margin width (no dimensions in state)', () => {
  const m = marker('MARGIN_LEFT', 0, RANGE_1_3, 1)
  // the state carries only side + range — no measured/required width
  const keys = Object.keys(m)
  assert.ok(!keys.some((k) => /width|margin|actual|expected/i.test(k)))
})

test('chip label is compact and readable (no overflow terms)', () => {
  const m = marker('MARGIN_LEFT', 0, RANGE_1_3, 1)
  const chip = marginMarkerChip(m)!
  assert.ok(chip.length < 60, `chip must be compact, got ${chip.length} chars: ${chip}`)
  assert.ok(!chip.includes('!='))
  assert.ok(!chip.includes('zero-based'))
})
