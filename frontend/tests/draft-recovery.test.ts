import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROFILE_DRAFT_RECOVERY_KEY, saveDraftRecovery, clearDraftRecovery, loadDraftRecoveryResult, parseDraftRecovery, serializeDraftRecovery, decideDraftRecovery, createMemoryDraftRecoveryAdapter, type ProfileDraftRecovery, type DraftUiState } from '../src/lib/custom-profile-store/draft-recovery.ts'
import { blankProfilePayload, bodyToUiModel, headingToUiModel, marginsToUiModel, referencesToUiModel, captionsToUiModel, listsToUiModel, citationMatchingToUiModel, applyPageElementsUiPatch, pageElementsToUiModel } from '../src/lib/custom-profile-store/editor.ts'

function recovery(): ProfileDraftRecovery {
  const payload = blankProfilePayload('actual-draft-id', 'Saved name')
  const ui: DraftUiState = {
    body: bodyToUiModel(payload.body as Record<string, unknown>),
    heading: headingToUiModel(payload.heading as Record<string, unknown>),
    margins: marginsToUiModel(payload.margins as Record<string, unknown>),
    references: referencesToUiModel(payload.references as Record<string, unknown>),
    captions: captionsToUiModel(payload.captions as Record<string, unknown>),
    lists: listsToUiModel(payload.lists as Record<string, unknown>),
    citation: citationMatchingToUiModel(payload.citation_matching),
  }
  ui.body!.lineSpacingEnabled = true
  ui.body!.lineSpacing = 'invalid unfinished 1.'
  return { schema_version: 2, profile_id: 'actual-draft-id', base_revision: 7,
    draft: { id: 'actual-draft-id', name: 'Unsaved Ω name ', description: 'Unsaved description', sourceId: 'apa7-student-paper', payload, validationState: 'draft', updatedAt: '2026-10-22T00:00:00.000Z' },
    ui, updated_at: '2026-10-23T00:00:00.000Z' }
}

test('v2 restores complete wrapper, actual new identity, raw invalid inputs and original baseline', () => {
  const adapter = createMemoryDraftRecoveryAdapter()
  const draft = recovery()
  assert.equal(saveDraftRecovery(adapter, draft), true)
  const loaded = loadDraftRecoveryResult(adapter)
  assert.equal(loaded.status, 'ready')
  if (loaded.status !== 'ready') throw new Error('Expected recovery')
  assert.deepEqual(loaded.recovery, draft)
  assert.equal(loaded.recovery.ui.body!.lineSpacing, 'invalid unfinished 1.')
  assert.equal(decideDraftRecovery(loaded.recovery, null, 7).action, 'apply')
  assert.equal(decideDraftRecovery(loaded.recovery, null, 8).action, 'conflict')
  assert.equal(decideDraftRecovery(loaded.recovery, 'other-id', 7).action, 'invalid')
})

test('malformed, old payload-only and future evidence stays byte-for-byte until explicit discard', () => {
  for (const [raw, status] of [
    ['{broken', 'invalid'],
    [JSON.stringify({ schema_version: 1, profile_id: 'new', payload: { body: {} } }), 'unsupported'],
    [JSON.stringify({ schema_version: 99, unknown: 'future data' }), 'unsupported'],
    [JSON.stringify({ ...recovery(), draft: { ...recovery().draft, id: 'wrong' } }), 'invalid'],
    [JSON.stringify({ ...recovery(), ui: { body: {} } }), 'invalid'],
  ] as const) {
    const adapter = createMemoryDraftRecoveryAdapter()
    adapter.set(PROFILE_DRAFT_RECOVERY_KEY, raw)
    assert.equal(loadDraftRecoveryResult(adapter).status, status)
    assert.equal(parseDraftRecovery(raw), null)
    assert.equal(saveDraftRecovery(adapter, recovery()), false)
    assert.equal(adapter.get(PROFILE_DRAFT_RECOVERY_KEY), raw)
    assert.equal(clearDraftRecovery(adapter), true)
    assert.deepEqual(loadDraftRecoveryResult(adapter), { status: 'empty' })
    assert.equal(saveDraftRecovery(adapter, recovery()), true)
  }
})

test('read, write and clear failures are reported without success or throwing', () => {
  const unavailable = { get() { throw new Error('read denied') }, set() { throw new Error('write denied') }, remove() { throw new Error('remove denied') } }
  assert.equal(loadDraftRecoveryResult(null).status, 'unavailable')
  assert.equal(loadDraftRecoveryResult(unavailable).status, 'unavailable')
  assert.equal(saveDraftRecovery(unavailable, recovery()), false)
  assert.equal(clearDraftRecovery(unavailable), false)
  assert.equal(clearDraftRecovery(null), false)
  const writeFailure = { ...unavailable, get: () => null }
  assert.equal(saveDraftRecovery(writeFailure, recovery()), false)
})

test('invalid partial UI model cannot be emitted as a complete recovery record', () => {
  const adapter = createMemoryDraftRecoveryAdapter()
  const record = recovery()
  record.ui.heading = { pairs: [] } as never
  assert.equal(saveDraftRecovery(adapter, record), false)
  assert.equal(adapter.get(PROFILE_DRAFT_RECOVERY_KEY), null)
  assert.equal(parseDraftRecovery(serializeDraftRecovery(record)), null)
})

test('every structural toggle combination and placement survives recovery without changing original id', () => {
  for (let bits = 0; bits < 8; bits++) for (const placement of ['header', 'footer', 'either'] as const) {
    const record = recovery()
    const controls = { headerEnabled: Boolean(bits & 1), footerEnabled: Boolean(bits & 2), pageNumberEnabled: Boolean(bits & 4), placement }
    record.draft.payload = applyPageElementsUiPatch(record.draft.payload, controls)
    const adapter = createMemoryDraftRecoveryAdapter()
    assert.equal(saveDraftRecovery(adapter, record), true)
    const loaded = loadDraftRecoveryResult(adapter)
    if (loaded.status !== 'ready') throw new Error('Expected complete recovery')
    assert.deepEqual(pageElementsToUiModel(loaded.recovery.draft.payload), controls)
    assert.equal(clearDraftRecovery(adapter), true)
    assert.equal(loadDraftRecoveryResult(adapter).status, 'empty')
  }
})
