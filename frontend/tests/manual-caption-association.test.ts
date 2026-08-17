/**
 * MANUAL_CAPTION association regression tests (Part A).
 *
 * Reproduces the EXACT structural pattern found in the real audit
 * (ACA_System_Edge_Case_Test_Document_2): the detector flags the 4th table
 * (table_index 3) as MANUAL_CAPTION even though its manually typed caption
 * text is numbered "Table 3" — the typed number does NOT match the
 * authoritative table ordinal. Nothing here hardcodes "Table 4" or fixture
 * text: counts, numbers, and labels are derived from variables so the
 * pattern stays structural.
 *
 * The backend now rides the caption paragraph identity in the violation
 * location (XML-adjacency association). The frontend must navigate from
 * that identity — never from the typed number.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OBJECT_UNAVAILABLE_MESSAGE,
  mapObjectFromBundle,
  resolveObjectNavigation,
  getObjectNavigation,
  resolveObjectSelection,
} from '../src/lib/pdf/object-navigation.ts'
import { mapBlocksToPages, normalizeText, type PageText } from '../src/lib/pdf/paragraph-mapping.ts'

const page = (pageNumber: number, texts: string[]): PageText => ({
  pageNumber,
  lines: texts.map((t) => ({ text: normalizeText(t), y: 100 })),
  headerFooterLines: new Set(),
  items: texts.map((t, i) => ({ str: t, transform: [1, 0, 0, 1, 90, 700 - i * 20], width: t.length * 5, height: 10 })),
  pageWidth: 595,
  pageHeight: 842,
})

/**
 * Structural fixture: `tableCount` tables; every table except the last has
 * a caption numbered with its ordinal; the LAST table's caption reuses the
 * previous number (typed-number mismatch, exactly the real-audit pattern).
 * Captions are placed one per page so the block mapping is unambiguous.
 */
function mismatchedCaptionFixture(tableCount: number) {
  const targetIndex = tableCount - 1
  const blocks = []
  for (let i = 0; i < tableCount; i++) {
    // typed number: ordinal for all but the last table, which reuses the
    // previous number — `Table {targetIndex}` instead of `Table {tableCount}`
    const typedNumber = i < targetIndex ? i + 1 : targetIndex
    blocks.push({ index: i, text: `Table ${typedNumber}: Description ${i}` })
  }
  const pages = blocks.map((b, i) => page(i + 1, [b.text]))
  const mapping = mapBlocksToPages(blocks, pages)
  return {
    tableCount,
    targetIndex,
    byIndex: new Map(mapping.map((m) => [m.index, m])),
    pages,
    blocks,
  }
}

const manualCaptionFinding = (tableIndex: number, paragraphIndex: number | null) => ({
  ruleCode: 'MANUAL_CAPTION',
  location: paragraphIndex === null ? { table_index: tableIndex } : { table_index: tableIndex, paragraph_index: paragraphIndex },
})

test('manual caption with mismatched typed number navigates via caption identity', () => {
  const f = mismatchedCaptionFixture(4)
  const m = mapObjectFromBundle(manualCaptionFinding(f.targetIndex, f.targetIndex), f)!
  assert.equal(m.pageNumber, f.tableCount)
  assert.equal(m.evidenceMethod, 'caption-identity')
  const d = resolveObjectNavigation(m)
  assert.equal(d.mode, 'rendered')
  assert.equal(d.label, `Page ${f.tableCount} · Table ${f.tableCount}`)
  assert.equal(d.chipLabel, `Table ${f.tableCount} · Page ${f.tableCount}`)
  assert.equal(d.message, null)
})

test('production selection helper navigates to the associated page', () => {
  const f = mismatchedCaptionFixture(4)
  const sel = resolveObjectSelection('audit-mismatch', manualCaptionFinding(f.targetIndex, f.targetIndex), f)
  assert.deepEqual(sel.status, { label: `Table ${f.tableCount} · Page ${f.tableCount}`, message: null })
  assert.equal(sel.navigatePage, f.tableCount)
})

test('caption immediately BELOW the object is associated (identity path)', () => {
  const f = mismatchedCaptionFixture(3)
  // caption block is the LAST block in the stream (below the object)
  const m = mapObjectFromBundle(manualCaptionFinding(f.targetIndex, f.targetIndex), f)!
  assert.equal(m.pageNumber, f.tableCount)
  assert.equal(m.evidenceMethod, 'caption-identity')
})

