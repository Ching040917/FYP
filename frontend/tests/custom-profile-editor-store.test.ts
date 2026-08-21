/**
 * Custom Profile Editor — store integration (Build 3).
 *
 * Exercises the full save workflow against the real custom-profile store
 * (in-memory adapter): creation → local draft → backend-confirmed save →
 * revision increment → multi-tab stale-write refusal → draft preserved on
 * failure. Pure node:test, no DOM, no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blankProfilePayload,
  buildSavePayload,
  clientValidate,
  copyProfilePayload,
  createMemoryStoreAdapter,
  deleteAndBump,
  generateProfileId,
  isUnsavedDraft,
  loadEnvelope,
  persistEnvelope,
  resolveUniqueName,
  upsertAndBump,
} from '../src/lib/custom-profile-store/editor.ts'
import {
  ACTIVE_KEY,
  RECOVERY_KEY,
  emptyEnvelope,
  serializeEnvelope,
  type StoreEnvelope,
} from '../src/lib/custom-profile-store/store.ts'

const NOW = '2026-08-21T00:00:00.000Z'

function seedStore(profiles: StoreEnvelope['profiles'] = []) {
  const adapter = createMemoryStoreAdapter()
  const env = { ...emptyEnvelope(), revision: profiles.length ? 1 : 0, profiles }
  adapter.set(ACTIVE_KEY, serializeEnvelope(env))
  return adapter
}

// ---------------------------------------------------------------------------
// Full save flow (mirrors the editor component, minus JSX)
// ---------------------------------------------------------------------------

test('save flow: blank creation → draft → backend-confirmed → revision bump', () => {
  const adapter = seedStore()
  let envelope = loadEnvelope(adapter)

  // 1. Create blank profile (collision-safe name).
  const name = resolveUniqueName(envelope.profiles.map((p) => p.name), 'Untitled custom profile')
  const id = generateProfileId()
  const draft = {
    id,
    name,
    description: '',
    payload: blankProfilePayload(id, name),
    validationState: 'locally_valid' as const,
    updatedAt: NOW,
  }
  envelope = upsertAndBump(envelope, draft, NOW)
  assert.equal(persistEnvelope(adapter, envelope, envelope.revision - 1).ok, true)
  envelope = loadEnvelope(adapter)
  assert.equal(envelope.revision, 1)
  assert.equal(envelope.profiles.length, 1)

  // 2. Edit name + description (draft), no store write yet.
  const edited = { ...draft, name: 'My Thesis Format', description: 'Personal format' }
  assert.deepEqual(clientValidate(edited, envelope), [])

  // 3. Backend would return a normalized payload — simulate `valid: true`.
  const confirmedPayload = buildSavePayload(edited as never)
  const confirmed = {
    ...edited,
    name: edited.name.trim(),
    payload: confirmedPayload,
    validationState: 'backend_confirmed' as const,
    updatedAt: '2026-08-21T01:00:00.000Z',
  }
  envelope = upsertAndBump(envelope, confirmed, confirmed.updatedAt)
  assert.equal(persistEnvelope(adapter, envelope, envelope.revision - 1).ok, true)

  // 4. Verify persisted state.
  const stored = loadEnvelope(adapter)
  assert.equal(stored.revision, 2)
  const saved = stored.profiles[0]!
  assert.equal(saved.name, 'My Thesis Format')
  assert.equal(saved.validationState, 'backend_confirmed')
  assert.equal(saved.payload.profile_source, 'custom')
  assert.equal(saved.payload.citation_style, 'APA 7')
  // Recovery holds the pre-save revision.
  const recovery = JSON.parse(adapter.get(RECOVERY_KEY)!) as { revision: number }
  assert.equal(recovery.revision, 1)
})

test('save flow: stale-write refusal keeps newer version and never overwrites', () => {
  const adapter = seedStore()
  let envelope = loadEnvelope(adapter)

  // Create + persist a profile (revision 1).
  const id = generateProfileId()
  const draft = {
    id,
    name: 'My Profile',
    description: '',
    payload: blankProfilePayload(id, 'My Profile'),
    validationState: 'locally_valid' as const,
    updatedAt: NOW,
  }
  envelope = upsertAndBump(envelope, draft, NOW)
  assert.equal(persistEnvelope(adapter, envelope, 0).ok, true)

  // Another tab bumps the revision to 3.
  const newer = {
    ...loadEnvelope(adapter),
    revision: 3,
    profiles: [
      { ...loadEnvelope(adapter).profiles[0]!, name: 'Renamed Elsewhere', validationState: 'backend_confirmed' as const },
    ],
    updated_at: '2026-08-21T02:00:00.000Z',
  }
  adapter.set(ACTIVE_KEY, serializeEnvelope(newer))

  // This tab still believes revision is 1 → save is refused.
  const myEdit = {
    ...draft,
    name: 'My Local Edit',
    validationState: 'backend_confirmed' as const,
    updatedAt: '2026-08-21T03:00:00.000Z',
  }
  const bumped = upsertAndBump(newer, myEdit, myEdit.updatedAt)
  const write = persistEnvelope(adapter, bumped, 1)
  assert.deepEqual(write, { ok: false, reason: 'stale-revision' })

  // The newer (other-tab) version is untouched.
  const after = loadEnvelope(adapter)
  assert.equal(after.revision, 3)
  assert.equal(after.profiles[0]!.name, 'Renamed Elsewhere')
})

test('save flow: validation failure keeps the draft, nothing is written', () => {
  const adapter = seedStore()
  let envelope = loadEnvelope(adapter)

  // Duplicate name → client validation fails.
  const id1 = generateProfileId()
  const first = {
    id: id1,
    name: 'Taken Name',
    description: '',
    payload: blankProfilePayload(id1, 'Taken Name'),
    validationState: 'backend_confirmed' as const,
    updatedAt: NOW,
  }
  envelope = upsertAndBump(envelope, first, NOW)
  assert.equal(persistEnvelope(adapter, envelope, 0).ok, true)

  const id2 = generateProfileId()
  const draft = {
    id: id2,
    name: 'taken name',
    description: '',
    payload: blankProfilePayload(id2, 'taken name'),
    validationState: 'locally_valid' as const,
    updatedAt: NOW,
  }
  assert.ok(clientValidate(draft, loadEnvelope(adapter)).some((e) => e.field === 'general.name'))

  // Nothing was persisted for the second profile.
  const after = loadEnvelope(adapter)
  assert.equal(after.profiles.length, 1)
  assert.equal(after.profiles[0]!.id, id1)
})

test('save flow: reference/caption/list values survive backend-confirmed save', () => {
  const adapter = seedStore()
  let envelope = loadEnvelope(adapter)

  const id = generateProfileId()
  const draft = {
    id,
    name: 'Build 5 Profile',
    description: '',
    payload: {
      ...blankProfilePayload(id, 'Build 5 Profile'),
      references: { line_spacing: 2, hanging_indent_in: null },
      captions: { space_before_pt: 6, space_after_pt: 12 },
      lists: { space_after_pt: 6 },
    },
    validationState: 'locally_valid' as const,
    updatedAt: NOW,
  }
  envelope = upsertAndBump(envelope, draft, NOW)
  assert.equal(persistEnvelope(adapter, envelope, 0).ok, true)

  // Backend-normalized result replaces the draft payload.
  const confirmed = {
    ...draft,
    payload: buildSavePayload(draft as never),
    validationState: 'backend_confirmed' as const,
    updatedAt: '2026-08-21T01:00:00.000Z',
  }
  envelope = upsertAndBump(loadEnvelope(adapter), confirmed, confirmed.updatedAt)
  assert.equal(persistEnvelope(adapter, envelope, 1).ok, true)

  const saved = loadEnvelope(adapter).profiles[0]!
  assert.equal(saved.validationState, 'backend_confirmed')
  assert.equal(saved.payload.references.line_spacing, 2)
  assert.equal(saved.payload.captions.space_before_pt, 6)
  assert.equal(saved.payload.captions.space_after_pt, 12)
  assert.equal(saved.payload.lists.space_after_pt, 6)
})

test('save flow: failed validation preserves every draft value incl. Build 5 groups', () => {
  const adapter = seedStore()
  let envelope = loadEnvelope(adapter)

  // A conflicting name forces client validation to fail.
  const id1 = generateProfileId()
  const first = {
    id: id1,
    name: 'Taken',
    description: '',
    payload: blankProfilePayload(id1, 'Taken'),
    validationState: 'backend_confirmed' as const,
    updatedAt: NOW,
  }
  envelope = upsertAndBump(envelope, first, NOW)
  assert.equal(persistEnvelope(adapter, envelope, 0).ok, true)

  const id2 = generateProfileId()
  const draft = {
    id: id2,
    name: 'taken',
    description: '',
    payload: {
      ...blankProfilePayload(id2, 'taken'),
      references: { line_spacing: 1.5, hanging_indent_in: null },
      captions: { space_before_pt: 6, space_after_pt: null },
      lists: { space_after_pt: null },
    },
    validationState: 'locally_valid' as const,
    updatedAt: NOW,
  }
  assert.ok(clientValidate(draft, loadEnvelope(adapter)).some((e) => e.field === 'general.name'))

  // Nothing written; the draft values remain untouched in the caller's copy.
  const after = loadEnvelope(adapter)
  assert.equal(after.profiles.length, 1)
  assert.equal(after.profiles[0]!.id, id1)
  assert.equal(draft.payload.references.line_spacing, 1.5)
  assert.equal(draft.payload.captions.space_before_pt, 6)
})

test('copy from a built-in payload preserves requirements under a custom identity', () => {
  const source = {
    profile_id: 'suc-academic-report',
    profile_name: 'SUC Academic Report',
    profile_version: 2,
    profile_source: 'built_in',
    body: { font_family: 'Times New Roman', font_size_pt: 12, line_spacing: 1.5 },
    margins: { margin_left_in: null },
    role_policy: { table_eligibility: 'administrative', exempt_roles: ['COVER'] },
  }
  const id = generateProfileId()
  const copy = copyProfilePayload(source, id, 'Copy of SUC Academic Report')
  const draft = {
    id,
    name: 'Copy of SUC Academic Report',
    description: '',
    sourceId: 'suc-academic-report',
    payload: copy,
    validationState: 'locally_valid' as const,
    updatedAt: NOW,
  }
  const adapter = seedStore()
  const env = loadEnvelope(adapter)
  const next = upsertAndBump(env, draft, NOW)
  assert.equal(persistEnvelope(adapter, next, 0).ok, true)
  const saved = loadEnvelope(adapter).profiles[0]!
  assert.equal(saved.payload.profile_source, 'custom')
  assert.equal(saved.payload.body.font_size_pt, 12)
  assert.equal(saved.payload.body.line_spacing, 1.5)
  assert.equal(saved.payload.role_policy.table_eligibility, 'administrative')
  // Source payload never mutated.
  assert.equal(source.profile_source, 'built_in')
})

test('ACTIVE/RECOVERY round trip preserves the saved custom profile', () => {
  const adapter = seedStore()
  const id = generateProfileId()
  const draft = {
    id,
    name: 'Persistent Profile',
    description: 'stored locally',
    payload: blankProfilePayload(id, 'Persistent Profile'),
    validationState: 'backend_confirmed' as const,
    updatedAt: NOW,
  }
  const env = loadEnvelope(adapter)
  const next = upsertAndBump(env, draft, NOW)
  assert.equal(persistEnvelope(adapter, next, 0).ok, true)

  // Simulate a page reload: fresh adapter reading the same storage key.
  const adapter2 = createMemoryStoreAdapter()
  adapter2.set(ACTIVE_KEY, adapter.get(ACTIVE_KEY)!)
  const reloaded = loadEnvelope(adapter2)
  assert.equal(reloaded.profiles[0]!.name, 'Persistent Profile')
  assert.equal(reloaded.profiles[0]!.validationState, 'backend_confirmed')
})

// ---------------------------------------------------------------------------
// Deletion (Build 5)
// ---------------------------------------------------------------------------

function makeStored(name: string, overrides: Record<string, unknown> = {}) {
  const id = generateProfileId()
  return {
    id,
    name,
    description: '',
    payload: blankProfilePayload(id, name),
    validationState: 'backend_confirmed' as const,
    updatedAt: NOW,
    ...overrides,
  }
}

test('delete removes only the target profile and bumps revision', () => {
  const a = makeStored('Alpha')
  const b = makeStored('Beta')
  const adapter = seedStore([a, b])
  const env = loadEnvelope(adapter)

  const result = deleteAndBump(env, a.id, NOW)
  assert.equal(result.ok, true)
  assert.equal(persistEnvelope(adapter, result.envelope, env.revision).ok, true)

  const after = loadEnvelope(adapter)
  assert.equal(after.profiles.length, 1)
  assert.equal(after.profiles[0]!.id, b.id) // sibling survives
  assert.equal(after.revision, env.revision + 1)
})

test('delete of selected profile resets selection to recommended built-in', () => {
  const a = makeStored('Selected')
  let env = { ...loadEnvelope(seedStore([a])), selected_id: a.id }
  const result = deleteAndBump(env, a.id, NOW)
  assert.equal(result.ok, true)
  assert.equal(result.envelope.selected_id, 'suc-academic-report')
})

test('delete refuses unknown profiles', () => {
  const adapter = seedStore([])
  const result = deleteAndBump(loadEnvelope(adapter), 'missing-id', NOW)
  assert.deepEqual(result, { ok: false, reason: 'not-found' })
})

test('stale revision refuses deletion and keeps the profile', () => {
  const a = makeStored('Target')
  const adapter = seedStore([a])
  const env = loadEnvelope(adapter)

  // Another tab writes first.
  const newer = { ...env, revision: env.revision + 5 }
  adapter.set(ACTIVE_KEY, serializeEnvelope(newer))

  // This tab still expects the old revision → refused.
  const result = deleteAndBump(env, a.id, NOW)
  assert.equal(result.ok, true)
  const write = persistEnvelope(adapter, result.envelope, env.revision)
  assert.deepEqual(write, { ok: false, reason: 'stale-revision' })

  // Profile still present.
  assert.equal(loadEnvelope(adapter).profiles.length, 1)
})

test('already-deleted in another tab: live read finds nothing', () => {
  const a = makeStored('Gone')
  const adapter = seedStore([a])
  // Another tab removed it.
  const emptied = { ...loadEnvelope(adapter), profiles: [], revision: 9 }
  adapter.set(ACTIVE_KEY, serializeEnvelope(emptied))

  const live = loadEnvelope(adapter)
  assert.equal(live.profiles.find((p) => p.id === a.id), undefined)
})

test('isUnsavedDraft distinguishes drafts from saved profiles', () => {
  const saved = makeStored('Saved')
  const adapter = seedStore([saved])
  const env = loadEnvelope(adapter)
  assert.equal(isUnsavedDraft(saved, env), false)

  const draftOnly = makeStored('Draft')
  assert.equal(isUnsavedDraft(draftOnly, env), true)
  assert.equal(isUnsavedDraft(null, env), false)
  assert.equal(isUnsavedDraft(draftOnly, null), false)
})
