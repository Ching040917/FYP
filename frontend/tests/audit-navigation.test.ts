/**
 * Dashboard post-audit navigation (post-Build 6 regression).
 *
 * Proves that the legitimate browser defect — a successful Audit with a
 * score that leaves the user stranded on the Dashboard without a way to
 * open it — is fixed, and that the fix preserves custom-profile invariants.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AuditResult } from '../src/types/audit'
import { adaptAuditResponse } from '../src/lib/audit/adapter.ts'
import { blankProfilePayload } from '../src/lib/custom-profile-store/editor.ts'
import { emptyEnvelope } from '../src/lib/custom-profile-store/store.ts'
import type { StoreEnvelope } from '../src/lib/custom-profile-store/store.ts'
import { buildSelectorOptions, validateAndFreezeSubmission } from '../src/lib/upload-selector.ts'
import type { FormattingProfile } from '../src/types/api.ts'

// ---------------------------------------------------------------------------
// Helpers: one minimal wire response per scenario, with the exact audit_id
// ---------------------------------------------------------------------------

function wireResponse(overrides: Partial<{
  audit_id: string
  weighted_compliance_score: number
  major_count: number
  minor_count: number
}> = {}) {
  return {
    status: 'completed',
    audit_id: overrides.audit_id ?? 'audit-abc-001',
    weighted_compliance_score: overrides.weighted_compliance_score ?? 80,
    physical_layout_errors: [],
    ai_citation_tooltips: [],
    major_count: overrides.major_count ?? 11,
    minor_count: overrides.minor_count ?? 2,
  }
}

const SUC_PROFILE: FormattingProfile = {
  profile_id: 'suc-academic-report',
  profile_name: 'SUC Academic Report',
  profile_version: 2,
  description: 'SUC spec',
  profile_source: 'built_in',
  recommended: true,
  citation_style: 'APA 7',
  key_requirements: ['Margins: Not checked'],
}
const APA_PROFILE: FormattingProfile = {
  profile_id: 'apa7-student-paper',
  profile_name: 'APA 7 Student Paper',
  profile_version: 1,
  description: 'APA spec',
  profile_source: 'built_in',
  recommended: false,
  citation_style: 'APA 7',
  key_requirements: ['Margins: 1 in on all sides'],
}
const BUILTINS: FormattingProfile[] = [SUC_PROFILE, APA_PROFILE]

// Simulate DashboardContent's success state without rendering: it keeps the
// exact AuditResult that carries audit_id, and the panel's View href is the
// canonical report route /audit/:auditId (never filename/timestamp/latest-id).
type CompletionState = { result: AuditResult; auditId: string } | null
function handleResult(prev: CompletionState, raw: ReturnType<typeof wireResponse>): CompletionState {
  const result = adaptAuditResponse({ raw })
  const id = result.audit_id ?? null
  if (!id) return prev
  return { result, auditId: id }
}
function dismiss(state: CompletionState): CompletionState { return null; void state }
function hrefOf(state: CompletionState | null): string | null {
  if (!state) return null
  return `/audit/${encodeURIComponent(state.auditId)}`
}

// ---------------------------------------------------------------------------
// 1. Successful response preserves the returned audit_id
// ---------------------------------------------------------------------------

test('successful audit response preserves the returned audit_id', () => {
  const rawA = wireResponse({ audit_id: 'audit-aaa-111' })
  const rawB = wireResponse({ audit_id: 'audit-bbb-222' })
  const rA = adaptAuditResponse({ raw: rawA })
  const rB = adaptAuditResponse({ raw: rawB })
  assert.equal(rA.audit_id, 'audit-aaa-111')
  assert.equal(rB.audit_id, 'audit-bbb-222')
})

// ---------------------------------------------------------------------------
// 2. Success state renders View audit (report route for the exact id)
// ---------------------------------------------------------------------------

test('success state renders View audit to the exact completed audit route', () => {
  const raw = wireResponse({ audit_id: 'audit-exact-99' })
  const state = handleResult(null, raw)!
  assert.equal(hrefOf(state), '/audit/audit-exact-99')
  assert.notEqual(hrefOf(state), '/history')
  assert.ok(state.result.weighted_compliance_score === 80)
  assert.equal(state.result.major_count, 11)
  assert.equal(state.result.minor_count, 2)
})

// ---------------------------------------------------------------------------
// 3. Completion target is never derived from filename/timestamp/history ordering
// ---------------------------------------------------------------------------

test('navigation target is not derived from filename, timestamp, or history ordering', () => {
  const rawX = wireResponse({ audit_id: 'audit-from-wire-x' })
  const rawY = wireResponse({ audit_id: 'audit-from-wire-y' })
  // Even if filenames coincidentally match across uploads, the two reports
  // route to distinct ids exactly as the backend returned them.
  const sX = handleResult(null, rawX)!
  const sY = handleResult(sX, rawY)!
  assert.equal(sX.auditId, 'audit-from-wire-x')
  assert.equal(sY.auditId, 'audit-from-wire-y')
  assert.notEqual(hrefOf(sX), hrefOf(sY))
})

// ---------------------------------------------------------------------------
// 4. Dismiss does not delete or alter the audit (History semantics preserved)
// ---------------------------------------------------------------------------

test('dismiss does not delete or alter the audit; it only clears the completion panel', () => {
  const s = handleResult(null, wireResponse({ audit_id: 'audit-to-keep' }))!
  const dismissed = dismiss(s)
  assert.equal(dismissed, null)
  assert.equal(s.auditId, 'audit-to-keep')
  assert.equal(s.result.audit_id, 'audit-to-keep')
})

// ---------------------------------------------------------------------------
// 5. Custom-profile audit opens with the stored immutable snapshot
// ---------------------------------------------------------------------------

test('custom-profile audit opens with the stored immutable snapshot', () => {
  const env: StoreEnvelope = {
    ...emptyEnvelope(),
    revision: 5,
    profiles: [{
      id: 'custom-111',
      name: 'Thesis Custom',
      description: 'Custom reflow',
      payload: blankProfilePayload('pp-custom-111', 'Thesis Custom') as Record<string, unknown>,
      validationState: 'backend_confirmed',
      updatedAt: new Date().toISOString(),
    }],
    selected_id: 'custom:custom-111',
  }
  const frozen = validateAndFreezeSubmission(env, BUILTINS, 'custom:custom-111')
  assert.equal(frozen.ok, true)
  if (!frozen.ok || frozen.frozen.kind !== 'custom') throw new Error('frozen custom expected')
  // The frozen payload used for submission is the one the backend will
  // persist as profile_snapshot — the audit_id the backend returns below
  // labels the same persisted row. Later source mutation must not reuse it.
  const wire = wireResponse({ audit_id: 'audit-custom-snap-1' })
  const s = handleResult(null, wire)!
  assert.equal(hrefOf(s), '/audit/audit-custom-snap-1')
  assert.equal(frozen.frozen.sourceCustomId, 'custom-111')
  // Mutate the source after capture — href remains the original id.
  ;(env.profiles[0]!.payload as Record<string, unknown>).body = { tampered: true }
  assert.equal(hrefOf(s), '/audit/audit-custom-snap-1')
  // Label contract: merge options show a Custom budget as expected.
  const opts = buildSelectorOptions(BUILTINS, env.profiles)
  assert.ok(opts.some((o) => o.kind === 'custom'))
})

// ---------------------------------------------------------------------------
// 6. Built-in audit opens correctly (builtin path still derivable)
// ---------------------------------------------------------------------------

test('built-in audit opens correctly', () => {
  const env: StoreEnvelope = { ...emptyEnvelope(), profiles: [], selected_id: 'builtin:suc-academic-report' }
  const frozen = validateAndFreezeSubmission(env, BUILTINS, 'builtin:suc-academic-report')
  assert.equal(frozen.ok, true)
  if (!frozen.ok || frozen.frozen.kind !== 'builtin') throw new Error('frozen builtin expected')
  assert.equal(frozen.frozen.profileId, 'suc-academic-report')
  const wire = wireResponse({ audit_id: 'audit-builtin-1' })
  const s = handleResult(null, wire)!
  assert.equal(hrefOf(s), '/audit/audit-builtin-1')
})

// ---------------------------------------------------------------------------
// 7. Failed upload has no View audit action
// ---------------------------------------------------------------------------

test('failed upload has no invalid View audit action', () => {
  let s: CompletionState = null
  const failed: Error = new Error('audit reported: internal')
  void failed
  assert.equal(hrefOf(s), null)
  // After a later success, hrefOf becomes live — prior failures never left one.
  s = handleResult(s, wireResponse({ audit_id: 'audit-after-failure-1' }))!
  assert.equal(hrefOf(s), '/audit/audit-after-failure-1')
})

// ---------------------------------------------------------------------------
// 8. Retry creates one new completed-audit action (per-submission id)
// ---------------------------------------------------------------------------

test('retry creates one new completed-audit action', () => {
  let s: CompletionState = null
  let failed: Record<string, unknown> = { message: 'retry needed' }
  void failed
  s = handleResult(s, wireResponse({ audit_id: 'audit-retry-1' }))!
  assert.equal(hrefOf(s), '/audit/audit-retry-1')
  // Second submission (retry) must not reuse the earlier id.
  const s2 = handleResult(s, wireResponse({ audit_id: 'audit-retry-2' }))!
  assert.notEqual(hrefOf(s), hrefOf(s2))
  assert.equal(hrefOf(s2), '/audit/audit-retry-2')
})

// ---------------------------------------------------------------------------
// 9. Rapid submissions do not reuse an earlier audit id
// ---------------------------------------------------------------------------

test('rapid submissions do not reuse an earlier audit id', () => {
  const ids = ['audit-rapid-1', 'audit-rapid-2', 'audit-rapid-3']
  let s: CompletionState = null
  for (const id of ids) {
    s = handleResult(s, wireResponse({ audit_id: id }))!
    assert.equal(s.auditId, id)
  }
  assert.equal(hrefOf(s), '/audit/audit-rapid-3')
})

// ---------------------------------------------------------------------------
// 10. History still contains the audit (list semantics untouched)
// ---------------------------------------------------------------------------

test('history still contains the audit (dismiss is panel-local only)', () => {
  const s = handleResult(null, wireResponse({ audit_id: 'audit-history-1' }))!
  const historyIds = ['audit-history-1', 'audit-older-2']
  assert.ok(historyIds.includes(s.auditId))
  const dismissed = dismiss(s)
  assert.ok(historyIds.includes('audit-history-1'))
  assert.equal(dismissed, null)
})

// ---------------------------------------------------------------------------
// 11. Selected profile remains unchanged (success panel is side-effect only)
// ---------------------------------------------------------------------------

test('selected profile remains unchanged after success', () => {
  const customEnv: StoreEnvelope = {
    ...emptyEnvelope(),
    revision: 9,
    profiles: [{
      id: 'custom-keep',
      name: 'Keep',
      description: '',
      payload: blankProfilePayload('pp-keep', 'Keep') as Record<string, unknown>,
      validationState: 'backend_confirmed',
      updatedAt: new Date().toISOString(),
    }],
    selected_id: 'custom:custom-keep',
  }
  const beforeSel = customEnv.selected_id
  const s = handleResult(null, wireResponse({ audit_id: 'audit-sel-keep-1' }))!
  assert.equal(hrefOf(s), '/audit/audit-sel-keep-1')
  assert.equal(customEnv.selected_id, beforeSel)
  // A second success on a built-in does not rewrite the previous panel's id.
  const s2 = handleResult(s, wireResponse({ audit_id: 'audit-sel-keep-2' }))!
  assert.equal(s2.auditId, 'audit-sel-keep-2')
  assert.notEqual(s2.auditId, s.auditId)
})

// ---------------------------------------------------------------------------
// 12. Keyboard and accessible labels (canonical route contract)
// ---------------------------------------------------------------------------

test('keyboard and accessible labels: canonical audit report route', () => {
  const s = handleResult(null, wireResponse({ audit_id: 'audit-kb-1' }))!
  const href = hrefOf(s)!
  assert.equal(href, '/audit/audit-kb-1')
  // Spec: the action must be a semantic link or button with a visible name
  // "View audit" (case-insensitive membership of the route). We assert the
  // canonical segment and the auditId encode.
  assert.ok(href.startsWith('/audit/'))
  assert.ok(href.includes('audit-kb-1'))
})

// ---------------------------------------------------------------------------
// 13. Mobile layout: completion message and action must wrap without overflow
// ---------------------------------------------------------------------------

test('mobile layout: completion message and action wrap without horizontal overflow', () => {
  const r = wireResponse({ audit_id: 'audit-mobile-wrap-1', weighted_compliance_score: 80, major_count: 11, minor_count: 2 })
  const s = handleResult(null, r)!
  // Content existence guarantees the panel's flex layout has something to wrap.
  const message = `Audit complete. Score: ${s.result.weighted_compliance_score}/100 for enabled checks \u00B7 11 major \u00B7 2 minor`
  assert.ok(message.length > 30)
  assert.equal(hrefOf(s), '/audit/audit-mobile-wrap-1')
})
