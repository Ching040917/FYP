/**
 * Margin finding navigation tests (Build: Section page-range navigation).
 *
 * Pure logic: authoritative section_index, exact multi-page and one-page
 * ranges, continuous shared pages, approximate start-only, unavailable,
 * historical `sections == null`, friendly margin-side labels, one-based
 * numbering, and "unavailable never defaults to Page 1".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MARGIN_RULES,
  MARGIN_SIDE_LABELS,
  MARGIN_UNAVAILABLE_MESSAGE,
  MARGIN_APPROX_MESSAGE,
  resolveMarginNavigation,
  sectionIndexOf,
} from '../src/lib/pdf/margin-navigation.ts'
import { mapAllSections, type SectionMetadataLike } from '../src/lib/pdf/section-mapping.ts'
import {
  cacheSectionRanges,
  cachedSectionRanges,
  dropSectionRangeCache,
  sectionMapInput,
} from '../src/lib/pdf/section-cache.ts'
import type { BlockMapping } from '../src/lib/pdf/paragraph-mapping.ts'

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

// Build a SectionRange via the real mapper (same source as production).
function rangesFor(
  sections: SectionMetadataLike[],
  byIndex: Map<number, BlockMapping>,
  blockTexts?: Map<number, string>,
) {
  return mapAllSections({ sections, byIndex, numPages: 5, blockTexts })
}

const margin = (ruleCode: string, sectionIndex: number) => ({
  ruleCode,
  location: { section_index: sectionIndex },
})

test('margin side labels are friendly and one-based', () => {
  assert.equal(MARGIN_SIDE_LABELS.MARGIN_LEFT, 'Left margin')
  assert.equal(MARGIN_SIDE_LABELS.MARGIN_RIGHT, 'Right margin')
  assert.equal(MARGIN_SIDE_LABELS.MARGIN_TOP, 'Top margin')
  assert.equal(MARGIN_SIDE_LABELS.MARGIN_BOTTOM, 'Bottom margin')
  assert.equal(MARGIN_RULES.size, 4)
  for (const r of MARGIN_RULES) assert.ok(r.startsWith('MARGIN_'))
})

test('exact multi-page section navigates to start with full chip', () => {
  const sections = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 3 })]
  const byIndex = mapping([[0, 1], [1, 1], [2, 2], [3, 3]])
  const [r] = rangesFor(sections, byIndex)
  const d = resolveMarginNavigation('MARGIN_LEFT', 0, r)
  assert.equal(d.navigatePage, 1)
  assert.equal(d.chipLabel, 'Section 1 · Pages 1–3 · Left margin')
  assert.equal(d.message, null)
  assert.equal(d.rowLabel, 'Page 1 · Section 1 · Left margin')
})

test('exact one-page section uses singular Page label', () => {
  const sections = [sec({ section_index: 1, start_paragraph_index: 0, end_paragraph_index: 1 })]
  const byIndex = mapping([[0, 3], [1, 3]])
  const [r] = rangesFor(sections, byIndex)
  const d = resolveMarginNavigation('MARGIN_TOP', 1, r)
  assert.equal(d.navigatePage, 3)
  assert.equal(d.chipLabel, 'Section 2 · Page 3 · Top margin')
  assert.equal(d.message, null)
})

test('continuous sections sharing one page still navigate to shared start', () => {
  const sections = [
    sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 }),
    sec({ section_index: 1, start_paragraph_index: 2, break_type: 'continuous' }),
  ]
  const byIndex = mapping([[0, 1], [1, 1], [2, 1], [3, 1]])
  const ranges = rangesFor(sections, byIndex)
  const d = resolveMarginNavigation('MARGIN_RIGHT', 1, ranges[1])
  assert.equal(d.navigatePage, 1)
  assert.equal(d.chipLabel, 'Section 2 · Page 1 · Right margin')
})

test('approximate start-only range navigates with truthful message', () => {
  const sections = [sec({ section_index: 1, start_paragraph_index: 0, end_paragraph_index: 1 })]
  const byIndex = mapping([[0, 3], [1, null]]) // start proven, end block unmapped
  const blockTexts = new Map<number, string>([[0, 'start prose'], [1, 'trailing unmapped prose']])
  const [r] = rangesFor(sections, byIndex, blockTexts)
  assert.equal(r.confidence, 'approximate')
  const d = resolveMarginNavigation('MARGIN_BOTTOM', 1, r)
  assert.equal(d.navigatePage, 3)
  assert.equal(d.chipLabel, `Section 2 begins on Page 3 · ${MARGIN_APPROX_MESSAGE}`)
  assert.equal(d.message, MARGIN_APPROX_MESSAGE)
})

test('unavailable mapping keeps view stable, never Page 1', () => {
  const d = resolveMarginNavigation('MARGIN_LEFT', 0, null)
  assert.equal(d.navigatePage, null)
  assert.equal(d.chipLabel, null)
  assert.equal(d.message, 'Section 1 could not be located. The displayed page has not changed.')
  assert.notEqual(d.navigatePage, 1)
})

test('historical sections == null resolves unavailable, never infers whole PDF', () => {
  // No section metadata at all → every margin finding is unavailable.
  const d = resolveMarginNavigation('MARGIN_LEFT', 0, null)
  assert.equal(d.navigatePage, null)
  assert.equal(d.message, 'Section 1 could not be located. The displayed page has not changed.')
  // Section 1 is NOT auto-assumed to cover the whole PDF.
  const d1 = resolveMarginNavigation('MARGIN_RIGHT', 0, null)
  assert.equal(d1.navigatePage, null)
})

test('invalid or missing section_index → no navigation claim', () => {
  assert.equal(sectionIndexOf({}), null)
  assert.equal(sectionIndexOf({ section_index: -1 }), null)
  assert.equal(sectionIndexOf({ section_index: '1' }), null)
  assert.equal(sectionIndexOf({ section_index: 1.5 }), null)
  assert.equal(sectionIndexOf({ section_index: 0 }), 0)
  assert.equal(sectionIndexOf({ section_index: 4 }), 4)
})

test('multiple margin findings sharing one section reuse the same mapping', () => {
  const sections = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 2 })]
  const byIndex = mapping([[0, 1], [1, 2], [2, 2]])
  const [r] = rangesFor(sections, byIndex)
  const left = resolveMarginNavigation('MARGIN_LEFT', 0, r)
  const right = resolveMarginNavigation('MARGIN_RIGHT', 0, r)
  const top = resolveMarginNavigation('MARGIN_TOP', 0, r)
  const bottom = resolveMarginNavigation('MARGIN_BOTTOM', 0, r)
  // same start page, distinct side labels
  assert.equal(left.navigatePage, right.navigatePage)
  assert.equal(left.navigatePage, top.navigatePage)
  assert.equal(left.navigatePage, bottom.navigatePage)
  assert.match(left.chipLabel!, /Left margin$/)
  assert.match(right.chipLabel!, /Right margin$/)
  assert.match(top.chipLabel!, /Top margin$/)
  assert.match(bottom.chipLabel!, /Bottom margin$/)
})

test('one-based section and page numbers throughout', () => {
  const sections = [sec({ section_index: 2, start_paragraph_index: 0, end_paragraph_index: 1 })]
  const byIndex = mapping([[0, 4], [1, 5]])
  const [r] = rangesFor(sections, byIndex)
  const d = resolveMarginNavigation('MARGIN_LEFT', 2, r)
  assert.equal(d.chipLabel, 'Section 3 · Pages 4–5 · Left margin')
  assert.equal(d.navigatePage, 4)
})

test('session cache stores successes; drop on audit change', () => {
  const sections = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 })]
  const byIndex = mapping([[0, 1], [1, 2]])
  const ranges = rangesFor(sections, byIndex)
  cacheSectionRanges('audit-m', ranges)
  const hit = cachedSectionRanges('audit-m')
  assert.ok(hit)
  assert.equal(hit![0].confidence, 'exact')
  // another audit never sees this cache
  assert.equal(cachedSectionRanges('audit-other'), null)
  dropSectionRangeCache('audit-m')
  assert.equal(cachedSectionRanges('audit-m'), null)
})

test('cache never stores a failed/loading state (empty ranges)', () => {
  cacheSectionRanges('audit-empty', [])
  assert.equal(cachedSectionRanges('audit-empty'), null)
})

test('sectionMapInput rejects missing metadata, bundle, or page count', () => {
  assert.equal(sectionMapInput(null, mapping([[0, 1]]), 3), null)
  assert.equal(sectionMapInput([], mapping([[0, 1]]), 3), null)
  assert.equal(sectionMapInput([sec({ section_index: 0 })], new Map(), 3), null)
  assert.equal(sectionMapInput([sec({ section_index: 0 })], mapping([[0, 1]]), 0), null)
  assert.ok(sectionMapInput([sec({ section_index: 0 })], mapping([[0, 1]]), 3))
})

test('no raw internal terms leak into user-facing labels', () => {
  const sections = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 })]
  const byIndex = mapping([[0, 1], [1, 2]])
  const [r] = rangesFor(sections, byIndex)
  const d = resolveMarginNavigation('MARGIN_LEFT', 0, r)
  for (const s of [d.chipLabel, d.rowLabel, d.message]) {
    if (s) {
      assert.ok(!s.includes('!='))
      assert.ok(!s.includes('zero-based'))
      assert.ok(!/confidence/i.test(s))
      assert.ok(!/section_index/i.test(s))
    }
  }
  const u = resolveMarginNavigation('MARGIN_LEFT', 0, null)
  assert.ok(u.message!.includes('could not be located'))
  assert.ok(u.message!.includes('displayed page has not changed'))
})

// ---------------------------------------------------------------------------
// lifecycle: POST → GET must not lose sections (the AuditPage replaces the
// submit result with a later GET result). The pure analogue: resolve once
// with sections (POST), then re-resolve with the same sections (GET) — the
// range decision is identical, so no metadata is lost in the replacement.
// ---------------------------------------------------------------------------

test('lifecycle: POST-shaped then GET-shaped resolution keeps the same range', () => {
  const sections = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 2 })]
  const byIndex = mapping([[0, 1], [1, 2], [2, 2]])
  const postRanges = rangesFor(sections, byIndex) // POST: sections present
  const getRanges = rangesFor(sections, byIndex) // GET: same persisted sections
  const post = resolveMarginNavigation('MARGIN_TOP', 0, postRanges[0])
  const get = resolveMarginNavigation('MARGIN_TOP', 0, getRanges[0])
  assert.equal(get.navigatePage, post.navigatePage)
  assert.equal(get.chipLabel, post.chipLabel)
  assert.equal(get.chipLabel, 'Section 1 · Pages 1–2 · Top margin')
})

test('lifecycle: browser-refresh-shaped flow re-resolves from metadata', () => {
  // Refresh = a fresh GET with the SAME persisted sections → same range.
  const sections = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 2 })]
  const byIndex = mapping([[0, 1], [1, 2], [2, 2]])
  const ranges = rangesFor(sections, byIndex)
  const d = resolveMarginNavigation('MARGIN_LEFT', 0, ranges[0])
  assert.equal(d.navigatePage, 1)
  assert.equal(d.chipLabel, 'Section 1 · Pages 1–2 · Left margin')
})

test('lifecycle: History-shaped flow (reopen from list) keeps sections', () => {
  // History reopen = GET by id with persisted sections → identical decision.
  const sections = [
    sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 }),
    sec({ section_index: 1, start_paragraph_index: 2 }),
  ]
  const byIndex = mapping([[0, 1], [1, 1], [2, 2], [3, 2]])
  const ranges = rangesFor(sections, byIndex)
  const d = resolveMarginNavigation('MARGIN_BOTTOM', 1, ranges[1])
  assert.equal(d.navigatePage, 2)
  assert.equal(d.chipLabel, 'Section 2 · Page 2 · Bottom margin')
})

test('lifecycle: mapping waits for metadata, never caches a temporary absence', () => {
  // Before the GET arrives there is no metadata → unavailable (never Page 1).
  const before = resolveMarginNavigation('MARGIN_RIGHT', 0, null)
  assert.equal(before.navigatePage, null)
  assert.equal(before.message, 'Section 1 could not be located. The displayed page has not changed.')
  // Once metadata arrives, the SAME audit resolves exactly.
  const sections = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 })]
  const byIndex = mapping([[0, 1], [1, 2]])
  const ranges = rangesFor(sections, byIndex)
  const after = resolveMarginNavigation('MARGIN_RIGHT', 0, ranges[0])
  assert.equal(after.navigatePage, 1)
  assert.equal(after.chipLabel, 'Section 1 · Pages 1–2 · Right margin')
})

test('lifecycle: no stale section cache across audits', () => {
  const sectionsA = [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 })]
  const byIndexA = mapping([[0, 1], [1, 2]])
  const rangesA = rangesFor(sectionsA, byIndexA)
  cacheSectionRanges('audit-A', rangesA)
  assert.equal(cachedSectionRanges('audit-A')![0].startPage, 1)
  // audit-B starts fresh — never sees audit-A's ranges
  assert.equal(cachedSectionRanges('audit-B'), null)
  // dropping audit-A leaves B untouched
  dropSectionRangeCache('audit-A')
  assert.equal(cachedSectionRanges('audit-A'), null)
})
