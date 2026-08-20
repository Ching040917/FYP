/**
 * Custom Profile Editor logic (Build 3) tests — pure, no DOM.
 *
 * Covers: creation paths (blank, SUC copy, APA copy), collision-safe names,
 * built-ins preserved (never mutated), blank payload null requirements and
 * safe table-caption policy, client-side validation, revision bumps,
 * persistence revision-gating (stale-write refusal), and the friendly-source
 * label helper.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APA_BUILTIN_ID,
  SUC_BUILTIN_ID,
  CITATION_STYLE,
  DEFAULT_PROFILE_NAMES,
  MAX_DESCRIPTION_LENGTH,
  SAFE_TABLE_ELIGIBILITY,
  blankProfilePayload,
  buildSavePayload,
  clientValidate,
  copyProfilePayload,
  createMemoryStoreAdapter,
  friendlySourceName,
  generateProfileId,
  isDirty,
  loadEnvelope,
  persistEnvelope,
  resolveUniqueName,
  upsertAndBump,
} from '../src/lib/custom-profile-store/editor.ts'
import { ACTIVE_KEY, RECOVERY_KEY, emptyEnvelope, serializeEnvelope } from '../src/lib/custom-profile-store/store.ts'

function makeProfile(overrides: Record<string, unknown> = {}) {
  const id = generateProfileId()
  return {
    id,
    name: 'My Profile',
    description: '',
    payload: blankProfilePayload(id, 'My Profile'),
    validationState: 'locally_valid' as const,
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Blank profile payload
// ---------------------------------------------------------------------------

test('blank profile: all deterministic requirements null + safe table policy', () => {
  const id = generateProfileId()
  const p = blankProfilePayload(id, 'Blank')
  assert.equal(p.profile_source, 'custom')
  assert.equal(p.citation_style, CITATION_STYLE)
  assert.equal(p.profile_version, 1)
  assert.equal(p.body.font_family, null)
  assert.equal(p.body.font_size_pt, null)
  assert.equal(p.body.line_spacing, null)
  assert.equal(p.margins.margin_left_in, null)
  assert.equal(p.margins.margin_right_in, null)
  assert.equal(p.references.hanging_indent_in, null)
  assert.equal(p.captions.space_after_pt, null)
  assert.equal(p.lists.space_after_pt, null)
  // Safe table-caption policy: never administrative/layout/rubric/unknown.
  assert.ok(['administrative', 'scholarly'].includes(p.role_policy.table_eligibility))
  assert.equal(p.role_policy.table_eligibility, SAFE_TABLE_ELIGIBILITY)
})

test('blank profile: no admin/rubric/unknown caption enabling', () => {
  const id = generateProfileId()
  const p = blankProfilePayload(id, 'Blank')
  const json = JSON.stringify(p).toLowerCase()
  assert.ok(!json.includes('"both"'))
  assert.ok(!json.includes('rubric'))
})

test('copy profile preserves requirements but forces custom identity', () => {
  const source = {
    profile_id: SUC_BUILTIN_ID,
    profile_name: 'SUC Academic Report',
    profile_source: 'built_in',
    body: { font_family: 'Times New Roman', font_size_pt: 12 },
    margins: { margin_left_in: null },
  }
  const id = generateProfileId()
  const copy = copyProfilePayload(source, id, 'Copy of SUC')
  assert.equal(copy.profile_id, id)
  assert.equal(copy.profile_name, 'Copy of SUC')
  assert.equal(copy.profile_source, 'custom')
  assert.equal(copy.body.font_family, 'Times New Roman')
  assert.equal(copy.body.font_size_pt, 12)
  assert.deepEqual(copy.margins, { margin_left_in: null })
})

test('copy never mutates the source payload', () => {
  const source = {
    profile_id: SUC_BUILTIN_ID,
    profile_name: 'SUC Academic Report',
    profile_source: 'built_in',
    body: { font_family: 'Times New Roman' },
  }
  const frozen = JSON.stringify(source)
  copyProfilePayload(source, generateProfileId(), 'Copy')
  assert.equal(JSON.stringify(source), frozen)
})

// ---------------------------------------------------------------------------
// Collision-safe names
// ---------------------------------------------------------------------------

test('resolveUniqueName appends friendly suffixes case-insensitively', () => {
  const names = ['My Profile', 'my profile (2)', 'MY PROFILE (3)']
  assert.equal(resolveUniqueName(names, 'My Profile'), 'My Profile (4)')
})

test('resolveUniqueName keeps desired name when free', () => {
  assert.equal(resolveUniqueName([], 'Untitled custom profile'), 'Untitled custom profile')
  assert.equal(resolveUniqueName(['Something else'], 'Untitled custom profile'), 'Untitled custom profile')
})

test('resolveUniqueName trims and falls back on blank', () => {
  assert.equal(resolveUniqueName([], '   '), 'Untitled custom profile')
})

// ---------------------------------------------------------------------------
// Friendly source label
// ---------------------------------------------------------------------------

test('friendlySourceName only resolves known built-ins', () => {
  assert.equal(friendlySourceName(SUC_BUILTIN_ID), 'SUC Academic Report')
  assert.equal(friendlySourceName(APA_BUILTIN_ID), 'APA 7 Student Paper')
  assert.equal(friendlySourceName('custom-uuid-123'), null)
  assert.equal(friendlySourceName(undefined), null)
})

// ---------------------------------------------------------------------------
// Client-side validation
// ---------------------------------------------------------------------------

test('clientValidate: empty name rejected', () => {
  const env = emptyEnvelope()
  const draft = makeProfile({ name: '   ' })
  const errors = clientValidate(draft, env)
  assert.ok(errors.some((e) => e.field === 'general.name'))
})

test('clientValidate: duplicate name rejected case-insensitively', () => {
  const existing = makeProfile({ name: 'My Profile' })
  const env = { ...emptyEnvelope(), profiles: [existing] }
  const draft = makeProfile({ name: 'my profile' })
  const errors = clientValidate(draft, env)
  assert.ok(errors.some((e) => e.field === 'general.name'))
})

test('clientValidate: same profile name is not a duplicate', () => {
  const existing = makeProfile({ name: 'My Profile' })
  const env = { ...emptyEnvelope(), profiles: [existing] }
  const draft = makeProfile({ name: 'My Profile', id: existing.id })
  const errors = clientValidate(draft, env)
  assert.ok(!errors.some((e) => e.field === 'general.name'))
})

test('clientValidate: over-long description rejected', () => {
  const env = emptyEnvelope()
  const draft = makeProfile({ description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) })
  const errors = clientValidate(draft, env)
  assert.ok(errors.some((e) => e.field === 'general.description'))
})

test('clientValidate: valid draft passes', () => {
  const env = emptyEnvelope()
  const draft = makeProfile({ name: 'Valid Name' })
  assert.deepEqual(clientValidate(draft, env), [])
})

// ---------------------------------------------------------------------------
// buildSavePayload
// ---------------------------------------------------------------------------

test('buildSavePayload enforces custom source + APA citation + trimmed name', () => {
  const draft = makeProfile({
    name: '  My Profile  ',
    description: 'desc',
    payload: {
      profile_id: 'x',
      profile_name: 'old',
      profile_source: 'built_in',
      citation_style: 'Chicago',
      body: { font_family: null },
    },
  })
  const p = buildSavePayload(draft as never)
  assert.equal(p.profile_name, 'My Profile')
  assert.equal(p.profile_source, 'custom')
  assert.equal(p.citation_style, CITATION_STYLE)
  assert.equal(p.description, 'desc')
})

// ---------------------------------------------------------------------------
// Revision + persistence (multi-tab safety)
// ---------------------------------------------------------------------------

test('upsertAndBump increments revision and stamps updated_at', () => {
  const env = { ...emptyEnvelope(), revision: 4, updated_at: 'old' }
  const profile = makeProfile()
  const next = upsertAndBump(env, profile, '2026-08-21T00:00:00.000Z')
  assert.equal(next.revision, 5)
  assert.equal(next.updated_at, '2026-08-21T00:00:00.000Z')
  assert.equal(next.profiles.length, 1)
})

test('persistEnvelope refuses stale revision writes', () => {
  const adapter = createMemoryStoreAdapter()
  const env = { ...emptyEnvelope(), revision: 7 }
  adapter.set(ACTIVE_KEY, serializeEnvelope(env))
  // Caller expects revision 5 but storage has 7 → stale refusal.
  const write = persistEnvelope(adapter, { ...env, revision: 8 }, 5)
  assert.deepEqual(write, { ok: false, reason: 'stale-revision' })
})

test('persistEnvelope succeeds when expected revision matches', () => {
  const adapter = createMemoryStoreAdapter()
  const env = { ...emptyEnvelope(), revision: 7 }
  adapter.set(ACTIVE_KEY, serializeEnvelope(env))
  const write = persistEnvelope(adapter, { ...env, revision: 8 }, 7)
  assert.equal(write.ok, true)
  const loaded = loadEnvelope(adapter)
  assert.equal(loaded.revision, 8)
  // Recovery holds the previous confirmed active envelope.
  const recovery = JSON.parse(adapter.get(RECOVERY_KEY)!) as { revision: number }
  assert.equal(recovery.revision, 7)
})

test('loadEnvelope on empty store returns empty envelope', () => {
  const adapter = createMemoryStoreAdapter()
  const env = loadEnvelope(adapter)
  assert.equal(env.revision, 0)
  assert.equal(env.profiles.length, 0)
})

// ---------------------------------------------------------------------------
// Dirty detection
// ---------------------------------------------------------------------------

test('isDirty: fresh unsaved draft is dirty; identical saved draft is not', () => {
  assert.equal(isDirty(null, null), false)
  const draft = makeProfile({ name: 'A' })
  assert.equal(isDirty(draft, null), true)
  const stored = { ...draft, name: 'A', description: '' }
  assert.equal(isDirty(draft, stored), false)
  assert.equal(isDirty({ ...draft, name: 'B' }, stored), true)
})

test('DEFAULT_PROFILE_NAMES match the spec', () => {
  assert.equal(DEFAULT_PROFILE_NAMES['copy-suc'], 'Copy of SUC Academic Report')
  assert.equal(DEFAULT_PROFILE_NAMES['copy-apa'], 'Copy of APA 7 Student Paper')
  assert.equal(DEFAULT_PROFILE_NAMES.blank, 'Untitled custom profile')
})
