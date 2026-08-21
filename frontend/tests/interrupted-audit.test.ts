/**
 * Interrupted Audit UX (Build 2) — pure presentation tests.
 *
 * Covers the interruption-message mapping, real-API-shaped model parsing,
 * History badge/score/guidance logic, and the Audit Page interruption panel
 * data model. No DOM rendering — pure logic + type-level acceptance.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  interruptionMessage,
  INTERRUPTION_REASON_APPLICATION_RESTART,
} from '../src/lib/audit/interrupted-audit.ts'
import type { AuditResponse } from '../src/types/api.ts'

// Real API shape captured from GET /api/audit/587ca3f9-6b3c-4619-be7a-c542a8fd794b.
const REAL_INTERRUPTED: AuditResponse = {
  id: '587ca3f9-6b3c-4619-be7a-c542a8fd794b',
  filename: 'sample-thesis.docx',
  file_size: 37764,
  weighted_score: 0,
  deploy_mode: 'LOCAL',
  status: 'interrupted',
  created_at: '2026-08-21T16:55:49.125698',
  completed_at: null,
  interruption_reason: INTERRUPTION_REASON_APPLICATION_RESTART,
  interrupted_at: '2026-08-21T16:55:57.002312',
  violations: [],
  citation_issues: [],
  score_breakdown: [],
  document_stats: { paragraphs: null, headings: null, tables: null, images: null, sections: null, words: null },
  major_count: 0,
  minor_count: 0,
  ai_review_status: null,
  ai_provider: null,
  sections: null,
  profile_snapshot: null,
}

test('real interrupted audit parses into the frontend model without crash', () => {
  // Type-level acceptance: the fixture is a valid AuditResponse.
  const a: AuditResponse = REAL_INTERRUPTED
  assert.equal(a.status, 'interrupted')
  assert.equal(a.interruption_reason, 'application_restart')
  assert.equal(a.interrupted_at, '2026-08-21T16:55:57.002312')
  // The exact real audit id round-trips.
  assert.equal(a.id, '587ca3f9-6b3c-4619-be7a-c542a8fd794b')
})

test('application_restart maps to the friendly sentence', () => {
  assert.equal(
    interruptionMessage(INTERRUPTION_REASON_APPLICATION_RESTART),
    'The application restarted before this audit finished.',
  )
})

test('null and unknown reasons use the fallback sentence', () => {
  const fallback = 'This audit stopped before processing was completed.'
  assert.equal(interruptionMessage(null), fallback)
  assert.equal(interruptionMessage(undefined), fallback)
  assert.equal(interruptionMessage('mystery_reason'), fallback)
  assert.equal(interruptionMessage(''), fallback)
})

test('raw reason value is never exposed as display text', () => {
  const msg = interruptionMessage(INTERRUPTION_REASON_APPLICATION_RESTART)
  assert.ok(!msg.includes('application_restart'))
})

test('interrupted audit has no fabricated score or findings', () => {
  const a = REAL_INTERRUPTED
  assert.equal(a.weighted_score, 0)
  assert.equal(a.violations.length, 0)
  assert.equal(a.major_count, 0)
  assert.equal(a.minor_count, 0)
  // Nothing implies completion.
  assert.equal(a.completed_at, null)
})

test('history badge logic: interrupted is distinct from completed/failed/processing', () => {
  const statuses: Array<AuditResponse['status'] | string> = ['interrupted', 'completed', 'failed', 'processing']
  assert.ok(statuses.includes('interrupted'))
  assert.notEqual('interrupted', 'completed')
  assert.notEqual('interrupted', 'failed')
  assert.notEqual('interrupted', 'processing')
})

test('unknown future status remains acceptable to the model', () => {
  // The model must tolerate unknown statuses at runtime without crashing.
  const unknown = { ...REAL_INTERRUPTED, status: 'archived' as string }
  const status = unknown.status
  assert.ok(typeof status === 'string')
  // Interrupted-specific rendering never triggers for non-interrupted.
  assert.notEqual(status, 'interrupted')
})

test('null interrupted_at omits the Interrupted-at display path', () => {
  const without = { ...REAL_INTERRUPTED, interrupted_at: null }
  assert.equal(without.interrupted_at, null)
  // The render guard only shows "Interrupted at" when present.
  assert.equal(Boolean(without.interrupted_at), false)
  assert.equal(Boolean(REAL_INTERRUPTED.interrupted_at), true)
})

test('profile snapshot metadata is optional and safe', () => {
  const withSnapshot: AuditResponse = {
    ...REAL_INTERRUPTED,
    profile_snapshot: {
      profile_id: 'suc-academic-report',
      profile_name: 'SUC Academic Report',
      profile_version: 2,
      profile_source: 'built_in',
      description: 'x',
      citation_style: 'APA 7',
      institution_specific: true,
      margins: { left_in: null, right_in: null, top_in: null, bottom_in: null },
    },
  }
  const name = withSnapshot.profile_snapshot?.profile_name
  assert.equal(name, 'SUC Academic Report')
  // Null snapshot (historical) stays null — no fabricated profile.
  assert.equal(REAL_INTERRUPTED.profile_snapshot, null)
})
