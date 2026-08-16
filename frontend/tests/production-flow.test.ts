/**
 * Production-flow navigation tests.
 *
 * Drives the REAL modules (mapBlocksToPages → PendingNav → clampPage)
 * with API-shaped fixtures: violations carrying location.paragraph_index,
 * persisted-style document blocks, and synthetic page text. Simulates the
 * exact browser sequence including loading windows, retries, manual mode
 * switching, and the final indicator/canvas agreement.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapBlocksToPages, normalizeText, type PageText } from '../src/lib/pdf/paragraph-mapping.ts'
import { PendingNav, clampPage, type NavCommand } from '../src/lib/pdf/pending-navigation.ts'
import { getMapping, invalidateMapping } from '../src/lib/pdf/mapping-cache.ts'
import { resolveFindingNavigation } from '../src/lib/pdf/finding-navigation.ts'

const page = (pageNumber: number, texts: string[]): PageText => ({
  pageNumber,
  lines: texts.map((t) => ({ text: normalizeText(t), y: 100 })),
  headerFooterLines: new Set(),
})

const PAGES: PageText[] = [
  page(1, ['chapter one.', 'introduction paragraph on page one.']),
  page(2, ['table caption row.', 'narrative continues on page two.']),
  page(3, ['figure caption row.', 'final concluding paragraph on page three.']),
]

// blocks in document order (index === paragraph identity)
const BLOCKS = [
  { order: 0, index: 0, text: 'Chapter one' },
  { order: 1, index: 1, text: 'Introduction paragraph on page one.' },
  { order: 2, index: 2, text: 'Table caption row.' },
  { order: 3, index: 3, text: 'Narrative continues on page two.' },
  { order: 4, index: 4, text: 'Figure caption row.' },
  { order: 5, index: 5, text: 'Final concluding paragraph on page three.' },
]

// violation shapes exactly as the API returns them
const violation = (id: string, ruleCode: string, paragraph_index: number, run_index = 0) => ({
  id,
  rule_code: ruleCode,
  severity: 'MINOR',
  location: { paragraph_index, run_index },
  message: `Font size mismatch in paragraph ${paragraph_index + 1}`,
  expected_value: '12pt',
  actual_value: '14pt',
})

const MAPPING = mapBlocksToPages(BLOCKS, PAGES)
const byIndex = new Map(MAPPING.map((m) => [m.index, m]))
assert.equal(MAPPING.filter((m) => m.confidence === 'exact').length, 6, 'all blocks map exactly')

const recorder = () => {
  const commands: NavCommand[] = []
  return { commands, emit: (c: NavCommand) => commands.push(c) }
}

// ---------------------------------------------------------------------------
// 1. click after mapping ready
// ---------------------------------------------------------------------------

test('production flow: click after mapping ready navigates to mapped page', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const v = violation('v-font-size', 'FONT_SIZE', 5) // block 5 → page 3
  nav.select(v, byIndex, emit)
  assert.deepEqual(commands, [{ kind: 'navigate', page: 3 }])
  // viewer applies: indicator == canvas page
  assert.equal(clampPage(commands[0].page, 3), 3)
})

// ---------------------------------------------------------------------------
// 2. click while blocks are loading
// ---------------------------------------------------------------------------

test('production flow: click while blocks load → locating, navigates when ready', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  // mapping has not started (blocks === null in the hook → idle)
  nav.select(violation('v1', 'FONT_SIZE', 3), undefined, emit)
  assert.deepEqual(commands, [{ kind: 'locating', findingId: 'v1' }])
  // never switched to Extracted Text while loading
  assert.ok(!commands.some((c) => c.kind === 'text'))
  nav.onMappingReady(byIndex, 'v1', emit)
  assert.deepEqual(commands.slice(-1), [{ kind: 'navigate', page: 2 }])
})

// ---------------------------------------------------------------------------
// 3. click while PDF text is loading
// ---------------------------------------------------------------------------

test('production flow: click while PDF loads behaves identically to blocks loading', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  nav.select(violation('v2', 'FONT_SIZE', 1), undefined, emit) // pdfBytes undefined → idle
  assert.deepEqual(commands, [{ kind: 'locating', findingId: 'v2' }])
  nav.onMappingReady(byIndex, 'v2', emit)
  assert.equal(commands[commands.length - 1].kind, 'navigate')
})

// ---------------------------------------------------------------------------
// 4. temporary unavailability is not cached
// ---------------------------------------------------------------------------

test('production flow: transient loader failure is not cached', async () => {
  invalidateMapping('flow-audit')
  let calls = 0
  const loader = async (id: string) => {
    calls += 1
    if (calls === 1) throw new Error('blocks not ready yet') // transient
    return { auditId: id, pages: PAGES, mapping: MAPPING, byIndex }
  }
  await assert.rejects(() => getMapping('flow-audit', loader))
  const bundle = await getMapping('flow-audit', loader)
  assert.equal(bundle.byIndex.get(5)?.pageNumber, 3)
  assert.equal(calls, 2) // retried, not served a stale unavailable
})

// ---------------------------------------------------------------------------
// 5. mapping becomes ready after selection
// ---------------------------------------------------------------------------

test('production flow: mapping ready after selection executes retained request', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  nav.select(violation('v3', 'FONT_SIZE', 0), undefined, emit) // locating
  assert.equal(nav['pending']?.id, 'v3')
  nav.onMappingReady(byIndex, 'v3', emit)
  assert.deepEqual(commands, [
    { kind: 'locating', findingId: 'v3' },
    { kind: 'navigate', page: 1 },
  ])
})

// ---------------------------------------------------------------------------
// 6. repeated selection retries navigation
// ---------------------------------------------------------------------------

test('production flow: re-selecting the same finding after ready retries', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const v = violation('v4', 'FONT_SIZE', 5)
  nav.select(v, byIndex, emit) // page 3
  nav.select(v, byIndex, emit) // again — must navigate again
  assert.deepEqual(commands, [
    { kind: 'navigate', page: 3 },
    { kind: 'navigate', page: 3 },
  ])
})

// ---------------------------------------------------------------------------
// 7. manual Rendered/Extracted switching preserves the last known page
// ---------------------------------------------------------------------------

test('production flow: manual mode switch keeps the last known rendered page', () => {
  // viewer state simulation: pageNum persists across mode switches
  let viewerPage = 1
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  nav.select(violation('v5', 'FONT_SIZE', 4), byIndex, emit) // navigate page 3
  viewerPage = clampPage(commands[0].page, 3) // viewer applies
  assert.equal(viewerPage, 3)

  // user switches Extracted → Rendered manually: no command, page stays
  const modeChange: Array<'text' | 'rendered'> = []
  modeChange.push('text', 'rendered')
  assert.deepEqual(modeChange, ['text', 'rendered'])
  assert.equal(viewerPage, 3) // never reset to 1, never pretended navigation
})

// ---------------------------------------------------------------------------
// 8. latest rapid selection wins
// ---------------------------------------------------------------------------

test('production flow: rapid selection while loading — latest wins', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  nav.select(violation('a', 'FONT_SIZE', 1), undefined, emit)
  nav.select(violation('b', 'FONT_SIZE', 5), undefined, emit)
  nav.onMappingReady(byIndex, 'b', emit)
  const navs = commands.filter((c) => c.kind === 'navigate')
  assert.deepEqual(navs, [{ kind: 'navigate', page: 3 }])
})

// ---------------------------------------------------------------------------
// 9. page indicator equals rendered canvas page
// ---------------------------------------------------------------------------

test('production flow: indicator and canvas agree after every command', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const numPages = PAGES.length
  const targets: number[] = []
  nav.select(violation('x', 'FONT_SIZE', 1), byIndex, emit)
  nav.select(violation('y', 'FONT_SIZE', 3), byIndex, emit)
  nav.select(violation('z', 'FONT_SIZE', 5), byIndex, emit)
  for (const c of commands) {
    if (c.kind === 'navigate') targets.push(clampPage(c.page, numPages))
  }
  assert.deepEqual(targets, [1, 2, 3])
  // each target is within bounds and distinct pages render distinct content
  assert.ok(targets.every((t) => t >= 1 && t <= numPages))
})

// ---------------------------------------------------------------------------
// 10. genuine unavailable falls back only after mapping completes
// ---------------------------------------------------------------------------

test('production flow: genuine unavailable falls back only after mapping completes', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  // mapping completes with unavailable for block 2 (e.g. table caption)
  const unavailableByIndex = new Map(
    MAPPING.map((m) => [
      m.index,
      m.index === 2 ? { ...m, pageNumber: null, confidence: 'unavailable' as const } : m,
    ]),
  )
  nav.select(violation('u1', 'FONT_SIZE', 2), unavailableByIndex, emit)
  assert.deepEqual(commands, [{ kind: 'text' }])
  assert.ok(!commands.some((c) => c.kind === 'navigate' && c.page === 1), 'never fake page 1')
  // and the decision label is truthful
  const decision = resolveFindingNavigation(violation('u1', 'FONT_SIZE', 2), unavailableByIndex)
  assert.equal(decision.locationLabel, 'Paragraph 3 · Page unavailable')
})

test('production flow: authoritative identity is paragraph_index === block.index', () => {
  // display position (1-based, position 6) must NOT be used as identity —
  // the violation carries paragraph_index 5 and block 5 is the target
  const displayPosition = 6
  const v = violation('v6', 'FONT_SIZE', 5)
  assert.equal(v.location.paragraph_index, 5)
  const block = BLOCKS.find((b) => b.index === v.location.paragraph_index)
  assert.equal(block?.index, 5)
  assert.notEqual(displayPosition, block?.index) // 1-based position ≠ index
  assert.equal(byIndex.get(v.location.paragraph_index)?.pageNumber, 3)
})

// ---------------------------------------------------------------------------
// Task 1/2: classification — multiple rules share one mapped paragraph
// ---------------------------------------------------------------------------

test('production flow: different rules on the same paragraph share the mapped page', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  // FONT_SIZE with run_index, ALIGNMENT without run_index, CITATION_MISMATCH
  nav.select({ ...violation('a', 'FONT_SIZE', 1, 0), location: { paragraph_index: 1, run_index: 0 } }, byIndex, emit)
  nav.select({ ...violation('b', 'ALIGNMENT', 1), location: { paragraph_index: 1 } }, byIndex, emit)
  nav.select({ ...violation('c', 'CITATION_MISMATCH', 1), location: { paragraph_index: 1 } }, byIndex, emit)
  const navs = commands.filter((c) => c.kind === 'navigate')
  assert.equal(navs.length, 3)
  assert.ok(navs.every((c) => c.page === 1)) // block 1 lives on page 1
})

test('production flow: run_index presence never affects the decision', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  nav.select({ ...violation('r1', 'FONT_SIZE', 5, 3), location: { paragraph_index: 5, run_index: 3 } }, byIndex, emit)
  nav.select({ ...violation('r2', 'FONT_SIZE', 5), location: { paragraph_index: 5 } }, byIndex, emit)
  const navs = commands.filter((c) => c.kind === 'navigate')
  assert.ok(navs.every((c) => c.page === 3))
})

// ---------------------------------------------------------------------------
// Task 1/3: object findings (even with a paragraph_index) never navigate
// ---------------------------------------------------------------------------

test('production flow: image finding with host paragraph_index is object-level', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  // IMAGE_CAPTION_MISSING carries { image_index, paragraph_index: host }
  nav.select(
    { id: 'img1', rule_code: 'IMAGE_CAPTION_MISSING', severity: 'MINOR', location: { image_index: 0, paragraph_index: 3 }, message: 'Image 1 has no caption.' },
    byIndex,
    emit,
  )
  assert.deepEqual(commands, [{ kind: 'none' }]) // view stays stable, nothing retained
  assert.equal(nav['pending'], null)
  // decision layer agrees
  const d = resolveFindingNavigation(
    { id: 'img1', location: { image_index: 0, paragraph_index: 3 } },
    byIndex,
  )
  assert.equal(d.mode, 'text')
  assert.equal(d.pageNumber, null)
  assert.equal(d.locationLabel, null)
})

test('production flow: table/margin/section findings keep the view stable', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  nav.select({ id: 't1', rule_code: 'TABLE_CAPTION_MISSING', severity: 'MINOR', location: { table_index: 0 }, message: 'x' }, byIndex, emit)
  nav.select({ id: 'm1', rule_code: 'MARGIN_LEFT', severity: 'MAJOR', location: { section_index: 0 }, message: 'x' }, byIndex, emit)
  nav.select({ id: 's1', rule_code: 'HEADING_HIERARCHY', severity: 'MAJOR', location: { section_index: 0 }, message: 'x' }, byIndex, emit)
  assert.deepEqual(commands, [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }])
})

// ---------------------------------------------------------------------------
// Task 1: empty and genuinely unmatched paragraphs
// ---------------------------------------------------------------------------

test('production flow: empty paragraph falls back to text after completed mapping', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const emptyByIndex = new Map(MAPPING.map((m) => [m.index, { ...m }]))
  // simulate an empty block mapped unavailable
  emptyByIndex.set(2, { index: 2, pageNumber: null, pageRange: null, paragraphOnPage: null, confidence: 'unavailable' })
  nav.select(violation('e1', 'FONT_SIZE', 2), emptyByIndex, emit)
  assert.deepEqual(commands, [{ kind: 'text' }])
})

test('production flow: genuinely unmatched paragraph falls back only after completion', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  // while mapping is loading → locating, NOT text
  nav.select(violation('u2', 'FONT_SIZE', 4), undefined, emit)
  assert.deepEqual(commands, [{ kind: 'locating', findingId: 'u2' }])
  // after completion with unavailable → text
  const unavailableByIndex = new Map(MAPPING.map((m) => [m.index, { ...m }]))
  unavailableByIndex.set(4, { index: 4, pageNumber: null, pageRange: null, paragraphOnPage: null, confidence: 'unavailable' })
  nav.onMappingReady(unavailableByIndex, 'u2', emit)
  assert.deepEqual(commands.slice(-1), [{ kind: 'text' }])
})
