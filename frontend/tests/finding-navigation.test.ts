/**
 * Finding-to-page navigation tests.
 *
 * Pure logic: resolveFindingNavigation decisions + mapping-cache semantics
 * (dedupe, invalidation, failure retry, staleness safety). The React hook
 * itself is a thin generation-counter wrapper — the parts that can break
 * are all here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFindingNavigation, isNavigable } from '../src/lib/pdf/finding-navigation.ts'
import { getMapping, invalidateMapping } from '../src/lib/pdf/mapping-cache.ts'
import type { BlockMapping } from '../src/lib/pdf/paragraph-mapping.ts'

const mapping = (index: number, pageNumber: number | null, confidence: BlockMapping['confidence'], paragraphOnPage: number | null = null): BlockMapping => ({
  index,
  pageNumber,
  pageRange: null,
  paragraphOnPage,
  confidence,
})

const finding = (id: string, location?: Record<string, unknown> | null) => ({ id, location })

// ---------------------------------------------------------------------------
// decision logic
// ---------------------------------------------------------------------------

test('exact mapped finding navigates to rendered page with label', () => {
  const byIndex = new Map([[4, mapping(4, 2, 'exact', 4)]])
  const d = resolveFindingNavigation(finding('f1', { paragraph_index: 4 }), byIndex)
  assert.equal(d.mode, 'rendered')
  assert.equal(d.pageNumber, 2)
  assert.equal(d.locationLabel, 'Page 2 · Paragraph 4')
})

test('approximate mapping navigates but never claims exactness', () => {
  const byIndex = new Map([[1, mapping(1, 3, 'approximate', 2)]])
  const d = resolveFindingNavigation(finding('f2', { paragraph_index: 1 }), byIndex)
  assert.equal(d.mode, 'rendered')
  assert.equal(d.pageNumber, 3)
  assert.equal(d.locationLabel, 'Page 3 · Paragraph 2')
  assert.ok(!d.locationLabel!.includes('approximate'))
})

test('unavailable mapping stays in extracted text with truthful label', () => {
  const byIndex = new Map([[2, mapping(2, null, 'unavailable')]])
  const d = resolveFindingNavigation(finding('f3', { paragraph_index: 2 }), byIndex)
  assert.equal(d.mode, 'text')
  assert.equal(d.pageNumber, null)
  assert.equal(d.locationLabel, 'Paragraph 3 · Page unavailable')
})

test('empty paragraph never guesses a page', () => {
  // mapper reports empty blocks as unavailable — decision must stay text
  const byIndex = new Map([[0, mapping(0, null, 'unavailable')]])
  const d = resolveFindingNavigation(finding('f4', { paragraph_index: 0 }), byIndex)
  assert.equal(d.mode, 'text')
  assert.equal(d.pageNumber, null)
})

test('duplicate paragraphs navigate by their own mapping', () => {
  const byIndex = new Map([
    [1, mapping(1, 1, 'exact', 2)], // first instance
    [5, mapping(5, 2, 'exact', 2)], // second instance, different page
  ])
  const d1 = resolveFindingNavigation(finding('a', { paragraph_index: 1 }), byIndex)
  const d2 = resolveFindingNavigation(finding('b', { paragraph_index: 5 }), byIndex)
  assert.equal(d1.pageNumber, 1)
  assert.equal(d2.pageNumber, 2)
  assert.equal(d1.locationLabel, 'Page 1 · Paragraph 2')
})

test('rapid repeated selection is deterministic', () => {
  const byIndex = new Map([[3, mapping(3, 4, 'exact', 1)]])
  const f = finding('f5', { paragraph_index: 3 })
  const a = resolveFindingNavigation(f, byIndex)
  const b = resolveFindingNavigation(f, byIndex)
  assert.deepEqual(a, b)
})

test('table/image/section findings are never forced through mapping', () => {
  const byIndex = new Map([[0, mapping(0, 1, 'exact', 1)]])
  const cases = [
    { table_index: 0 },
    { image_index: 1 },
    { section_index: 0 },
    { margin: 'left' },
    {},
    null,
  ]
  for (const location of cases) {
    const d = resolveFindingNavigation(finding('x', location), byIndex)
    assert.equal(d.mode, 'text', JSON.stringify(location))
    assert.equal(d.pageNumber, null)
    assert.equal(d.locationLabel, null, JSON.stringify(location))
  }
})

test('missing/loading mapping falls back to text without claims', () => {
  const d = resolveFindingNavigation(finding('f6', { paragraph_index: 7 }), undefined)
  assert.equal(d.mode, 'text')
  assert.equal(d.pageNumber, null)
  assert.equal(d.locationLabel, null)
})

test('labels never surface confidence terminology', () => {
  const byIndex = new Map([
    [0, mapping(0, 1, 'exact', 1)],
    [1, mapping(1, null, 'unavailable')],
  ])
  for (const i of [0, 1]) {
    const d = resolveFindingNavigation(finding(`f${i}`, { paragraph_index: i }), byIndex)
    assert.ok(d.locationLabel)
    // "Page unavailable" is required user phrasing; confidence jargon is not.
    assert.ok(!/exact|approximate|confidence|mapping|rated|reliab/i.test(d.locationLabel!))
  }
})

test('isNavigable only for exact and approximate', () => {
  assert.equal(isNavigable('exact'), true)
  assert.equal(isNavigable('approximate'), true)
  assert.equal(isNavigable('unavailable'), false)
  assert.equal(isNavigable(undefined), false)
})

// ---------------------------------------------------------------------------
// mapping cache semantics
// ---------------------------------------------------------------------------

test('cache deduplicates concurrent requests (loader called once)', async () => {
  invalidateMapping('audit-1')
  let calls = 0
  const loader = async (id: string) => {
    calls += 1
    await new Promise((r) => setTimeout(r, 10))
    return { auditId: id, pages: [], mapping: [], byIndex: new Map() }
  }
  const [a, b] = await Promise.all([getMapping('audit-1', loader), getMapping('audit-1', loader)])
  assert.equal(calls, 1)
  assert.equal(a, b)
})

test('cache serves the session copy without re-running the loader', async () => {
  invalidateMapping('audit-2')
  let calls = 0
  const loader = async (id: string) => {
    calls += 1
    return { auditId: id, pages: [], mapping: [], byIndex: new Map() }
  }
  await getMapping('audit-2', loader)
  await getMapping('audit-2', loader)
  assert.equal(calls, 1)
})

test('invalidation forces a fresh computation', async () => {
  invalidateMapping('audit-3')
  let calls = 0
  const loader = async (id: string) => {
    calls += 1
    return { auditId: id, pages: [], mapping: [], byIndex: new Map() }
  }
  await getMapping('audit-3', loader)
  invalidateMapping('audit-3')
  await getMapping('audit-3', loader)
  assert.equal(calls, 2)
})

test('failed loads are not cached and can be retried', async () => {
  invalidateMapping('audit-4')
  let calls = 0
  const loader = async (id: string) => {
    calls += 1
    if (calls === 1) throw new Error('pdf unavailable')
    return { auditId: id, pages: [], mapping: [], byIndex: new Map() }
  }
  await assert.rejects(() => getMapping('audit-4', loader))
  const bundle = await getMapping('audit-4', loader)
  assert.equal(bundle.auditId, 'audit-4')
  assert.equal(calls, 2)
})

test('stale resolutions are identifiable by bundle identity', async () => {
  // A consumer that ignores stale work checks the auditId it requested.
  invalidateMapping('audit-5')
  let resolveFirst: (b: { auditId: string; pages: never[]; mapping: never[]; byIndex: Map<number, never> }) => void
  const gate = new Promise<any>((r) => (resolveFirst = r))
  let calls = 0
  const loader = async (id: string) => {
    calls += 1
    if (calls === 1) return gate.then(() => ({ auditId: id, pages: [], mapping: [], byIndex: new Map() }))
    return { auditId: id, pages: [], mapping: [], byIndex: new Map() }
  }
  const first = getMapping('audit-5', loader)
  invalidateMapping('audit-5')
  const second = getMapping('audit-5', loader)
  resolveFirst!({ auditId: 'audit-5', pages: [], mapping: [], byIndex: new Map() })
  const [r1, r2] = await Promise.all([first, second])
  // both resolve; a stale consumer (generation counter) decides to ignore r1
  assert.equal(r1.auditId, r2.auditId)
  assert.equal(calls, 2)
})
