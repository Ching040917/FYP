import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { api, TimeoutError } from '../src/services/api.ts'
import { adaptAuditResponse } from '../src/lib/audit/adapter.ts'

function mockFetchOnce(handler: (input: RequestInfo, init?: RequestInit) => Promise<Response> | Response) {
  const orig = globalThis.fetch
  globalThis.fetch = handler as typeof fetch
  return () => { globalThis.fetch = orig }
}

// healthCheck must target /health (valid in both Vite dev via proxy and packaged same-origin)
test('healthCheck targets /health with timeout', async () => {
  let capturedUrl = ''
  let capturedSignal: AbortSignal | undefined
  const restore = mockFetchOnce(async (input, init) => {
    capturedUrl = typeof input === 'string' ? input : String(input)
    capturedSignal = (init as RequestInit)?.signal as AbortSignal | undefined
    return new Response(JSON.stringify({ status: 'healthy' }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    const res = await api.healthCheck()
    assert.equal(capturedUrl, '/health')
    assert.ok(capturedSignal instanceof AbortSignal, 'should use AbortSignal via fetchWithTimeout')
    assert.equal(res.status, 'healthy')
  } finally { restore() }
})

test('healthCheck propagates non-2xx as error', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({ detail: 'Not ready' }), { status: 500 }))
  try {
    await assert.rejects(() => api.healthCheck(), (err: Error) => {
      assert.match(err.message, /Not ready|HTTP 500/)
      return true
    })
  } finally { restore() }
})

test('healthCheck timeout becomes TimeoutError', async () => {
  const restore = mockFetchOnce(async (_input, init) => {
    const signal = (init as RequestInit)?.signal as AbortSignal | undefined
    return new Promise<Response>((_, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          const e = new Error('aborted')
          ;(e as Error).name = 'AbortError'
          reject(e)
        })
      }
    })
  })
  try {
    await assert.rejects(() => api.healthCheck(), (err: Error) => {
      assert.equal(err.name, 'TimeoutError')
      return true
    })
  } finally { restore() }
})

// listAudits must use timeout-enabled path and standard response handling
test('listAudits uses timeout and hits /api/audits with limit/offset', async () => {
  let capturedUrl = ''
  let capturedSignal: AbortSignal | undefined
  const payload = [{ id: 'a1', filename: 'doc.docx', weighted_score: 85, status: 'completed', created_at: '2026-08-25T00:00:00Z' }]
  const restore = mockFetchOnce(async (input, init) => {
    capturedUrl = typeof input === 'string' ? input : String(input)
    capturedSignal = (init as RequestInit)?.signal as AbortSignal | undefined
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  try {
    const list = await api.listAudits(20, 0)
    assert.ok(capturedUrl.includes('/api/audits?limit=20&offset=0'))
    assert.ok(capturedSignal instanceof AbortSignal)
    assert.deepEqual(list, payload)
  } finally { restore() }
})

test('listAudits propagates non-2xx as error', async () => {
  const restore = mockFetchOnce(async () => new Response(JSON.stringify({ detail: 'db error' }), { status: 500 }))
  try {
    await assert.rejects(() => api.listAudits(10, 5), (err: Error) => {
      assert.match(err.message, /db error|HTTP 500/)
      return true
    })
  } finally { restore() }
})

test('listAudits timeout becomes TimeoutError', async () => {
  const restore = mockFetchOnce(async (_input, init) => {
    const signal = (init as RequestInit)?.signal as AbortSignal | undefined
    return new Promise<Response>((_, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          const e = new Error('aborted')
          ;(e as Error).name = 'AbortError'
          reject(e)
        })
      }
    })
  })
  try {
    await assert.rejects(() => api.listAudits(20, 0), (err: Error) => {
      assert.equal(err.name, 'TimeoutError')
      return true
    })
  } finally { restore() }
})

