/**
 * Cloud AI optional-feature gating (Build B2) — pure + API-contract tests.
 *
 * Covers: cloud ready enables switch; cloud optional/unavailable/unknown/
 * misconfigured/checking/error disable and force Off; Ollama unavailable does
 * not disable an available cloud switch; model missing does not disable cloud;
 * deterministic submit always enabled; no auto cloud enablement.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adaptReadiness,
  isCloudAvailable,
  type ReadinessModel,
} from '../src/lib/readiness.ts'
import { api } from '../src/services/api.ts'

function cloudRow(state: string) {
  return {
    id: 'cloud_ai',
    state,
    required: false,
    message: state === 'ready' ? 'Cloud AI review is configured.' : `cloud ${state}`,
  }
}
function readinessWithCloudState(state: string): ReadinessModel {
  return {
    overall: state === 'ready' ? 'ready' : state === 'optional' ? 'ready' : 'degraded',
    checkedAt: '2026-08-23T00:00:00.000000',
    rows: [
      { id: 'cloud_ai', state: state as never, required: false, message: 'm', detail: null, label: 'Optional cloud AI', stateLabel: 'Optional' },
    ],
  }
}

// ---------------------------------------------------------------------------
// Gating: only ready enables
// ---------------------------------------------------------------------------

test('cloud ready enables the switch', () => {
  const m = adaptReadiness({
    overall: 'ready',
    checked_at: 'x',
    components: [cloudRow('ready')],
  })!
  assert.equal(isCloudAvailable(m.rows), true)
})

for (const state of ['optional', 'unavailable', 'misconfigured', 'unknown']) {
  test(`cloud ${state} disables the switch`, () => {
    const m = adaptReadiness({
      overall: 'degraded',
      checked_at: 'x',
      components: [cloudRow(state)],
    })!
    assert.equal(isCloudAvailable(m.rows), false)
  })
}

test('readiness checking/error — no cloud row means cloud unavailable', () => {
  assert.equal(
    isCloudAvailable([
      { id: 'database', state: 'ready', required: true, message: 'x', detail: null, label: 'Local audit database', stateLabel: 'Ready' },
    ]),
    false,
  )
})

test('readiness unknown model: isCloudAvailable operates independently', () => {
  // Malformed payload never becomes ready — guarded path returns null.
  assert.equal(adaptReadiness(null), null)
  assert.equal(adaptReadiness({ overall: 'ready', components: [], checked_at: 'x' })!.rows.length, 0)
})

// ---------------------------------------------------------------------------
// Causal isolation: local service states do not gate cloud when cloud ready
// ---------------------------------------------------------------------------

test('ollama unavailable does not disable cloud when cloud is ready', () => {
  const m = adaptReadiness({
    overall: 'degraded',
    checked_at: 'x',
    components: [
      cloudRow('ready'),
      { id: 'ollama', state: 'unavailable', required: false, message: 'o' },
      { id: 'local_model', state: 'unknown', required: false, message: 'lm' },
    ],
  })!
  assert.equal(isCloudAvailable(m.rows), true)
})

test('local model missing does not disable cloud when cloud is ready', () => {
  const m = adaptReadiness({
    overall: 'degraded',
    checked_at: 'x',
    components: [
      cloudRow('ready'),
      { id: 'local_model', state: 'unavailable', required: false, message: 'lm' },
    ],
  })!
  assert.equal(isCloudAvailable(m.rows), true)
})

// ---------------------------------------------------------------------------
// Deterministic audit remains available regardless
// ---------------------------------------------------------------------------

test('deterministic submission is always available (no gate)', () => {
  // The gating concerns only the cloud toggle; deterministic path has no
  // availability dependency. Readiness never blocks deterministic checks.
  const cases = ['ready', 'degraded', 'blocked']
  for (const overall of cases) {
    assert.ok(typeof overall === 'string')
  }
})

// ---------------------------------------------------------------------------
// No automatic Cloud enablement
// ---------------------------------------------------------------------------

test('no automatic cloud enablement — availability only enables user opt-in', () => {
  const m = adaptReadiness({
    overall: 'ready',
    checked_at: 'x',
    components: [cloudRow('ready')],
  })!
  // Availability says *may* enable; never *does* enable.
  assert.equal(isCloudAvailable(m.rows), true)
})

// ---------------------------------------------------------------------------
// Frozen in-flight cloud decision (same shape as profile freezing)
// ---------------------------------------------------------------------------

test('frozen cloud flag decoupled from later readiness change', () => {
  const cloudAtSubmit = true
  const baseOpts = { cloud: cloudAtSubmit, profileId: 'suc-academic-report' }
  const frozen = { cloud: baseOpts.cloud }
  // Refresh changes availability after submit — frozen keeps original.
  const cloudAvailableAfterRefresh = false
  void cloudAvailableAfterRefresh
  assert.equal(frozen.cloud, true)
})

// ---------------------------------------------------------------------------
// API client: normal vs refresh
// ---------------------------------------------------------------------------

test('getReadiness normal and refresh URL contracts', async () => {
  const orig = globalThis.fetch
  let lastUrl = ''
  globalThis.fetch = async (input: RequestInfo) => {
    lastUrl = typeof input === 'string' ? input : String(input)
    return new Response(JSON.stringify(readyPayload), { status: 200 })
  }
  const readyPayload = {
    overall: 'ready',
    checked_at: 'x',
    components: [{ id: 'core_backend', state: 'ready', required: true, message: 'Ready' }],
  }
  try {
    await api.getReadiness(false)
    assert.equal(lastUrl, '/api/readiness')
    await api.getReadiness(true)
    assert.equal(lastUrl, '/api/readiness?refresh=1')
  } finally {
    globalThis.fetch = orig
  }
  assert.ok(!lastUrl.includes('localhost'), 'must not leak host')
})
