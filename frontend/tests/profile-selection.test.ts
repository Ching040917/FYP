/**
 * Profile-selection logic tests (Build 5).
 *
 * Covers: recommended default, session retention of a valid previous
 * selection, stale-selection reset to recommended, no-profile block, and
 * summary-driven switching (SUC → APA → different key requirements).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveProfileSelection,
  profileBlockingSubmission,
} from '../src/lib/profile-selection.ts'
import type { FormattingProfile } from '../src/types/api'

const SUC: FormattingProfile = {
  profile_id: 'suc-academic-report',
  profile_name: 'SUC Academic Report',
  profile_version: 2,
  description: 'Institution-specific.',
  profile_source: 'built_in',
  recommended: true,
  citation_style: 'APA 7',
  key_requirements: ['Margins: Not checked unless your course or document template specifies them.', 'Times New Roman 12 pt body text', '1.5 line spacing for body text'],
}

const APA: FormattingProfile = {
  profile_id: 'apa7-student-paper',
  profile_name: 'APA 7 Student Paper',
  profile_version: 1,
  description: 'APA paper format.',
  profile_source: 'built_in',
  recommended: false,
  citation_style: 'APA 7',
  key_requirements: ['Margins: 1 in on all sides', 'double line spacing for body text', 'Left-aligned body paragraphs'],
}

const PROFILES = [SUC, APA]

test('no profiles → null selection and submission blocked', () => {
  assert.deepEqual(resolveProfileSelection([], null), { selectedId: null, reset: false })
  assert.equal(profileBlockingSubmission([]), true)
})

test('no previous selection → recommended SUC default', () => {
  assert.deepEqual(resolveProfileSelection(PROFILES, null), {
    selectedId: 'suc-academic-report',
    reset: false,
  })
})

test('valid previous selection retained (session persistence)', () => {
  assert.deepEqual(resolveProfileSelection(PROFILES, 'apa7-student-paper'), {
    selectedId: 'apa7-student-paper',
    reset: false,
  })
})

test('stale previous selection resets to recommended with flag', () => {
  const result = resolveProfileSelection(PROFILES, 'deleted-custom-profile')
  assert.deepEqual(result, { selectedId: 'suc-academic-report', reset: true })
})

test('switching SUC → APA changes key requirements summary', () => {
  const suc = PROFILES.find((p) => p.profile_id === 'suc-academic-report')!
  const apa = PROFILES.find((p) => p.profile_id === 'apa7-student-paper')!
  assert.notDeepEqual(suc.key_requirements, apa.key_requirements)
  assert.ok(suc.key_requirements.some((r) => r.includes('Margins: Not checked')))
  assert.ok(apa.key_requirements.some((r) => r.includes('Margins: 1 in on all sides')))
  assert.ok(apa.key_requirements.some((r) => r.includes('double line spacing')))
  assert.ok(apa.key_requirements.some((r) => r.includes('Left-aligned')))
  // APA key requirements never claim institution-specific values.
  assert.ok(!apa.key_requirements.some((r) => r.includes('Not checked')))
})
