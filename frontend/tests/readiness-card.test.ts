/**
 * Setup Readiness Build B1 — pure logic + API-contract tests.
 *
 * Covers response adaptation/validation, ordering, labels, counts, summary
 * wording, unknown fallbacks, and the getReadiness URL contract. Component
 * rendering (collapse/refresh UI) is asserted via a source contract test,
 * matching the repo's no-DOM node:test convention.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adaptReadiness,
  overallHeadline,
  overallSupporting,
  issueCountSentence,
  unavailableOptionalCount,
  requiredActionNeededCount,
} from '../src/lib/readiness.ts'
import { api } from '../src/services/api.ts'

function readyPayload() {
  return {
    overall: 'ready',
    checked_at: '2026-08-22T00:00:00.000000',
    components: [
      { id: 'core_backend', state: 'ready', required: true, message: 'Ready to audit documents' },
      { id: 'database', state: 'ready', required: true, message: 'The database is up to date.' },
      { id: 'docx_audit', state: 'ready', required: true, message: 'Deterministic checks built in.' },
      { id: 'libreoffice', state: 'ready', required: false, message: 'Conversion support found.' },
      { id: 'rendered_preview', state: 'ready', required: false, message: 'Preview appears available.' },
      { id: 'ollama', state: 'ready', required: false, message: 'Local AI available.' },
      { id: 'local_model', state: 'ready', required: false, message: 'Model installed.', detail: 'Configured model: qwen3.5:4b' },
      { id: 'cloud_ai', state: 'optional', required: false, message: 'Cloud AI optional and not configured.' },
    ],
  }
}

function degradedPayload() {
  const p = readyPayload()
  p.overall = 'degraded'
  p.components = p.components.map((c) =>
    c.id === 'libreoffice' || c.id === 'ollama'
      ? { ...c, state: 'unavailable' }
      : c,
  )
  return p
}

// ---------------------------------------------------------------------------
// Adaptation + validation
// ---------------------------------------------------------------------------

test('valid response adapts with eight rows in deterministic order', () => {
  const m = adaptReadiness(readyPayload())
  assert.ok(m)
  assert.equal(m.overall, 'ready')
  assert.equal(m.rows.length, 8)
  assert.deepEqual(
    m.rows.map((r) => r.id),
    ['core_backend', 'database', 'docx_audit', 'libreoffice', 'rendered_preview', 'ollama', 'local_model', 'cloud_ai'],
  )
})

test('component reordering is normalized to contract order', () => {
  const p = readyPayload()
  p.components = [...p.components].reverse()
  const m = adaptReadiness(p)!
  assert.deepEqual(
    m.rows.map((r) => r.id),
    ['core_backend', 'database', 'docx_audit', 'libreoffice', 'rendered_preview', 'ollama', 'local_model', 'cloud_ai'],
  )
})

test('unknown future component id falls back to Additional component', () => {
  const p = readyPayload()
  p.components.push({ id: 'future_gadget', state: 'ready', required: false, message: 'x' })
  const m = adaptReadiness(p)!
  assert.equal(m.rows.length, 9)
  const last = m.rows[m.rows.length - 1]
  assert.equal(last.id, 'future_gadget')
  assert.equal(last.label, 'Additional component')
})

test('unknown future state falls back to Could not confirm', () => {
  const p = readyPayload()
  p.components[1].state = 'warped'
  const m = adaptReadiness(p)!
  assert.equal(m.rows[1].state, 'unknown')
  assert.equal(m.rows[1].stateLabel, 'Could not confirm')
})

test('malformed payload rejected — never becomes ready', () => {
  assert.equal(adaptReadiness(null), null)
  assert.equal(adaptReadiness({}), null)
  assert.equal(adaptReadiness({ overall: 'ready' }), null)
  assert.equal(adaptReadiness({ overall: 'ready', components: 'nope', checked_at: 'x' }), null)
  assert.equal(adaptReadiness({ overall: 'bogus', components: [], checked_at: 'x' }), null)
  assert.equal(adaptReadiness({ overall: 'ready', components: [], checked_at: '' }), null)
})

test('malformed component records are skipped, not rendered raw', () => {
  const p = readyPayload()
  p.components = [
    { id: 'core_backend', state: 'ready', required: true, message: 'x' },
    { state: 'ready', required: true }, // missing id + message
    'garbage',
    { id: 'database', state: 'ready', required: true, message: 'y' },
  ]
  const m = adaptReadiness(p)!
  assert.equal(m.rows.length, 2)
  assert.deepEqual(m.rows.map((r) => r.id), ['core_backend', 'database'])
})

test('missing checked_at rejected', () => {
  const p = readyPayload()
  delete p.checked_at
  assert.equal(adaptReadiness(p), null)
})

// ---------------------------------------------------------------------------
// Labels + friendly names
// ---------------------------------------------------------------------------

test('all eight known ids get friendly labels', () => {
  const m = adaptReadiness(readyPayload())!
  const labels = Object.fromEntries(m.rows.map((r) => [r.id, r.label]))
  assert.deepEqual(labels, {
    core_backend: 'Core application',
    database: 'Local audit database',
    docx_audit: 'Document checking',
    libreoffice: 'Rendered-page support',
    rendered_preview: 'Page preview',
    ollama: 'Local AI review',
    local_model: 'Local AI model',
    cloud_ai: 'Optional cloud AI',
  })
  // Raw snake-case ids never appear as the visible label.
  assert.ok(!m.rows.some((r) => r.label.includes('_') || r.label === r.id))
})

test('state labels map correctly', () => {
  const p = readyPayload()
  p.components = [
    { id: 'core_backend', state: 'ready', required: true, message: 'a' },
    { id: 'database', state: 'misconfigured', required: true, message: 'b' },
    { id: 'ollama', state: 'unavailable', required: false, message: 'c' },
    { id: 'cloud_ai', state: 'optional', required: false, message: 'd' },
  ]
  const m = adaptReadiness(p)!
  const byId = Object.fromEntries(m.rows.map((r) => [r.id, r.stateLabel]))
  assert.equal(byId['core_backend'], 'Ready')
  assert.equal(byId['database'], 'Action needed')
  assert.equal(byId['ollama'], 'Unavailable')
  assert.equal(byId['cloud_ai'], 'Optional')
})

// ---------------------------------------------------------------------------
// Counts + summary wording
// ---------------------------------------------------------------------------

test('degraded count counts only unavailable optional components', () => {
  const m = adaptReadiness(degradedPayload())!
  assert.equal(unavailableOptionalCount(m.rows), 2)
  assert.equal(issueCountSentence('degraded', m.rows), '2 optional features unavailable')
  assert.equal(m.overall, 'degraded')
})

test('cloud optional never counts toward unavailable', () => {
  const m = adaptReadiness(readyPayload())!
  assert.equal(unavailableOptionalCount(m.rows), 0)
  const withCloud = adaptReadiness({
    ...readyPayload(),
    components: [{ id: 'cloud_ai', state: 'optional', required: false, message: 'x' }],
  })!
  assert.equal(unavailableOptionalCount(withCloud.rows), 0)
})

test('single optional unavailable uses singular wording', () => {
  const p = readyPayload()
  p.components = [{ id: 'ollama', state: 'unavailable', required: false, message: 'x' }]
  const m = adaptReadiness(p)!
  assert.equal(issueCountSentence('degraded', m.rows), '1 optional feature unavailable')
})

test('blocked count counts required components needing attention', () => {
  const p = readyPayload()
  p.overall = 'blocked'
  p.components = [
    { id: 'database', state: 'misconfigured', required: true, message: 'db' },
    { id: 'docx_audit', state: 'unknown', required: true, message: 'docx' },
    { id: 'ollama', state: 'unavailable', required: false, message: 'ai' },
  ]
  const m = adaptReadiness(p)!
  assert.equal(requiredActionNeededCount(m.rows), 2)
  assert.equal(issueCountSentence('blocked', m.rows), '2 components need attention')
})

test('optional unknown does not count as action needed', () => {
  const p = readyPayload()
  p.components = [{ id: 'local_model', state: 'unknown', required: false, message: 'm' }]
  const m = adaptReadiness(p)!
  assert.equal(requiredActionNeededCount(m.rows), 0)
  assert.equal(unavailableOptionalCount(m.rows), 0)
  assert.equal(issueCountSentence('degraded', m.rows), '')
})

test('headlines and supporting text for all three overall states', () => {
  assert.equal(overallHeadline('ready'), 'Ready to audit documents')
  assert.equal(overallHeadline('degraded'), 'Ready to audit documents')
  assert.equal(overallHeadline('blocked'), 'Action needed before auditing')
  assert.equal(
    overallSupporting('ready'),
    'Required document-checking features are available.',
  )
  assert.equal(
    overallSupporting('degraded'),
    'Some optional features are unavailable. Deterministic document checks remain available.',
  )
  assert.equal(
    overallSupporting('blocked'),
    'A required component needs attention before auditing.',
  )
})

// ---------------------------------------------------------------------------
// Optional-failure wording contract (Backend messages surfaced as-is)
// ---------------------------------------------------------------------------

test('LibreOffice unavailable wording is non-blocking', () => {
  const p = readyPayload()
  p.overall = 'degraded'
  p.components = [
    { id: 'libreoffice', state: 'unavailable', required: false, message: 'Rendered-page preview is unavailable. Extracted-text evidence remains available.' },
  ]
  const m = adaptReadiness(p)!
  const row = m.rows[0]
  assert.equal(row.stateLabel, 'Unavailable')
  assert.ok(row.message.includes('Extracted-text evidence remains available'))
  assert.equal(m.overall, 'degraded')
})

test('Ollama unavailable wording keeps deterministic checks', () => {
  const p = readyPayload()
  p.components = [
    { id: 'ollama', state: 'unavailable', required: false, message: 'Local AI citation review is unavailable. Deterministic checks remain available.' },
  ]
  const m = adaptReadiness(p)!
  assert.ok(m.rows[0].message.includes('Deterministic checks remain available'))
})

test('model unavailable keeps safe detail', () => {
  const p = readyPayload()
  p.components = [
    { id: 'local_model', state: 'unavailable', required: false, message: 'The configured local AI model is not installed.', detail: 'Configured model: qwen3.5:4b' },
  ]
  const m = adaptReadiness(p)!
  assert.equal(m.rows[0].detail, 'Configured model: qwen3.5:4b')
})

// ---------------------------------------------------------------------------
// API client contract
// ---------------------------------------------------------------------------

test('getReadiness normal call hits /api/readiness with no query', async () => {
  const orig = globalThis.fetch
  let captured = ''
  globalThis.fetch = async (input: RequestInfo) => {
    captured = typeof input === 'string' ? input : String(input)
    return new Response(JSON.stringify(readyPayload()), { status: 200 })
  }
  try {
    await api.getReadiness(false)
    assert.equal(captured, '/api/readiness')
  } finally {
    globalThis.fetch = orig
  }
})

test('getReadiness refresh call uses refresh=1', async () => {
  const orig = globalThis.fetch
  let captured = ''
  globalThis.fetch = async (input: RequestInfo) => {
    captured = typeof input === 'string' ? input : String(input)
    return new Response(JSON.stringify(readyPayload()), { status: 200 })
  }
  try {
    await api.getReadiness(true)
    assert.equal(captured, '/api/readiness?refresh=1')
  } finally {
    globalThis.fetch = orig
  }
})

// ---------------------------------------------------------------------------
// Source contract for component rendering + accessibility
// ---------------------------------------------------------------------------

test('readiness-card source exposes required a11y + progressive-disclosure markers', () => {
  const { readFileSync } = requireNode('fs')
  const { join } = requireNode('path')
  const src = readFileSync(
    join(process.cwd(), 'src', 'components', 'dashboard', 'readiness-card.tsx'),
    'utf8',
  )
  assert.ok(src.includes('aria-expanded'))
  assert.ok(src.includes('aria-controls={detailsId}'))
  assert.ok(src.includes('aria-label="Refresh system readiness"'))
  assert.ok(src.includes('role="status"'))
  assert.ok(src.includes('role="alert"'))
  assert.ok(src.includes('View details'))
  assert.ok(src.includes('Hide details'))
  assert.ok(src.includes('min-h-[44px]'))
  assert.ok(src.includes('fetchingRef.current')) // duplicate-request guard
})

// ESM wrapper — repo tests run under "type": "module".
import { createRequire } from 'node:module'
const requireNode = createRequire(new URL(import.meta.url))
