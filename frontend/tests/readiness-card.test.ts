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
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import vm from 'node:vm'
import ts from 'typescript'
import {
  adaptReadiness,
  overallHeadline,
  overallSupporting,
  issueCountSentence,
  unavailableOptionalCount,
  requiredActionNeededCount,
} from '../src/lib/readiness.ts'
import { api } from '../src/services/api.ts'
import { LOCAL_MODEL_COPY } from '../src/lib/local-model-download.ts'
import { SETUP_COPY } from '../src/lib/setup-paths.ts'

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

test('valid response adapts with seven rows in deterministic order', () => {
  const m = adaptReadiness(readyPayload())
  assert.ok(m)
  assert.equal(m.overall, 'ready')
  assert.equal(m.rows.length, 7)
  assert.deepEqual(
    m.rows.map((r) => r.id),
    ['core_backend', 'database', 'docx_audit', 'libreoffice', 'rendered_preview', 'ollama', 'local_model'],
  )
})

test('component reordering is normalized to contract order', () => {
  const p = readyPayload()
  p.components = [...p.components].reverse()
  const m = adaptReadiness(p)!
  assert.deepEqual(
    m.rows.map((r) => r.id),
    ['core_backend', 'database', 'docx_audit', 'libreoffice', 'rendered_preview', 'ollama', 'local_model'],
  )
})

