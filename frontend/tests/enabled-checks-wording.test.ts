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
  profileDisclosure,
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
