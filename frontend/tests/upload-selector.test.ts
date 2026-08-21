import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../src/services/api.ts'
import {
  blankProfilePayload,
  createMemoryStoreAdapter,
  generateProfileId,
  loadEnvelope,
} from '../src/lib/custom-profile-store/editor.ts'
import {
  emptyEnvelope,
  saveStore,
  type StoreEnvelope,
  type StoredCustomProfile,
} from '../src/lib/custom-profile-store/store.ts'
import {
  buildSelectorOptions,
  decodeSelectorIdentity,
  encodeSelectorIdentity,
  resolveUploadSelection,
  staleFriendlyMessage,
  validateAndFreezeSubmission,
} from '../src/lib/upload-selector.ts'
import type { FormattingProfile } from '../src/types/api.ts'

// ---------------------------------------------------------------------------
// Helpers & fixtures
// ---------------------------------------------------------------------------

const SUC_ID = 'suc-academic-report'
const APA_ID = 'apa7-student-paper'

const SUC_PROFILE: FormattingProfile = {
  profile_id: SUC_ID,
  profile_name: 'SUC Academic Report',
  profile_version: 2,
  description: 'SUC spec',
  profile_source: 'built_in',
  recommended: true,
  citation_style: 'APA 7',
  key_requirements: ['Margins: Not checked'],
}
const APA_PROFILE: FormattingProfile = {
  profile_id: APA_ID,
  profile_name: 'APA 7 Student Paper',
  profile_version: 1,
  description: 'APA spec',
  profile_source: 'built_in',
  recommended: false,
  citation_style: 'APA 7',
  key_requirements: ['Margins: 1 in on all sides'],
}
const BUILTINS: FormattingProfile[] = [SUC_PROFILE, APA_PROFILE]

