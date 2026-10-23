import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../src/services/api.ts'
import { ACTIVE_KEY, RECOVERY_KEY, loadStore, emptyEnvelope, saveStore, serializeEnvelope, acceptReset, type StoreAdapter, type StoredCustomProfile } from '../src/lib/custom-profile-store/store.ts'
import { LocalStorageStoreAdapter, createBrowserStoreAdapter } from '../src/lib/custom-profile-store/localstorage-adapter.ts'
import { blankProfilePayload, buildSavePayload, bodyToUiModel, headingToUiModel, marginsToUiModel, referencesToUiModel, captionsToUiModel, listsToUiModel, citationMatchingToUiModel, createMemoryStoreAdapter, upsertAndBump, deleteAndBump, clientValidate } from '../src/lib/custom-profile-store/editor.ts'
import type { DraftUiState } from '../src/lib/custom-profile-store/draft-recovery.ts'
import { validateAndFreezeSubmission } from '../src/lib/upload-selector.ts'
import { createDurableTestAdapter, readStoredEnvelope } from './custom-profile-fixtures.ts'

const NOW = '2026-10-23T00:00:00.000Z'
function profile(): StoredCustomProfile {
  return { id: 'custom-one', name: 'Saved Ω', description: 'Description', payload: { ...blankProfilePayload('custom-one', 'Saved Ω'), description: 'Description' }, validationState: 'backend_confirmed', updatedAt: NOW }
}
function models(p: Record<string, unknown>): DraftUiState {
  return { body: bodyToUiModel(p.body as Record<string, unknown>), heading: headingToUiModel(p.heading as Record<string, unknown>), margins: marginsToUiModel(p.margins as Record<string, unknown>), references: referencesToUiModel(p.references as Record<string, unknown>), captions: captionsToUiModel(p.captions as Record<string, unknown>), lists: listsToUiModel(p.lists as Record<string, unknown>), citation: citationMatchingToUiModel(p.citation_matching) }
}

test('unchanged projected candidate preserves independent fonts, simultaneous pairs, unknown metadata, disabled values and tri-state', () => {
  for (const lineSwitch of [undefined, null, false, true]) {
    const draft = profile()
    draft.payload.body = { font_family: 'Family only', font_size_pt: null, first_line_indent_in: 0.5, alignment: 'unknown alignment', unsupported: { evidence: true } }
    draft.payload.heading = { font_size_pt: 16, allowed_font_combos: [['Other', 14]], level_1: { alignment: false, nested: { exact: ['bytes'] } }, level_2: null }
    draft.payload.references = { check_heading_text: false, heading_text: 'sources', allow_heading_aliases: true, check_line_spacing: lineSwitch, line_spacing: 2, check_hanging_indent: false, hanging_indent_in: 0, check_heading_bold: true, heading_bold: false, check_font_family: false, font_family: 'Retained Font' }
    draft.payload.citation_matching = { check_citations_have_references: false, check_author_year_consistency: true, check_year_suffixes: true, future_flag: 'raw' }
    draft.payload.created_at = 'original timestamp'
    const original = structuredClone(draft.payload)
    const ui = models(draft.payload)
    assert.equal(ui.references!.headingText, '')
    const candidate = buildSavePayload(draft, ui)
    assert.deepEqual(candidate, original)
    ui.body!.spaceAfterEnabled = true
    ui.body!.spaceAfter = '0'
    ui.references!.headingBold = true
    ui.citation!.check_duplicate_references = false
    const edited = buildSavePayload(draft, ui)
    assert.deepEqual(edited.body, { ...(original.body as object), space_after_pt: 0 })
    assert.deepEqual(edited.references, { ...(original.references as object), heading_bold: true })
    assert.deepEqual(edited.heading, original.heading)
    assert.equal((edited.citation_matching as Record<string, unknown>).check_author_year_consistency, true)
    assert.equal((edited.citation_matching as Record<string, unknown>).future_flag, 'raw')
    assert.deepEqual(draft.payload, original)
  }
})

test('malformed typed input reaches exact candidate and client rejection instead of becoming null', () => {
  const draft = profile()
  const ui = models(draft.payload)
  ui.body!.lineSpacingEnabled = true
  ui.body!.lineSpacing = 'not numeric'
  const candidate = buildSavePayload(draft, ui)
  assert.equal((candidate.body as Record<string, unknown>).line_spacing, 'not numeric')
  assert.ok(clientValidate({ ...draft, payload: candidate }, emptyEnvelope()).some((error) => error.field === 'body.line_spacing'))
  assert.equal((draft.payload.body as Record<string, unknown>).line_spacing, null)
})

test('memory and missing-lock capabilities refuse persistent success', async () => {
  const next = { ...emptyEnvelope(), revision: 1 }
  assert.deepEqual(await saveStore(createMemoryStoreAdapter(), next, 0), { ok: false, reason: 'not-persistent' })
  const durable = createDurableTestAdapter()
  const noLock: StoreAdapter = { ...durable, withExclusiveWrite: undefined }
  assert.deepEqual(await saveStore(noLock, next, 0), { ok: false, reason: 'locking-unavailable' })
  assert.equal(durable.get(ACTIVE_KEY), null)
})