test('unknown future component id falls back to Additional component', () => {
  const p = readyPayload()
  p.components.push({ id: 'future_gadget', state: 'ready', required: false, message: 'x' })
  const m = adaptReadiness(p)!
  assert.equal(m.rows.length, 8)
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

test('all seven known ids get friendly labels', () => {
  const m = adaptReadiness(readyPayload())!
  const labels = Object.fromEntries(m.rows.map((r) => [r.id, r.label]))
  assert.deepEqual(labels, {
    core_backend: 'Core application',
    database: 'Local audit database',
    docx_audit: 'Document checking',
    libreoffice: 'Rendered-page support',
    rendered_preview: 'Page preview',
    ollama: 'Local AI Citation Guidance',
    local_model: 'Citation Guidance Model',
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
    { id: 'local_model', state: 'optional', required: false, message: 'd' },
  ]
  const m = adaptReadiness(p)!
  const byId = Object.fromEntries(m.rows.map((r) => [r.id, r.stateLabel]))
  assert.equal(byId['core_backend'], 'Ready')
  assert.equal(byId['database'], 'Action needed')
  assert.equal(byId['ollama'], 'Unavailable')
  assert.equal(byId['local_model'], 'Optional')
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

test('legacy cloud_ai row is filtered out — never rendered or counted', () => {
  const m = adaptReadiness(readyPayload())!
  assert.equal(unavailableOptionalCount(m.rows), 0)
  const withCloud = adaptReadiness({
    ...readyPayload(),
    components: [
      { id: 'ollama', state: 'ready', required: false, message: 'ok' },
      { id: 'cloud_ai', state: 'unavailable', required: false, message: 'legacy row' },
    ],
  })!
  assert.deepEqual(withCloud.rows.map((r) => r.id), ['ollama'])
  assert.ok(!withCloud.rows.some((r) => r.label === 'Additional component'))
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
  // The details IDREF is emitted only while the target is mounted; its full
  // lifecycle is asserted against the rendered DOM in
  // e2e/upload-audit-workflow.spec.ts rather than by matching source text.
  assert.ok(src.includes('aria-label="Refresh system readiness"'))
  assert.ok(src.includes('role="status"'))
  assert.ok(src.includes('role="alert"'))
  assert.ok(src.includes('View details'))
  assert.ok(src.includes('Hide details'))
  assert.ok(src.includes('min-h-[44px]'))
  assert.ok(src.includes('fetchingRef.current')) // duplicate-request guard
})

/** Render the production card with readiness already loaded; effects do not run
 * during server rendering, so no readiness or download request is made here. */
function readinessView(payload: unknown, state = 'loaded') {
  const { readFileSync } = requireNode('node:fs')
  const { resolve } = requireNode('node:path')
  const source = readFileSync(resolve('src/components/dashboard/readiness-card.tsx'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText
  // Card hooks: load state, model, expanded, refresh flags, download state/flags.
  const values: unknown[] = [state, payload ? adaptReadiness(payload) : null, false, false, false, null, false, false, false, false]
  let cursor = 0
  let setupClick: (() => void) | undefined
  const exports: Record<string, React.ComponentType> = {}
  vm.runInNewContext(compiled, { exports, require(name: string) {
    if (name === 'react') return {
      ...React,
      useState(initial: unknown) {
        const index = cursor++
        if (index >= values.length) return React.useState(initial)
        return [values[index], (next: unknown) => {
          values[index] = typeof next === 'function' ? next(values[index]) : next
        }]
      },
    }
    if (name === 'react/jsx-runtime') return requireNode(name)
    if (name.includes('/lib/utils')) return { cn: (...parts: string[]) => parts.join(' ') }
    for (const lib of ['readiness', 'setup-paths', 'local-model-download']) {
      if (name.endsWith(`/lib/${lib}`)) return requireNode(resolve(`src/lib/${lib}.ts`))
    }
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => null })
    if (name.endsWith('/ui/button')) return {
      Button({ children, onClick, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) {
        if (children === 'View Local AI setup') setupClick = onClick as (() => void) | undefined
        return React.createElement('button', props, children)
      },
    }
    return new Proxy({}, { get: () => ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('div', props, children) })
  } })
  return {
    render() {
      cursor = 0
      return renderToStaticMarkup(React.createElement(exports.ReadinessCard))
    },
    expandSetup() {
      assert.ok(setupClick, 'the rendered setup control must have an action')
      setupClick()
    },
  }
}

for (const [ollama, localModel, expected] of [
  ['ready', 'ready', 'Ready'],
  ['ready', 'unavailable', 'Setup required'],
  ['unavailable', 'unknown', 'Unavailable'],
  ['optional', 'optional', 'Disabled'],
  ['unknown', 'unknown', 'Unavailable'],
  ['misconfigured', 'ready', 'Unavailable'],
  ['ready', 'unknown', 'Unavailable'],
] as const) {
  test(`collapsed Local AI row reports ${expected} for ${ollama}/${localModel}`, () => {
    const payload = readyPayload()
    payload.components = payload.components.map((row) => ({
      ...row, state: row.id === 'ollama' ? ollama : row.id === 'local_model' ? localModel : row.state,
    }))
    const view = readinessView(payload)
    const html = view.render()
    assert.match(html, /Local AI<span role="status"[^>]*>/)
    assert.ok(html.includes(`>${expected}</span>`), html)
    assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>View Local AI setup<\/button>/)
    assert.doesNotMatch(html, /id="readiness-details"/)
  })
}

test('Local AI setup expands existing details without starting a model download', () => {
  const payload = readyPayload()
  payload.components.find((row) => row.id === 'local_model')!.state = 'unavailable'
  const view = readinessView(payload)
  view.render()
  view.expandSetup()
  const html = view.render()
  assert.match(html, /id="readiness-details"/)
  assert.match(html, /aria-controls="readiness-details"/)
  assert.ok(html.includes(LOCAL_MODEL_COPY.downloadAction))
  assert.ok(html.includes(LOCAL_MODEL_COPY.scope))
  assert.ok(html.includes(LOCAL_MODEL_COPY.accuracy))
  assert.ok(html.includes(SETUP_COPY.model.body))
  assert.ok(!html.includes(LOCAL_MODEL_COPY.confirmTitle), 'setup expansion must not open download consent')
})

test('missing or failed readiness never claims Local AI is ready or enables setup', () => {
  for (const state of ['checking', 'error']) {
    const html = readinessView(null, state).render()
    assert.match(html, />Unavailable<\/span>/)
    assert.match(html, /<button[^>]*disabled=""[^>]*>View Local AI setup<\/button>/)
  }
})

test('model download action appears only for Ollama ready and model confirmed missing', () => {
  for (const [ollama, localModel, downloadAllowed] of [
    ['ready', 'unavailable', true],
    ['unavailable', 'unavailable', false],
    ['unknown', 'unavailable', false],
    ['optional', 'optional', false],
    ['ready', 'ready', false],
    ['ready', 'unknown', false],
  ] as const) {
    const payload = readyPayload()
    payload.components = payload.components.map((row) => ({
      ...row, state: row.id === 'ollama' ? ollama : row.id === 'local_model' ? localModel : row.state,
    }))
    const view = readinessView(payload)
    view.render()
    view.expandSetup()
    assert.equal(view.render().includes(LOCAL_MODEL_COPY.downloadAction), downloadAllowed, `${ollama}/${localModel}`)
  }
})

// ESM wrapper — repo tests run under "type": "module".
import { createRequire } from 'node:module'
const requireNode = createRequire(new URL(import.meta.url))
