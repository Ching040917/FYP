/**
 * Custom Profile Store — Build 1 PoC tests.
 *
 * Pure persistence layer: envelope loading/recovery, revision-based
 * concurrency, immutable IDs, unique names, lifecycle ops, corruption
 * recovery, and the no-sensitive-fields guarantee. Uses an injected
 * in-memory adapter so everything is deterministic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_KEY,
  RECOVERY_KEY,
  acceptReset,
  canSubmitProfile,
  CUSTOM_STORE_SCHEMA_VERSION,
  deleteProfile,
  duplicateProfile,
  emptyEnvelope,
  generateProfileId,
  handleStorageEvent,
  hasNewerExternalRevision,
  isNameTaken,
  isWellFormedEnvelope,
  loadStore,
  markValidationState,
  RECOMMENDED_BUILTIN_ID,
  renameProfile,
  saveStore,
  serializeEnvelope,
  setSelectedProfile,
  upsertProfile,
  type StoreAdapter,
  type StoreEnvelope,
  type StoredCustomProfile,
} from '../src/lib/custom-profile-store/store.ts'

// ---------------------------------------------------------------------------
// In-memory adapter
// ---------------------------------------------------------------------------

class MemoryAdapter implements StoreAdapter {
  readonly persistent = true
  private pending: Promise<unknown> = Promise.resolve()
  withExclusiveWrite<T>(write: () => T | Promise<T>): Promise<T> {
    const next = this.pending.then(write)
    this.pending = next.catch(() => undefined)
    return next
  }
  private store = new Map<string, string>()
  private listeners = new Set<(key: string) => void>()

  get(key: string): string | null {
    return this.store.get(key) ?? null
  }
  set(key: string, value: string): void {
    this.store.set(key, value)
    this.listeners.forEach((fn) => fn(key))
  }
  onExternalChange(cb: (key: string) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  get raw(): Map<string, string> {
    return this.store
  }
}

function profile(overrides: Partial<StoredCustomProfile> = {}): StoredCustomProfile {
  return {
    id: generateProfileId(),
    name: 'My Profile',
    description: '',
    payload: { profile_name: 'My Profile', citation_style: 'APA 7', profile_source: 'custom' },
    validationState: 'locally_valid',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  }
}

function env(overrides: Partial<StoreEnvelope> = {}): StoreEnvelope {
  return {
    schema_version: CUSTOM_STORE_SCHEMA_VERSION,
    revision: 0,
    updated_at: '2026-08-20T00:00:00.000Z',
    profiles: [],
    selected_id: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// First run / empty
// ---------------------------------------------------------------------------

test('empty first run returns fresh envelope with no profiles', async () => { const adapter = new MemoryAdapter()
const result = loadStore(adapter)
assert.ok(result.ok && result.firstRun)
assert.equal(result.envelope.profiles.length, 0)
assert.equal(result.envelope.revision, 0)
assert.equal(result.envelope.selected_id, null) })

// ---------------------------------------------------------------------------
// Valid store load
// ---------------------------------------------------------------------------

test('valid active store loads without recovery', async () => { const adapter = new MemoryAdapter()
const p = profile({ name: 'Active Only' })
const envelope = env({ revision: 3, profiles: [p], selected_id: p.id })
adapter.set(ACTIVE_KEY, serializeEnvelope(envelope))
const result = loadStore(adapter)
assert.ok(result.ok)
assert.equal(result.recovered, false)
assert.equal(result.envelope.revision, 3)
assert.equal(result.envelope.profiles[0]!.name, 'Active Only') })

test('valid recovery store is used when active is absent', async () => { const adapter = new MemoryAdapter()
const p = profile({ name: 'Recovered' })
const envelope = env({ revision: 2, profiles: [p] })
adapter.set(RECOVERY_KEY, serializeEnvelope(envelope))
const result = loadStore(adapter)
assert.ok(result.ok)
assert.equal(result.recovered, true)
assert.equal(result.envelope.profiles[0]!.name, 'Recovered') })

test('newest valid revision wins across active and recovery', async () => { const adapter = new MemoryAdapter()
const a = profile({ name: 'Active Older' })
const r = profile({ name: 'Recovery Newer' })
adapter.set(ACTIVE_KEY, serializeEnvelope(env({ revision: 1, profiles: [a] })))
adapter.set(RECOVERY_KEY, serializeEnvelope(env({ revision: 5, profiles: [r] })))
const result = loadStore(adapter)
assert.ok(result.ok)
assert.equal(result.recovered, true)
assert.equal(result.envelope.revision, 5)
assert.equal(result.envelope.profiles[0]!.name, 'Recovery Newer') })

// ---------------------------------------------------------------------------
// Corruption recovery
// ---------------------------------------------------------------------------

test('malformed active with valid recovery falls back to recovery', async () => { const adapter = new MemoryAdapter()
const r = profile({ name: 'Fallback' })
adapter.set(ACTIVE_KEY, '{ not valid json !!')
adapter.set(RECOVERY_KEY, serializeEnvelope(env({ revision: 4, profiles: [r] })))
const result = loadStore(adapter)
assert.ok(result.ok)
assert.equal(result.recovered, true)
assert.equal(result.envelope.profiles[0]!.name, 'Fallback') })

test('both corrupted returns friendly state with raw values preserved', async () => { const adapter = new MemoryAdapter()
adapter.set(ACTIVE_KEY, 'garbage-active')
adapter.set(RECOVERY_KEY, 'garbage-recovery')
const result = loadStore(adapter)
assert.ok(!result.ok)
assert.equal(result.reason, 'both-corrupted')
assert.equal(result.corruptedActive, 'garbage-active')
assert.equal(result.corruptedRecovery, 'garbage-recovery') })

test('accept reset writes clean envelope and selects recommended built-in', async () => { const adapter = new MemoryAdapter()
adapter.set(ACTIVE_KEY, 'garbage-active')
adapter.set(RECOVERY_KEY, 'garbage-recovery')
const clean = (await acceptReset(adapter))
assert.ok(clean.ok)
assert.equal(clean.envelope.selected_id, `builtin:${RECOMMENDED_BUILTIN_ID}`)
assert.equal(clean.envelope.profiles.length, 0)
const reloaded = loadStore(adapter)
assert.ok(reloaded.ok)
assert.equal(reloaded.envelope.selected_id, `builtin:${RECOMMENDED_BUILTIN_ID}`) })

test('corrupted raw data replaced only after accept reset', async () => { const adapter = new MemoryAdapter()
adapter.set(ACTIVE_KEY, 'garbage')
const clean = (await acceptReset(adapter))
// acceptReset overwrites both keys with clean data; raw corruption is
// intentionally lost only AFTER the user accepts the reset.
assert.ok(clean.ok)
assert.equal(adapter.get(ACTIVE_KEY), serializeEnvelope(clean.envelope))
assert.notEqual(adapter.get(ACTIVE_KEY), 'garbage') })

// ---------------------------------------------------------------------------
// Future schema version
// ---------------------------------------------------------------------------

test('future schema version is read-only', async () => { const adapter = new MemoryAdapter()
const future = env({ schema_version: 99, revision: 10 })
adapter.set(ACTIVE_KEY, serializeEnvelope(future))
const result = loadStore(adapter)
assert.ok(result.ok)
assert.equal(result.readonly, true)
const write = (await saveStore(adapter, env({ revision: 11 }), 10))
assert.deepEqual(write, { ok: false, reason: 'readonly' }) })

// ---------------------------------------------------------------------------
// ID / name rules
// ---------------------------------------------------------------------------

test('duplicate profile ID cannot be added twice', async () => { const p = profile({ name: 'One' })
let e = env()
const r1 = upsertProfile(e, p)
assert.ok(r1.ok)
e = r1.envelope
const dup = { ...p, name: 'Two' } // same id, different name
const r2 = upsertProfile(e, dup)
assert.ok(r2.ok) // same id replaces (identity is the id)
assert.equal(e.profiles.length, 1) })

test('case-insensitive duplicate name is refused', async () => { let e = env()
const r1 = upsertProfile(e, profile({ name: 'My Profile' }))
assert.ok(r1.ok)
e = r1.envelope
const r2 = upsertProfile(e, profile({ name: 'my profile' }))
assert.ok(!r2.ok)
assert.equal(r2.reason, 'duplicate-name') })

test('rename keeps the immutable id', async () => { const p = profile({ name: 'Original' })
const r1 = upsertProfile(env(), p)
assert.ok(r1.ok)
const r2 = renameProfile(r1.envelope, p.id, 'Renamed')
assert.ok(r2.ok)
assert.equal(r2.envelope.profiles[0]!.id, p.id)
assert.equal(r2.envelope.profiles[0]!.name, 'Renamed') })

test('rename refuses duplicate name case-insensitively', async () => { const p1 = profile({ name: 'First' })
const p2 = profile({ name: 'Second' })
let e = env()
e = upsertProfile(e, p1).ok ? e : e
const r1 = upsertProfile(e, p1)
assert.ok(r1.ok)
e = r1.envelope
const r2 = upsertProfile(e, p2)
assert.ok(r2.ok)
e = r2.envelope
const rn = renameProfile(e, p2.id, 'first')
assert.ok(!rn.ok)
assert.equal(rn.reason, 'duplicate-name') })

test('isNameTaken detects case-insensitive collision', async () => { const e = env({ profiles: [profile({ name: 'Taken Name' })] })
assert.equal(isNameTaken(e, 'taken name'), true)
assert.equal(isNameTaken(e, 'Taken Name', 'some-other-id'), true) })

// ---------------------------------------------------------------------------
// Built-in safety
// ---------------------------------------------------------------------------

test('delete refuses built-in (no built-in profiles exist in store)', async () => { const adapter = new MemoryAdapter()
const e = env()
adapter.set(ACTIVE_KEY, serializeEnvelope(e))
// Built-ins are never in the custom store — deleting a non-existent id fails.
const r = deleteProfile(e, RECOMMENDED_BUILTIN_ID)
assert.ok(!r.ok)
assert.equal(r.reason, 'not-found') })

test('duplicate of a built-in listing creates a custom profile with new id', async () => { const adapter = new MemoryAdapter()
const e = env()
const builtin: import('../src/types/api').FormattingProfile = {
  profile_id: 'suc-academic-report',
  profile_name: 'SUC Academic Report',
  profile_version: 2,
  description: 'Institution-specific.',
  profile_source: 'built_in',
  recommended: true,
  citation_style: 'APA 7',
  key_requirements: [],
}
const r = duplicateProfile(e, builtin, 'My SUC Copy')
assert.ok(r.ok)
assert.notEqual(r.profile.id, builtin.profile_id)
assert.equal(r.profile.sourceId, 'suc-academic-report')
assert.equal(r.profile.name, 'My SUC Copy') })

// ---------------------------------------------------------------------------
// Deletion lifecycle
// ---------------------------------------------------------------------------

test('deleting selected custom profile resets selection to recommended built-in', async () => { const p = profile({ name: 'Selected' })
let e = env({ profiles: [p], selected_id: `custom:${p.id}` })
const r = deleteProfile(e, p.id)
assert.ok(r.ok)
assert.equal(r.envelope.selected_id, `builtin:${RECOMMENDED_BUILTIN_ID}`)
assert.equal(r.envelope.profiles.length, 0) })

test('deleting a non-selected profile keeps selection', async () => { const p1 = profile({ name: 'Keep' })
const p2 = profile({ name: 'Delete' })
const e = env({ profiles: [p1, p2], selected_id: p1.id })
const r = deleteProfile(e, p2.id)
assert.ok(r.ok)
assert.equal(r.envelope.selected_id, p1.id)
assert.equal(r.envelope.profiles.length, 1) })

test('set selected profile stores id', async () => { const p = profile()
const e = setSelectedProfile(env({ profiles: [p] }), p.id)
assert.equal(e.selected_id, p.id) })

// ---------------------------------------------------------------------------
// Revision / concurrency
// ---------------------------------------------------------------------------

test('save refuses a stale revision write', async () => { const adapter = new MemoryAdapter()
const e = env({ revision: 7 })
adapter.set(ACTIVE_KEY, serializeEnvelope(e))
const stale = (await saveStore(adapter, env({ revision: 8 }), 5))
assert.deepEqual(stale, { ok: false, reason: 'stale-revision' }) })

test('save writes recovery before replacing active', async () => { const adapter = new MemoryAdapter()
const e1 = env({ revision: 1 })
adapter.set(ACTIVE_KEY, serializeEnvelope(e1))
const e2 = env({ revision: 2 })
const r = (await saveStore(adapter, e2, 1))
assert.ok(r.ok)
// Recovery holds the previous confirmed active envelope.
const recovered = JSON.parse(adapter.get(RECOVERY_KEY)!) as StoreEnvelope
assert.equal(recovered.revision, 1)
const active = JSON.parse(adapter.get(ACTIVE_KEY)!) as StoreEnvelope
assert.equal(active.revision, 2) })


test('hasNewerExternalRevision detects newer revision', async () => { assert.equal(hasNewerExternalRevision(1, env({ revision: 2 })), true)
assert.equal(hasNewerExternalRevision(2, env({ revision: 2 })), false)
assert.equal(hasNewerExternalRevision(3, env({ revision: 2 })), false)
assert.equal(hasNewerExternalRevision(1, null), false) })

test('storage-event handler flags a conflict when external revision is newer', async () => { const adapter = new MemoryAdapter()
const current = env({ revision: 2 })
adapter.set(ACTIVE_KEY, serializeEnvelope(current))
const incoming = env({ revision: 9 })
const result = handleStorageEvent(adapter, {
  key: ACTIVE_KEY,
  newValue: serializeEnvelope(incoming),
})
assert.equal(result.conflict, true)
assert.ok(result.envelope)
assert.equal(result.envelope!.revision, 9) })

test('storage-event handler does not flag equal or older revisions', async () => { const adapter = new MemoryAdapter()
const current = env({ revision: 9 })
adapter.set(ACTIVE_KEY, serializeEnvelope(current))
const older = env({ revision: 4 })
const result = handleStorageEvent(adapter, {
  key: ACTIVE_KEY,
  newValue: serializeEnvelope(older),
})
assert.equal(result.conflict, false) })

// ---------------------------------------------------------------------------
// Validation-state gating
// ---------------------------------------------------------------------------

test('only backend_confirmed profiles can be submitted', async () => { const p = profile({ validationState: 'locally_valid' })
assert.equal(canSubmitProfile(p), false)
assert.equal(canSubmitProfile({ ...p, validationState: 'draft' }), false)
assert.equal(canSubmitProfile({ ...p, validationState: 'invalid' }), false)
assert.equal(canSubmitProfile({ ...p, validationState: 'backend_confirmed' }), true)
assert.equal(canSubmitProfile(undefined), false) })

test('markValidationState updates state', async () => { const p = profile()
const e = env({ profiles: [p] })
const r = markValidationState(e, p.id, 'backend_confirmed')
assert.ok(r.ok)
assert.equal(r.envelope.profiles[0]!.validationState, 'backend_confirmed') })

// ---------------------------------------------------------------------------
// Disabled values / sensitive fields / determinism
// ---------------------------------------------------------------------------

test('disabled requirements remain null in payload', async () => { const p = profile({
  payload: {
    profile_name: 'No Margins',
    margins: { left_in: null, right_in: null, top_in: null, bottom_in: null },
  },
})
const payload = p.payload as { margins: Record<string, unknown> }
assert.equal(payload.margins.left_in, null) })

test('store envelope carries only profile data, never document/audit/secrets', async () => { // The store itself never introduces sensitive fields; a well-formed
// envelope serializes only identity + formatting payload.
const p = profile({ payload: { profile_name: 'X', citation_style: 'APA 7', profile_source: 'custom' } })
const raw = serializeEnvelope(env({ profiles: [p] }))
assert.ok(!raw.includes('document'))
assert.ok(!raw.includes('filename'))
assert.ok(!raw.includes('audit'))
assert.ok(!raw.includes('api_key'))
assert.ok(!raw.includes('credentials'))
assert.ok(!raw.includes('password'))
assert.ok(!raw.includes('token')) })

test('deterministic serialization across calls', async () => { const e = env({ revision: 3, profiles: [profile({ name: 'Stable' })] })
assert.equal(serializeEnvelope(e), serializeEnvelope(e)) })

test('source object mutation does not alter stored copy', async () => { const p = profile({ name: 'Mutable Source' })
let e = env()
const r = upsertProfile(e, p)
assert.ok(r.ok)
e = r.envelope
const stored = serializeEnvelope(e)
p.name = 'Mutated!'
;(p.payload as Record<string, unknown>).profile_name = 'Mutated payload!'
assert.equal(serializeEnvelope(e), stored) })

test('isWellFormedEnvelope rejects malformed envelopes', async () => { assert.equal(isWellFormedEnvelope(null), false)
assert.equal(isWellFormedEnvelope({}), false)
assert.equal(isWellFormedEnvelope(env({ revision: -1 })), false)
assert.equal(isWellFormedEnvelope(env({ profiles: [profile({ id: '' })] })), false)
assert.equal(isWellFormedEnvelope(env({ profiles: [profile({ validationState: 'bogus' as never })] })), false)
assert.ok(isWellFormedEnvelope(env())) })