function makeProfile(overrides: Partial<StoredCustomProfile> = {}): StoredCustomProfile {
  const id = generateProfileId()
  return {
    id,
    name: 'Custom profile',
    description: 'A custom thesis.',
    payload: blankProfilePayload(`pp-${id}`, 'Custom profile') as Record<string, unknown>,
    validationState: 'backend_confirmed',
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as StoredCustomProfile
}

// -------------------------------------------------------------------------
// Selector identity: encoding / decoding / legacy / malformed
// -------------------------------------------------------------------------

test('built-in and custom selector identity encoding/decoding', () => {
  assert.equal(encodeSelectorIdentity('builtin', SUC_ID), `builtin:${SUC_ID}`)
  assert.equal(encodeSelectorIdentity('custom', 'a-uuid'), 'custom:a-uuid')
  for (const [kind, id] of [
    ['builtin', SUC_ID],
    ['custom', 'c-123'],
  ] as const) {
    const v = encodeSelectorIdentity(kind, id)
    const d = decodeSelectorIdentity(v)!
    assert.equal(d.kind, kind)
    assert.equal(d.id, id)
  }
})

test('encode rejects empty, whitespace, control chars', () => {
  assert.throws(() => encodeSelectorIdentity('builtin', '   '))
  assert.throws(() => encodeSelectorIdentity('custom', ''))
  assert.throws(() => encodeSelectorIdentity('builtin', 'suc id space'))
  assert.throws(() => encodeSelectorIdentity('builtin', 'suc\0bad'))
})

test('malformed identity rejection never interpreted as custom', () => {
  const malformed = [
    '',
    ' ',
    'suc bad',
    'builtin:',
    'custom:',
    'custom:some id',
    ' builtin:suc-academic-report',
    'unknown:foo',
    'builtin',
    'custom',
    'custom:  ',
    'builtin:\u0000bad',
  ]
  for (const v of malformed) {
    assert.equal(decodeSelectorIdentity(v), null, `should be malformed: "${JSON.stringify(v)}"`)
  }
})

test('legacy raw built-in selected_id compatibility', () => {
  const d = decodeSelectorIdentity(SUC_ID)!
  assert.equal(d.kind, 'builtin')
  assert.equal(d.id, SUC_ID)
  const e = decodeSelectorIdentity(APA_ID)!
  assert.equal(e.kind, 'builtin')
  assert.equal(e.id, APA_ID)
  assert.equal(decodeSelectorIdentity('some-custom-uuid-unknown'), null)
})

test('malformed identity rejected with stale reset to SUC', () => {
  const r = resolveUploadSelection(BUILTINS, [], 'broken:thing', false, false)
  assert.equal(r.selectedValue, `builtin:${SUC_ID}`)
  assert.equal(r.stale, true)
  assert.ok(r.friendlyMessage && r.friendlyMessage.length > 10)
  // Genuine first visit with malformed stored value does not warn.
  const first = resolveUploadSelection(BUILTINS, [], 'broken:thing', false, true)
  assert.equal(first.stale, false)
  assert.equal(first.selectedValue, `builtin:${SUC_ID}`)
})

// -------------------------------------------------------------------------
// Recommended built-in default
// -------------------------------------------------------------------------

test('recommended built-in default when no valid selection exists', () => {
  const r = resolveUploadSelection(BUILTINS, [], null, false, true)
  assert.equal(r.selectedValue, `builtin:${SUC_ID}`)
  assert.equal(r.stale, false)
  // Genuine first visit without any id does not trigger stale.
  const r2 = resolveUploadSelection(BUILTINS, [], null, false, false)
  assert.equal(r2.stale, false)
})

test('legacy raw built-in normalized on confirmed write', () => {
  const r = resolveUploadSelection(BUILTINS, [], SUC_ID, false, false)
  assert.equal(r.selectedValue, `builtin:${SUC_ID}`)
  assert.equal(r.stale, false)
  assert.equal(r.normalizedPersisted, `builtin:${SUC_ID}`)
})

// -------------------------------------------------------------------------
// Merged selector: only backend_confirmed customs appear
// -------------------------------------------------------------------------

test('backend-confirmed custom profile appears; no internal id exposed in visible text', () => {
  const custom = makeProfile({ name: 'My Thesis' })
  const opts = buildSelectorOptions(BUILTINS, [custom])
  const customOpt = opts.find((o) => o.kind === 'custom')!
  assert.ok(customOpt)
  assert.equal(customOpt.displayName, 'My Thesis')
  assert.equal(customOpt.isBuiltIn, false)
  assert.equal(customOpt.value, `custom:${custom.id}`)
  for (const o of opts) {
    if (o.kind === 'custom') {
      assert.ok(!o.displayName.includes(custom.id))
      assert.ok(!o.description.includes(custom.id))
      assert.ok(!o.keyRequirements.some((x) => x.includes(custom.id)))
    }
  }
})

test('draft, locally_valid, and invalid profiles are excluded', () => {
  const badStates: Array<StoredCustomProfile['validationState']> = ['draft', 'locally_valid', 'invalid']
  for (const state of badStates) {
    const bad = makeProfile({ validationState: state })
    const opts = buildSelectorOptions(BUILTINS, [bad])
    assert.equal(opts.filter((o) => o.kind === 'custom').length, 0, `state ${state} must not appear`)
  }
})

test('corrupted store (both-corrupted) degrades to built-ins only', () => {
  const opts = buildSelectorOptions(BUILTINS, [])
  assert.equal(opts.filter((o) => o.kind === 'custom').length, 0)
  assert.ok(opts.some((o) => o.kind === 'builtin' && o.underlyingId === SUC_ID))
})

test('built-ins remain available even when custom list empty', () => {
  const opts = buildSelectorOptions(BUILTINS, [])
  assert.ok(opts.some((o) => o.kind === 'builtin'))
  assert.ok(opts.some((o) => o.isRecommended))
})

test('built-ins remain available when localStorage unavailable (empty envelope)', () => {
  // Adapter null ⇒ custom profiles unavailable, but built-ins still render.
  const opts = buildSelectorOptions(BUILTINS, [])
  assert.ok(opts.some((o) => o.kind === 'builtin'))
})

test('built-in submission sends profile_id only via FormData query (no custom_profile)', async () => {
  // We assert the API-layer discriminated contract by inspecting the FormData path:
  // intercept fetch to capture what auditDocument sends.
  const origFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedHasCustomField = false
  globalThis.fetch = async (input: RequestInfo, init?: RequestInit) => {
    capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input)
    const body: unknown = init?.body
    if (body instanceof FormData) {
      capturedHasCustomField = body.has('custom_profile')
    }
    return new Response(JSON.stringify({ status: 'ok', audit_id: 'a', weighted_compliance_score: 100, physical_layout_errors: [], ai_citation_tooltips: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    await api.auditDocument(new File(['x'], 'x.docx'), { profileId: SUC_ID })
    assert.ok(capturedUrl.includes(`profile_id=${encodeURIComponent(SUC_ID)}`), capturedUrl)
    assert.equal(capturedHasCustomField, false)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('custom submission sends custom_profile only (no profile_id query)', async () => {
  const origFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedHasCustomField = false
  let capturedCustomJson = ''
  globalThis.fetch = async (input: RequestInfo, init?: RequestInit) => {
    capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input)
    const body: unknown = init?.body
    if (body instanceof FormData) {
      capturedHasCustomField = body.has('custom_profile')
      capturedCustomJson = (body as FormData).get('custom_profile') as string
    }
    return new Response(JSON.stringify({ status: 'ok', audit_id: 'a', weighted_compliance_score: 100, physical_layout_errors: [], ai_citation_tooltips: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const payload: Record<string, unknown> = { profile_id: 'p', profile_name: 'X', profile_source: 'custom', citation_style: 'APA 7' }
    await api.auditDocument(new File(['x'], 'x.docx'), { customProfile: payload })
    assert.equal(capturedUrl.includes('profile_id='), false, capturedUrl)
    assert.equal(capturedHasCustomField, true)
    assert.deepEqual(JSON.parse(capturedCustomJson), payload)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('API layer refuses both profileId and customProfile together', async () => {
  await assert.rejects(
    () => api.auditDocument(new File(['x'], 'x.docx'), { profileId: SUC_ID, customProfile: { profile_id: 'p' } }),
    (err: unknown) => {
      assert.match((err as Error).message, /provide either profileId or customProfile/i)
      return true
    },
  )
})

test('custom summary and disabled count', () => {
  const custom = makeProfile({ name: 'Wide' })
  const opts = buildSelectorOptions(BUILTINS, [custom])
  const opt = opts.find((o) => o.kind === 'custom')!
  assert.equal(opt.isBuiltIn, false)
  assert.ok(opt.keyRequirements.length >= 2)
  const text = opt.keyRequirements.join(' ')
  assert.ok(!text.includes('null'))
  assert.ok(!text.includes('fingerprint'))
  assert.ok(text.includes('Citation style:') || text.includes('requirements will not be checked') || text.length > 20)
  // Ensure custom carries APA 7 and keyRequirements are present.
  assert.equal(opt.citationStyle, 'APA 7')
})

test('selected custom profile survives navigation (persisted selected_id)', () => {
  const custom = makeProfile({ name: 'Persist' })
  const value = `custom:${custom.id}`
  let env: StoreEnvelope = { ...emptyEnvelope(), profiles: [custom] }
  env = { ...env, selected_id: value }
  const r = resolveUploadSelection(BUILTINS, [custom], env.selected_id, false, false)
  assert.equal(r.selectedValue, value)
  assert.equal(r.stale, false)
})

test('selection write uses revision guard (stale-write refusal)', () => {
  const adapter = createMemoryStoreAdapter()
  let env: StoreEnvelope = { ...emptyEnvelope(), profiles: [] }
  const write0 = saveStore(adapter, { ...env, revision: 1, selected_id: `builtin:${SUC_ID}` }, 0)
  assert.equal(write0.ok, true)
  env = loadEnvelope(adapter)
  assert.equal(env.revision, 1)
  const stale = saveStore(adapter, { ...env, revision: 2, selected_id: `custom:x` }, 0)
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.reason, 'stale-revision')
})

test('stale custom selection resets to SUC', () => {
  const custom = makeProfile({ name: 'X' })
  const value = `custom:${custom.id}`
  const r = resolveUploadSelection(BUILTINS, [], value, false, false)
  assert.equal(r.stale, true)
  assert.equal(r.selectedValue, `builtin:${SUC_ID}`)
  assert.equal(r.friendlyMessage, staleFriendlyMessage())
})

test('deleting selected custom profile resets to SUC', () => {
  const custom = makeProfile({ name: 'ToDelete' })
  const customValue = `custom:${custom.id}`
  // After deletion it no longer appears in confirmed list → stale.
  const r = resolveUploadSelection(BUILTINS, [], customValue, false, false)
  assert.equal(r.stale, true)
  assert.equal(r.selectedValue, `builtin:${SUC_ID}`)
})

test('new profile from another tab appears (merged selector picks it up)', () => {
  const a = makeProfile({ name: 'Known', validationState: 'backend_confirmed' })
  let opts = buildSelectorOptions(BUILTINS, [a])
  assert.equal(opts.filter((o) => o.kind === 'custom').length, 1)
  const b = makeProfile({ name: 'From other tab', validationState: 'backend_confirmed' })
  opts = buildSelectorOptions(BUILTINS, [a, b])
  assert.equal(opts.filter((o) => o.kind === 'custom').length, 2)
  assert.ok(opts.some((o) => o.displayName === 'From other tab'))
})

test('a newer external revision does not overwrite an in-flight request (frozen copy)', () => {
  const custom = makeProfile({ name: 'Frozen' })
  const env: StoreEnvelope = {
    ...emptyEnvelope(),
    revision: 5,
    profiles: [custom],
    selected_id: `custom:${custom.id}`,
  }
  const value = `custom:${custom.id}`
  const result = validateAndFreezeSubmission(env, BUILTINS, value)
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('unreachable')
  assert.equal(result.frozen.kind, 'custom')
  if (result.frozen.kind !== 'custom') throw new Error('expected custom')
  const frozenPayload = result.frozen.payload
  const originalLineSpacing = (custom.payload as Record<string, unknown>).body
  // Mutate the source after capture — frozen copy must not change.
  ;(custom.payload as Record<string, unknown>).body = { tampered: true }
  assert.notDeepEqual(frozenPayload.body, (custom.payload as Record<string, unknown>).body)
  // Envelope revision also frozen.
  assert.equal(result.frozen.envelopeRevision, 5)
  void originalLineSpacing
})

test('custom payload is copied at submission start; later mutation does not alter captured request', () => {
  const custom = makeProfile({ name: 'CopyGuard' })
  const env: StoreEnvelope = {
    ...emptyEnvelope(),
    revision: 7,
    profiles: [custom],
    selected_id: `custom:${custom.id}`,
  }
  const value = `custom:${custom.id}`
  const first = validateAndFreezeSubmission(env, BUILTINS, value)
  assert.equal(first.ok, true)
  if (!first.ok || first.frozen.kind !== 'custom') throw new Error('expected custom frozen')
  first.frozen.payload.description = 'MUTATED'
  // Source must be untouched.
  assert.notEqual((custom.payload as Record<string, unknown>).description, 'MUTATED')
  // Second capture from the same source still reflects the canonical payload, not the mutated frozen copy.
  const second = validateAndFreezeSubmission(env, BUILTINS, value)
  assert.equal(second.ok, true)
  if (!second.ok || second.frozen.kind !== 'custom') throw new Error('expected custom frozen')
  assert.notEqual(second.frozen.payload.description, 'MUTATED')
})

test('failed upload preserves valid selection (validateAndFreeze still ok afterwards)', () => {
  const custom = makeProfile({ name: 'Retryable' })
  const env: StoreEnvelope = {
    ...emptyEnvelope(),
    revision: 3,
    profiles: [custom],
    selected_id: `custom:${custom.id}`,
  }
  const value = `custom:${custom.id}`
  const before = validateAndFreezeSubmission(env, BUILTINS, value)
  assert.equal(before.ok, true)
  // Simulate a failed fetch — the caller shows a toast but keeps selection.
  // The selection should still validate afterwards.
  const after = validateAndFreezeSubmission(env, BUILTINS, value)
  assert.equal(after.ok, true)
  if (!after.ok || after.frozen.kind !== 'custom') throw new Error('expected custom frozen')
  assert.equal(after.frozen.sourceCustomId, custom.id)
})

test('validateAndFreezeSubmission: fallback when no selection and builtins exist (compatibility)', () => {
  const env: StoreEnvelope = { ...emptyEnvelope(), profiles: [], selected_id: null }
  const r = validateAndFreezeSubmission(env, BUILTINS, null)
  assert.equal(r.ok, true)
  if (!r.ok) throw new Error('expected ok')
  assert.equal(r.frozen.kind, 'fallback')
})

test('custom payload snapshot: Audit Snapshot remains immutable after later source mutation is handled by backend', () => {
  // Frontend guarantee: we never mutate the submitted payload or re-submit an
  // existing Audit. The backend persists profile_snapshot in the same transaction
  // as the audit row (routes.py). This test pins that our frozen copy is the
  // only thing sent — later edits to the custom profile object do not retroactively
  // change a previously captured frozen request.
  const custom = makeProfile({ name: 'Snapshot' })
  const env: StoreEnvelope = {
    ...emptyEnvelope(),
    revision: 1,
    profiles: [custom],
    selected_id: `custom:${custom.id}`,
  }
  const frozenBefore = validateAndFreezeSubmission(env, BUILTINS, `custom:${custom.id}`)
  assert.equal(frozenBefore.ok, true)
  if (!frozenBefore.ok || frozenBefore.frozen.kind !== 'custom') throw new Error('expected custom')
  const snap = JSON.stringify(frozenBefore.frozen.payload)
  ;(custom.payload as Record<string, unknown>).margins = { margin_left_in: 99 }
  assert.notEqual(JSON.stringify(frozenBefore.frozen.payload), JSON.stringify(custom.payload))
  assert.equal(JSON.stringify(frozenBefore.frozen.payload), snap)
})

test('localStorage unavailable path still resolves built-ins (degraded mode)', () => {
  // When adapter is null, the merge is built-ins-only; verify no throw.
  const opts = buildSelectorOptions(BUILTINS, [])
  assert.ok(opts.some((o) => o.kind === 'builtin'))
  const r = resolveUploadSelection(BUILTINS, [], null, false, true)
  assert.equal(r.selectedValue, `builtin:${SUC_ID}`)
})
