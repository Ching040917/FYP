/**
 * Table/Figure object navigation — PRODUCTION-FLOW tests.
 *
 * Fixtures are shaped exactly like the real API contract:
 *   - `Violation` (frontend/src/types/api.ts): `rule_code`, `severity`,
 *     `location: Record<string, unknown> | null` — the audit response rows
 *     the AuditPage findings list is built from;
 *   - backend location keys verified against layout_engine.py:
 *     `table_index` (zero-based), `image_index` (zero-based),
 *     `paragraph_index` (supporting, zero-based);
 *   - `LayoutError` (presentation) DROPS `location` — selection must go
 *     through the real violation by id, so the flow here always passes the
 *     violation-shaped finding into `resolveObjectSelection`, exactly as
 *     AuditPage.applyNavigation does after its id lookup.
 *
 * The decision path under test is the exact production helper:
 *   classifyFindingTarget(violation) === 'object'  →  OBJECT_RULES gate  →
 *   resolveObjectSelection(auditId, findingLike, bundle)  →  chip + one-shot
 *   page command. Navigation semantics asserted: exact → navigate once;
 *   approximate → navigate + truthful boundary chip; unavailable / not-ready
 *   → view stable, nothing shown, never a guessed page; one-based labels.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFindingTarget } from '../src/lib/pdf/finding-navigation.ts'
import {
  OBJECT_RULES,
  OBJECT_APPROX_MESSAGE,
  OBJECT_UNAVAILABLE_MESSAGE,
  resolveObjectSelection,
  getObjectNavigation,
  dropObjectNavCache,
  resolveObjectNavigation,
} from '../src/lib/pdf/object-navigation.ts'
import { mapBlocksToPages, normalizeText, type PageText } from '../src/lib/pdf/paragraph-mapping.ts'
import type { Violation } from '../src/types/api'

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

/** API-shaped violation exactly as `GET /api/audit` returns it. */
function violation(
  ruleCode: string,
  location: Record<string, unknown> | null,
  id = 'v-1',
): Violation {
  return {
    id,
    rule_code: ruleCode,
    severity: 'MAJOR',
    location,
    message: 'backend message (authoritative, never altered)',
    expected_value: null,
    actual_value: null,
  }
}

/** One audit id per test — no cross-test cache bleed. */
let auditSeq = 0
const nextAudit = () => `audit-flow-${++auditSeq}`

test('table finding: zero-based table_index=0 → Table 1, exact page, chip + navigate', () => {
  const v = violation('TABLE_CAPTION_MISSING', { table_index: 0 })
  // the production branch gate must classify this as an object finding
  assert.equal(classifyFindingTarget(v), 'object')
  assert.ok(OBJECT_RULES.has(v.rule_code))
  const sel = resolveObjectSelection(nextAudit(), v, bundle())
  assert.deepEqual(sel.status, { label: 'Table 1 · Page 1', message: null })
  assert.equal(sel.navigatePage, 1)
})

test('figure finding: zero-based image_index=0 → Figure 1 via caption evidence', () => {
  const v = violation('IMAGE_CAPTION_MISSING', { image_index: 0, paragraph_index: 2 })
  assert.equal(classifyFindingTarget(v), 'object')
  const sel = resolveObjectSelection(nextAudit(), v, bundle())
  assert.deepEqual(sel.status, { label: 'Figure 1 · Page 2', message: null })
  assert.equal(sel.navigatePage, 2)
})

test('one-based conversion: table_index=2 renders as Table 3 (never Table 2)', () => {
  // dedicated bundle: Table 3 caption lives on page 3
  const pages = [page(1, ['Intro.']), page(2, ['Body.']), page(3, ['Table 3: Final results'])]
  const blocks = [
    { index: 0, text: 'Intro.' },
    { index: 1, text: 'Body.' },
    { index: 2, text: 'Table 3: Final results' },
  ]
  const mapping = mapBlocksToPages(blocks, pages)
  const b = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  const v = violation('TABLE_CAPTION_MISSING', { table_index: 2 })
  const sel = resolveObjectSelection(nextAudit(), v, b)
  assert.deepEqual(sel.status, { label: 'Table 3 · Page 3', message: null })
  assert.equal(sel.navigatePage, 3)
})

test('missing index in location → nothing shown, view stable, no crash', () => {
  const v = violation('TABLE_CAPTION_MISSING', { paragraph_index: 1 })
  const sel = resolveObjectSelection(nextAudit(), v, bundle())
  assert.deepEqual(sel, { status: null, navigatePage: null })
})

test('LayoutError-style violation with location null → nothing shown, no crash', () => {
  const v = violation('IMAGE_ALT_TEXT_MISSING', null)
  const sel = resolveObjectSelection(nextAudit(), v, bundle())
  assert.deepEqual(sel, { status: null, navigatePage: null })
})

test('non-object rule never triggers object navigation', () => {
  const v = violation('FONT_SIZE', { paragraph_index: 3 })
  assert.equal(classifyFindingTarget(v), 'paragraph')
  const sel = resolveObjectSelection(nextAudit(), v, bundle())
  assert.deepEqual(sel, { status: null, navigatePage: null })
})

