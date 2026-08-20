/**
 * Sanitized real-document rendered-page regression (Build: location fixes).
 *
 * API-shaped fixture matching the real structure:
 *   - cover content;
 *   - field-based/invisible TOC with heading text duplicated;
 *   - first real Heading followed by unique BODY text;
 *   - later headings map correctly (monotonic);
 *   - multiple Sections with a shared rendered page;
 *   - section cache never stores temporary unavailable;
 *   - Profile selection never affects mapping.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapBlocksToPages, type PageText, type BlockLike } from '../src/lib/pdf/paragraph-mapping.ts'
import { mapAllSections, type SectionMetadataLike } from '../src/lib/pdf/section-mapping.ts'
import { cacheSectionRanges, cachedSectionRanges } from '../src/lib/pdf/section-cache.ts'
import { resolveMarginNavigation } from '../src/lib/pdf/margin-navigation.ts'

function page(pageNumber: number, texts: string[]): PageText {
  return {
    pageNumber,
    lines: texts.map((t) => ({ text: t.toLowerCase(), y: 100 })),
    headerFooterLines: new Set(),
  }
}

// Real structure: cover (p1), invisible/field TOC (p1), Section 1 = cover,
// Section 2 = academic content (p2-3), Section 3 = back matter (p3).
const PAGES: PageText[] = [
  page(1, ['the impact of artificial intelligence', 'on higher education', '1. introduction', '2. methods', '3. results']),
  page(2, ['abstract and admin content here', '1. introduction', 'this chapter explores datasets in depth.']),
  page(3, ['2. methods', 'the methodology section follows.', '3. results', 'results are presented here.', 'references']),
]

// Blocks mirror the real persisted document_blocks: cover, TOC entries,
// then the REAL headings (P14, P20, P25 zero-based → 13, 19, 24).
const BLOCKS: BlockLike[] = [
  { index: 0, text: 'THE IMPACT OF ARTIFICIAL INTELLIGENCE', role: 'COVER' },
  { index: 1, text: 'ON HIGHER EDUCATION', role: 'COVER' },
  { index: 2, text: 'Table of Contents', role: 'TABLE_OF_CONTENTS_HEADING' },
  { index: 3, text: '1. Introduction', role: 'TABLE_OF_CONTENTS_ENTRY' },
  { index: 4, text: '2. Methods', role: 'TABLE_OF_CONTENTS_ENTRY' },
  { index: 5, text: '3. Results', role: 'TABLE_OF_CONTENTS_ENTRY' },
  // Section break / empty boundary blocks.
  { index: 6, text: '', role: 'EMPTY' },
  // Real academic content.
  { index: 13, text: '1. Introduction', role: 'HEADING_1' },
  { index: 14, text: 'This chapter explores datasets in depth.', role: 'BODY' },
  { index: 19, text: '2. Methods', role: 'HEADING_1' },
  { index: 20, text: 'The methodology section follows.', role: 'BODY' },
  { index: 24, text: '3. Results', role: 'HEADING_1' },
  { index: 25, text: 'Results are presented here.', role: 'BODY' },
]

function mappingByIndex() {
  const mapping = mapBlocksToPages(BLOCKS, PAGES)
  return new Map(mapping.map((m) => [m.index, m]))
}

// ---------------------------------------------------------------------------
// Part A: heading page mapping (TOC vs body)
// ---------------------------------------------------------------------------

test('first academic Heading maps to the body occurrence, not the TOC', () => {
  const byIndex = mappingByIndex()
  const h1 = byIndex.get(13)!
  assert.equal(h1.confidence, 'exact')
  assert.equal(h1.pageNumber, 2) // body occurrence — NOT the TOC page 1
  assert.equal(h1.paragraphOnPage, 1) // first block on page 2
  // The body paragraph right after the heading maps to the same page.
  const body = byIndex.get(14)!
  assert.equal(body.pageNumber, 2)
})

test('later headings remain monotonic and correct', () => {
  const byIndex = mappingByIndex()
  assert.equal(byIndex.get(19)!.pageNumber, 3) // 2. Methods
  assert.equal(byIndex.get(20)!.pageNumber, 3) // its body
  assert.equal(byIndex.get(24)!.pageNumber, 3) // 3. Results
  assert.equal(byIndex.get(25)!.pageNumber, 3)
  // TOC entries stay on the TOC page, never claim the academic identity.
  assert.equal(byIndex.get(3)!.pageNumber, 1)
  assert.equal(byIndex.get(4)!.pageNumber, 1)
  assert.equal(byIndex.get(5)!.pageNumber, 1)
})

// ---------------------------------------------------------------------------
// Part B: Section page ranges
// ---------------------------------------------------------------------------

const SECTIONS: SectionMetadataLike[] = [
  { section_index: 0, start_paragraph_index: 0, end_paragraph_index: 5, break_type: 'nextPage',
    page_width: null, page_height: null, margin_left: null, margin_right: null, margin_top: null, margin_bottom: null },
  { section_index: 1, start_paragraph_index: 6, end_paragraph_index: 20, break_type: 'nextPage',
    page_width: null, page_height: null, margin_left: null, margin_right: null, margin_top: null, margin_bottom: null },
  { section_index: 2, start_paragraph_index: 21, end_paragraph_index: null, break_type: 'nextPage',
    page_width: null, page_height: null, margin_left: null, margin_right: null, margin_top: null, margin_bottom: null },
]

test('Section 1, 2, 3 ranges match independently prepared ground truth', () => {
  const byIndex = mappingByIndex()
  const numPages = PAGES.length // real PDF page count, not maxMapped
  const ranges = mapAllSections({ sections: SECTIONS, byIndex, numPages })
  const r0 = ranges.find((r) => r.sectionIndex === 0)!
  const r1 = ranges.find((r) => r.sectionIndex === 1)!
  const r2 = ranges.find((r) => r.sectionIndex === 2)!
  // Section 0 (cover/TOC) → page 1; Section 1 (academic) → pages 2-3;
  // Section 2 (back matter) → page 3. All exact, monotonic.
  assert.equal(r0.confidence, 'exact')
  assert.deepEqual([r0.startPage, r0.endPage], [1, 1])
  assert.equal(r1.confidence, 'exact')
  assert.deepEqual([r1.startPage, r1.endPage], [2, 3])
  assert.equal(r2.confidence, 'exact')
  assert.deepEqual([r2.startPage, r2.endPage], [3, 3])
})

test('numPages bound uses the real PDF page count, not maxMapped', () => {
  // If numPages were derived from maxMapped and the last page had unmapped
  // paragraphs, a real boundary on that page would be rejected. The real
  // page count (3) must be used.
  const byIndex = mappingByIndex()
  const ranges = mapAllSections({ sections: SECTIONS, byIndex, numPages: 3 })
  assert.equal(ranges.every((r) => r.confidence === 'exact'), true)
})

test('section cache never stores temporary unavailable', () => {
  const byIndex = mappingByIndex()
  const full = mapAllSections({ sections: SECTIONS, byIndex, numPages: 3 })
  assert.equal(full.every((r) => r.confidence !== 'unavailable'), true)
  cacheSectionRanges('audit-x', full)
  assert.equal(cachedSectionRanges('audit-x')!.length, 3)

  // A set with ANY unavailable section is never cached as final.
  const partial = full.map((r, i) => (i === 1 ? { ...r, confidence: 'unavailable' as const, startPage: null, endPage: null } : r))
  cacheSectionRanges('audit-y', partial)
  assert.equal(cachedSectionRanges('audit-y'), null)
})

test('section unavailable resolves margin navigation with stable message', () => {
  const byIndex = mappingByIndex()
  const ranges = mapAllSections({ sections: SECTIONS, byIndex, numPages: 3 })
  // Force section 1 unavailable to test the UX contract.
  const d = resolveMarginNavigation('MARGIN_LEFT', 1, null)
  assert.equal(d.navigatePage, null)
  assert.equal(d.message, 'Section 2 could not be located. The displayed page has not changed.')
})

// ---------------------------------------------------------------------------
// Profile independence
// ---------------------------------------------------------------------------

test('profile selection never affects mapping (roles only, no profile data)', () => {
  // Mapping consumes only blocks + pages — no profile input exists in the
  // mapping pipeline, so different profiles cannot change page locations.
  const byIndex = mappingByIndex()
  const h1 = byIndex.get(13)!
  assert.equal(h1.pageNumber, 2)
  // A duplicate run yields the identical mapping (deterministic).
  const again = mappingByIndex()
  assert.deepEqual([...again.entries()], [...byIndex.entries()])
})

// ---------------------------------------------------------------------------
// Unavailable UX for paragraphs
// ---------------------------------------------------------------------------

test('genuinely ambiguous paragraph stays unavailable — never a guessed page', () => {
  // A heading whose text appears in TOC AND body, but whose body content is
  // not on any page → genuine ambiguity → unavailable, never first match.
  const pages = [
    page(1, ['toc', 'unique heading', 'something']),
    page(2, ['unique heading', 'body text here']),
  ]
  const blocks: BlockLike[] = [
    { index: 0, text: 'toc', role: 'TABLE_OF_CONTENTS_ENTRY' },
    { index: 1, text: 'Unique heading', role: 'HEADING_1' },
    { index: 2, text: 'Body text here', role: 'BODY' },
  ]
  // The body text DOES appear on page 2 → heading maps to page 2.
  const mapped = mapBlocksToPages(blocks, pages)
  assert.equal(mapped[1].pageNumber, 2)

  // When the body text appears on NO page → ambiguous → unavailable.
  const pages2 = [
    page(1, ['toc', 'unique heading']),
    page(2, ['unique heading']),
  ]
  const blocks2: BlockLike[] = [
    { index: 0, text: 'Unique heading', role: 'HEADING_1' },
    { index: 1, text: 'Completely missing body content', role: 'BODY' },
  ]
  const mapped2 = mapBlocksToPages(blocks2, pages2)
  assert.equal(mapped2[0].confidence, 'unavailable')
  assert.equal(mapped2[0].pageNumber, null)
})