test('caption immediately ABOVE the object is associated (identity path)', () => {
  const f = mismatchedCaptionFixture(3)
  // caption block is the FIRST block in the stream (above the object)
  const blocks = [
    { index: 0, text: `Table ${f.targetIndex}: Opening caption` },
    { index: 1, text: 'Unrelated body text one.' },
    { index: 2, text: 'Unrelated body text two.' },
  ]
  const pages = [page(1, [blocks[0].text]), page(2, ['Unrelated body text one.', 'Unrelated body text two.'])]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  const m = mapObjectFromBundle(manualCaptionFinding(f.targetIndex, 0), bundle)!
  assert.equal(m.pageNumber, 1)
  assert.equal(m.evidenceMethod, 'caption-identity')
})

test('placeholder caption text "Table N" still resolves by identity', () => {
  const blocks = [{ index: 0, text: 'Table N placeholder caption' }]
  const pages = [page(1, ['Table N placeholder caption'])]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  const m = mapObjectFromBundle(manualCaptionFinding(0, 0), bundle)!
  assert.equal(m.pageNumber, 1)
  assert.equal(m.evidenceMethod, 'caption-identity')
})

test('unrelated paragraphs around the caption never break identity association', () => {
  const f = mismatchedCaptionFixture(4)
  // interleave unrelated blocks before/after the caption block
  const blocks = [
    { index: 0, text: 'Chapter intro prose.' },
    { index: 1, text: 'More prose before.' },
    ...f.blocks.map((b) => ({ index: b.index + 2, text: b.text })),
    { index: f.blocks.length + 2, text: 'Trailing prose.' },
  ]
  const pages = [
    page(1, ['Chapter intro prose.', 'More prose before.']),
    ...f.pages.map((p, i) => page(i + 2, p.lines.map((l) => l.text))),
    page(f.tableCount + 2, ['Trailing prose.']),
  ]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  const m = mapObjectFromBundle(manualCaptionFinding(f.targetIndex, f.targetIndex + 2), bundle)!
  assert.equal(m.pageNumber, f.tableCount + 1)
  assert.equal(m.evidenceMethod, 'caption-identity')
})

test('legacy shape without paragraph_index: typed-number mismatch stays unavailable (never guessed)', () => {
  const f = mismatchedCaptionFixture(4)
  const m = mapObjectFromBundle(manualCaptionFinding(f.targetIndex, null), f)!
  assert.equal(m.pageNumber, null)
  assert.equal(m.evidenceMethod, 'caption')
  const d = getObjectNavigation('audit-legacy', manualCaptionFinding(f.targetIndex, null), f)
  assert.equal(d.mode, 'stable')
  assert.equal(d.pageNumber, null)
  assert.equal(d.label, `Table ${f.tableCount} · Page unavailable`)
})

test('ambiguous adjacent objects (duplicate typed numbers) remain unavailable', () => {
  // two tables, both captioned "Table 1", no identity → regex finds the
  // first caption for table 0 only; table 1's "Table 2" has no block
  const blocks = [
    { index: 0, text: 'Table 1: First results' },
    { index: 1, text: 'Table 1: Second results' },
  ]
  const pages = [page(1, ['Table 1: First results', 'Table 1: Second results'])]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  const d = getObjectNavigation('audit-ambig', manualCaptionFinding(1, null), bundle)
  assert.equal(d.mode, 'stable')
  assert.equal(d.pageNumber, null)
  assert.ok(!d.message?.includes('Extracted Text'))
})

test('working caption mappings remain unchanged (matching number, no identity)', () => {
  const blocks = [{ index: 0, text: 'Table 1: Results summary' }]
  const pages = [page(1, ['Table 1: Results summary'])]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  const m = mapObjectFromBundle(manualCaptionFinding(0, null), bundle)!
  assert.equal(m.pageNumber, 1)
  assert.equal(m.evidenceMethod, 'caption')
  assert.equal(m.confidence, 'exact')
})

test('unmapped caption block stays honestly unavailable even with identity', () => {
  // caption block exists but its text does not appear on any page
  const blocks = [{ index: 0, text: 'Table 1: Never rendered' }]
  const pages = [page(1, ['Some other text.'])]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  const m = mapObjectFromBundle(manualCaptionFinding(0, 0), bundle)!
  assert.equal(m.pageNumber, null)
  const d = resolveObjectNavigation(m)
  assert.equal(d.mode, 'stable')
  assert.equal(d.message, OBJECT_UNAVAILABLE_MESSAGE)
  assert.equal(d.label, 'Table 1 · Page unavailable')
})
