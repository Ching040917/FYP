/**
 * Audit context disclosure tests — compact Profile Summary + Selected
 * Evidence (overflow regression fix).
 *
 * Covers compact wording, enabled/stored requirement counts, grouped profile
 * details, evidence precision and disclosure event behavior. Pure logic only;
 * rendered controls and navigation are exercised in browser acceptance.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DISCLOSURE_GROUP_EVENT,
  isForeignDisclosureEvent,
} from '../src/lib/audit/disclosure-group.ts'
import {
  compactEvidenceText,
  compactPrecisionLabel,
  evidencePage,
  evidencePrecision,
  evidenceTargetLabel,
} from '../src/lib/audit/evidence-summary.ts'
import {
  compactProfileSummary,
  enabledCheckCount,
  PAGE_ELEMENTS_HELP_TEXT,
  marginsDisclosureLine,
  profileDetailSections,
  referenceCheckParts,
  referenceUncheckedParts,
  referencesDisclosure,
  selectedProfileSummary,
} from '../src/lib/audit/enabled-checks-wording.ts'
import type { ProfileSnapshot } from '../src/types/api'


function snapshot(overrides: Record<string, unknown> = {}): ProfileSnapshot {
  return {
    profile_id: 'p1',
    profile_name: 'My Profile',
    profile_version: 1,
    profile_source: 'custom',
    description: '',
    citation_style: 'APA 7',
    institution_specific: false,
    margins: { left_in: null, right_in: null, top_in: null, bottom_in: null },
    references: {},
    ...overrides,
  } as ProfileSnapshot
}

// ---------------------------------------------------------------------------
// Profile Summary: compact + count
// ---------------------------------------------------------------------------

test('compact profile summary prioritizes name and enabled-check count', () => {
  const s = snapshot({
    margins: { left_in: 1, right_in: 1, top_in: 1, bottom_in: 1 },
    references: { check_hanging_indent: true, hanging_indent_in: 0.5 },
  })
  assert.equal(compactProfileSummary(s), 'My Profile · 2 scored checks enabled')
})

test('compact profile summary is null without a snapshot', () => {
  assert.equal(compactProfileSummary(null), null)
  assert.equal(compactProfileSummary(undefined), null)
})

test('enabled-check count covers margins once plus every enabled reference part', () => {
  assert.equal(enabledCheckCount(null), 0)
  assert.equal(enabledCheckCount(snapshot()), 0)
  assert.equal(
    enabledCheckCount(
      snapshot({ margins: { left_in: 1, right_in: null, top_in: null, bottom_in: null } }),
    ),
    1,
  )
  assert.equal(
    enabledCheckCount(
      snapshot({ references: { check_hanging_indent: true, hanging_indent_in: 0.5 } }),
    ),
    1,
  )
  // Legacy tri-state: stored line spacing without a toggle still counts.
  assert.equal(
    enabledCheckCount(snapshot({ references: { line_spacing: 2.0 } })),
    1,
  )
  assert.equal(
    enabledCheckCount(
      snapshot({
        margins: { left_in: 1, right_in: 1, top_in: 1, bottom_in: 1 },
        references: {
          check_hanging_indent: true,
          hanging_indent_in: 0.5,
          check_reference_order: true,
        },
      }),
    ),
    3,
  )
})

test('margins disclosure wording is unchanged', () => {
  assert.equal(
    marginsDisclosureLine({ left_in: null, right_in: null, top_in: null, bottom_in: null }),
    'Margins: Not checked',
  )
  assert.equal(
    marginsDisclosureLine({ left_in: 1, right_in: 1, top_in: 1, bottom_in: 1 }),
    'Margins: 1 in on all sides',
  )
  assert.equal(
    marginsDisclosureLine({ left_in: 1.5, right_in: null, top_in: null, bottom_in: null }),
    'Margins: 1.5 in left',
  )
})

test('reference parts list carries alphabetical order only when enabled', () => {
  assert.ok(referenceCheckParts({ check_reference_order: true }).includes('alphabetical order'))
  assert.ok(!referenceCheckParts({ check_reference_order: false }).includes('alphabetical order'))
  assert.ok(!referenceCheckParts({}).includes('alphabetical order'))
  assert.ok(!referenceCheckParts(null).includes('alphabetical order'))
})

test('profile details sections expose identity, enabled and not-checked groups', () => {
  const sections = profileDetailSections(
    snapshot({
      references: { check_hanging_indent: true, hanging_indent_in: 0.5, check_reference_order: true },
    }),
  )
  const map = new Map(sections.map((s) => [s.heading, s.items.map((i) => i.text)]))
  assert.deepEqual(map.get('Profile'), ['My Profile', 'Source: Custom · Version 1'])
  assert.deepEqual(sections.map((section) => section.heading), [
    'Profile', 'Scored checks', 'Manual review only · Unscored', 'Not checked', 'Citation style',
  ])
  assert.ok((map.get('Scored checks') ?? []).includes('0.5 in hanging indent'))
  assert.ok((map.get('Scored checks') ?? []).includes('alphabetical order'))
  assert.ok((map.get('Not checked') ?? []).includes('Margins: Not checked'))
  assert.ok(!(map.get('Not checked') ?? []).includes('Alphabetical order'))
})

test('unchecked parts mirror the enabled parts without overlap', () => {
  const refs = { check_hanging_indent: true, hanging_indent_in: 0.5, check_reference_order: true }
  const on = new Set(referenceCheckParts(refs))
  const off = referenceUncheckedParts(refs)
  assert.ok(off.includes('Margins') === false, 'margins handled by caller')
  assert.ok(off.includes('Alphabetical order') === false)
  assert.ok(off.includes('Reference heading'))
  // No requirement is both enabled and not-checked.
  for (const item of off) assert.ok(!on.has(item), item)
  // Legacy tri-state: stored line spacing without a toggle counts as enabled.
  assert.ok(!referenceUncheckedParts({ line_spacing: 2.0 }).includes('Reference line spacing'))
  assert.ok(referenceUncheckedParts({}).includes('Alphabetical order'))
})

test('profile details expose no raw indexes, keys, or internals', () => {
  const blob = JSON.stringify(profileDetailSections(snapshot()))
  for (const token of ['paragraph_index', 'author_key', 'fingerprint', 'schema_version', 'twip', 'numPr']) {
    assert.ok(!blob.includes(token), token)
  }
})

// ---------------------------------------------------------------------------
// Selected Evidence: compact + precision
// ---------------------------------------------------------------------------

test('compact evidence text prioritizes location and precision, never title or target', () => {
  assert.equal(
    compactEvidenceText({ paragraphIndex: 4, page: 2, precision: 'Paragraph evidence' }),
    'Evidence · Page 2 · Paragraph 5 · Paragraph evidence',
  )
  assert.equal(
    compactEvidenceText({ paragraphIndex: null, page: 3, objectLabel: 'Table 3', precision: 'Page-only evidence' }),
    'Evidence · Page 3 · Table 3 · Page-only evidence',
  )
  assert.equal(
    compactEvidenceText({ paragraphIndex: null, page: null, precision: 'Visual region unavailable' }),
    'Evidence · Visual region unavailable',
  )
})

test('compact precision shortens only the exact-citation form', () => {
  assert.equal(compactPrecisionLabel('Exact evidence'), 'Exact evidence')
  assert.equal(compactPrecisionLabel('Paragraph evidence'), 'Paragraph evidence')
  assert.equal(compactPrecisionLabel('Page-only evidence'), 'Page-only evidence')
  assert.equal(compactPrecisionLabel('Visual region unavailable'), 'Visual region unavailable')
})

test('evidence target prefers short location-like labels', () => {
  assert.equal(
    evidenceTargetLabel({ citationRects: [{ page: 1 }] } as never),
    'Citation occurrence',
  )
  assert.equal(
    evidenceTargetLabel({ formattingEvidence: {}, referenceEntry: true, paragraphIndex: 0 } as never),
    'Reference entry',
  )
  assert.equal(
    evidenceTargetLabel({ formattingEvidence: {}, headingEntry: true } as never),
    'References heading',
  )
  assert.equal(
    evidenceTargetLabel({ formattingEvidence: {}, paragraphIndex: 0 } as never),
    'Paragraph 1',
  )
  assert.equal(evidenceTargetLabel({ objectLabel: 'Table 3' }), 'Table 3')
  assert.equal(evidenceTargetLabel({}), '—')
})

test('evidence target never repeats a finding title', () => {
  const title = 'Reference List is not in alphabetical order'
  for (const target of [
    evidenceTargetLabel({ citationRects: [{ page: 1 }] } as never),
    evidenceTargetLabel({ formattingEvidence: {}, referenceEntry: true, paragraphIndex: 3 } as never),
    evidenceTargetLabel({ objectLabel: 'Table 1' }),
  ]) {
    assert.ok(!target.includes(title), target)
    assert.ok(target.length <= 30, `short label: ${target}`)
  }
})

test('evidence precision states are truthful per highlight source', () => {
  assert.equal(evidencePrecision({ citationRects: [{ page: 1 }] } as never), 'Exact evidence')
  assert.equal(
    evidencePrecision({ formattingEvidence: { kind: 'paragraph', pageRects: [] } } as never),
    'Paragraph evidence',
  )
  assert.equal(
    evidencePrecision({ formattingEvidence: { kind: 'run', pageRects: [] } } as never),
    'Paragraph evidence',
  )
  assert.equal(
    evidencePrecision({ objectStatus: { label: 'Table 3', message: null } } as never),
    'Page-only evidence',
  )
  assert.equal(
    evidencePrecision({ figureOutline: { label: 'Figure 1' } } as never),
    'Page-only evidence',
  )
  assert.equal(
    evidencePrecision({ marginStatus: { label: 'Margins', message: 'ok' } } as never),
    'Page-only evidence',
  )
  assert.equal(evidencePrecision({ highlightMessage: 'No highlight' }), 'Visual region unavailable')
  assert.equal(evidencePrecision({}), 'Visual region unavailable')
})

test('evidence page prefers citation, then formatting, figure, margin', () => {
  assert.equal(
    evidencePage({
      citationRects: [{ page: 2 }],
      formattingPageRects: [{ page: 3 }],
      figurePage: 4,
      marginStartPage: 5,
    }),
    2,
  )
  assert.equal(evidencePage({ formattingPageRects: [{ page: 3 }] }), 3)
  assert.equal(evidencePage({ figurePage: 4 }), 4)
  assert.equal(evidencePage({ marginStartPage: 5 }), 5)
  assert.equal(evidencePage({}), null)
})


test('disclosure events distinguish their own dialog from other dialogs', () => {
  assert.equal(isForeignDisclosureEvent(new CustomEvent(DISCLOSURE_GROUP_EVENT, { detail: 'a' }), 'b'), true)
  assert.equal(isForeignDisclosureEvent(new CustomEvent(DISCLOSURE_GROUP_EVENT, { detail: 'a' }), 'a'), false)
})


test('reference-order profile wording remains present', () => {
  assert.ok(referencesDisclosure({ check_reference_order: true }).includes('alphabetical order'))
  const sections = profileDetailSections(snapshot({ references: { check_reference_order: true } }))
  const enabled = sections.find((s) => s.heading === 'Scored checks')
  assert.ok(enabled?.items.some((i) => i.text === 'alphabetical order'))
  const unchecked = sections.find((s) => s.heading === 'Not checked')
  assert.ok(!(unchecked?.items.some((i) => i.text === 'Alphabetical order') ?? false))
})

test('stored page element requirements each count once for all eight combinations', () => {
  for (let bits = 0; bits < 8; bits += 1) {
    for (const placement of ['header', 'footer', 'either'] as const) {
      const s = snapshot({
        headers: { check_header_requirements: Boolean(bits & 1) },
        footers: { check_footer_requirements: Boolean(bits & 2) },
        page_numbers: { check_page_number_requirements: Boolean(bits & 4), placement },
      })
      const count = Number(Boolean(bits & 1)) + Number(Boolean(bits & 2)) + Number(Boolean(bits & 4))
      assert.equal(enabledCheckCount(s), count)
      assert.equal(compactProfileSummary(s), `My Profile · 0 scored checks enabled${count ? ` · ${count} manual review only (unscored)` : ''}`)
      const sections = profileDetailSections(s)
      const on = sections.find((section) => section.heading === 'Manual review only · Unscored')!.items.map((item) => item.text)
      assert.ok(!sections.find((section) => section.heading === 'Scored checks')!.items.some((item) => /Header|Footer|Page number/.test(item.text)))
      const off = sections.find((section) => section.heading === 'Not checked')!.items.map((item) => item.text)
      for (const [mask, name, disabled] of [
        [1, 'Header requirements', 'Headers: Not checked'],
        [2, 'Footer requirements', 'Footers: Not checked'],
        [4, 'Page number requirements', 'Page numbers: Not checked'],
      ] as const) {
        assert.equal(on.some((line) => line.startsWith(`${name} · Manual review only · Unscored`)), Boolean(bits & mask))
        assert.equal(off.includes(disabled), !Boolean(bits & mask))
      }
      const scope = sections.find((section) => section.heading === 'Manual review only · Unscored')!.note
      assert.equal(scope, count > 0 ? PAGE_ELEMENTS_HELP_TEXT : undefined)
    }
  }
})

test('old snapshot details explicitly leave all three page element requirements unchecked', () => {
  const sections = profileDetailSections(snapshot())
  const off = sections.find((section) => section.heading === 'Not checked')!.items.map((item) => item.text)
  for (const line of ['Headers: Not checked', 'Footers: Not checked', 'Page numbers: Not checked']) {
    assert.ok(off.includes(line))
  }
  assert.equal(enabledCheckCount(snapshot({ page_numbers: { placement: 'header' } })), 0)
})

test('profile details keep stored structural settings independent of later profile edits', () => {
  const saved = snapshot({
    headers: { check_header_requirements: true },
    footers: { check_footer_requirements: false },
    page_numbers: { check_page_number_requirements: true, placement: 'footer' },
  })
  const before = profileDetailSections(saved)
  const currentProfile = structuredClone(saved)
  currentProfile.headers!.check_header_requirements = false
  currentProfile.footers!.check_footer_requirements = true
  currentProfile.page_numbers!.placement = 'header'
  assert.deepEqual(profileDetailSections(saved), before)
  assert.notDeepEqual(profileDetailSections(currentProfile), before)
  const enabled = before.find((section) => section.heading === 'Manual review only · Unscored')!.items.map((item) => item.text)
  assert.ok(enabled.includes('Header requirements · Manual review only · Unscored'))
  assert.ok(enabled.includes('Page number requirements · Manual review only · Unscored · Placement: Footer'))
})

test('stored effective controls are grouped and counted without reading a current profile', () => {
  const stored = snapshot({
    body: { allowed_font_combos: [['Arial', 11]], line_spacing: 2, space_after_pt: 0, first_line_indent_in: 0.5 },
    heading: { alignment: 'left', level_1: { bold: true } },
    captions: { space_before_pt: 6, space_after_pt: null },
    lists: { space_after_pt: 0 },
    citation_matching: { check_citations_have_references: true, flag_ambiguous_matches: true },
    headers: { check_header_requirements: true },
  })
  const sections = profileDetailSections(stored)
  const scored = sections.find((section) => section.heading === 'Scored checks')!.items.map((item) => item.text)
  const manual = sections.find((section) => section.heading === 'Manual review only · Unscored')!.items.map((item) => item.text)
  assert.ok(scored.includes('Body font: Arial 11 pt'))
  assert.ok(scored.includes('Body space after: 0 pt'))
  assert.ok(scored.includes('Headings alignment: left'))
  assert.ok(scored.includes('Captions space before: 6 pt'))
  assert.ok(scored.includes('Lists space after: 0 pt'))
  assert.ok(scored.includes('Citations have matching references'))
  assert.ok(!scored.some((item) => item.includes('Header requirements') || item.includes('Ambiguous')))
  assert.equal(manual.length, 2)
  assert.ok(sections.find((section) => section.heading === 'Not checked')!.items.some((item) => item.text.includes('Heading 1 bold: true (stored setting; not checked)')))
  assert.deepEqual(sections.find((section) => section.heading === 'Citation style')!.items.map((item) => item.text), [stored.citation_style])
  assert.equal(enabledCheckCount(stored), scored.length + manual.length)
  assert.equal(compactProfileSummary(stored), `My Profile · ${scored.length} scored checks enabled · 2 manual review only (unscored)`)
})

test('Dashboard compact groups separate every independent page element and placement', () => {
  for (let bits = 0; bits < 8; bits += 1) {
    for (const [placement, label] of [['header', 'Header'], ['footer', 'Footer'], ['either', 'Header or Footer']] as const) {
      const s = snapshot({
        body: { font_family: 'Arial', font_size_pt: 11, line_spacing: 2 },
        references: { check_doi_format: true },
        headers: { check_header_requirements: Boolean(bits & 1) },
        footers: { check_footer_requirements: Boolean(bits & 2) },
        page_numbers: { check_page_number_requirements: Boolean(bits & 4), placement },
      })
      const rows = new Map(selectedProfileSummary(s).map((row) => [row.heading, row]))
      assert.equal(rows.get('Scored checks')!.text, '3 enabled · Body text, Reference List')
      assert.equal(rows.get('Citation style')!.text, 'APA 7')
      const manual = rows.get('Manual review only · Unscored')!
      const off = rows.get('Not checked')!
      for (const [mask, name] of [[1, 'Headers'], [2, 'Footers'], [4, 'Page numbers']] as const) {
        assert.equal(manual.items!.some((item) => item.label === name && item.value === 'Manual review'), Boolean(bits & mask))
        assert.equal(off.items!.some((item) => item.label === name && item.value === 'Not checked'), !Boolean(bits & mask))
        assert.equal([...manual.items!, ...off.items!].filter((item) => item.label === name).length, 1)
      }
      assert.equal(manual.items!.some((item) => item.label === 'Placement' && item.value === label), Boolean(bits & 4))
      assert.doesNotMatch(JSON.stringify([...rows]), /https:\/\/doi\.org|registration or resolution/)
    }
  }
})

test('details retain requirement values and scopes once within semantic areas', () => {
  const s = snapshot({
    description: 'Saved requirements',
    margins: { left_in: 1, right_in: null, top_in: null, bottom_in: null },
    references: { check_doi_format: true, check_reference_order: true },
    role_exemptions: ['title_page'],
    table_eligibility: 'scholarly',
    citation_matching: { allow_personal_communication: true },
  })
  const sections = profileDetailSections(s)
  const scored = sections.find((section) => section.heading === 'Scored checks')!
  assert.deepEqual(scored.groups?.map((group) => group.heading), ['Margins', 'Reference List'])
  assert.equal(scored.items.filter((item) => item.text === 'Reference DOI format').length, 1)
  assert.match(scored.note!, /presentation only, not registration or resolution/)
  const identity = sections[0].items.map((item) => item.text)
  for (const text of ['Saved requirements', 'Formatting exemptions: title page', 'Table classification: Scholarly']) assert.ok(identity.includes(text))
  const unchecked = sections.find((section) => section.heading === 'Not checked')!
  assert.ok(unchecked.groups?.find((group) => group.heading === 'Margins')?.items.some((item) => item.text === 'Right margin: Not checked'))
})

test('empty requirement groups expose no placeholder rows or inflated counts', () => {
  const sections = profileDetailSections(snapshot())
  assert.deepEqual(sections.find(section => section.heading === 'Scored checks')!.items, [])
  assert.deepEqual(sections.find(section => section.heading === 'Scored checks')!.groups, [])
  assert.deepEqual(sections.find(section => section.heading === 'Manual review only · Unscored')!.items, [])
  assert.equal(enabledCheckCount(snapshot()), 0)
})

test('fully configured controls leave no fabricated unchecked row', () => {
  const sections = profileDetailSections(snapshot({
    margins: { left_in: 1, right_in: 1, top_in: 1, bottom_in: 1 },
    references: {
      check_heading_text: true, heading_text: 'References', check_heading_bold: true,
      check_heading_alignment: true, heading_alignment: 'center', check_start_on_new_page: true,
      check_hanging_indent: true, hanging_indent_in: 0.5, check_line_spacing: true, line_spacing: 2,
      check_space_before: true, space_before_pt: 0, check_space_after: true, space_after_pt: 0,
      check_font_family: true, font_family: 'Times New Roman', check_font_size: true, font_size_pt: 12,
      check_alignment: true, alignment: 'left', check_reference_order: true, check_doi_format: true,
    },
    citation_matching: {
      check_citations_have_references: true, check_references_are_cited: true,
      check_author_year_consistency: true, check_year_suffixes: true,
      check_duplicate_references: true, flag_ambiguous_matches: true,
    },
    headers: { check_header_requirements: true }, footers: { check_footer_requirements: true },
    page_numbers: { check_page_number_requirements: true },
  }))
  const off = sections.find(section => section.heading === 'Not checked')!
  assert.deepEqual(off.items, [])
  assert.deepEqual(off.groups, [])
  assert.equal(sections.find(section => section.heading === 'Manual review only · Unscored')!.items.length, 4)
})
