/**
 * Strict Local AI eligibility — behavioral helper matrix (authoritative)
 * plus a secondary source guard pinning AuditPage integration.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isLocalAiCitationEligible } from '../src/lib/local-ai-citation-eligibility.ts'

const v = (over: Record<string, unknown> = {}) => ({
  rule_code: 'CITATION_MISMATCH',
  severity: 'MAJOR',
  location: { paragraph_index: 2 },
  message: "Citation 'Smith (2020)' was found in text.",
  expected_value: 'Reference entry for Smith',
  actual_value: '(Smith, 2020)',
  ...over,
})

test('1 valid paragraph-scoped CITATION_MISMATCH is eligible', () => {
  assert.equal(isLocalAiCitationEligible(v()), true)
})

test('2 missing_references_section=true is denied', () => {
  assert.equal(
    isLocalAiCitationEligible(
      v({ location: { paragraph_index: 0, citation_count: 2, missing_references_section: true }, actual_value: null }),
    ),
    false,
  )
})

test('3 missing paragraph_index is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ location: {} })), false)
  assert.equal(isLocalAiCitationEligible(v({ location: { paragraph_index: null } })), false)
  assert.equal(isLocalAiCitationEligible(v({ location: null })), false)
})

test('4 boolean paragraph_index is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ location: { paragraph_index: true } })), false)
  assert.equal(isLocalAiCitationEligible(v({ location: { paragraph_index: false } })), false)
})

test('5 negative paragraph_index is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ location: { paragraph_index: -1 } })), false)
})

test('6 string paragraph_index is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ location: { paragraph_index: '2' } })), false)
})

test('7 fractional paragraph index is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ location: { paragraph_index: 1.5 } })), false)
  assert.equal(isLocalAiCitationEligible(v({ location: { paragraph_index: Number.NaN } })), false)
})

test('8 null actual_value is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ actual_value: null })), false)
})

test('9 empty actual_value is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ actual_value: '' })), false)
})

test('10 whitespace-only actual_value is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ actual_value: '   \n\t ' })), false)
})

test('11 REVIEW severity is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ severity: 'REVIEW' })), false)
})

test('12 unknown severity is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ severity: 'UNKNOWN' })), false)
})

test('13 null severity is denied', () => {
  assert.equal(isLocalAiCitationEligible(v({ severity: null })), false)
})

test('14 other citation/reference codes are denied', () => {
  for (const rule_code of [
    'CITATION_REFERENCE_MISMATCH',
    'CITATION_YEAR_SUFFIX_MISMATCH',
    'CITATION_REFERENCE_AMBIGUOUS',
    'REFERENCE_NOT_CITED',
    'REFERENCE_DUPLICATE',
    'REFERENCE_HEADING_TEXT',
    'ALIGNMENT',
  ]) {
    assert.equal(isLocalAiCitationEligible(v({ rule_code })), false, rule_code)
  }
})

test('15 reference-entry target is denied', () => {
  assert.equal(
    isLocalAiCitationEligible(
      v({
        rule_code: 'REFERENCE_DUPLICATE',
        severity: 'MINOR',
        location: { paragraph_index: 9, entry_count: 2, paragraph_indexes: [8, 9] },
        actual_value: 'Smith, J. (2020). Title.',
      }),
    ),
    false,
  )
})

test('16 consolidated valid CITATION_MISMATCH is eligible', () => {
  assert.equal(
    isLocalAiCitationEligible(
      v({ location: { paragraph_index: 3, occurrences: 4, paragraph_indexes: [3, 7, 9] } }),
    ),
    true,
  )
})

// ---- Secondary source guard: AuditPage must use the helper ----

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = readFileSync(resolve(ROOT, 'src/pages/AuditPage.tsx'), 'utf8')
const SECTION = PAGE.slice(PAGE.indexOf('function CitationSection('), PAGE.indexOf('const STAT_LABELS'))

test('AuditPage CitationSection uses the shared helper (no inline code-only gate)', () => {
  assert.match(PAGE, /isLocalAiCitationEligible/)
  assert.match(SECTION, /isLocalAiCitationEligible\(selectedViolation\)/)
  assert.match(SECTION, /if \(!isCitationSelected\) return null/)
})
