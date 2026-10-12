/**
 * TABLE_CAPTION_MISSING page resolution — strict same-page contract (A–F).
 *
 * Mirrors backend/tests/test_table_page_resolution.py. The ONLY resolving case
 * is both anchors on the SAME page; a truthful null (unavailable) is always
 * preferred to a guessed page.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveTablePageFromAnchors,
  resolveTablePageFromSurroundings,
  hasPersistedAnchors,
} from '../src/lib/pdf/table-page-resolution.ts'
import type { BlockMapping } from '../src/lib/pdf/paragraph-mapping.ts'

// paragraphs 0,1 -> page 1; 2 -> page 2; 3 -> page 3
const pages = new Map<number, number>([
  [0, 1],
  [1, 1],
  [2, 2],
  [3, 3],
])

const byIndex = new Map<number, BlockMapping>(
  [...pages.entries()].map(([index, pageNumber]) => [index, { index, pageNumber, paragraphOnPage: null, confidence: 'exact' } as BlockMapping]),
)

const loc = (prev: number | null, next: number | null) => ({
  table_index: 0,
  previous_anchor_paragraph_index: prev,
  next_anchor_paragraph_index: next,
})

test('case A: both anchors same page resolves', () => {
  const r = resolveTablePageFromAnchors(loc(0, 1), byIndex)
  assert.equal(r.page, 1)
  assert.equal(r.reason, 'resolved')
})

test('case B: adjacent-page pair is unavailable', () => {
  const r = resolveTablePageFromAnchors(loc(0, 2), byIndex)
  assert.equal(r.page, null)
  assert.equal(r.reason, 'inconsistent-surroundings')
})

test('case C: single previous anchor is unavailable', () => {
  const r = resolveTablePageFromAnchors(loc(0, null), byIndex)
  assert.equal(r.page, null)
  assert.equal(r.reason, 'missing-boundary')
})

test('case D: gap between anchors is unavailable', () => {
  const r = resolveTablePageFromAnchors(loc(0, 3), byIndex)
  assert.equal(r.page, null)
  assert.equal(r.reason, 'inconsistent-surroundings')
})

test('case E: only next anchor is unavailable', () => {
  const r = resolveTablePageFromAnchors(loc(null, 1), byIndex)
  assert.equal(r.page, null)
  assert.equal(r.reason, 'missing-boundary')
})

test('case F: only previous anchor is unavailable', () => {
  const r = resolveTablePageFromAnchors(loc(1, null), byIndex)
  assert.equal(r.page, null)
  assert.equal(r.reason, 'missing-boundary')
})

test('historical location without anchors is unavailable', () => {
  const r = resolveTablePageFromAnchors({ table_index: 0 }, byIndex)
  assert.equal(r.page, null)
  assert.equal(r.reason, 'no-evidence')
})

test('both anchors none is unavailable', () => {
  const r = resolveTablePageFromAnchors(loc(null, null), byIndex)
  assert.equal(r.page, null)
  assert.equal(r.reason, 'no-evidence')
})

test('unmapped anchors are unavailable', () => {
  const r = resolveTablePageFromAnchors(loc(99, 99), byIndex)
  assert.equal(r.page, null)
  assert.equal(r.reason, 'no-evidence')
})

test('hasPersistedAnchors detects the legacy shape', () => {
  assert.equal(hasPersistedAnchors({ table_index: 0 }), false)
  assert.equal(hasPersistedAnchors(loc(0, 1)), true)
  assert.equal(hasPersistedAnchors({ previous_anchor_paragraph_index: null }), true)
})

// ---------------------------------------------------------------------------
// legacy surrounding path — strict same-page rule only
// ---------------------------------------------------------------------------

test('legacy surroundings: all reliable blocks on one page resolve', () => {
  assert.equal(resolveTablePageFromSurroundings([1, 1, 1]).page, 1)
})

test('legacy surroundings: multi-page window is unavailable', () => {
  assert.equal(resolveTablePageFromSurroundings([1, 2]).page, null)
  assert.equal(resolveTablePageFromSurroundings([2, 2, 3]).page, null)
})

test('legacy surroundings: empty / one-sided evidence is unavailable', () => {
  assert.equal(resolveTablePageFromSurroundings([]).page, null)
  assert.equal(resolveTablePageFromSurroundings([1]).page, 1) // single reliable block on ONE page is fine
})