test('listAudits successful audit-history response parses correctly', async () => {
  const historyPayload = [
    { id: '1', filename: 'a.docx', weighted_score: null, status: 'completed', created_at: null },
    { id: '2', filename: 'b.docx', weighted_score: 0, status: 'completed', created_at: '2026-08-25T00:00:00Z' },
    { id: '3', filename: 'c.docx', weighted_score: 92, status: 'completed', created_at: '2026-08-25T00:00:00Z' },
  ]
  const restore = mockFetchOnce(async () => new Response(JSON.stringify(historyPayload), { status: 200 }))
  try {
    const list = await api.listAudits(25, 0)
    assert.equal(list.length, 3)
    assert.equal(list[0].weighted_score, null)
    assert.equal(list[1].weighted_score, 0)
    assert.equal(list[2].weighted_score, 92)
  } finally { restore() }
})


// ---------------------------------------------------------------------------
// REVIEW severity (manual review) — real adapter behaviour
// ---------------------------------------------------------------------------

test('adapter keeps REVIEW findings visible but out of the major/minor counts', async () => {
  const { adaptAuditResponse } = await import('../src/lib/audit/adapter.ts')
  const raw = {
    status: 'completed',
    audit_id: 'audit-review-1',
    weighted_compliance_score: 95,
    physical_layout_errors: [
      {
        id: 'v-major',
        rule_code: 'CITATION_MISMATCH',
        severity: 'MAJOR',
        location: { paragraph_index: 3, occurrences: 1, paragraph_indexes: [3] },
        message: 'm',
        expected_value: 'Reference entry for Smith',
        actual_value: '(Smith, 2020)',
      },
      {
        id: 'v-review',
        rule_code: 'CITATION_REFERENCE_AMBIGUOUS',
        severity: 'REVIEW',
        location: { paragraph_index: 7, occurrences: 1, paragraph_indexes: [7] },
        message: 'm',
        expected_value: 'One unambiguous matching entry',
        actual_value: '(Smith, 2024)',
      },
    ],
    ai_citation_tooltips: [],
  } as Parameters<typeof adaptAuditResponse>[0]['raw']

  const result = adaptAuditResponse({ raw })
  assert.equal(result.physical_layout_errors.length, 2)
  assert.equal(result.physical_layout_errors[1].severity, 'review')
  assert.equal(result.physical_layout_errors[1].title, 'Citation could match more than one entry')
  // Counts fall back to the deterministic findings and exclude review.
  assert.equal(result.major_count, 1)
  assert.equal(result.minor_count, 0)
})

test('adapter retains geometry-free page-element reviews without scored categories', () => {
  const codes = ['HEADER_CONTENT_REQUIRED', 'FOOTER_CONTENT_REQUIRED', 'PAGE_NUMBER_FIELD_REQUIRED']
  const action = 'In Word, review Section 1 · Header · Normal pages against your Custom Profile and add the required content if needed. Verify the rendered document manually.'
  const raw = {
    status: 'completed',
    audit_id: 'structural-review',
    weighted_compliance_score: 100,
    physical_layout_errors: codes.map((rule_code, index) => ({
      id: `structural-${index}`, rule_code, severity: 'REVIEW',
      location: { structural_story: true, section_index: 0, story_type: 'header', story_variant: 'default', evidence_state: 'missing' },
      message: action,
      expected_value: "Text or a supported field in each section's Normal-pages Header definition",
      actual_value: 'No effective Normal-pages Header definition',
    })),
    ai_citation_tooltips: [],
  } as Parameters<typeof adaptAuditResponse>[0]['raw']
  const result = adaptAuditResponse({ raw })
  assert.equal(result.physical_layout_errors.length, 3)
  for (const finding of result.physical_layout_errors) {
    assert.equal(finding.category, null)
    assert.equal(finding.severity, 'review')
    assert.equal(finding.position, 0)
    assert.equal(finding.snippet, undefined)
    assert.match(finding.suggestion, /^In Word, check this section’s /)
    assert.match(finding.suggestion, /Verify the rendered document manually\.$/)
    assert.doesNotMatch(finding.detail, /effective Normal-pages|Custom Profile|definition/)
  }
  assert.equal(result.physical_layout_errors.filter(finding => finding.category === 'page_margins').length, 0)
  assert.equal(result.major_count, 0)
  assert.equal(result.minor_count, 0)
})
