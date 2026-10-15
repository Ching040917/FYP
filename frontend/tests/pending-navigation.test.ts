/**
 * Integration-level navigation state tests (pending-navigation + decision
 * chain, without React). Simulates the production interaction sequence:
 * selection → mapping availability → command emission → clamped page.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingNav, PageCommandConsumer, clampPage, hasParagraphIdentity } from '../src/lib/pdf/pending-navigation.ts'
import type { NavCommand } from '../src/lib/pdf/pending-navigation.ts'
import type { BlockMapping } from '../src/lib/pdf/paragraph-mapping.ts'

const mapping = (index: number, pageNumber: number | null, confidence: BlockMapping['confidence'], paragraphOnPage: number | null = null): BlockMapping => ({
  index,
  pageNumber,
  pageRange: null,
  paragraphOnPage,
  confidence,
})

const finding = (id: string, location?: Record<string, unknown> | null) => ({ id, location })

function recorder() {
  const commands: NavCommand[] = []
  return {
    commands,
    emit: (c: NavCommand) => commands.push(c),
  }
}

// ---------------------------------------------------------------------------
// click after mapping ready
// ---------------------------------------------------------------------------

test('click after mapping ready navigates immediately', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const byIndex = new Map([[3, mapping(3, 2, 'exact', 4)]])
  nav.select(finding('f1', { paragraph_index: 3 }), byIndex, emit)
  assert.deepEqual(commands, [{ kind: 'navigate', page: 2 }])
})

// ---------------------------------------------------------------------------
// click before PDF/mapping ready
// ---------------------------------------------------------------------------

test('click before mapping ready is retained and executed on readiness', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  nav.select(finding('f1', { paragraph_index: 3 }), null, emit) // mapping loading
  assert.deepEqual(commands, [{ kind: 'locating', findingId: 'f1' }])
  assert.equal(nav['pending']?.id, 'f1')

  const byIndex = new Map([[3, mapping(3, 4, 'exact', 1)]])
  nav.onMappingReady(byIndex, 'f1', emit)
  assert.deepEqual(commands, [{ kind: 'locating', findingId: 'f1' }, { kind: 'navigate', page: 4 }])
})

test('click before mapping ready, then mapping fails → text fallback', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  nav.select(finding('f1', { paragraph_index: 3 }), null, emit)
  nav.onMappingFailed('f1', emit)
  assert.deepEqual(commands, [{ kind: 'locating', findingId: 'f1' }, { kind: 'text' }])
})

// ---------------------------------------------------------------------------
// mode switching: extracted text → rendered pages
// ---------------------------------------------------------------------------

test('switching from extracted text to rendered pages emits navigate', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const byIndex = new Map([[0, mapping(0, null, 'unavailable')]])
  nav.select(finding('a', { paragraph_index: 0 }), byIndex, emit) // unavailable → text
  assert.deepEqual(commands, [{ kind: 'text' }])

  nav.select(finding('b', { paragraph_index: 5 }), new Map([[5, mapping(5, 3, 'exact', 1)]]), emit)
  assert.deepEqual(commands, [{ kind: 'text' }, { kind: 'navigate', page: 3 }])
})

// ---------------------------------------------------------------------------
// cross-page finding selection
// ---------------------------------------------------------------------------

test('cross-page finding navigates to its start page', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const byIndex = new Map([[7, { index: 7, pageNumber: 3, pageRange: [3, 5] as [number, number], paragraphOnPage: 1, confidence: 'exact' as const }]])
  nav.select(finding('f1', { paragraph_index: 7 }), byIndex, emit)
  assert.deepEqual(commands, [{ kind: 'navigate', page: 3 }])
})

// ---------------------------------------------------------------------------
// rapid selection — latest command wins
// ---------------------------------------------------------------------------

test('rapid selection while loading: latest pending wins', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  nav.select(finding('old', { paragraph_index: 1 }), null, emit)
  nav.select(finding('new', { paragraph_index: 2 }), null, emit) // overwrites pending
  const byIndex = new Map([
    [1, mapping(1, 9, 'exact', 1)],
    [2, mapping(2, 5, 'exact', 1)],
  ])
  nav.onMappingReady(byIndex, 'new', emit)
  assert.deepEqual(commands, [
    { kind: 'locating', findingId: 'old' },
    { kind: 'locating', findingId: 'new' },
    { kind: 'navigate', page: 5 },
  ])
})

test('rapid selection after mapping ready: each selection navigates', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const byIndex = new Map([
    [1, mapping(1, 2, 'exact', 1)],
    [2, mapping(2, 3, 'exact', 1)],
  ])
  nav.select(finding('a', { paragraph_index: 1 }), byIndex, emit)
  nav.select(finding('b', { paragraph_index: 2 }), byIndex, emit)
  assert.deepEqual(commands, [
    { kind: 'navigate', page: 2 },
    { kind: 'navigate', page: 3 },
  ])
})

// ---------------------------------------------------------------------------
// stale audit command ignored
// ---------------------------------------------------------------------------

test('stale audit request is discarded on reset and on selection mismatch', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  nav.select(finding('f1', { paragraph_index: 1 }), null, emit)
  nav.reset() // audit changed
  nav.onMappingReady(new Map([[1, mapping(1, 4, 'exact', 1)]]), 'f1', emit)
  assert.deepEqual(commands, [{ kind: 'locating', findingId: 'f1' }]) // never navigated

  // selection moved on while pending
  const nav2 = new PendingNav()
  const r2 = recorder()
  nav2.select(finding('f1', { paragraph_index: 1 }), null, r2.emit)
  nav2.onMappingReady(new Map([[1, mapping(1, 4, 'exact', 1)]]), 'other-finding', r2.emit)
  assert.deepEqual(r2.commands, [{ kind: 'locating', findingId: 'f1' }])
})

// ---------------------------------------------------------------------------
// unavailable mapping → text fallback, never page 1
// ---------------------------------------------------------------------------

test('unavailable mapping falls back to text, never navigates to page 1', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const byIndex = new Map([[4, mapping(4, null, 'unavailable')]])
  nav.select(finding('f1', { paragraph_index: 4 }), byIndex, emit)
  assert.deepEqual(commands, [{ kind: 'text' }])
  assert.ok(!commands.some((c) => c.kind === 'navigate'))
})

test('empty paragraph finding falls back to text', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const byIndex = new Map([[0, mapping(0, null, 'unavailable')]])
  nav.select(finding('f1', { paragraph_index: 0 }), byIndex, emit)
  assert.deepEqual(commands, [{ kind: 'text' }])
})

// ---------------------------------------------------------------------------
// page indicator and rendered page agree
// ---------------------------------------------------------------------------

test('clampPage bounds the command to the rendered document', () => {
  assert.equal(clampPage(1, 6), 1)
  assert.equal(clampPage(6, 6), 6)
  assert.equal(clampPage(9, 6), 6) // beyond last page clamps
  assert.equal(clampPage(0, 6), 1)
  assert.equal(clampPage(-3, 6), 1)
  assert.equal(clampPage(NaN, 6), 1)
  assert.equal(clampPage(2.4, 6), 2)
})

test('hasParagraphIdentity is exact about location shape', () => {
  assert.equal(hasParagraphIdentity(finding('a', { paragraph_index: 0 })), true)
  assert.equal(hasParagraphIdentity(finding('a', { paragraph_index: -1 })), false)
  assert.equal(hasParagraphIdentity(finding('a', { table_index: 2 })), false)
  assert.equal(hasParagraphIdentity(finding('a', null)), false)
  assert.equal(hasParagraphIdentity(finding('a')), false)
})

test('non-paragraph finding never emits navigation', () => {
  const nav = new PendingNav()
  const { commands, emit } = recorder()
  const byIndex = new Map([[0, mapping(0, 1, 'exact', 1)]])
  nav.select(finding('t1', { table_index: 1 }), byIndex, emit)
  nav.select(finding('s1', { section_index: 0 }), byIndex, emit)
  nav.select(finding('m1', { margin: 'left' }), byIndex, emit)
  assert.deepEqual(commands, [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }])
})

test('structural selection cancels pending body navigation before delayed success or failure', () => {
  for (const story_type of ['header', 'footer', 'either']) {
    const nav = new PendingNav()
    const { commands, emit } = recorder()
    const structural = finding('story', {
      structural_story: true,
      section_index: 0,
      story_type,
      story_variant: 'default',
      evidence_state: 'unresolved',
      paragraph_index: 3,
    })
    nav.select(finding('body', { paragraph_index: 3 }), null, emit)
    nav.select(structural, null, emit)
    assert.equal(hasParagraphIdentity(structural), false)
    assert.equal(nav['pending'], null)
    assert.deepEqual(commands, [
      { kind: 'locating', findingId: 'body' },
      { kind: 'preserve' },
    ])
    // Even a delayed callback carrying the OLD selected id must stay inert.
    nav.onMappingReady(new Map([[3, mapping(3, 8, 'exact', 1)]]), 'body', emit)
    nav.onMappingFailed('body', emit)
    assert.equal(commands.length, 2, 'late body evidence must not navigate or switch to text')
  }
})

test('structural selection clears outstanding page commands without moving the current view', () => {
  for (const mode of ['rendered', 'text'] as const) {
    const nav = new PendingNav()
    const consumer = new PageCommandConsumer()
    let currentPage = 5
    let previewMode: 'rendered' | 'text' = mode
    let command: { page: number; seq: number } | null = { page: 2, seq: 1 }
    let seq = 1
    let locatingId: string | null = 'body'
    let notice: string | null = 'Locating finding…'
    const emit = (c: NavCommand) => {
      if (c.kind === 'preserve') {
        command = null
        locatingId = null
        notice = null
      } else if (c.kind === 'navigate') {
        command = { page: c.page, seq: ++seq }
        previewMode = 'rendered'
      } else if (c.kind === 'text') {
        previewMode = 'text'
      }
    }
    nav.select(finding('story', {
      structural_story: true,
      section_index: 1,
      story_type: 'footer',
      story_variant: 'default',
      evidence_state: 'empty',
    }), null, emit)
    const structuralPage = consumer.consume(command, 10)
    if (structuralPage !== null) currentPage = structuralPage
    assert.equal(command, null)
    assert.equal(locatingId, null)
    assert.equal(notice, null)
    assert.equal(currentPage, 5)
    assert.equal(previewMode, mode)

    nav.select(finding('next-body', { paragraph_index: 2 }), new Map([[2, mapping(2, 7, 'exact', 1)]]), emit)
    assert.equal(consumer.consume(command, 10), 7)
    assert.equal(previewMode, 'rendered')
  }
})
