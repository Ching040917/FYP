import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { api, TimeoutError } from '../src/services/api.ts'
import { createRequire } from 'node:module'
const requireNode = createRequire(import.meta.url)

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

// vite proxy contract: /health must be proxied in dev
test('vite config proxies /health to backend', () => {
  const src = requireNode('fs').readFileSync(requireNode('path').join(process.cwd(), 'vite.config.ts'), 'utf8')
  assert.ok(src.includes("'/health'") || src.includes('"/health"'), 'vite.config.ts should proxy /health')
  assert.ok(src.includes('127.0.0.1:8000'), 'proxy target should be 127.0.0.1:8000')
})
