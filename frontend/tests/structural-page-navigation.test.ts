import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sectionFirstRenderedPage } from '../src/lib/audit/page-elements.ts'
import { evidencePage, evidencePrecision, evidenceSummary, compactEvidenceText } from '../src/lib/audit/evidence-summary.ts'
import type { SectionMetadataLike } from '../src/lib/pdf/section-mapping.ts'
import type { BlockMapping } from '../src/lib/pdf/paragraph-mapping.ts'

const location = { structural_story: true, section_index: 2, story_type: 'header', story_variant: 'default' }
const sections: SectionMetadataLike[] = [{ section_index: 2, start_paragraph_index: 18, end_paragraph_index: null,
  break_type: 'nextPage', page_width: 8.5, page_height: 11, margin_left: 1, margin_right: 1, margin_top: 1, margin_bottom: 1 }]
const blocks = [{ index: 18, text: 'Section 3' }, { index: 19, text: 'Body' }]
const mapped = (pageNumber: number | null, confidence: BlockMapping['confidence'] = 'exact'): BlockMapping =>
  ({ index: 18, pageNumber, confidence, pageRange: null, paragraphOnPage: 1 })

test('Header and Page Number findings in section 3 resolve the proven rendered page 3', () => {
  for (const story_type of ['header', 'footer', 'either']) {
    assert.equal(sectionFirstRenderedPage({ ...location, story_type }, sections, blocks, new Map([[18, mapped(3)]]), 3), 3)
  }
  assert.equal(sectionFirstRenderedPage(location, sections, blocks, new Map([[18, mapped(2)]]), 3), 2)
})

test('later, approximate, missing, blank, or out-of-range evidence never guesses a first page', () => {
  for (const mapping of [new Map(), new Map([[19, { ...mapped(3), index: 19 }]]),
    new Map([[18, mapped(3, 'approximate')]]), new Map([[18, mapped(null)]]),
    new Map([[18, mapped(0)]]), new Map([[18, mapped(4)]]), new Map([[18, mapped(2.5)]])]) {
    assert.equal(sectionFirstRenderedPage(location, sections, blocks, mapping, 3), null)
  }
  const mapping = new Map([[18, mapped(3)], [19, { ...mapped(3), index: 19 }]])
  assert.equal(sectionFirstRenderedPage(location, sections, [{ index: 18, text: '' }, blocks[1]], mapping, 3), null)
  assert.equal(sectionFirstRenderedPage(location, sections, [blocks[1]], mapping, 3), null)
  assert.equal(sectionFirstRenderedPage(location, sections.concat(sections), blocks, mapping, 3), null)
})

test('mapped structural evidence reports a page without inheriting old exact highlights', () => {
  const input = { structuralLocation: location, structuralPage: 3, citationRects: [{ page: 1 }], formattingEvidence: {} }
  assert.equal(evidencePage(input), 3)
  assert.equal(evidencePrecision(input), 'Page-level structural evidence')
  assert.match(evidenceSummary(input)!.text, /Page 3/)
  assert.match(evidenceSummary(input)!.text, /No exact Header\/Footer highlight is available\./)
  assert.doesNotMatch(evidenceSummary(input)!.text, /Page 1/)
  assert.match(compactEvidenceText({ ...input, paragraphIndex: 18, page: 1, precision: '' }), /Page 3/)
})

test('unmapped structural evidence has no page and the explicit unavailable message', () => {
  const input = { structuralLocation: location, structuralPage: null, citationRects: [{ page: 1 }] }
  assert.equal(evidencePage(input), null)
  assert.equal(evidencePrecision(input), 'Structural evidence only')
  assert.match(evidenceSummary(input)!.text, /Rendered page could not be determined/)
  assert.doesNotMatch(evidenceSummary(input)!.text, /Page 1/)
})
