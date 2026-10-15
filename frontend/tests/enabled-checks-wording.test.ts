/**
 * Enabled-checks score wording + profile/margin disclosure tests
 * (evidence-based margin policy Build).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_ENABLED_CHECKS_PASSED,
  ENABLED_CHECKS_CAUTION,
  ENABLED_CHECKS_SUFFIX,
  PAGE_ELEMENTS_HELP_TEXT,
  pageElementCheckParts,
  pageElementDisclosureLines,
  profileDisclosure,
  selectedProfileSummary,
} from '../src/lib/audit/enabled-checks-wording.ts'
import type { ProfileSnapshot } from '../src/types/api'

function snap(overrides: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return {
    profile_id: 'suc-academic-report',
    profile_name: 'SUC Academic Report',
    profile_version: 2,
    profile_source: 'built_in',
    description: '',
    citation_style: 'APA 7',
    institution_specific: true,
    margins: { left_in: null, right_in: null, top_in: null, bottom_in: null },
    ...overrides,
  }
}

test('score suffix labels the score as applying to enabled checks', () => {
  assert.equal(ENABLED_CHECKS_SUFFIX, 'for enabled checks')
})

test('no-findings heading is All enabled checks passed', () => {
  assert.equal(ALL_ENABLED_CHECKS_PASSED, 'All enabled checks passed')
})

test('caution text does not certify academic correctness', () => {
  assert.ok(ENABLED_CHECKS_CAUTION.includes('does not certify') || ENABLED_CHECKS_CAUTION.includes('not enabled in this profile'))
  assert.ok(ENABLED_CHECKS_CAUTION.includes('enabled deterministic checks'))
})

test('SUC disclosure shows Margins: Not checked', () => {
  const line = profileDisclosure(snap())
  assert.ok(line!.includes('SUC Academic Report'))
  assert.ok(line!.includes('APA 7'))
  assert.ok(line!.includes('Margins: Not checked'))
})

test('APA disclosure shows 1 in on all sides', () => {
  const line = profileDisclosure(snap({
    profile_id: 'apa7-student-paper',
    profile_name: 'APA 7 Student Paper',
    institution_specific: false,
    margins: { left_in: 1, right_in: 1, top_in: 1, bottom_in: 1 },
  }))
  assert.ok(line!.includes('APA 7 Student Paper'))
  assert.ok(line!.includes('Margins: 1 in on all sides'))
})

test('custom explicit margins show their values', () => {
  const line = profileDisclosure(snap({
    profile_name: 'Custom',
    margins: { left_in: 1.5, right_in: 1, top_in: 1, bottom_in: 1 },
  }))
  assert.ok(line!.includes('Margins: 1.5 in left'))
})

test('null snapshot (historical audit) → null disclosure', () => {
  assert.equal(profileDisclosure(null), null)
  assert.equal(profileDisclosure(undefined), null)
})

test('never exposes schema, fingerprint, or PresetConfig terminology', () => {
  const line = profileDisclosure(snap())!
  assert.ok(!line.includes('fingerprint'))
  assert.ok(!line.includes('PresetConfig'))
  assert.ok(!line.includes('schema'))
  assert.ok(!line.includes('null'))
})

test('historical disclosures explicitly leave page elements unchecked', () => {
  const line = profileDisclosure(snap())!
  for (const status of ['Headers: Not checked', 'Footers: Not checked', 'Page numbers: Not checked']) {
    assert.ok(line.includes(status))
  }
  assert.deepEqual(pageElementCheckParts(snap()), [])
  assert.ok(!line.includes(PAGE_ELEMENTS_HELP_TEXT))
})

test('every independent enabled structural group discloses manual, unscored scope', () => {
  for (let bits = 0; bits < 8; bits += 1) {
    const s = snap({
      profile_source: 'custom',
      headers: { check_header_requirements: Boolean(bits & 1) },
      footers: { check_footer_requirements: Boolean(bits & 2) },
      page_numbers: { check_page_number_requirements: Boolean(bits & 4), placement: 'either' },
    })
    const names = [
      ...(bits & 1 ? ['Header requirements'] : []),
      ...(bits & 2 ? ['Footer requirements'] : []),
      ...(bits & 4 ? ['Page number requirements'] : []),
    ]
    assert.deepEqual(pageElementCheckParts(s), names)
    const line = profileDisclosure(s)!
    for (const name of names) assert.ok(line.includes(`${name} · Manual review only · Unscored`))
    assert.equal(line.includes('Headers: Not checked'), !(bits & 1))
    assert.equal(line.includes('Footers: Not checked'), !(bits & 2))
    assert.equal(line.includes('Page numbers: Not checked'), !(bits & 4))
    assert.equal(line.includes(PAGE_ELEMENTS_HELP_TEXT), bits !== 0)
  }
})

test('PAGE placement affects disclosure only when the PAGE requirement is enabled', () => {
  for (const [placement, label] of [['header', 'Header'], ['footer', 'Footer'], ['either', 'Header or Footer']] as const) {
    const off = snap({ page_numbers: { check_page_number_requirements: false, placement } })
    assert.deepEqual(pageElementDisclosureLines(off), [
      'Headers: Not checked', 'Footers: Not checked', 'Page numbers: Not checked',
    ])
    assert.deepEqual(pageElementCheckParts(off), [])
    const on = snap({ page_numbers: { check_page_number_requirements: true, placement } })
    assert.deepEqual(pageElementDisclosureLines(on), [
      'Headers: Not checked',
      'Footers: Not checked',
      `Page number requirements · Manual review only · Unscored · Placement: ${label}`,
    ])
  }
})

test('structural helper states the exact stored-definition limitations', () => {
  assert.equal(PAGE_ELEMENTS_HELP_TEXT,
    'Checks stored Normal-pages definitions in every document section. Does not verify rendered visibility or numbering. First-page and even-page definitions are not checked. Unsupported evidence is reported for manual review.')
})

test('compact selected profile always discloses independent page-element states and enabled placements', () => {
  for (let bits = 0; bits < 8; bits += 1) {
    for (const placement of ['header', 'footer', 'either'] as const) {
      const rows = selectedProfileSummary(snap({
        headers: { check_header_requirements: Boolean(bits & 1) },
        footers: { check_footer_requirements: Boolean(bits & 2) },
        page_numbers: { check_page_number_requirements: Boolean(bits & 4), placement },
      }))
      const manual = rows.find((row) => row.heading.startsWith('Manual'))!
      const items = rows.flatMap((row) => row.items ?? [])
      for (const [label, bit] of [['Headers', 1], ['Footers', 2], ['Page numbers', 4]] as const) {
        assert.equal(items.find((item) => item.label === label)?.value,
          bits & bit ? 'Manual review' : 'Not checked')
      }
      assert.equal(manual.items!.find((item) => item.label === 'Placement')?.value,
        bits & 4 ? placement === 'header' ? 'Header' : placement === 'footer' ? 'Footer' : 'Header or Footer' : undefined)
      assert.equal(rows.find((row) => row.heading === 'Scored checks')?.text, '0 enabled')
    }
  }
  const defaults = selectedProfileSummary(snap()).flatMap((row) => row.items ?? []).filter((item) => ['Headers', 'Footers', 'Page numbers'].includes(item.label))
  assert.deepEqual(defaults, ['Headers', 'Footers', 'Page numbers'].map((label) => ({ label, value: 'Not checked' })))
})