test('read failure and corrupt bytes cannot be overwritten by ordinary mutations', async () => {
  const adapter = createDurableTestAdapter()
  adapter.set(ACTIVE_KEY, '{corrupt active')
  adapter.set(RECOVERY_KEY, '{corrupt recovery')
  assert.equal(loadStore(adapter).ok, false)
  assert.deepEqual(await saveStore(adapter, { ...emptyEnvelope(), revision: 1 }, 0), { ok: false, reason: 'corrupted' })
  assert.equal(adapter.get(ACTIVE_KEY), '{corrupt active')
  const denied = { ...adapter, get() { throw new Error('read denied') } }
  assert.deepEqual(await saveStore(denied, { ...emptyEnvelope(), revision: 1 }, 0), { ok: false, reason: 'unavailable' })
  assert.equal(loadStore(denied).ok, false)
})

test('future recovery remains readonly even beside valid active and explicit reset refuses downgrade', async () => {
  const adapter = createDurableTestAdapter()
  adapter.set(ACTIVE_KEY, serializeEnvelope(emptyEnvelope()))
  const future = serializeEnvelope({ ...emptyEnvelope(), schema_version: 99, revision: 20 })
  adapter.set(RECOVERY_KEY, future)
  const loaded = loadStore(adapter)
  assert.ok(loaded.ok)
  assert.equal(loaded.readonly, true)
  assert.deepEqual(await saveStore(adapter, { ...emptyEnvelope(), revision: 1 }, 0), { ok: false, reason: 'readonly' })
  assert.deepEqual(await acceptReset(adapter), { ok: false, reason: 'readonly' })
  assert.equal(adapter.get(RECOVERY_KEY), future)
})

test('failed recovery or active writes preserve the last usable committed bytes', async () => {
  for (const failingKey of [RECOVERY_KEY, ACTIVE_KEY]) {
    const adapter = createDurableTestAdapter()
    const before = { ...emptyEnvelope(), revision: 5, profiles: [profile()] }
    adapter.set(ACTIVE_KEY, serializeEnvelope(before))
    const failing: StoreAdapter = { ...adapter, set(key, value) { if (key === failingKey) throw new Error('quota denied'); adapter.set(key, value) } }
    const candidate = upsertAndBump(before, { ...profile(), name: 'Dirty draft' }, NOW)
    assert.deepEqual(await saveStore(failing, candidate, 5), { ok: false, reason: 'write-failed' })
    assert.equal(adapter.get(ACTIVE_KEY), serializeEnvelope(before))
    assert.equal(readStoredEnvelope(adapter).profiles[0].name, 'Saved Ω')
    if (failingKey === ACTIVE_KEY) assert.equal(adapter.get(RECOVERY_KEY), serializeEnvelope(before))
  }
})

test('exclusive concurrent writers with one origin revision cannot both commit', async () => {
  const adapter = createDurableTestAdapter()
  const base = emptyEnvelope()
  const a = upsertAndBump(base, profile(), NOW)
  const b = upsertAndBump(base, { ...profile(), name: 'Other tab' }, NOW)
  const results = await Promise.all([saveStore(adapter, a, 0), saveStore(adapter, b, 0)])
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.deepEqual(results.find((r) => !r.ok), { ok: false, reason: 'stale-revision' })
  assert.equal(readStoredEnvelope(adapter).revision, 1)
  assert.deepEqual(await saveStore(adapter, { ...a, revision: 2 }, 0), { ok: false, reason: 'stale-revision' })
})

test('selected deletion persists namespaced fallback; nonselected deletion does not reset it', async () => {
  for (const selected of ['custom:custom-one', 'builtin:apa7-student-paper']) {
    const adapter = createDurableTestAdapter()
    const base = { ...emptyEnvelope(), revision: 1, profiles: [profile()], selected_id: selected }
    adapter.set(ACTIVE_KEY, serializeEnvelope(base))
    const removed = deleteAndBump(base, 'custom-one', NOW)
    assert.ok(removed.ok)
    assert.ok((await saveStore(adapter, removed.envelope, 1)).ok)
    assert.equal(readStoredEnvelope(adapter).selected_id, selected.startsWith('custom:') ? 'builtin:suc-academic-report' : selected)
  }
})

test('volatile or future custom profiles cannot be frozen for audit submission', () => {
  const env = { ...emptyEnvelope(), profiles: [profile()] }
  for (const storage of [undefined, { persistent: false, readonly: false }, { persistent: true, readonly: true }]) {
    assert.equal(validateAndFreezeSubmission(env, [], 'custom:custom-one', storage).ok, false)
  }
  const captured = validateAndFreezeSubmission(env, [], 'custom:custom-one', { persistent: true, readonly: false })
  assert.ok(captured.ok)
  if (captured.frozen.kind !== 'custom') throw new Error('Expected custom')
  assert.ok(Object.isFrozen(captured.frozen.payload.body))
  assert.throws(() => { (captured.frozen.payload.body as Record<string, unknown>).line_spacing = 4 }, TypeError)
})

