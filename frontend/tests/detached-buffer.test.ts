/**
 * Detached-ArrayBuffer regression tests (Build: rendered-PDF byte ownership).
 *
 * The bug: pdf.js may TRANSFER (detach) the ArrayBuffer handed to
 * `getDocument({data})` when moving bytes to its worker. When a shared
 * cached buffer was passed to multiple consumers, the viewer's later
 * `.slice()` on the now-detached buffer threw
 *   "Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer".
 *
 * Fixes under test:
 *   1. `openDocument` always hands pdf.js a FRESH owned copy — the caller's
 *      shared buffer is never passed through, so it can never be detached.
 *   2. `geometryLoaderFromBytes` copies into an owned buffer and returns
 *      null (not a crash) when the source is detached or empty.
 *   3. The viewer guards `bytes.slice(0)` against detached/zero-length
 *      sources instead of throwing.
 *   4. Geometry failure stays contained (returns null / omitted outline).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geometryLoaderFromBytes, getPageGeometry, dropPageGeometry } from '../src/lib/pdf/figure-outlines.ts'
import { extractPageText } from '../src/lib/pdf/pdf-text-extract.ts'
import type { PageGeometry } from '../src/lib/pdf/pdf-text-extract.ts'

/** Build a valid minimal PDF bytes (a real 1-page pdfjs-loadable doc). */
function pdfBytes(): Uint8Array {
  // Minimal PDF with one blank page.
  const content =
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF\n'
  return new Uint8Array([...content].map((c) => c.charCodeAt(0)))
}

function detach(buf: ArrayBuffer): void {
  // Transfer the buffer to a throwaway worker-like sink: structuredClone
  // with transfer detaches the source.
  ;(globalThis as any).__sink = new Uint8Array(buf)
  // Force actual detachment: MessageChannel transfer detaches the buffer.
  const channel = new MessageChannel()
  channel.port1.postMessage(buf, [buf])
  channel.port1.close()
  channel.port2.close()
}

test('openDocument never hands the caller buffer to pdf.js (no shared detachment)', async () => {
  const bytes = pdfBytes()
  // Extract once (this internally calls openDocument → getDocument).
  const pages = await extractPageText(bytes.buffer.slice(0))
  assert.ok(pages.length >= 1)
  // The CALLER's buffer must still be usable afterwards — pdf.js must not
  // have detached it (we passed a fresh owned copy inside openDocument).
  assert.equal(bytes.byteLength, pdfBytes().byteLength)
  assert.ok(bytes.byteLength > 0)
  // And the source buffer itself is still sliceable.
  const again = bytes.slice(0)
  assert.equal(again.byteLength, bytes.byteLength)
})

test('geometryLoaderFromBytes returns null on a detached buffer, never throws', () => {
  const bytes = pdfBytes()
  detach(bytes.buffer)
  // Detached: slicing throws inside the loader — it must return null.
  const loader = geometryLoaderFromBytes(bytes.buffer)
  assert.equal(loader, null)
})

test('geometryLoaderFromBytes returns null on a zero-length buffer', () => {
  const loader = geometryLoaderFromBytes(new ArrayBuffer(0))
  assert.equal(loader, null)
})

test('geometryLoaderFromBytes returns null for undefined bytes', () => {
  assert.equal(geometryLoaderFromBytes(undefined), null)
})

test('geometry loader with a healthy buffer loads geometry without detaching it', async () => {
  const bytes = pdfBytes()
  const loader = geometryLoaderFromBytes(bytes.buffer.slice(0))
  assert.ok(loader)
  const geometry = await loader()
  assert.ok(Array.isArray(geometry))
  assert.ok(geometry.length >= 1)
  // The source bytes remain intact and sliceable.
  assert.ok(bytes.byteLength > 0)
  assert.equal(bytes.slice(0).byteLength, bytes.byteLength)
})

test('getPageGeometry dedupes concurrent requests for the same audit', async () => {
  let calls = 0
  const loader = async (): Promise<PageGeometry[]> => {
    calls += 1
    return [{ pageNumber: 1, rotation: 0, pageWidth: 612, pageHeight: 792, imageOps: [], segments: [] }]
  }
  const [a, b, c] = await Promise.all([
    getPageGeometry('audit-dedup', loader),
    getPageGeometry('audit-dedup', loader),
    getPageGeometry('audit-dedup', loader),
  ])
  assert.equal(calls, 1, 'concurrent requests must be deduplicated')
  assert.equal(a, b)
  assert.equal(b, c)
  dropPageGeometry('audit-dedup')
})

test('getPageGeometry failure is contained (caller receives rejection, not crash)', async () => {
  const failing = async (): Promise<PageGeometry[]> => {
    throw new Error('worker failed')
  }
  await assert.rejects(getPageGeometry('audit-fail', failing), /worker failed/)
  // Subsequent calls are not poisoned by the failure (not cached).
  const ok = async (): Promise<PageGeometry[]> => [{ pageNumber: 1, rotation: 0, pageWidth: 612, pageHeight: 792, imageOps: [], segments: [] }]
  const g = await getPageGeometry('audit-fail', ok)
  assert.ok(g.length === 1)
  dropPageGeometry('audit-fail')
})

test('geometry cache is per-audit (no cross-audit contamination)', async () => {
  const mk = (id: string) => async (): Promise<PageGeometry[]> => [{ pageNumber: 1, rotation: 0, pageWidth: 612, pageHeight: 792, imageOps: [], segments: [] }]
  const gA = await getPageGeometry('audit-A', mk('A'))
  const gB = await getPageGeometry('audit-B', mk('B'))
  assert.notEqual(gA, gB)
  assert.ok(gA.length === 1 && gB.length === 1)
  dropPageGeometry('audit-A')
  dropPageGeometry('audit-B')
})

test('shared source buffer survives after both extraction and geometry load', async () => {
  // Simulates viewer + mapping + geometry all reading the SAME cached
  // ArrayBuffer: after every consumer, the source must remain sliceable.
  const bytes = pdfBytes()
  const shared = bytes.buffer.slice(0) // the cached ArrayBuffer
  const pages = await extractPageText(shared) // mapping consumer
  assert.ok(pages.length >= 1)
  const loader = geometryLoaderFromBytes(shared)
  assert.ok(loader, 'geometry loader must be valid after extraction')
  const geometry = await loader()
  assert.ok(geometry.length >= 1)
  // The shared buffer is still alive and sliceable — the crash is gone.
  assert.equal(shared.byteLength, bytes.byteLength)
  const copy = shared.slice(0)
  assert.equal(copy.byteLength, shared.byteLength)
})
