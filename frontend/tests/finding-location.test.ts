/**
 * Shared friendly location — one value for every surface.
 *
 * The Findings card, the selected-evidence chip and Finding Details must all
 * render the SAME label for a finding. The ambiguous bare "Paragraph 65"
 * (document-wide index) is never shown, because the on-page position the
 * mapping proves can be "Paragraph 3" on page 9 — the two disagree, and the
 * screenshot showed exactly that bug.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  friendlyParagraphLocation,
  resolveFindingNavigation,
} from '../src/lib/pdf/finding-navigation.ts'
import type { BlockMapping } from '../src/lib/pdf/paragraph-mapping.ts'
import { structuralStoryLabel } from '../src/lib/audit/page-elements.ts'
import { objectLabel } from '../src/lib/friendly-finding.ts'


const PAGE: BlockMapping = {
  index: 64,
  pageNumber: 9,
  pageRange: null,
  paragraphOnPage: 3,
  confidence: 'exact',
}

// ---------------------------------------------------------------------------
// The helper itself
// ---------------------------------------------------------------------------

test('a rendered mapping yields the on-page position, not the document index', () => {
  assert.equal(friendlyParagraphLocation(64, PAGE), 'Page 9 · Paragraph 3')
})

test('the same finding resolves through the navigation decision identically', () => {
  const byIndex = new Map([[64, PAGE]])
  const decision = resolveFindingNavigation({ id: 'v', location: { paragraph_index: 64 } }, byIndex)
  assert.equal(decision.locationLabel, 'Page 9 · Paragraph 3')
  assert.equal(decision.locationLabel, friendlyParagraphLocation(64, PAGE))
})

test('a mapping with the page but no on-page ordinal shows only the page', () => {
  assert.equal(friendlyParagraphLocation(64, { ...PAGE, paragraphOnPage: null }), 'Page 9')
})

test('the historical fallback names the document-wide paragraph explicitly', () => {
  assert.equal(friendlyParagraphLocation(64), 'Document paragraph 65')
  assert.equal(friendlyParagraphLocation(64, null), 'Document paragraph 65')
  assert.equal(friendlyParagraphLocation(64, null, null), 'Document paragraph 65')
})

test('a persisted page only (no rendered mapping) keeps the paragraph half document-wide', () => {
  assert.equal(friendlyParagraphLocation(64, null, 3), 'Page 3 · Document paragraph 65')
})

test('an unavailable mapping states the page is unavailable, never a guessed page', () => {
  assert.equal(
    friendlyParagraphLocation(64, { ...PAGE, pageNumber: null, confidence: 'unavailable' }),
    'Document paragraph 65 · Page unavailable',
  )
})

test('the bare ambiguous "Paragraph 65" is never produced by any branch', () => {
  const labels = [
    friendlyParagraphLocation(64, PAGE),
    friendlyParagraphLocation(64, { ...PAGE, paragraphOnPage: null }),
    friendlyParagraphLocation(64),
    friendlyParagraphLocation(64, null, 3),
    friendlyParagraphLocation(64, { ...PAGE, pageNumber: null, confidence: 'unavailable' }),
  ]
  for (const label of labels) {
    assert.notEqual(label, 'Paragraph 65')
    assert.doesNotMatch(label ?? '', /^Paragraph \d+$/)
  }
})

test('no paragraph identity yields null rather than a fabricated label', () => {
  assert.equal(friendlyParagraphLocation(null), null)
  assert.equal(friendlyParagraphLocation(undefined), null)
  assert.equal(friendlyParagraphLocation(-1), null)
})


test('structural story labels precede object and body fallbacks without guessing pages', () => {
  for (const [kind, label] of [['header', 'Header'], ['footer', 'Footer'], ['either', 'Header or Footer']]) {
    const location = { structural_story: true, section_index: 2, story_type: kind, story_variant: 'default', paragraph_index: 99, image_index: 8 }
    assert.equal(structuralStoryLabel(location), `Section 3 · ${label} · Normal pages`)
    assert.equal(objectLabel(location), `Section 3 · ${label} · Normal pages`)
  }
  assert.equal(structuralStoryLabel({ section_index: 0, story_type: 'header', story_variant: 'default' }), null)
  assert.equal(structuralStoryLabel({ structural_story: true, section_index: -1, story_type: 'header', story_variant: 'default' }), null)
  for (const story_type of ['unknown', 'constructor', '__proto__']) {
    assert.equal(structuralStoryLabel({ structural_story: true, section_index: 0, story_type, story_variant: 'default' }), null)
  }
})
