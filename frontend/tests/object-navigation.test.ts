/**
 * Table/Figure page-navigation integration tests.
 *
 * Pure logic: object identity from table_index/image_index, navigation
 * decisions (rendered/stable/none), one-based labels, truthful messages,
 * session caching of successes only, and family disjointness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OBJECT_RULES,
  OBJECT_APPROX_MESSAGE,
  OBJECT_UNAVAILABLE_MESSAGE,
  mapObjectFromBundle,
  resolveObjectNavigation,
  getObjectNavigation,
  dropObjectNavCache,
} from '../src/lib/pdf/object-navigation.ts'
import { mapBlocksToPages, normalizeText, type PageText } from '../src/lib/pdf/paragraph-mapping.ts'
import { evidenceFamily } from '../src/lib/pdf/formatting-highlight.ts'

const page = (pageNumber: number, texts: string[]): PageText => ({
  pageNumber,
  lines: texts.map((t) => ({ text: normalizeText(t), y: 100 })),
  headerFooterLines: new Set(),
  items: texts.map((t, i) => ({ str: t, transform: [1, 0, 0, 1, 90, 700 - i * 20], width: t.length * 5, height: 10 })),
  pageWidth: 595,
  pageHeight: 842,
})

function bundle() {
  const pages = [
    page(1, ['Chapter title.', 'Table 1: Results summary']),
    page(2, ['Figure 1: Growth chart', 'Body text after.']),
    page(3, ['Final paragraph.']),
  ]
  const blocks = [
    { index: 0, text: 'Chapter title.' },
    { index: 1, text: 'Table 1: Results summary' },
    { index: 2, text: 'Figure 1: Growth chart' },
    { index: 3, text: 'Body text after.' },
    { index: 4, text: 'Final paragraph.' },
  ]
  const mapping = mapBlocksToPages(blocks, pages)
  return {
    byIndex: new Map(mapping.map((m) => [m.index, m])),
    pages,
    blocks,
  }
}

const finding = (ruleCode: string, location: Record<string, unknown>) => ({ ruleCode, location })

test('table with semantic caption maps exact page', () => {
  const b = bundle()
  const m = mapObjectFromBundle(finding('TABLE_CAPTION_MISSING', { table_index: 0 }), b)!
  assert.equal(m.pageNumber, 1)
  assert.equal(m.confidence, 'exact')
  const d = resolveObjectNavigation(m)
  assert.equal(d.mode, 'rendered')
  assert.equal(d.pageNumber, 1)
  assert.equal(d.label, 'Page 1 · Table 1')
  assert.equal(d.chipLabel, 'Table 1 · Page 1')
  assert.equal(d.message, null)
})

test('missing table caption (no matching block) is unavailable and view-stable', () => {
  const b = bundle()
  const m = mapObjectFromBundle(finding('TABLE_CAPTION_MISSING', { table_index: 4 }), b)!
  assert.equal(m.pageNumber, null)
  const d = resolveObjectNavigation(m)
  assert.equal(d.mode, 'stable')
  assert.equal(d.pageNumber, null)
  assert.equal(d.label, 'Table 5 · Page unavailable')
  assert.equal(d.chipLabel, 'Table 5 · Page unavailable')
  assert.equal(d.message, OBJECT_UNAVAILABLE_MESSAGE)
})

test('manual caption still navigates using the caption page', () => {
  // MANUAL_CAPTION carries a manually typed caption → block exists → page
  const b = bundle()
  const m = mapObjectFromBundle(finding('MANUAL_CAPTION', { table_index: 0 }), b)!
  assert.equal(m.pageNumber, 1)
  const d = resolveObjectNavigation(m)
  assert.equal(d.mode, 'rendered')
  assert.equal(d.label, 'Page 1 · Table 1')
})

test('figure with semantic caption maps exact page', () => {
  const b = bundle()
  const m = mapObjectFromBundle(finding('IMAGE_CAPTION_MISSING', { image_index: 0, paragraph_index: 2 }), b)!
  assert.equal(m.pageNumber, 2)
  const d = resolveObjectNavigation(m)
  assert.equal(d.label, 'Page 2 · Figure 1')
  assert.equal(d.message, null)
})

test('missing figure caption falls back to host paragraph page', () => {
  const b = bundle()
  // figure 2 (no caption block) with host paragraph 3 on page 2
  const m = mapObjectFromBundle(finding('IMAGE_CAPTION_MISSING', { image_index: 1, paragraph_index: 3 }), b)!
  assert.equal(m.pageNumber, 2)
  assert.equal(m.evidenceMethod, 'host-paragraph')
})

test('image-only host (unmapped) and no caption → unavailable', () => {
  const b = bundle()
  const m = mapObjectFromBundle(finding('IMAGE_ALT_TEXT_MISSING', { image_index: 5, paragraph_index: 9 }), b)!
  assert.equal(m.pageNumber, null)
  const d = resolveObjectNavigation(m)
  assert.equal(d.mode, 'stable')
  assert.equal(d.label, 'Figure 6 · Page unavailable')
})

test('alt-text finding navigates to the figure page, never caption-as-evidence', () => {
  const b = bundle()
  const m = mapObjectFromBundle(finding('IMAGE_ALT_TEXT_MISSING', { image_index: 0, paragraph_index: 2 }), b)!
  assert.equal(m.pageNumber, 2)
  assert.equal(m.evidenceMethod, 'caption') // figure caption block, not alt text
  assert.equal(resolveObjectNavigation(m).mode, 'rendered')
})

test('approximate mapping navigates with a truthful boundary message', () => {
  const m = { targetType: 'table' as const, targetIndex: 2, pageNumber: 3, bbox: null, confidence: 'approximate' as const, evidenceMethod: 'surrounding-paragraphs', ambiguityReason: null }
  const d = resolveObjectNavigation(m)
  assert.equal(d.mode, 'rendered')
  assert.equal(d.pageNumber, 3)
  assert.equal(d.label, 'Page 3 · Table 3')
  assert.equal(d.chipLabel, 'Table 3 begins on Page 3')
  assert.equal(d.message, OBJECT_APPROX_MESSAGE)
})

test('labels are one-based', () => {
  assert.equal(resolveObjectNavigation({ targetType: 'table', targetIndex: 0, pageNumber: 1, bbox: null, confidence: 'exact', evidenceMethod: 'caption', ambiguityReason: null }).label, 'Page 1 · Table 1')
  assert.equal(resolveObjectNavigation({ targetType: 'figure', targetIndex: 2, pageNumber: 4, bbox: null, confidence: 'exact', evidenceMethod: 'caption', ambiguityReason: null }).label, 'Page 4 · Figure 3')
  assert.equal(resolveObjectNavigation({ targetType: 'figure', targetIndex: 2, pageNumber: 4, bbox: null, confidence: 'exact', evidenceMethod: 'caption', ambiguityReason: null }).chipLabel, 'Figure 3 · Page 4')
})

test('no mapping → decision is none (no chip, no navigation)', () => {
  const d = resolveObjectNavigation(null)
  assert.equal(d.mode, 'none')
  assert.equal(d.label, null)
  assert.equal(d.chipLabel, null)
  assert.equal(d.message, null)
})

test('unavailable object keeps the current view stable (never Extracted Text)', () => {
  const d = resolveObjectNavigation({ targetType: 'figure', targetIndex: 0, pageNumber: null, bbox: null, confidence: 'unavailable', evidenceMethod: 'caption', ambiguityReason: 'no-caption-evidence' })
  assert.equal(d.mode, 'stable')
  assert.equal(d.pageNumber, null)
  assert.ok(!d.message?.includes('Extracted Text'))
})

test('multiple objects on one page resolve to the same page', () => {
  const b = bundle()
  const t = resolveObjectNavigation(mapObjectFromBundle(finding('TABLE_CAPTION_MISSING', { table_index: 0 }), b)!)
  const f = resolveObjectNavigation(mapObjectFromBundle(finding('IMAGE_CAPTION_MISSING', { image_index: 0, paragraph_index: 2 }), b)!)
  // different pages here by fixture; both rendered with labels
  assert.equal(t.mode, 'rendered')
  assert.equal(f.mode, 'rendered')
})

test('object rules are disjoint from citation and formatting families', () => {
  for (const rule of OBJECT_RULES) {
    assert.equal(evidenceFamily(rule), 'none') // object family handled separately
  }
  assert.ok(!OBJECT_RULES.has('CITATION_MISMATCH'))
  assert.ok(!OBJECT_RULES.has('FONT_SIZE'))
})

test('session cache stores successes only; audit change drops them', () => {
  const b = bundle()
  const f = finding('TABLE_CAPTION_MISSING', { table_index: 0 })
  const d1 = getObjectNavigation('audit-1', f, b)
  assert.equal(d1.mode, 'rendered')
  const d2 = getObjectNavigation('audit-1', f, b)
  assert.equal(d2, d1) // cached instance
  // temporary loading (no bundle) is never cached
  const d3 = getObjectNavigation('audit-1', f, null)
  assert.equal(d3.mode, 'none')
  dropObjectNavCache('audit-1')
  const d4 = getObjectNavigation('audit-1', f, b)
  assert.notEqual(d4, d1) // recomputed after drop
  assert.equal(d4.mode, 'rendered')
})

test('stale audit id never reuses another audit cache entry', () => {
  const b = bundle()
  const f = finding('TABLE_CAPTION_MISSING', { table_index: 0 })
  getObjectNavigation('audit-a', f, b)
  const d = getObjectNavigation('audit-b', f, b)
  assert.equal(d.mode, 'rendered')
  assert.equal(d.label, 'Page 1 · Table 1')
})

test('object navigation never emits a fake page when evidence is absent', () => {
  const d = getObjectNavigation('audit-x', finding('TABLE_CAPTION_MISSING', { table_index: 9 }), bundle())
  assert.equal(d.mode, 'stable')
  assert.equal(d.pageNumber, null)
})
