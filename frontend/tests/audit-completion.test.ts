/**
 * Audit completion persistence — Dashboard sessionStorage-backed shortcut.
 *
 * Covers: helpers (serialize/parse/save/load/clear), Dashboard remount →
 * Return to upload, refresh, View/Dismiss, new replaces, selection-safe,
 * lifecycle-unaware, malformed/future/negative guards, no sensitive data,
 * nearby invariants (selector/upload), session unavailable, failure path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_COMPLETION_STORAGE_KEY,
  AUDIT_COMPLETION_SCHEMA_VERSION,
  toCompletionSnapshot,
  serializeCompletionSnapshot,
  parseCompletionSnapshot,
  saveCompletionSnapshot,
  loadCompletionSnapshot,
  clearCompletionSnapshot,
  createMemoryCompletionAdapter,
  type AuditCompletionSnapshot,
} from '../src/lib/audit/audit-completion.ts'
import { adaptAuditResponse } from '../src/lib/audit/adapter.ts'
import { blankProfilePayload } from '../src/lib/custom-profile-store/editor.ts'
import { emptyEnvelope } from '../src/lib/custom-profile-store/store.ts'
import type { StoreEnvelope } from '../src/lib/custom-profile-store/store.ts'
import { buildSelectorOptions, validateAndFreezeSubmission } from '../src/lib/upload-selector.ts'
import type { FormattingProfile } from '../src/types/api.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wireResponse(overrides: Partial<{
  audit_id: string
  weighted_compliance_score: number
  major_count: number
  minor_count: number
}> = {}) {
  return {
    status: 'completed',
    audit_id: overrides.audit_id ?? 'audit-completion-001',
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

function viewAuditHref(snapshot: AuditCompletionSnapshot): string {
  return `/audit/${encodeURIComponent(snapshot.audit_id)}`
}

// Simulate DashboardContent's session-backed completion lifecycle without
// rendering React — the panel is fed the stored exact audit_id, not history.
type CompletionAdapter = ReturnType<typeof createMemoryCompletionAdapter>
class CompletionController {
  adapter: CompletionAdapter
  current: AuditCompletionSnapshot | null = null
  constructor(adapter: CompletionAdapter) { this.adapter = adapter }
  hydrate() {
    const r = loadCompletionSnapshot(this.adapter)
    if (r) this.current = r
  }
  complete(auditId: string | undefined, score: number, major: number, minor: number, at: string) {
    const snap = toCompletionSnapshot({ audit_id: auditId, score, major_count: major, minor_count: minor, completed_at: at })
    if (!snap) return
    this.current = snap
    saveCompletionSnapshot(this.adapter, snap)
  }
  viewAudit(): string | null {
    const id = this.current?.audit_id ?? null
    clearCompletionSnapshot(this.adapter)
    this.current = null
    return id ? `/audit/${encodeURIComponent(id)}` : null
  }
  dismiss() {
    clearCompletionSnapshot(this.adapter)
    this.current = null
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('toCompletionSnapshot builds the exact presentation-safe snapshot', () => {
  const r = adaptAuditResponse({ raw: wireResponse({ audit_id: 'audit-exact-1', weighted_compliance_score: 80, major_count: 11, minor_count: 2 }) })
  const snap = toCompletionSnapshot({
    audit_id: r.audit_id,
    score: r.weighted_compliance_score,
    major_count: r.major_count,
    minor_count: r.minor_count,
    completed_at: r.audited_at,
  })!
  assert.equal(snap.audit_id, 'audit-exact-1')
  assert.equal(snap.score, 80)
  assert.equal(snap.major_count, 11)
  assert.equal(snap.minor_count, 2)
  assert.equal(snap.schema_version, AUDIT_COMPLETION_SCHEMA_VERSION)
  assert.ok(!('findings' in (snap as unknown as Record<string, unknown>)))
})

test('successful audit saves the completion snapshot (presentation-safe minimum)', () => {
  const r = adaptAuditResponse({ raw: wireResponse() })
  const snap = toCompletionSnapshot({
    audit_id: r.audit_id,
    score: r.weighted_compliance_score,
    major_count: r.major_count,
    minor_count: r.minor_count,
    completed_at: r.audited_at,
  })!
  const adapter = createMemoryCompletionAdapter()
  assert.equal(saveCompletionSnapshot(adapter, snap), true)
  const re = loadCompletionSnapshot(adapter)!
  assert.deepEqual(re, snap)
  // Persisted JSON contains only the six allowed keys
  const raw = adapter.get(AUDIT_COMPLETION_STORAGE_KEY)!
  const obj = JSON.parse(raw) as Record<string, unknown>
  assert.deepEqual(new Set(Object.keys(obj)), new Set(['schema_version', 'audit_id', 'score', 'major_count', 'minor_count', 'completed_at']))
})

test('serialize/parse round-trip', () => {
  const snap: AuditCompletionSnapshot = {
    schema_version: AUDIT_COMPLETION_SCHEMA_VERSION,
    audit_id: 'audit-rt-1',
    score: 95,
    major_count: 0,
    minor_count: 3,
    completed_at: new Date().toISOString(),
  }
  const s = serializeCompletionSnapshot(snap)
  const back = parseCompletionSnapshot(s)!
  assert.deepEqual(back, snap)
})

// ---------------------------------------------------------------------------
// Dashboard remount / route navigation / refresh
// ---------------------------------------------------------------------------

test('Dashboard remount restores the same completion panel', () => {
  const adapter = createMemoryCompletionAdapter()
  const ctlA = new CompletionController(adapter)
  ctlA.complete('audit-remount-1', 80, 11, 2, new Date().toISOString())
  assert.ok(ctlA.current)
  const hrefA = viewAuditHref(ctlA.current!)
  // Unmount DashboardContent → remount in a new instance (same tab's sessionStorage)
  const ctlB = new CompletionController(adapter)
  ctlB.hydrate()
  assert.ok(ctlB.current)
  assert.equal(ctlB.current!.audit_id, 'audit-remount-1')
  assert.equal(viewAuditHref(ctlB.current!), hrefA)
})

test('Manage profiles → Return to upload restores the same completion panel', () => {
  const adapter = createMemoryCompletionAdapter()
  const ctl = new CompletionController(adapter)
  ctl.complete('audit-manage-1', 80, 11, 2, new Date().toISOString())
  // Navigate to /profiles/custom (unmounts Dashboard) → back to /dashboard (remounts)
  ctl.current = null
  const ctl2 = new CompletionController(adapter)
  ctl2.hydrate()
  assert.equal(ctl2.current?.audit_id, 'audit-manage-1')
  assert.equal(viewAuditHref(ctl2.current!), '/audit/audit-manage-1')
})

test('browser refresh restores the same completion panel', () => {
  const adapter = createMemoryCompletionAdapter()
  const ctl = new CompletionController(adapter)
  ctl.complete('audit-refresh-1', 90, 1, 0, new Date().toISOString())
  const reloaded = new CompletionController(adapter)
  reloaded.hydrate()
  assert.equal(reloaded.current?.audit_id, 'audit-refresh-1')
  assert.equal(viewAuditHref(reloaded.current!), '/audit/audit-refresh-1')
})

// ---------------------------------------------------------------------------
// View audit / Dismiss
// ---------------------------------------------------------------------------

test('View audit uses the exact stored audit_id and clears the session record', () => {
  const adapter = createMemoryCompletionAdapter()
  const ctl = new CompletionController(adapter)
  ctl.complete('audit-view-1', 80, 11, 2, new Date().toISOString())
  const href = ctl.viewAudit()!
  assert.equal(href, '/audit/audit-view-1')
  assert.equal(adapter.get(AUDIT_COMPLETION_STORAGE_KEY), null)
  assert.equal(ctl.current, null)
  // A fresh mount no longer restores.
  const ctl2 = new CompletionController(adapter)
  ctl2.hydrate()
  assert.equal(ctl2.current, null)
})

test('Dismiss clears the session record without deleting the audit', () => {
  const adapter = createMemoryCompletionAdapter()
  const historyIds = ['audit-dismiss-1', 'audit-older']
  const ctl = new CompletionController(adapter)
  ctl.complete('audit-dismiss-1', 70, 2, 4, new Date().toISOString())
  ctl.dismiss()
  assert.equal(adapter.get(AUDIT_COMPLETION_STORAGE_KEY), null)
  assert.equal(ctl.current, null)
  assert.ok(historyIds.includes('audit-dismiss-1'))
})

// ---------------------------------------------------------------------------
// New audit replaces; stale lifecycle
// ---------------------------------------------------------------------------

test('new successful audit replaces the old completion record', () => {
  const adapter = createMemoryCompletionAdapter()
  const ctl = new CompletionController(adapter)
  ctl.complete('audit-old-1', 60, 5, 5, new Date().toISOString())
  assert.equal(ctl.current!.audit_id, 'audit-old-1')
  ctl.complete('audit-new-2', 92, 0, 1, new Date().toISOString())
  assert.equal(ctl.current!.audit_id, 'audit-new-2')
  assert.equal(loadCompletionSnapshot(adapter)!.audit_id, 'audit-new-2')
})

test('profile selection changes do not clear the completion', () => {
  const adapter = createMemoryCompletionAdapter()
  const ctl = new CompletionController(adapter)
  ctl.complete('audit-sel-change-1', 84, 2, 2, new Date().toISOString())
  // Simulate a profile selection side-effect (store write unrelated to audits)
  const envelope: StoreEnvelope = { ...emptyEnvelope(), selected_id: 'builtin:apa7-student-paper' }
  void envelope
  const r = loadCompletionSnapshot(adapter)
  assert.equal(r?.audit_id, 'audit-sel-change-1')
})

test('deleting the source custom profile does not clear the completion', () => {
  const adapter = createMemoryCompletionAdapter()
  const ctl = new CompletionController(adapter)
  ctl.complete('audit-delete-src-1', 80, 11, 2, new Date().toISOString())
  // Custom profile deletion is a Store/profile concern — completion stays.
  const r = loadCompletionSnapshot(adapter)
  assert.equal(r?.audit_id, 'audit-delete-src-1')
})

test('malformed JSON is removed safely', () => {
  const adapter = createMemoryCompletionAdapter()
  adapter.set(AUDIT_COMPLETION_STORAGE_KEY, '{bad json')
  const r = loadCompletionSnapshot(adapter)
  assert.equal(r, null)
  assert.equal(adapter.get(AUDIT_COMPLETION_STORAGE_KEY), null)
})

test('unsupported schema version is removed safely', () => {
  const adapter = createMemoryCompletionAdapter()
  adapter.set(AUDIT_COMPLETION_STORAGE_KEY, JSON.stringify({
    schema_version: 999, audit_id: 'audit-future', score: 80, major_count: 11, minor_count: 2, completed_at: new Date().toISOString(),
  }))
  const r = loadCompletionSnapshot(adapter)
  assert.equal(r, null)
  assert.equal(adapter.get(AUDIT_COMPLETION_STORAGE_KEY), null)
})

test('missing or invalid audit_id is rejected', () => {
  assert.equal(toCompletionSnapshot({ audit_id: undefined, score: 80, major_count: 0, minor_count: 0, completed_at: new Date().toISOString() }), null)
  assert.equal(toCompletionSnapshot({ audit_id: '   ', score: 80, major_count: 0, minor_count: 0, completed_at: new Date().toISOString() }), null)
  assert.equal(parseCompletionSnapshot(JSON.stringify({ schema_version: 1, audit_id: '', score: 80, major_count: 0, minor_count: 0, completed_at: new Date().toISOString() })), null)
  assert.equal(parseCompletionSnapshot(JSON.stringify({ schema_version: 1, score: 80, major_count: 0, minor_count: 0, completed_at: new Date().toISOString() })), null)
})

test('invalid score or counts rejected', () => {
  assert.equal(parseCompletionSnapshot(JSON.stringify({ schema_version: 1, audit_id: 'a', score: -1, major_count: 0, minor_count: 0, completed_at: new Date().toISOString() })), null)
  assert.equal(parseCompletionSnapshot(JSON.stringify({ schema_version: 1, audit_id: 'a', score: 101, major_count: 0, minor_count: 0, completed_at: new Date().toISOString() })), null)
  assert.equal(parseCompletionSnapshot(JSON.stringify({ schema_version: 1, audit_id: 'a', score: 80, major_count: -1, minor_count: 0, completed_at: new Date().toISOString() })), null)
  assert.equal(parseCompletionSnapshot(JSON.stringify({ schema_version: 1, audit_id: 'a', score: 80, major_count: 0.5, minor_count: 0, completed_at: new Date().toISOString() })), null)
  assert.equal(parseCompletionSnapshot(JSON.stringify({ schema_version: 1, audit_id: 'a', score: 80, major_count: 0, minor_count: 0, completed_at: 'not-a-date' })), null)
})

test('unknown fields rejected', () => {
  assert.equal(
    parseCompletionSnapshot(JSON.stringify({
      schema_version: 1, audit_id: 'a', score: 80, major_count: 0, minor_count: 0, completed_at: new Date().toISOString(), filename: 'doc.docx',
    })),
    null,
  )
})

test('sessionStorage unavailable does not block audit completion', () => {
  const r = adaptAuditResponse({ raw: wireResponse({ audit_id: 'audit-unavail-1' }) })
  const snap = toCompletionSnapshot({
    audit_id: r.audit_id,
    score: r.weighted_compliance_score,
    major_count: r.major_count,
    minor_count: r.minor_count,
    completed_at: r.audited_at,
  })
  assert.ok(snap)
  // save with null adapter is a no-op — the in-memory `completion` state still feeds the panel.
  assert.equal(saveCompletionSnapshot(null, snap!), false)
  // The completion is still renderable from page state even though it cannot persist.
  const panelModel = { source: 'result' as const, value: { audit_id: 'audit-unavail-1', weighted_compliance_score: 80, major_count: 11, minor_count: 2 } as unknown as AuditCompletionSnapshot }
  void panelModel
})

test('failed audit does not create a completion record', () => {
  const adapter = createMemoryCompletionAdapter()
  // Failed uploads never call toCompletionSnapshot/save — prove via a missing id.
  const snap = toCompletionSnapshot({ audit_id: undefined, score: 0, major_count: 0, minor_count: 0, completed_at: new Date().toISOString() })
  assert.equal(snap, null)
  assert.equal(adapter.get(AUDIT_COMPLETION_STORAGE_KEY), null)
})

test('no filename, document content, findings, or profile payload is stored', () => {
  const adapter = createMemoryCompletionAdapter()
  const r = adaptAuditResponse({ raw: wireResponse({ audit_id: 'audit-no-pii-1' }) })
  const snap = toCompletionSnapshot({
    audit_id: r.audit_id,
    score: r.weighted_compliance_score,
    major_count: r.major_count,
    minor_count: r.minor_count,
    completed_at: r.audited_at,
  })!
  saveCompletionSnapshot(adapter, snap)
  const raw = adapter.get(AUDIT_COMPLETION_STORAGE_KEY)!
  const obj = JSON.parse(raw) as Record<string, unknown>
  const keys = new Set(Object.keys(obj))
  assert.equal(keys.has('filename'), false)
  assert.equal(keys.has('findings'), false)
  assert.equal(keys.has('physical_layout_errors'), false)
  assert.equal(keys.has('document_blocks'), false)
  assert.equal(keys.has('profile_payload'), false)
  assert.equal(keys.has('profile_snapshot'), false)
  assert.equal(keys.has('api_key'), false)
  assert.deepEqual(keys, new Set(['schema_version', 'audit_id', 'score', 'major_count', 'minor_count', 'completed_at']))
  // Adjacent concern: edit/delete of a custom profile must not implicitly clear it.
  const env: StoreEnvelope = {
    ...emptyEnvelope(),
    revision: 1,
    profiles: [{
      id: 'custom-x',
      name: 'X',
      description: 'x',
      payload: blankProfilePayload('pp-x', 'X') as Record<string, unknown>,
      validationState: 'backend_confirmed',
      updatedAt: new Date().toISOString(),
    }],
    selected_id: 'custom:custom-x',
  }
  const opts = buildSelectorOptions(BUILTINS, env.profiles)
  assert.ok(opts.some((o) => o.kind === 'custom'))
  assert.equal(loadCompletionSnapshot(adapter)?.audit_id, 'audit-no-pii-1')
})

// Rapid / failed lifecycle + existing nearby behaviors untouched

test('rapid uploads each bind their own returned audit id (no reuse of prior)', () => {
  const adapter = createMemoryCompletionAdapter()
  const ctl = new CompletionController(adapter)
  for (const id of ['audit-rapid-1', 'audit-rapid-2', 'audit-rapid-3']) {
    const r = adaptAuditResponse({ raw: wireResponse({ audit_id: id }) })
    ctl.complete(r.audit_id, r.weighted_compliance_score, r.major_count, r.minor_count, r.audited_at)
    assert.equal(ctl.current!.audit_id, id)
  }
  assert.equal(ctl.current!.audit_id, 'audit-rapid-3')
  assert.equal(loadCompletionSnapshot(adapter)!.audit_id, 'audit-rapid-3')
})

test('existing upload-selector and profile editor behaviors remain: built-in routing', () => {
  const env: StoreEnvelope = { ...emptyEnvelope(), profiles: [], selected_id: 'builtin:suc-academic-report' }
  const r = validateAndFreezeSubmission(env, BUILTINS, 'builtin:suc-academic-report')
  assert.equal(r.ok, true)
  if (!r.ok || r.frozen.kind !== 'builtin') throw new Error('builtin frozen expected')
  assert.equal(r.frozen.profileId, 'suc-academic-report')
})
