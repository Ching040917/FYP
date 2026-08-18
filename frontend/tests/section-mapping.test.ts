/**
 * Section → page-range mapping unit tests (PoC).
 *
 * Pure logic: authoritative section_index, first/last eligible mapped
 * blocks, exact vs approximate vs unavailable, mid-page flags, monotonic
 * validation, and "never default to Page 1".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapSection, mapAllSections, type SectionMetadataLike } from '../src/lib/pdf/section-mapping.ts'
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

test('single section across three pages → exact 1..3', () => {
  const byIndex = mapping([[0, 1], [1, 1], [2, 2], [3, 3], [4, 3]])
  const r = mapSection({ sections: [sec({ section_index: 0, start_paragraph_index: 0 })], byIndex, numPages: 3 }, 0)
  assert.equal(r.confidence, 'exact')
  assert.equal(r.startPage, 1)
  assert.equal(r.endPage, 3)
  assert.deepEqual(r.affectedPages, [1, 2, 3])
  assert.equal(r.startsMidPage, false)
  assert.equal(r.endsMidPage, false)
})

test('single section is NOT auto Pages 1-N — needs both boundaries proven', () => {
  // only paragraph 2 maps to page 2; nothing proves page 1 or 3
  const byIndex = mapping([[0, null], [1, null], [2, 2], [3, null]])
  const r = mapSection({ sections: [sec({ section_index: 0, start_paragraph_index: 0 })], byIndex, numPages: 3 }, 0)
  assert.equal(r.startPage, 2)
  assert.equal(r.endPage, 2)
  assert.equal(r.confidence, 'exact') // both boundaries proven to same page
})

test('two next-page sections map distinct monotonic ranges', () => {
  const byIndex = mapping([[0, 1], [1, 1], [2, 1], [3, 2], [4, 2], [5, 3]])
  const sections = [
    sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 2 }),
    sec({ section_index: 1, start_paragraph_index: 3 }),
  ]
  const r0 = mapSection({ sections, byIndex, numPages: 3 }, 0)
  const r1 = mapSection({ sections, byIndex, numPages: 3 }, 1)
  assert.equal(r0.confidence, 'exact')
  assert.deepEqual([r0.startPage, r0.endPage], [1, 1])
  assert.deepEqual([r1.startPage, r1.endPage], [2, 3])
  assert.equal(r0.endPage! < r1.startPage!, true) // distinct, monotonic
})

test('continuous sections sharing one page set mid-page flags', () => {
  // section 0 ends on page 2; section 1 (continuous) starts on page 2
  const byIndex = mapping([[0, 1], [1, 2], [2, 2], [3, 3]])
  const sections = [
    sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1, break_type: 'nextPage' }),
    sec({ section_index: 1, start_paragraph_index: 2, break_type: 'continuous' }),
  ]
  const r0 = mapSection({ sections, byIndex, numPages: 3 }, 0)
  const r1 = mapSection({ sections, byIndex, numPages: 3 }, 1)
  assert.deepEqual([r0.startPage, r0.endPage], [1, 2])
  assert.deepEqual([r1.startPage, r1.endPage], [2, 3])
  assert.equal(r1.startsMidPage, true) // continuous shares page 2 with section 0
})

test('empty section with no eligible block → unavailable, never Page 1', () => {
  const byIndex = mapping([[0, 1], [1, null], [2, null]])
  const r = mapSection({ sections: [sec({ section_index: 1, start_paragraph_index: 1, end_paragraph_index: 2 })], byIndex, numPages: 3 }, 1)
  assert.equal(r.confidence, 'unavailable')
  assert.equal(r.startPage, null)
  assert.equal(r.endPage, null)
  assert.deepEqual(r.affectedPages, [])
  assert.notEqual(r.startPage, 1) // never default Page 1
})

test('table-only section uses verified object-page evidence', () => {
  const byIndex = mapping([[0, 1], [1, null], [2, null]]) // blocks 1-2 empty (table host)
  const objectPages = new Map<number, number>([[2, 2]]) // table block 2 verified on page 2
  const r = mapSection(
    { sections: [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 2 })], byIndex, objectPages, numPages: 3 },
    0,
  )
  assert.equal(r.confidence, 'exact')
  assert.equal(r.startPage, 1)
  assert.equal(r.endPage, 2)
})

test('approximate: proven start, unmapped end block after start', () => {
  // block 0 → page 1 (start proven); block 1 has content but is unmapped →
  // end evidence incomplete → approximate
  const byIndex = mapping([[0, 1], [1, null]])
  const blockTexts = new Map<number, string>([[0, 'Section start prose'], [1, 'Trailing prose that never matched']])
  const r = mapSection(
    { sections: [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 })], byIndex, blockTexts, numPages: 3 },
    0,
  )
  assert.equal(r.confidence, 'approximate')
  assert.equal(r.startPage, 1)
  assert.equal(r.endPage, null)
  assert.equal(r.ambiguityReason, 'end-boundary-unmapped')
})

test('reversed boundaries → unavailable', () => {
  // start block maps to page 3, end block to page 1 — impossible
  const byIndex = mapping([[0, 3], [1, null], [2, 1]])
  const r = mapSection({ sections: [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 2 })], byIndex, numPages: 3 }, 0)
  assert.equal(r.confidence, 'unavailable')
  assert.equal(r.ambiguityReason, 'start page after end page')
})

test('out-of-range page → unavailable', () => {
  const byIndex = mapping([[0, 5]]) // page 5 > numPages 3
  const r = mapSection({ sections: [sec({ section_index: 0, start_paragraph_index: 0 })], byIndex, numPages: 3 }, 0)
  assert.equal(r.confidence, 'unavailable')
  assert.equal(r.ambiguityReason, 'start page outside PDF')
})

test('non-monotonic sections do not collapse — later section before earlier', () => {
  const byIndex = mapping([[0, 2], [1, null], [2, 1]])
  const sections = [
    sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 }),
    sec({ section_index: 1, start_paragraph_index: 2 }),
  ]
  const r1 = mapSection({ sections, byIndex, numPages: 3 }, 1)
  assert.equal(r1.confidence, 'unavailable')
  assert.equal(r1.ambiguityReason, 'section range regresses before previous section')
})

test('unknown section index → unavailable', () => {
  const byIndex = mapping([[0, 1]])
  const r = mapSection({ sections: [sec({ section_index: 0 })], byIndex, numPages: 1 }, 4)
  assert.equal(r.confidence, 'unavailable')
  assert.equal(r.ambiguityReason, 'section index not found')
})

test('mapAllSections preserves order and distinct identities', () => {
  const byIndex = mapping([[0, 1], [1, 1], [2, 2]])
  const sections = [
    sec({ section_index: 1, start_paragraph_index: 2 }),
    sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1 }),
  ]
  const all = mapAllSections({ sections, byIndex, numPages: 2 })
  assert.deepEqual(all.map((r) => r.sectionIndex), [0, 1])
  assert.deepEqual(all.map((r) => [r.startPage, r.endPage]), [[1, 1], [2, 2]])
})

test('oddPage break does not override contradictory rendered evidence', () => {
  // oddPage suggests the section starts on an odd page, but rendered
  // evidence proves page 2 — evidence wins
  const byIndex = mapping([[0, 2], [1, 2]])
  const r = mapSection(
    { sections: [sec({ section_index: 0, start_paragraph_index: 0, end_paragraph_index: 1, break_type: 'oddPage' })], byIndex, numPages: 3 },
    0,
  )
  assert.equal(r.startPage, 2)
  assert.equal(r.confidence, 'exact')
})
