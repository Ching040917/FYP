/**
 * Finding Detail presentation consistency tests (Part B).
 *
 * `presentationFor` is what the Finding Detail pane renders. Every
 * supported rule's Confirmed Issue / Required Action / Expected / Actual
 * must be student-friendly: no `!=`, `->`, `SEQ field`, `numPr`, or
 * mechanical "Adjust the affected element from X to Y" phrasing. The raw
 * deterministic `message` field is never mutated.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { presentationFor } from '../src/lib/audit/finding-presentation.ts'
import { friendlyFindingMessage } from '../src/lib/friendly-finding.ts'
import type { Violation } from '../src/types/api'

function v(
  rule_code: string,
  message: string,
  expected_value: string | null = null,
  actual_value: string | null = null,
  location: Record<string, unknown> | null = null,
): Violation {
  return { id: 'v', rule_code, severity: 'MAJOR', location, message, expected_value, actual_value }
}

const ALL_RULES: Array<[string, Violation]> = [
  ['FONT_SIZE', v('FONT_SIZE', 'Body font size 15pt != required 12pt', '12pt', '15pt', { paragraph_index: 3, run_index: 0 })],
  ['FONT_CONSISTENCY', v('FONT_CONSISTENCY', "Font 'Arial' does not match required 'Times New Roman'", 'Times New Roman', 'Arial', { paragraph_index: 3, run_index: 0 })],
  ['ALIGNMENT', v('ALIGNMENT', "Alignment 'center' != required 'justify'", 'justify', 'center', { paragraph_index: 3 })],
  ['LINE_SPACING', v('LINE_SPACING', 'Line spacing 2.0 != required 1.5', '1.5', '2.0', { paragraph_index: 3 })],
  ['SPACE_BEFORE', v('SPACE_BEFORE', 'Space before 18pt != required 0pt', '0pt', '18pt', { paragraph_index: 3 })],
  ['SPACE_AFTER', v('SPACE_AFTER', 'Space after 18pt != required 6pt', '6pt', '18pt', { paragraph_index: 3 })],
  ['MARGIN_LEFT', v('MARGIN_LEFT', 'Page margin left 1.25in != required 1.5in', '1.5in', '1.25in', { section_index: 0 })],
  ['MARGIN_RIGHT', v('MARGIN_RIGHT', 'Page margin right 2in != required 1in', '1in', '2in', { section_index: 0 })],
  ['MARGIN_TOP', v('MARGIN_TOP', 'Page margin top 1in != required 1.5in', '1.5in', '1in', { section_index: 0 })],
  ['MARGIN_BOTTOM', v('MARGIN_BOTTOM', 'Page margin bottom 1in != required 1.5in', '1.5in', '1in', { section_index: 0 })],
  ['TABLE_CAPTION_MISSING', v('TABLE_CAPTION_MISSING', "Table 3 has no caption. Add a paragraph above or below it starting with 'Table 3: '.", null, null, { table_index: 2 })],
  ['IMAGE_CAPTION_MISSING', v('IMAGE_CAPTION_MISSING', 'Image 2 has no caption.', null, null, { image_index: 1, paragraph_index: 5 })],
  ['IMAGE_ALT_TEXT_MISSING', v('IMAGE_ALT_TEXT_MISSING', 'Image 2 has no alt-text. Right-click the image -> Alt Text -> enter a concise description.', null, null, { image_index: 1, paragraph_index: 5 })],
  ['MANUAL_CAPTION', v('MANUAL_CAPTION', 'Table 4 has a manually typed caption. Use Word semantics.', 'Word caption (References → Insert Caption)', "Manual 'Table N' text without Caption style or SEQ field", { table_index: 3 })],
  ['HEADING_HIERARCHY', v('HEADING_HIERARCHY', 'Heading level skipped: H1 -> H3 (missing H2)', 'H2', 'H3', { paragraph_index: 6 })],
  ['UNKNOWN_RULE', v('UNKNOWN_RULE', 'Something != something else -> raw', '12pt', '15pt', { paragraph_index: 1 })],
]

test('every supported rule presentation is free of banned tokens', () => {
  for (const [name, violation] of ALL_RULES) {
    const pres = presentationFor(violation)
    const fields = [pres.issue, pres.requiredAction, pres.expected, pres.actual, pres.missingRequirement, pres.affectedElement]
    for (const f of fields) {
      if (f == null) continue
      assert.ok(!f.includes('!='), `${name} banned != in: ${f}`)
      assert.ok(!f.includes('->'), `${name} banned -> in: ${f}`)
      assert.ok(!f.includes('=>'), `${name} banned => in: ${f}`)
      assert.ok(!/SEQ\s+field/i.test(f), `${name} banned SEQ field in: ${f}`)
      assert.ok(!/numPr/i.test(f), `${name} banned numPr in: ${f}`)
    }
  }
})

test('no required action uses the mechanical Adjust-the-element phrasing', () => {
  for (const [name, violation] of ALL_RULES) {
    const action = presentationFor(violation).requiredAction
    if (action != null) {
      assert.ok(!action.includes('Adjust the affected element'), name)
    }
  }
})

test('MANUAL_CAPTION presentation matches the spec wording exactly', () => {
  const pres = presentationFor(v('MANUAL_CAPTION', 'raw', null, null, { table_index: 3 }))
  assert.equal(
    pres.issue,
    "Table 4 uses manually typed caption text instead of Microsoft Word's built-in caption feature. Automatic numbering and cross-references may not update correctly.",
  )
  assert.ok(pres.requiredAction!.includes('Select Table 4'))
  assert.ok(pres.requiredAction!.includes('References → Insert Caption'))
  assert.ok(pres.requiredAction!.includes('the “Table” label'))
  assert.equal(pres.affectedElement, 'Table 4')
})

test('missing-requirement rules use Figure labels, not internal Image terms', () => {
  const caption = presentationFor(v('IMAGE_CAPTION_MISSING', 'raw', null, null, { image_index: 1 }))
  assert.equal(caption.issue, 'Figure 2 does not have a caption.')
  assert.equal(caption.affectedElement, 'Figure 2')
  const alt = presentationFor(v('IMAGE_ALT_TEXT_MISSING', 'raw', null, null, { image_index: 1 }))
  assert.equal(alt.issue, 'Figure 2 does not have alternative text for screen-reader users.')
})

test('CITATION_MISMATCH shows the source-faithful parenthetical evidence', () => {
  const pres = presentationFor(
    v('CITATION_MISMATCH', "Citation 'Garcia (2018)' was found in text, but no matching entry was found in the References bibliography.", null, '(Garcia, 2018)', { paragraph_index: 23 }),
  )
  assert.equal(
    pres.issue,
    'The in-text citation (Garcia, 2018) does not have a matching entry in the References section.',
  )
  assert.equal(pres.evidence, '(Garcia, 2018)')
  assert.equal(
    pres.requiredAction,
    'Add the matching APA 7 reference entry. If the citation refers to the wrong source or is no longer needed, correct or remove it.',
  )
  // never displayed as the normalized narrative form
  assert.ok(!pres.issue.includes('Citation \u2019Garcia (2018)\u2019'))
})

test('CITATION_MISMATCH keeps the narrative evidence verbatim when it is the source form', () => {
  const pres = presentationFor(
    v('CITATION_MISMATCH', "Citation 'Garcia (2018)' was found in text", null, 'Garcia (2018)', { paragraph_index: 3 }),
  )
  assert.equal(pres.evidence, 'Garcia (2018)')
  assert.ok(pres.issue.includes('Garcia (2018)'))
})

test('raw deterministic message is never mutated by presentation', () => {
  const raw = 'Body font size 15pt != required 12pt'
  const violation = v('FONT_SIZE', raw, '12pt', '15pt', { paragraph_index: 3 })
  presentationFor(violation)
  assert.equal(violation.message, raw)
})

test('Finding Detail presentation is consistent with the shared friendly source', () => {
  // presentationFor(issue) must equal friendlyFindingMessage for the same
  // violation — one source of wording, no divergence.
  for (const [, violation] of ALL_RULES) {
    const pres = presentationFor(violation)
    const expected = friendlyFindingMessage(violation.rule_code, violation.message, violation.expected_value, violation.actual_value, violation.location)
    assert.equal(pres.issue, expected, `${violation.rule_code} diverged from the shared source`)
  }
})

test('formatting presentations normalize units in Expected/Actual', () => {
  const pres = presentationFor(v('FONT_SIZE', 'x', '12pt', '15.0pt', { paragraph_index: 1 }))
  assert.equal(pres.expected, '12 pt')
  assert.equal(pres.actual, '15 pt')
  const margin = presentationFor(v('MARGIN_LEFT', 'x', '1.5in', '1.25in', { section_index: 0 }))
  assert.equal(margin.expected, '1.5 in')
  assert.equal(margin.actual, '1.25 in')
})

// ---------------------------------------------------------------------------
// Citation ↔ Reference List matching findings (citation reference build)
// ---------------------------------------------------------------------------

test('CITATION_MISMATCH keeps evidence, never an Actual value', () => {
  const pres = presentationFor(
    v(
      'CITATION_MISMATCH',
      "Citation 'Smith (2020)' was found in text, but no matching entry was found in the References bibliography.",
      'Reference entry for Smith',
      '(Smith, 2020)',
      { paragraph_index: 3, occurrences: 1, paragraph_indexes: [3] },
    ),
  )
  assert.equal(pres.evidence, '(Smith, 2020)')
  assert.ok(pres.expected == null)
  assert.ok(pres.actual == null)
})

test('citation year mismatch shows the entry year as Expected and the span as Actual', () => {
  const pres = presentationFor(
    v(
      'CITATION_REFERENCE_MISMATCH',
      "Citation 'Smith (2020)' and the Reference List entry for Smith (2019) state different years.",
      'Consistent year for Smith (2019)',
      '(Smith, 2020)',
      { paragraph_index: 3, occurrences: 1, paragraph_indexes: [3] },
    ),
  )
  assert.equal(pres.expected, 'Consistent year for Smith (2019)')
  assert.equal(pres.actual, '(Smith, 2020)')
  assert.equal(pres.evidence, undefined)
  assert.match(pres.issue, /same year/)
  assert.equal(
    pres.requiredAction,
    'Correct the year in the in-text citation or in the Reference List entry so both state the same year.',
  )
})

test('year-suffix mismatch shows the suffixed year', () => {
  const pres = presentationFor(
    v(
      'CITATION_YEAR_SUFFIX_MISMATCH',
      "Citation 'Smith (2020)' is missing the year suffix used by the Reference List entry 'Smith (2020a)'.",
      'Smith (2020a)',
      '(Smith, 2020)',
      { paragraph_index: 4, occurrences: 1, paragraph_indexes: [4] },
    ),
  )
  assert.equal(pres.expected, 'Smith (2020a)')
  assert.equal(pres.actual, '(Smith, 2020)')
  assert.equal(
    pres.requiredAction,
    'Add the matching year suffix (a, b, …) to the in-text citation, or correct the suffix in the Reference List entry.',
  )
})

test('ambiguous match presents the span as evidence and asks for confirmation', () => {
  const pres = presentationFor({
    id: 'amb',
    rule_code: 'CITATION_REFERENCE_AMBIGUOUS',
    severity: 'REVIEW',
    location: { paragraph_index: 7, occurrences: 1, paragraph_indexes: [7] },
    message:
      "Citation 'Smith (2024)' could match 2 Reference List entries for Smith; the citation carries no initials.",
    expected_value: 'One unambiguous matching entry',
    actual_value: '(Smith, 2024)',
  })
  assert.equal(pres.evidence, '(Smith, 2024)')
  assert.ok(pres.expected == null)
  assert.ok(pres.actual == null)
  assert.match(pres.issue, /could match more than one entry/)
  assert.equal(pres.requiredAction, 'Confirm which listed source this citation refers to.')
})

test('uncited reference shows the entry preview, not an Actual value', () => {
  const pres = presentationFor(
    v(
      'REFERENCE_NOT_CITED',
      "Reference List entry 'Jones (2019)' was not cited in the body text.",
      'At least one in-text citation',
      'Jones, A. (2019). Other things. Press.',
      { paragraph_index: 12 },
    ),
  )
  assert.equal(pres.entryPreview, 'Jones, A. (2019). Other things. Press.')
  assert.ok(pres.expected == null)
  assert.ok(pres.actual == null)
  assert.equal(pres.evidence, undefined)
  assert.equal(pres.requiredAction, 'Cite this source in the text, or remove the entry.')
})

test('duplicate reference reports the entry count and keeps the preview', () => {
  const pres = presentationFor(
    v(
      'REFERENCE_DUPLICATE',
      "Reference List entry 'Smith (2020)' appears 2 times; a source must have exactly one entry.",
      'One entry per source',
      'Smith, J. (2020). On things. Press.',
      { paragraph_index: 12, entry_count: 2, paragraph_indexes: [9, 12] },
    ),
  )
  assert.equal(pres.entryPreview, 'Smith, J. (2020). On things. Press.')
  assert.match(pres.issue, /Found 2 entries\./)
  assert.equal(pres.requiredAction, 'Keep one entry and remove the duplicate.')
})

test('citation/reference presentations never leak raw message tokens', () => {
  const cases: Violation[] = [
    v('CITATION_REFERENCE_MISMATCH', "!= -> raw", 'Consistent year for Smith (2019)', '(Smith, 2020)', { paragraph_index: 1 }),
    v('CITATION_YEAR_SUFFIX_MISMATCH', "!= -> raw", 'Smith (2020a)', '(Smith, 2020)', { paragraph_index: 1 }),
    v('CITATION_REFERENCE_AMBIGUOUS', "!= -> raw", 'One unambiguous matching entry', '(Smith, 2024)', { paragraph_index: 1 }),
    v('REFERENCE_NOT_CITED', "!= -> raw", 'At least one in-text citation', 'Jones, A. (2019). X.', { paragraph_index: 1 }),
    v('REFERENCE_DUPLICATE', "!= -> raw", 'One entry per source', 'Smith, J. (2020). X.', { paragraph_index: 1, entry_count: 2 }),
  ]
  for (const violation of cases) {
    const pres = presentationFor(violation)
    const fields = [pres.issue, pres.requiredAction, pres.expected, pres.actual, pres.evidence, pres.entryPreview]
    for (const field of fields) {
      if (field == null) continue
      assert.ok(!field.includes('!='), field)
      assert.ok(!field.includes('->'), field)
    }
  }
})
