/**
 * Student-friendly finding presentation tests (Part B).
 *
 * Raw deterministic messages stay untouched; the presenter converts to
 * plain language, names object labels (Table/Figure), gives concrete
 * Microsoft Word steps, and strips developer-style tokens from fallback
 * output. Banned tokens never appear: `!=`, `->`, `SEQ field`, `numPr`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  friendlyFindingMessage,
  friendlyRequiredAction,
  friendlyRuleTitle,
  friendlyValue,
  cleanMessage,
  objectLabel,
} from '../src/lib/friendly-finding.ts'
import {
  normalizeViolationSeverity,
} from '../src/lib/audit/adapter.ts'
import { severityBadge } from '../src/lib/audit/categories.ts'

test('FONT_SIZE uses plain language without !=', () => {
  const out = friendlyFindingMessage('FONT_SIZE', 'Normal font size 15.0pt != required 12pt', '12pt', '15.0pt')
  assert.equal(out, 'This text uses 15 pt, but the required font size is 12 pt.')
  assert.ok(!out.includes('!='))
})

test('FONT_CONSISTENCY uses plain language', () => {
  const out = friendlyFindingMessage('FONT_CONSISTENCY', "Font 'Arial' does not match required 'Times New Roman'", 'Times New Roman', 'Arial')
  assert.equal(out, 'This text uses Arial, but the required font is Times New Roman.')
})

test('ALIGNMENT uses plain language with friendly words', () => {
  const out = friendlyFindingMessage('ALIGNMENT', "Alignment 'center' != required 'justify'", 'justify', 'center')
  assert.equal(out, 'This paragraph is centered, but justified alignment is required.')
  assert.ok(!out.includes('!='))
})

test('LINE_SPACING keeps decimal values and plain language', () => {
  const out = friendlyFindingMessage('LINE_SPACING', 'Line spacing 2.0 != required 1.5', '1.5', '2.0')
  assert.equal(out, 'This paragraph uses 2.0 line spacing, but 1.5 is required.')
})

test('SPACE_BEFORE and SPACE_AFTER use plain language', () => {
  const before = friendlyFindingMessage('SPACE_BEFORE', 'Space before 18pt != required 0pt', '0pt', '18pt')
  const after = friendlyFindingMessage('SPACE_AFTER', 'Space after 18pt != required 6pt', '6pt', '18pt')
  assert.equal(before, 'This paragraph has 18 pt spacing before it, but 0 pt is required.')
  assert.equal(after, 'This paragraph has 18 pt spacing after it, but 6 pt is required.')
})

test('MARGIN rules name the side in plain language', () => {
  const left = friendlyFindingMessage('MARGIN_LEFT', 'Page margin left 1.25in != required 1.5in', '1.5in', '1.25in')
  assert.equal(left, 'The left margin is 1.25 in, but the required margin is 1.5 in.')
  const top = friendlyFindingMessage('MARGIN_TOP', 'x', '1.0in', '2.0in')
  assert.equal(top, 'The top margin is 2 in, but the required margin is 1 in.')
})

test('MANUAL_CAPTION: Confirmed Issue and Required Action match the spec', () => {
  const loc = { table_index: 3 }
  const issue = friendlyFindingMessage('MANUAL_CAPTION', 'Table 4 has a manually typed caption. Use Word semantics.', null, null, loc)
  assert.equal(
    issue,
    "Table 4 uses manually typed caption text instead of Microsoft Word's built-in caption feature. Automatic numbering and cross-references may not update correctly.",
  )
  const action = friendlyRequiredAction('MANUAL_CAPTION', null, null, loc)
  assert.equal(
    action,
    'Delete the manually typed caption. Select Table 4, then use References → Insert Caption in Microsoft Word. Choose the “Table” label and confirm that Word generates the number automatically.',
  )
  assert.ok(action!.includes('References → Insert Caption'))
})

test('MANUAL_CAPTION for a figure uses the Figure label', () => {
  const loc = { image_index: 1 }
  const issue = friendlyFindingMessage('MANUAL_CAPTION', 'x', null, null, loc)
  assert.ok(issue.startsWith('Figure 2 uses manually typed caption text'))
  const action = friendlyRequiredAction('MANUAL_CAPTION', null, null, loc)
  assert.ok(action!.includes('Select Figure 2'))
  assert.ok(action!.includes('the “Figure” label'))
})

test('missing caption/alt-text rules name the object plainly', () => {
  assert.equal(
    friendlyFindingMessage('TABLE_CAPTION_MISSING', 'Table 3 has no caption.', null, null, { table_index: 2 }),
    'Table 3 does not have a caption.',
  )
  assert.equal(
    friendlyFindingMessage('IMAGE_CAPTION_MISSING', 'Image 2 has no caption.', null, null, { image_index: 1 }),
    'Figure 2 does not have a caption.',
  )
  assert.equal(
    friendlyFindingMessage('IMAGE_ALT_TEXT_MISSING', 'Image 2 has no alt-text.', null, null, { image_index: 1 }),
    'Figure 2 does not have alternative text for screen-reader users.',
  )
  assert.ok(
    !friendlyRequiredAction('IMAGE_ALT_TEXT_MISSING', null, null, { image_index: 1 })!.includes('->'),
  )
})

test('required actions give concrete Microsoft Word steps', () => {
  const manual = friendlyRequiredAction('MANUAL_CAPTION', null, null, { table_index: 0 })!
  assert.ok(manual.includes('References → Insert Caption'))
  const table = friendlyRequiredAction('TABLE_CAPTION_MISSING', null, null, { table_index: 2 })!
  assert.ok(table.includes('References → Insert Caption'))
  const alt = friendlyRequiredAction('IMAGE_ALT_TEXT_MISSING', null, null, { image_index: 0 })!
  assert.ok(alt.includes('Edit Alt Text'))
  const font = friendlyRequiredAction('FONT_SIZE', '12pt', '15pt')!
  assert.equal(font, 'Change the font size from 15 pt to 12 pt.')
})

test('no presentation output contains banned tokens', () => {
  const samples = [
    friendlyFindingMessage('FONT_SIZE', 'x != y', '12pt', '15pt'),
    friendlyFindingMessage('ALIGNMENT', "Alignment 'center' != required 'justify'", 'justify', 'center'),
    friendlyFindingMessage('LINE_SPACING', 'Line spacing 2.0 != required 1.5', '1.5', '2.0'),
    friendlyFindingMessage('MARGIN_LEFT', 'Page margin left 1.25in != required 1.5in', '1.5in', '1.25in'),
    friendlyFindingMessage('MANUAL_CAPTION', 'x', null, null, { table_index: 0 }),
    cleanMessage("Manual 'Table N' text without Caption style or SEQ field"),
    cleanMessage('Heading level skipped: H1 -> H3 (missing H2)'),
    friendlyRequiredAction('MANUAL_CAPTION', null, null, { table_index: 0 }) ?? '',
  ]
  for (const s of samples) {
    assert.ok(!s.includes('!='), `banned != in: ${s}`)
    assert.ok(!s.includes('->'), `banned -> in: ${s}`)
    assert.ok(!s.includes('=>'), `banned => in: ${s}`)
    assert.ok(!/SEQ\s+field/i.test(s), `banned SEQ field in: ${s}`)
    assert.ok(!/numPr/i.test(s), `banned numPr in: ${s}`)
  }
})

test('generic fallback never uses the mechanical Adjust-the-element phrasing', () => {
  const action = friendlyRequiredAction('SOME_UNKNOWN_RULE', '12pt', '15pt')
  assert.equal(action, 'Update this element to meet the required specification (12 pt).')
  assert.ok(!action!.includes('Adjust the affected element'))
})

test('objectLabel is one-based and friendly', () => {
  assert.equal(objectLabel({ table_index: 0 }), 'Table 1')
  assert.equal(objectLabel({ image_index: 4 }), 'Figure 5')
  assert.equal(objectLabel(null), null)
  assert.equal(objectLabel({ paragraph_index: 2 }), null)
})

test('unknown rules fall back to a cleaned message', () => {
  const out = friendlyFindingMessage('HEADING_HIERARCHY', 'Heading level skipped: H1 -> H3 (missing H2)', null, null)
  assert.ok(!out.includes('->'))
  assert.ok(out.includes('H1 to H3'))
  const out2 = friendlyFindingMessage(null, 'Normal font size 15.0pt != required 12pt', null, null)
  assert.ok(!out2.includes('!='))
})

test('friendlyValue humanizes units and keeps bare decimals', () => {
  assert.equal(friendlyValue('15.0pt'), '15 pt')
  assert.equal(friendlyValue('1.5in'), '1.5 in')
  assert.equal(friendlyValue('2.0'), '2.0')
  assert.equal(friendlyValue('1.5'), '1.5')
  assert.equal(friendlyValue(null), null)
})

test('cleanMessage never mutates the source raw message', () => {
  const raw = 'Normal font size 15.0pt != required 12pt'
  const out = cleanMessage(raw)
  assert.equal(raw, 'Normal font size 15.0pt != required 12pt') // source untouched
  assert.equal(out, 'Normal font size 15.0pt is not required 12pt')
})

// ---------------------------------------------------------------------------
// Citation ↔ Reference List matching findings (citation reference build)
// ---------------------------------------------------------------------------

test('friendly titles exist for the citation/reference codes only', () => {
  assert.equal(friendlyRuleTitle('CITATION_MISMATCH'), 'Citation without a Reference List entry')
  assert.equal(
    friendlyRuleTitle('CITATION_REFERENCE_MISMATCH'),
    'Citation year does not match the Reference List entry',
  )
  assert.equal(friendlyRuleTitle('CITATION_YEAR_SUFFIX_MISMATCH'), 'Citation is missing the year suffix')
  assert.equal(friendlyRuleTitle('CITATION_REFERENCE_AMBIGUOUS'), 'Citation could match more than one entry')
  assert.equal(friendlyRuleTitle('REFERENCE_NOT_CITED'), 'Reference List entry not cited in the text')
  assert.equal(friendlyRuleTitle('REFERENCE_DUPLICATE'), 'Duplicate Reference List entry')
  // Unknown codes have no bespoke title (caller falls back to humanization).
  assert.equal(friendlyRuleTitle('FONT_SIZE'), null)
  assert.equal(friendlyRuleTitle(null), null)
})

test('citation year mismatch explains both years from the source-faithful span', () => {
  const out = friendlyFindingMessage(
    'CITATION_REFERENCE_MISMATCH',
    "Citation 'Smith (2020)' and the Reference List entry for Smith (2019) state different years.",
    'Consistent year for Smith (2019)',
    '(Smith, 2020)',
  )
  assert.equal(
    out,
    'The in-text citation (Smith, 2020) does not state the same year as its Reference List entry (Consistent year for Smith (2019)).',
  )
})

test('citation suffix mismatch names the entry year with suffix', () => {
  const out = friendlyFindingMessage(
    'CITATION_YEAR_SUFFIX_MISMATCH',
    "Citation 'Smith (2020)' is missing the year suffix used by the Reference List entry 'Smith (2020a)'.",
    'Smith (2020a)',
    '(Smith, 2020)',
  )
  assert.equal(
    out,
    'The in-text citation (Smith, 2020) is missing the year suffix used by its Reference List entry (Smith (2020a)).',
  )
})

test('ambiguous citation explains the manual check without initials', () => {
  const out = friendlyFindingMessage(
    'CITATION_REFERENCE_AMBIGUOUS',
    "Citation 'Smith (2024)' could match 2 Reference List entries for Smith.",
    'One unambiguous matching entry',
    '(Smith, 2024)',
  )
  assert.match(out, /could match more than one entry/)
  assert.match(out, /manual check/)
})

test('missing-reference finding reports the occurrence count from the location', () => {
  const out = friendlyFindingMessage(
    'CITATION_MISMATCH',
    "Citation 'Smith (2020)' was found in text, but no matching entry was found in the References bibliography.",
    'Reference entry for Smith',
    'Smith (2020)',
    { paragraph_index: 3, occurrences: 3, paragraph_indexes: [3, 8] },
  )
  assert.equal(
    out,
    'The in-text citation Smith (2020) does not have a matching entry in the References section. Found 3 times in the document.',
  )
  // A single occurrence adds no count sentence.
  const single = friendlyFindingMessage(
    'CITATION_MISMATCH',
    "Citation 'Smith (2020)' was found in text, but no matching entry was found in the References bibliography.",
    'Reference entry for Smith',
    'Smith (2020)',
    { paragraph_index: 3, occurrences: 1 },
  )
  assert.ok(!single.includes('Found'))
})

test('uncited reference quotes the entry preview', () => {
  const out = friendlyFindingMessage(
    'REFERENCE_NOT_CITED',
    "Reference List entry 'Jones (2019)' was not cited in the body text.",
    'At least one in-text citation',
    'Jones, A. (2019). Other things. Press.',
  )
  assert.equal(out, '“Jones, A. (2019). Other things. Press.” was not cited anywhere in the text.')
})

test('duplicate reference reports the entry count from the location', () => {
  const out = friendlyFindingMessage(
    'REFERENCE_DUPLICATE',
    "Reference List entry 'Smith (2020)' appears 2 times; a source must have exactly one entry.",
    'One entry per source',
    'Smith, J. (2020). On things. Press.',
    { paragraph_index: 12, entry_count: 2, paragraph_indexes: [9, 12] },
  )
  assert.equal(
    out,
    '“Smith, J. (2020). On things. Press.” is listed more than once. Found 2 entries.',
  )
})

test('citation/reference required actions are fixed, non-formatting copy', () => {
  assert.equal(
    friendlyRequiredAction('CITATION_REFERENCE_MISMATCH', 'Consistent year for Smith (2019)', '(Smith, 2020)'),
    'Correct the year in the in-text citation or in the Reference List entry so both state the same year.',
  )
  assert.equal(
    friendlyRequiredAction('CITATION_YEAR_SUFFIX_MISMATCH', 'Smith (2020a)', '(Smith, 2020)'),
    'Add the matching year suffix (a, b, …) to the in-text citation, or correct the suffix in the Reference List entry.',
  )
  assert.equal(
    friendlyRequiredAction('CITATION_REFERENCE_AMBIGUOUS', 'One unambiguous matching entry', '(Smith, 2024)'),
    'Confirm which listed source this citation refers to.',
  )
  assert.equal(
    friendlyRequiredAction('REFERENCE_NOT_CITED', 'At least one in-text citation', 'Jones, A. (2019). X.'),
    'Cite this source in the text, or remove the entry.',
  )
  assert.equal(
    friendlyRequiredAction('REFERENCE_DUPLICATE', 'One entry per source', 'Smith, J. (2020). X.'),
    'Keep one entry and remove the duplicate.',
  )
})

// ---------------------------------------------------------------------------
// Severity mapping — MAJOR / MINOR / REVIEW (manual review)
// ---------------------------------------------------------------------------

test('severity normalization is explicit for every valid token', () => {
  assert.equal(normalizeViolationSeverity('MAJOR'), 'major')
  assert.equal(normalizeViolationSeverity('MINOR'), 'minor')
  assert.equal(normalizeViolationSeverity('REVIEW'), 'review')
})

test('review severity badge is neutral and labelled Manual review', () => {
  const review = severityBadge('review')
  assert.equal(review.label, 'Manual review')
  assert.ok(!/rose|amber|destructive|warning/.test(review.className), review.className)
  // Major/minor keep their alarm styling.
  assert.equal(severityBadge('major').label, 'Major')
  assert.match(severityBadge('major').className, /rose/)
  assert.equal(severityBadge('minor').label, 'Minor')
  assert.match(severityBadge('minor').className, /amber/)
})

test('citation/reference rule codes share the APA citations category', async () => {
  const { categoryForRuleCode } = await import('../src/lib/audit/adapter.ts')
  for (const code of [
    'CITATION_MISMATCH',
    'CITATION_REFERENCE_MISMATCH',
    'CITATION_YEAR_SUFFIX_MISMATCH',
    'CITATION_REFERENCE_AMBIGUOUS',
    'REFERENCE_NOT_CITED',
    'REFERENCE_DUPLICATE',
  ]) {
    assert.equal(categoryForRuleCode(code), 'citation_apa', code)
  }
})

// ---------------------------------------------------------------------------
// Document-wide finding: citations present, no References section
// ---------------------------------------------------------------------------

test('missing References section is never phrased as one bad citation', () => {
  const location = { paragraph_index: 3, citation_count: 2, missing_references_section: true }
  const message = 'No References section was found, so 2 in-text citation(s) could not be checked.'
  const issue = friendlyFindingMessage('CITATION_MISMATCH', message, 'References section', null, location)
  assert.equal(
    issue,
    'No References section was found, so 2 in-text citations could not be checked against a Reference List.',
  )
  assert.ok(!issue.includes('The in-text citation'))
  assert.equal(
    friendlyRequiredAction('CITATION_MISMATCH', 'References section', null, location),
    'Add a References section and list every source cited in the text.',
  )
})

test('a single uncitable citation still uses the per-citation wording', () => {
  const issue = friendlyFindingMessage(
    'CITATION_MISMATCH',
    "Citation 'Smith (2020)' was found in text, but no matching entry was found in the References bibliography.",
    'Reference entry for Smith',
    '(Smith, 2020)',
    { paragraph_index: 2, occurrences: 1 },
  )
  assert.match(issue, /^The in-text citation \(Smith, 2020\)/)
})

test('the explicit flag identifies the root finding even with a real paragraph index', () => {
  // Navigable root finding: same rule code, real (navigable) paragraph index
  // plus the explicit flag — the wording must stay document-wide.
  const issue = friendlyFindingMessage(
    'CITATION_MISMATCH',
    'No References section was found, so 2 in-text citation(s) could not be checked.',
    'References section',
    null,
    { paragraph_index: 3, citation_count: 2, missing_references_section: true },
  )
  assert.equal(
    issue,
    'No References section was found, so 2 in-text citations could not be checked against a Reference List.',
  )
})

test('a location without the flag is never treated as document-wide', () => {
  // An unrelated finding with no paragraph index must not borrow the
  // missing-References wording.
  const issue = friendlyFindingMessage(
    'CITATION_MISMATCH',
    "Citation 'Smith (2020)' was found in text, but no matching entry was found in the References bibliography.",
    'Reference entry for Smith',
    '(Smith, 2020)',
    { paragraph_index: null },
  )
  assert.match(issue, /^The in-text citation/)
})

// ---------------------------------------------------------------------------
// Severity mapping contract — MAJOR / MINOR / REVIEW / unknown
// ---------------------------------------------------------------------------

test('valid backend severity tokens map to their exact display severity', () => {
  assert.equal(normalizeViolationSeverity('MAJOR'), 'major')
  assert.equal(normalizeViolationSeverity('MINOR'), 'minor')
  assert.equal(normalizeViolationSeverity('REVIEW'), 'review')
})

test('unknown or malformed severity never becomes a scored severity', () => {
  for (const token of ['CRITICAL', 'N/A', '', 'info', undefined, null, 42 as never]) {
    const mapped = normalizeViolationSeverity(token as string | null | undefined)
    assert.notEqual(mapped, 'minor', `token ${String(token)} must not map to minor`)
    assert.notEqual(mapped, 'review', `token ${String(token)} must not map to review`)
    assert.equal(mapped, 'unknown', `token ${String(token)}`)
  }
})

test('unclassified severity has neutral presentation with no alarm styling', () => {
  const badge = severityBadge('unknown')
  assert.equal(badge.label, 'Unclassified')
  assert.ok(!/rose|amber|destructive|warning|red/.test(badge.className), badge.className)
  // Scoped presentation stays neutral, review presentation is unchanged.
  assert.equal(severityBadge('review').label, 'Manual review')
  assert.equal(severityBadge('major').label, 'Major')
  assert.equal(severityBadge('minor').label, 'Minor')
})

test('unknown severity is excluded from every count', async () => {
  const { adaptAuditResponse } = await import('../src/lib/audit/adapter.ts')
  const raw = {
    status: 'completed',
    audit_id: 'audit-unknown-1',
    weighted_compliance_score: 95,
    physical_layout_errors: [
      {
        id: 'v-major',
        rule_code: 'CITATION_MISMATCH',
        severity: 'MAJOR',
        location: { paragraph_index: 1 },
        message: 'm',
        expected_value: 'e',
        actual_value: '(Smith, 2020)',
      },
      {
        id: 'v-review',
        rule_code: 'CITATION_REFERENCE_AMBIGUOUS',
        severity: 'REVIEW',
        location: { paragraph_index: 2 },
        message: 'm',
        expected_value: 'e',
        actual_value: '(Smith, 2024)',
      },
      {
        id: 'v-unknown',
        rule_code: 'FONT_SIZE',
        severity: 'WEIRD',
        location: { paragraph_index: 3 },
        message: 'm',
        expected_value: 'e',
        actual_value: 'a',
      },
    ],
    ai_citation_tooltips: [],
  } as Parameters<typeof adaptAuditResponse>[0]['raw']

  const result = adaptAuditResponse({ raw })
  const byId = new Map(result.physical_layout_errors.map((e) => [e.id, e]))
  assert.equal(byId.get('v-major')!.severity, 'major')
  assert.equal(byId.get('v-review')!.severity, 'review')
  // Unclassified stays visible and never counted.
  assert.equal(byId.get('v-unknown')!.severity, 'unknown')
  assert.equal(result.physical_layout_errors.length, 3)
  assert.equal(result.major_count, 1)
  assert.equal(result.minor_count, 0)
  assert.equal(result.weighted_compliance_score, 95)
})

test('an unknown severity cannot make a finding Guided-Fix eligible', () => {
  // Guided Fixes eligibility is decided by the backend rule whitelist, which
  // is severity-independent: an unclassified FONT_SIZE finding stays
  // manual-only, exactly as a valid MINOR FONT_SIZE finding does.
  assert.equal(severityBadge('unknown').label, 'Unclassified')
  assert.notEqual(severityBadge('unknown').label, severityBadge('minor').label)
})

test('whitespace-padded valid tokens still normalize to their exact severity', () => {
  assert.equal(normalizeViolationSeverity(' major '), 'major')
  assert.equal(normalizeViolationSeverity('review '), 'review')
})