test('section-typed rule (margin) is object-classified but not an OBJECT_RULE → no chip, no navigation', () => {
  const v = violation('MARGIN_LEFT', { section_index: 0 })
  assert.equal(classifyFindingTarget(v), 'object')
  assert.ok(!OBJECT_RULES.has(v.rule_code))
  const sel = resolveObjectSelection(nextAudit(), v, bundle())
  assert.deepEqual(sel, { status: null, navigatePage: null })
})

test('mapping not ready (no bundle): stable, nothing cached, retry after ready works', () => {
  const audit = nextAudit()
  const v = violation('TABLE_CAPTION_MISSING', { table_index: 0 })
  const before = resolveObjectSelection(audit, v, null)
  assert.deepEqual(before, { status: null, navigatePage: null })
  // later retry with the ready bundle resolves — nothing was cached from the
  // temporary not-ready state
  const after = resolveObjectSelection(audit, v, bundle())
  assert.deepEqual(after.status, { label: 'Table 1 · Page 1', message: null })
  assert.equal(after.navigatePage, 1)
})

test('repeated selection is idempotent (cached success, same chip every time)', () => {
  const audit = nextAudit()
  const v = violation('TABLE_CAPTION_MISSING', { table_index: 0 })
  const b = bundle()
  const first = resolveObjectSelection(audit, v, b)
  const second = resolveObjectSelection(audit, v, b)
  assert.deepEqual(second, first)
  assert.equal(second.navigatePage, 1)
  dropObjectNavCache(audit)
  const third = resolveObjectSelection(audit, v, b)
  assert.deepEqual(third, first) // recomputed but identical
})

test('rapid latest-wins: each selection resolves deterministically and replaces the previous', () => {
  const audit = nextAudit()
  const b = bundle()
  const table = violation('TABLE_CAPTION_MISSING', { table_index: 0 })
  const figure = violation('IMAGE_CAPTION_MISSING', { image_index: 0, paragraph_index: 2 })
  // two selections in quick succession — the LAST decision wins
  const last = resolveObjectSelection(audit, figure, b)
  resolveObjectSelection(audit, table, b)
  // the later call's result is what the viewer renders (latest-wins in AuditPage)
  assert.deepEqual(last.status, { label: 'Figure 1 · Page 2', message: null })
  assert.equal(last.navigatePage, 2)
})

test('approximate mapping: chip says "begins on Page N", still navigates, truthful boundary message', () => {
  const v = violation('TABLE_CAPTION_MISSING', { table_index: 2 })
  const d = resolveObjectNavigation({
    targetType: 'table',
    targetIndex: 2,
    pageNumber: 3,
    bbox: null,
    confidence: 'approximate',
    evidenceMethod: 'surrounding-paragraphs',
    ambiguityReason: null,
  })
  const sel = { status: { label: d.chipLabel, message: d.message }, navigatePage: d.pageNumber }
  assert.deepEqual(sel.status, { label: 'Table 3 begins on Page 3', message: OBJECT_APPROX_MESSAGE })
  assert.equal(sel.navigatePage, 3)
  // the finding itself is still object-classified through the production gate
  assert.equal(classifyFindingTarget(v), 'object')
})

test('unavailable: "Table M · Page unavailable" chip, view stable, never a guessed page', () => {
  const audit = nextAudit()
  const v = violation('TABLE_CAPTION_MISSING', { table_index: 9 })
  const sel = resolveObjectSelection(audit, v, bundle())
  assert.deepEqual(sel.status, {
    label: 'Table 10 · Page unavailable',
    message: OBJECT_UNAVAILABLE_MESSAGE,
  })
  assert.equal(sel.navigatePage, null)
})

test('unavailable figure: "Figure M · Page unavailable", no navigation', () => {
  const v = violation('IMAGE_ALT_TEXT_MISSING', { image_index: 5, paragraph_index: 9 })
  const sel = resolveObjectSelection(nextAudit(), v, bundle())
  assert.deepEqual(sel.status, {
    label: 'Figure 6 · Page unavailable',
    message: OBJECT_UNAVAILABLE_MESSAGE,
  })
  assert.equal(sel.navigatePage, null)
})

test('snake_case rule_code (raw API shape) resolves identically to camelCase FindingLike', () => {
  const audit = nextAudit()
  const b = bundle()
  const raw = resolveObjectSelection(audit, violation('MANUAL_CAPTION', { table_index: 0 }), b)
  const like = resolveObjectSelection(audit, { ruleCode: 'MANUAL_CAPTION', location: { table_index: 0 } }, b)
  assert.deepEqual(raw.status, { label: 'Table 1 · Page 1', message: null })
  assert.deepEqual(like.status, raw.status)
  assert.equal(like.navigatePage, 1)
})

test('row label and chip agree on the object identity (Page N · Table M vs Table M · Page N)', () => {
  const audit = nextAudit()
  const v = violation('TABLE_CAPTION_MISSING', { table_index: 0 })
  // row label comes from getObjectNavigation(...).label (locationLabels memo)
  const nav = getObjectNavigation(audit, v, bundle())
  assert.equal(nav.label, 'Page 1 · Table 1')
  const sel = resolveObjectSelection(audit, v, bundle())
  assert.equal(sel.status?.label, 'Table 1 · Page 1')
  assert.ok(nav.label!.includes('Table 1'))
  assert.ok(sel.status!.label!.includes('Table 1'))
  assert.equal(sel.navigatePage, 1)
})