test('adapter unsubscribes the exact subscription and drops listener callbacks on destroy', () => {
  let event: ((e: { key: string; newValue: string | null }) => void) | undefined
  let removed = 0
  const adapter = new LocalStorageStoreAdapter({ getItem: () => null, setItem() {}, removeItem() {} }, (listener) => { event = listener; return () => { removed++ } })
  let calls = 0
  const unsubscribe = adapter.onExternalChange(() => { calls++ })
  event!({ key: ACTIVE_KEY, newValue: null })
  unsubscribe()
  event!({ key: ACTIVE_KEY, newValue: null })
  adapter.onExternalChange(() => { calls++ })
  adapter.destroy()
  event!({ key: ACTIVE_KEY, newValue: null })
  assert.equal(calls, 1)
  assert.equal(removed, 1)
})

test('validation API rejects malformed success discriminants and accepts structured 422 errors', async () => {
  const original = globalThis.fetch
  const payload = blankProfilePayload('custom-one', 'Saved Ω')
  try {
    for (const body of [{}, { valid: 'true', profile: payload }, { valid: true }, { valid: true, profile: [] }, { valid: true, profile: { ...payload, profile_id: 'different' } }, { valid: true, profile: { ...payload, body: [] } }, { valid: false, errors: [{ field: 1 }] }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 })
      assert.deepEqual(await api.validateCustomProfile(payload), { valid: false, unreachable: true })
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ valid: false, errors: [{ field: 'body.font_pairs', message: 'Invalid pair.' }] }), { status: 422 })
    assert.deepEqual(await api.validateCustomProfile(payload), { valid: false, errors: [{ field: 'body.font_pairs', message: 'Invalid pair.' }] })
    globalThis.fetch = async () => new Response(JSON.stringify({ valid: true, profile: payload }), { status: 200 })
    assert.deepEqual(await api.validateCustomProfile(payload), { valid: true, profile: payload })
  } finally { globalThis.fetch = original }
})

test('opaque future envelope bytes are protected even when this build cannot parse the shape', async () => {
  const adapter = createDurableTestAdapter()
  const raw = JSON.stringify({ schema_version: 99, future_profiles: ['do not downgrade'] })
  adapter.set(ACTIVE_KEY, raw)
  const loaded = loadStore(adapter)
  assert.ok(!loaded.ok)
  assert.equal(loaded.reason, 'unsupported-version')
  assert.deepEqual(await acceptReset(adapter), { ok: false, reason: 'readonly' })
  assert.deepEqual(await saveStore(adapter, { ...emptyEnvelope(), revision: 1 }, 0), { ok: false, reason: 'readonly' })
  assert.equal(adapter.get(ACTIVE_KEY), raw)
})

test('a removed store still conflicts with a nonzero edit-origin revision', async () => {
  const adapter = createDurableTestAdapter()
  assert.deepEqual(await saveStore(adapter, { ...emptyEnvelope(), revision: 8 }, 7), { ok: false, reason: 'stale-revision' })
  assert.equal(adapter.get(ACTIVE_KEY), null)
})

test('browser adapter removes the very same native storage listener it registered', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const bytes = new Map<string, string>()
  let registered: unknown
  let removed: unknown
  const storage = {
    getItem: (key: string) => bytes.get(key) ?? null,
    setItem: (key: string, value: string) => { bytes.set(key, value) },
    removeItem: (key: string) => { bytes.delete(key) },
  }
  const fakeWindow = {
    localStorage: storage,
    addEventListener(_name: string, handler: unknown) { registered = handler },
    removeEventListener(_name: string, handler: unknown) { removed = handler },
  }
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow })
    const adapter = createBrowserStoreAdapter()
    assert.ok(adapter)
    adapter.destroy()
    assert.equal(typeof registered, 'function')
    assert.equal(removed, registered)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('supported active/recovery damage is disclosed without deleting the damaged bytes', () => {
  for (const damaged of [ACTIVE_KEY, RECOVERY_KEY]) {
    const adapter = createDurableTestAdapter()
    adapter.set(damaged, '{retained damage')
    adapter.set(damaged === ACTIVE_KEY ? RECOVERY_KEY : ACTIVE_KEY, serializeEnvelope({ ...emptyEnvelope(), revision: 7 }))
    const loaded = loadStore(adapter)
    assert.ok(loaded.ok)
    assert.equal(loaded.recovered, damaged === ACTIVE_KEY)
    assert.deepEqual(loaded.damagedCopies, [damaged === ACTIVE_KEY ? 'active' : 'recovery'])
    assert.equal(adapter.get(damaged), '{retained damage')
  }
})

test('canonical copy request rejects missing or mismatched source payload instead of substituting blank data', async () => {
  const original = globalThis.fetch
  try {
    for (const body of [{}, { profile: [] }, { profile: { profile_id: 'different', profile_source: 'built_in', profile_name: 'Wrong source' } }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 })
      await assert.rejects(api.getBuiltinProfilePayload('apa7-student-paper'))
    }
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    await assert.rejects(api.getBuiltinProfilePayload('apa7-student-paper'))
  } finally { globalThis.fetch = original }
})
