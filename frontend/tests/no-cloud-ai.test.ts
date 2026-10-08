/**
 * Cloud AI removal — negative contract tests.
 *
 * Source- and semantics-level proof that the final product contains no cloud
 * AI control, copy, API-key field, provider label, or readiness row; that a
 * legacy `cloud_ai` readiness row is filtered rather than rendered; that
 * historical cloud provider strings degrade to a neutral label; and that the
 * retained Local AI surfaces stay intact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HIDDEN_COMPONENT_IDS, adaptReadiness } from '../src/lib/readiness.ts'
import { aiProviderLabel, normalizeAiProvider } from '../src/lib/audit/adapter.ts'
import { api } from '../src/services/api.ts'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '..', 'src')
const read = (p: string) => readFileSync(join(here, '..', p), 'utf8')

function readAllSrc(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) readAllSrc(p, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(readFileSync(p, 'utf8'))
  }
  return out
}

const ALL_SRC = readAllSrc(srcRoot).join('\n')

// ---------------------------------------------------------------------------
// No cloud control, copy, or provider surface
// ---------------------------------------------------------------------------

test('no cloud AI toggle, control, or copy exists anywhere in src', () => {
  for (const forbidden of [
    'cloud-toggle',
    'Use cloud AI-assisted review',
    'Cloud AI review is unavailable.',
    'requires explicit opt-in',
    'Optional cloud AI',
    'Cloud AI review is optional',
  ]) {
    assert.equal(
      ALL_SRC.includes(forbidden),
      false,
      `removed cloud string found: ${forbidden}`,
    )
  }
})

test('no API-key field, Gemini reference, or provider selector exists in src', () => {
  assert.equal(/apikey|api_key|gemini|GEMINI/.test(ALL_SRC), false)
})

// ---------------------------------------------------------------------------
// Readiness compatibility filter
// ---------------------------------------------------------------------------

test('HIDDEN_COMPONENT_IDS is the explicit legacy-row filter', () => {
  assert.equal(HIDDEN_COMPONENT_IDS['cloud_ai'], true)
})

test('legacy cloud_ai readiness row renders no row at all', () => {
  const m = adaptReadiness({
    overall: 'degraded',
    checked_at: '2026-10-08T00:00:00.000000',
    components: [
      { id: 'ollama', state: 'ready', required: false, message: 'Local AI available.' },
      { id: 'cloud_ai', state: 'optional', required: false, message: 'Cloud AI review is optional and is not configured.' },
    ],
  })!
  assert.deepEqual(m.rows.map((r) => r.id), ['ollama'])
  assert.ok(!m.rows.some((r) => r.label === 'Additional component'))
  assert.ok(!m.rows.some((r) => r.id.includes('cloud')))
})

// ---------------------------------------------------------------------------
// Historical provider strings
// ---------------------------------------------------------------------------

test('unsupported historical providers normalise to UNKNOWN', () => {
  assert.equal(normalizeAiProvider('CLOUD_GEMINI'), 'UNKNOWN')
  assert.equal(normalizeAiProvider('CLOUD_FALLBACK_LOCAL'), 'UNKNOWN')
  assert.equal(normalizeAiProvider('LOCAL_OLLAMA'), 'LOCAL_OLLAMA')
  assert.equal(normalizeAiProvider(null), null)
})

test('unknown provider label is the neutral AI', () => {
  assert.equal(aiProviderLabel('UNKNOWN'), 'AI')
  assert.equal(aiProviderLabel(null), 'AI')
  assert.equal(aiProviderLabel('LOCAL_OLLAMA'), 'local Ollama')
})

// ---------------------------------------------------------------------------
// Submission payload
// ---------------------------------------------------------------------------

test('audit submission sends only profile_id — never a cloud parameter', async () => {
  const orig = globalThis.fetch
  let captured = ''
  globalThis.fetch = async (input: RequestInfo) => {
    captured = typeof input === 'string' ? input : String(input)
    return new Response(JSON.stringify({ audit_id: 'a1', status: 'processing' }), {
      status: 200,
    })
  }
  try {
    const file = new File([new Uint8Array([1, 2, 3])], 'thesis.docx', {
      type: 'application/octet-stream',
    })
    await api.auditDocument(file, { profileId: 'suc-academic-report' })
  } finally {
    globalThis.fetch = orig
  }
  assert.equal(captured, '/api/audit?profile_id=suc-academic-report')
  assert.equal(captured.includes('cloud'), false)
})

// ---------------------------------------------------------------------------
// Retained Local AI + determinism surfaces
// ---------------------------------------------------------------------------

test('Local AI setup pathways and model-download UI remain', () => {
  const setupPaths = read('src/lib/setup-paths.ts')
  assert.ok(setupPaths.includes('Download Ollama'))
  assert.ok(setupPaths.includes('local_model'))
  const downloadCopy = read('src/lib/local-model-download.ts')
  assert.ok(downloadCopy.includes('Download optional model'))
  const readiness = read('src/lib/readiness.ts')
  assert.ok(readiness.includes("ollama: 'Local AI Citation Guidance'"))
  assert.ok(readiness.includes("local_model: 'Citation Guidance Model'"))
})

test('deterministic-audit independence wording remains', () => {
  assert.ok(
    read('src/components/audit/compliance-summary.tsx').includes(
      'Optional AI-assisted citation review was unavailable; deterministic results are unaffected.',
    ),
  )
  const auditPage = read('src/pages/AuditPage.tsx')
  assert.ok(auditPage.includes('AI-assisted guidance was unavailable for this citation finding.'))
  assert.ok(auditPage.includes('Deterministic'))
})
