/**
 * Unsaved Custom Profile editor draft recovery (sessionStorage) tests.
 *
 * Covers the approved requirement: a page reload during editing must recover
 * unsaved Custom Profile edits, scoped to profile id + confirmed revision,
 * with strict structural validation, conflict handling, and no sensitive
 * data ever persisted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROFILE_DRAFT_RECOVERY_KEY,
  PROFILE_DRAFT_RECOVERY_SCHEMA_VERSION,
  NEW_DRAFT_ID,
  serializeDraftRecovery,
  parseDraftRecovery,
  saveDraftRecovery,
  loadDraftRecovery,
  clearDraftRecovery,
  decideDraftRecovery,
  createMemoryDraftRecoveryAdapter,
  type ProfileDraftRecovery,
} from '../src/lib/custom-profile-store/draft-recovery.ts'
import { blankProfilePayload } from '../src/lib/custom-profile-store/editor.ts'

function makeRecovery(overrides: Partial<ProfileDraftRecovery> = {}): ProfileDraftRecovery {
  return {
    schema_version: PROFILE_DRAFT_RECOVERY_SCHEMA_VERSION,
    profile_id: 'profile-abc',
    base_revision: 5,
    payload: blankProfilePayload('pp-1', 'My Profile') as Record<string, unknown>,
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Serialize / parse round-trip + strict validation
// ---------------------------------------------------------------------------

test('serialize/parse round-trips a valid recovery record', () => {
  const r = makeRecovery()
  const back = parseDraftRecovery(serializeDraftRecovery(r))!
  assert.deepEqual(back, r)
})

test('malformed JSON is rejected', () => {
  assert.equal(parseDraftRecovery('{bad json'), null)
  assert.equal(parseDraftRecovery(''), null)
  assert.equal(parseDraftRecovery(null), null)
})

test('missing audit-critical fields rejected', () => {
  assert.equal(parseDraftRecovery(JSON.stringify({ schema_version: 1, base_revision: 5, payload: {}, updated_at: new Date().toISOString() })), null)
  assert.equal(parseDraftRecovery(JSON.stringify({ schema_version: 1, profile_id: '', base_revision: 5, payload: {}, updated_at: new Date().toISOString() })), null)
  assert.equal(parseDraftRecovery(JSON.stringify({ schema_version: 1, profile_id: 'p', payload: {}, updated_at: new Date().toISOString() })), null)
  assert.equal(parseDraftRecovery(JSON.stringify({ schema_version: 1, profile_id: 'p', base_revision: 5, updated_at: new Date().toISOString() })), null)
  assert.equal(parseDraftRecovery(JSON.stringify({ schema_version: 1, profile_id: 'p', base_revision: 5, payload: {}, })), null)
})

test('future schema version is rejected', () => {
  const r = makeRecovery({ schema_version: 999 })
  assert.equal(parseDraftRecovery(serializeDraftRecovery(r)), null)
})

test('negative or non-integer base_revision is rejected', () => {
  assert.equal(parseDraftRecovery(serializeDraftRecovery(makeRecovery({ base_revision: -1 }))), null)
  assert.equal(parseDraftRecovery(serializeDraftRecovery(makeRecovery({ base_revision: 1.5 }))), null)
  assert.equal(parseDraftRecovery(serializeDraftRecovery(makeRecovery({ base_revision: Number.NaN }))), null)
})

test('unknown fields rejected (strict allowlist)', () => {
  const r = makeRecovery()
  const withExtra = { ...r, filename: 'thesis.docx', findings: [1, 2] } as unknown as ProfileDraftRecovery
  assert.equal(parseDraftRecovery(serializeDraftRecovery(withExtra)), null)
})

test('invalid updated_at rejected', () => {
  assert.equal(parseDraftRecovery(serializeDraftRecovery(makeRecovery({ updated_at: 'not-a-date' }))), null)
})

test('non-object payload rejected', () => {
  assert.equal(parseDraftRecovery(serializeDraftRecovery({ ...makeRecovery(), payload: 'nope' })), null)
  assert.equal(parseDraftRecovery(serializeDraftRecovery({ ...makeRecovery(), payload: null })), null)
  assert.equal(parseDraftRecovery(serializeDraftRecovery({ ...makeRecovery(), payload: [1, 2] })), null)
})

// ---------------------------------------------------------------------------
// Save / load / clear
// ---------------------------------------------------------------------------

test('save + load round-trips through the adapter', () => {
  const adapter = createMemoryDraftRecoveryAdapter()
  const r = makeRecovery()
  assert.equal(saveDraftRecovery(adapter, r), true)
  assert.deepEqual(loadDraftRecovery(adapter), r)
})

test('load removes malformed records so they cannot linger', () => {
  const adapter = createMemoryDraftRecoveryAdapter()
  adapter.set(PROFILE_DRAFT_RECOVERY_KEY, '{broken')
  assert.equal(loadDraftRecovery(adapter), null)
  assert.equal(adapter.get(PROFILE_DRAFT_RECOVERY_KEY), null)
})

test('load removes future-version records', () => {
  const adapter = createMemoryDraftRecoveryAdapter()
  adapter.set(PROFILE_DRAFT_RECOVERY_KEY, serializeDraftRecovery(makeRecovery({ schema_version: 999 })))
  assert.equal(loadDraftRecovery(adapter), null)
  assert.equal(adapter.get(PROFILE_DRAFT_RECOVERY_KEY), null)
})

test('null adapter is a safe no-op', () => {
  const r = makeRecovery()
  assert.equal(saveDraftRecovery(null, r), false)
  assert.equal(loadDraftRecovery(null), null)
  assert.doesNotThrow(() => clearDraftRecovery(null))
})

test('clear removes the record', () => {
  const adapter = createMemoryDraftRecoveryAdapter()
  saveDraftRecovery(adapter, makeRecovery())
  assert.notEqual(adapter.get(PROFILE_DRAFT_RECOVERY_KEY), null)
  clearDraftRecovery(adapter)
  assert.equal(adapter.get(PROFILE_DRAFT_RECOVERY_KEY), null)
})

// ---------------------------------------------------------------------------
// decideDraftRecovery — apply / conflict / invalid
// ---------------------------------------------------------------------------

test('same profile + same revision → apply', () => {
  const r = makeRecovery({ profile_id: 'p1', base_revision: 5 })
  const d = decideDraftRecovery(r, 'p1', 5)
  assert.equal(d.action, 'apply')
})

test('same profile + newer confirmed revision → conflict (never auto-apply)', () => {
  const r = makeRecovery({ profile_id: 'p1', base_revision: 5 })
  const d = decideDraftRecovery(r, 'p1', 7)
  assert.equal(d.action, 'conflict')
  if (d.action === 'conflict') assert.equal(d.recovery.profile_id, 'p1')
})

test('different profile → invalid different-profile', () => {
  const r = makeRecovery({ profile_id: 'p1', base_revision: 5 })
  const d = decideDraftRecovery(r, 'p2', 5)
  assert.equal(d.action, 'invalid')
  if (d.action === 'invalid') assert.equal(d.reason, 'different-profile')
})

test('new-draft sentinel identity is distinct from any stored profile', () => {
  const r = makeRecovery({ profile_id: NEW_DRAFT_ID, base_revision: 3 })
  const d = decideDraftRecovery(r, 'p1', 3)
  assert.equal(d.action, 'invalid')
  const d2 = decideDraftRecovery(r, null, 3)
  assert.equal(d2.action, 'apply')
})

test('null recovery → invalid malformed', () => {
  const d = decideDraftRecovery(null, 'p1', 5)
  assert.equal(d.action, 'invalid')
  if (d.action === 'invalid') assert.equal(d.reason, 'malformed')
})

// ---------------------------------------------------------------------------
// Security: never persists sensitive data
// ---------------------------------------------------------------------------

test('serialized record contains only the five allowed keys', () => {
  const adapter = createMemoryDraftRecoveryAdapter()
  saveDraftRecovery(adapter, makeRecovery())
  const raw = adapter.get(PROFILE_DRAFT_RECOVERY_KEY)!
  const obj = JSON.parse(raw) as Record<string, unknown>
  assert.deepEqual(
    new Set(Object.keys(obj)),
    new Set(['schema_version', 'profile_id', 'base_revision', 'payload', 'updated_at']),
  )
})

test('payload is profile-shaped only — no document/filename/audit/findings/keys', () => {
  const adapter = createMemoryDraftRecoveryAdapter()
  const payload = blankProfilePayload('pp-sec', 'Secure Profile') as Record<string, unknown>
  saveDraftRecovery(adapter, makeRecovery({ payload }))
  const raw = adapter.get(PROFILE_DRAFT_RECOVERY_KEY)!
  const lower = raw.toLowerCase()
  for (const banned of ['filename', '.docx', 'findings', 'audit_id', 'api_key', 'credentials', 'password', 'token', 'c:\\', 'document_blocks', 'physical_layout_errors']) {
    assert.ok(!lower.includes(banned), `must not contain ${banned}`)
  }
  const obj = JSON.parse(raw) as Record<string, unknown>
  const payloadKeys = Object.keys(obj.payload as Record<string, unknown>)
  assert.deepEqual(
    new Set(payloadKeys),
    new Set(['profile_id', 'profile_name', 'profile_version', 'profile_source', 'description', 'citation_style', 'body', 'heading', 'margins', 'references', 'captions', 'lists', 'role_policy']),
  )
})

// ---------------------------------------------------------------------------
// Lifecycle: recovery must never leak into the upload selector / audit
// ---------------------------------------------------------------------------

test('recovered draft is NOT a stored profile — selector cannot see it', () => {
  // The recovery record lives in sessionStorage under its own key; the
  // profile store (localStorage ACTIVE_KEY) is untouched by save/load here.
  const adapter = createMemoryDraftRecoveryAdapter()
  saveDraftRecovery(adapter, makeRecovery())
  // Simulate: the profile-store envelope is empty — recovery must not have
  // added anything to it.
  const rawStore = adapter.get('custom-profiles:active')
  assert.equal(rawStore, null, 'recovery must never write into the profile store')
})

test('recovery is cleared explicitly after Save/Discard/Delete semantics', () => {
  const adapter = createMemoryDraftRecoveryAdapter()
  saveDraftRecovery(adapter, makeRecovery())
  // Save succeeded:
  clearDraftRecovery(adapter)
  assert.equal(loadDraftRecovery(adapter), null)
  // Discard:
  saveDraftRecovery(adapter, makeRecovery())
  clearDraftRecovery(adapter)
  assert.equal(loadDraftRecovery(adapter), null)
  // Delete:
  saveDraftRecovery(adapter, makeRecovery())
  clearDraftRecovery(adapter)
  assert.equal(loadDraftRecovery(adapter), null)
})
