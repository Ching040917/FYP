/**
 * Table 3 / Table 4 object-mapping collision regression tests.
 *
 * API-shaped fixture mirroring the confirmed browser evidence: 4 tables;
 * tables 0/1 have correctly numbered captions; table 2 (index 2, "Table 3")
 * is UNCAPTIONED on page 2 under a "5.2 Deliberately Uncaptioned Table"
 * heading; table 3 (index 3, "Table 4") is an appendix table on page 3
 * whose manually typed caption visibly says "Table 3".
 *
 * Nothing hardcodes "Table 3"/"Table 4" or fixture text — counts, numbers,
 * and labels derive from variables, so the pattern stays structural.
 *
 * Identity rules under test:
 *   1. location.table_index is the authoritative identity.
 *   2. visible caption numbering is never authoritative.
 *   3. one physical object is never assigned to two table indexes.
 *   4. MANUAL_CAPTION uses persisted caption paragraph identity.
 *   5. TABLE_CAPTION_MISSING never borrows another table's caption; it maps
 *      from DOCX object order + surrounding mapped blocks.
 *   6. conflicting evidence → unavailable (never a silent shared object).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveTableNavigations,
  surroundingPage,
  captionAnchors,
  OBJECT_UNAVAILABLE_MESSAGE,
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

/**
 * The confirmed browser-evidence structure, derived from variables:
 *  - `tableCount` tables, the last two being the uncaptioned "Table N-1"
 *    and the mismatched-caption "Table N";
 *  - captions numbered `1..tableCount-2` correctly, plus the last table's
 *    caption reusing the second-to-last number.
 */
function collisionFixture() {
  const tableCount = 4
  const missingIdx = tableCount - 2 // uncaptioned table (index 2 → "Table 3")
  const targetIdx = tableCount - 1 // appendix table (index 3 → "Table 4")

  const captionOf = (i: number) => `Table ${i === targetIdx ? missingIdx + 1 : i + 1}: Results ${i}`
  const blocks = [
    { index: 0, text: captionOf(0) }, // t0 caption, page 1
    { index: 1, text: 'Intro prose.' }, // page 1
    { index: 2, text: captionOf(1) }, // t1 caption, page 2
    { index: 3, text: '5.2 Deliberately Uncaptioned Table' }, // heading, page 2
    { index: 4, text: 'Body around the uncaptioned table.' }, // page 2
    { index: 5, text: 'Appendix heading' }, // page 3
    { index: 6, text: 'Appendix prose.' }, // page 3
    { index: 7, text: captionOf(targetIdx) }, // t3 caption, page 3 (visible number = missingIdx+1)
  ]
  const pages = [
    page(1, [blocks[0].text, blocks[1].text]),
    page(2, [blocks[2].text, blocks[3].text, blocks[4].text]),
    page(3, [blocks[5].text, blocks[6].text, blocks[7].text]),
  ]
  const mapping = mapBlocksToPages(blocks, pages)
  return {
    tableCount,
    missingIdx,
    targetIdx,
    byIndex: new Map(mapping.map((m) => [m.index, m])),
    pages,
    blocks,
  }
}

function violation(
  ruleCode: string,
  location: Record<string, unknown>,
  id: string,
): Violation {
  return { id, rule_code: ruleCode, severity: 'MINOR', location, message: 'raw', expected_value: null, actual_value: null }
}

function findingsFor(f: ReturnType<typeof collisionFixture>) {
  return [
    { id: 'a', ruleCode: 'MANUAL_CAPTION', location: { table_index: 0, paragraph_index: 0 } },
    { id: 'b', ruleCode: 'MANUAL_CAPTION', location: { table_index: 1, paragraph_index: 2 } },
    { id: 'c', ruleCode: 'TABLE_CAPTION_MISSING', location: { table_index: f.missingIdx } },
    { id: 'd', ruleCode: 'MANUAL_CAPTION', location: { table_index: f.targetIdx, paragraph_index: 7 } },
  ]
}

test('Table 3 resolves ONLY to Page 2; Table 4 resolves ONLY to Page 3', () => {
  const f = collisionFixture()
  const nav = resolveTableNavigations('audit-collision', findingsFor(f), f)

  const t3 = nav.get(f.missingIdx)!
  assert.equal(t3.mode, 'rendered')
  assert.equal(t3.pageNumber, 2)
  assert.equal(t3.label, `Page 2 · Table ${f.missingIdx + 1}`)
  assert.equal(t3.chipLabel, `Table ${f.missingIdx + 1} · Page 2`)

  const t4 = nav.get(f.targetIdx)!
  assert.equal(t4.mode, 'rendered')
  assert.equal(t4.pageNumber, 3)
  assert.equal(t4.label, `Page 3 · Table ${f.targetIdx + 1}`)
  assert.equal(t4.chipLabel, `Table ${f.targetIdx + 1} · Page 3`)

  // correctly numbered captions keep their pages
  assert.equal(nav.get(0)!.pageNumber, 1)
  assert.equal(nav.get(1)!.pageNumber, 2)
  assert.equal(nav.get(0)!.label, 'Page 1 · Table 1')
  assert.equal(nav.get(1)!.label, 'Page 2 · Table 2')
})

test('both mappings use DIFFERENT evidence identities; no shared evidence block', () => {
  const f = collisionFixture()
  const nav = resolveTableNavigations('audit-collision', findingsFor(f), f)
  // uncaptioned table: surrounding-block evidence; appendix table: caption
  // paragraph identity — never the same evidence
  assert.equal(nav.get(f.missingIdx)!.evidenceMethod, 'surrounding-blocks')
  assert.equal(nav.get(f.targetIdx)!.evidenceMethod, 'caption-identity')
  // distinct physical objects: pages differ
  assert.notEqual(nav.get(f.missingIdx)!.pageNumber, nav.get(f.targetIdx)!.pageNumber)
})

test('repeated visible caption number never overrides table_index', () => {
  const f = collisionFixture()
  const nav = resolveTableNavigations('audit-collision', findingsFor(f), f)
  // the appendix caption VISIBLY says `Table {missingIdx+1}` ("Table 3"),
  // yet the finding is Table 4 (index 3) — identity wins
  const t4 = nav.get(f.targetIdx)!
  assert.equal(t4.label, `Page 3 · Table ${f.targetIdx + 1}`)
  assert.ok(!t4.label.includes(`Table ${f.missingIdx + 1} ·`))
})

test('row label, chip, and one-shot navigation page all agree', () => {
  const f = collisionFixture()
  const nav = resolveTableNavigations('audit-collision', findingsFor(f), f)
  for (const idx of [0, 1, f.missingIdx, f.targetIdx]) {
    const d = nav.get(idx)!
    assert.ok(d.label.includes(`Table ${idx + 1}`))
    assert.ok(d.chipLabel.includes(`Table ${idx + 1}`))
    if (d.mode === 'rendered') {
      assert.equal(d.label, `Page ${d.pageNumber} · Table ${idx + 1}`)
      assert.equal(d.chipLabel, `Table ${idx + 1} · Page ${d.pageNumber}`)
    }
  }
})

test('caption ABOVE the appendix table resolves identically (identity, not position)', () => {
  const f = collisionFixture()
  // move the appendix caption block BEFORE the appendix prose (above table)
  const blocks = [
    { index: 0, text: f.blocks[0].text },
    { index: 1, text: f.blocks[1].text },
    { index: 2, text: f.blocks[2].text },
    { index: 3, text: f.blocks[3].text },
    { index: 4, text: f.blocks[4].text },
    { index: 5, text: f.blocks[7].text }, // caption above
    { index: 6, text: f.blocks[5].text },
    { index: 7, text: f.blocks[6].text },
  ]
  const pages = [
    page(1, [blocks[0].text, blocks[1].text]),
    page(2, [blocks[2].text, blocks[3].text, blocks[4].text]),
    page(3, [blocks[5].text, blocks[6].text, blocks[7].text]),
  ]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  const findings = [
    { id: 'a', ruleCode: 'MANUAL_CAPTION', location: { table_index: 0, paragraph_index: 0 } },
    { id: 'b', ruleCode: 'MANUAL_CAPTION', location: { table_index: 1, paragraph_index: 2 } },
    { id: 'c', ruleCode: 'TABLE_CAPTION_MISSING', location: { table_index: f.missingIdx } },
    { id: 'd', ruleCode: 'MANUAL_CAPTION', location: { table_index: f.targetIdx, paragraph_index: 5 } },
  ]
  const nav = resolveTableNavigations('audit-above', findings, bundle)
  assert.equal(nav.get(f.targetIdx)!.pageNumber, 3)
  assert.equal(nav.get(f.missingIdx)!.pageNumber, 2)
})

test('caption BELOW the appendix table resolves identically (the confirmed layout)', () => {
  const f = collisionFixture()
  const nav = resolveTableNavigations('audit-below', findingsFor(f), f)
  assert.equal(nav.get(f.targetIdx)!.pageNumber, 3)
  assert.equal(nav.get(f.targetIdx)!.evidenceMethod, 'caption-identity')
})

test('surroundingPage: single-page window consensus and empty-window unavailability', () => {
  const f = collisionFixture()
  const anchors = captionAnchors(f)
  // table 1: window (0, 2) contains block 1 on page 1 → consensus page 1
  assert.equal(surroundingPage(f, anchors, 1, 0), 1)
  // table 0: window before the first caption is empty → null
  assert.equal(surroundingPage(f, anchors, 0, 0), null)
})

test('surroundingPage: boundary-crossing window anchors to the previous caption page', () => {
  const f = collisionFixture()
  const anchors = captionAnchors(f)
  // table 2 (uncaptioned): window (2, 7) spans pages 2 and 3; previous
  // caption (block 2) is on page 2 → page 2
  assert.equal(surroundingPage(f, anchors, f.missingIdx, 0), 2)
})

test('surroundingPage: unanchored boundary window returns unavailable', () => {
  // previous caption on page 1; window spans pages 2/3 → no anchor → null
  const blocks = [
    { index: 0, text: 'Table 1: First' },
    { index: 1, text: 'A.' },
    { index: 2, text: 'B.' },
    { index: 3, text: 'Table 2: Second' },
  ]
  const pages = [page(1, ['Table 1: First']), page(2, ['A.']), page(3, ['B.', 'Table 2: Second'])]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  // table 1: window (0, 3) → blocks 1 (p2), 2 (p3) → {2,3}; prev caption p1
  // is NOT in the window pages → null (never guess)
  assert.equal(surroundingPage(bundle, captionAnchors(bundle), 1, 0), null)
})

test('surroundingPage: empty window and no-caption document stay unavailable', () => {
  // no caption anchors at all: window = whole stream, pages disagree → null
  const blocks = [
    { index: 0, text: 'Intro prose.' },
    { index: 1, text: 'More prose.' },
  ]
  const pages = [page(1, ['Intro prose.']), page(2, ['More prose.'])]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  assert.equal(captionAnchors(bundle).length, 0)
  assert.equal(surroundingPage(bundle, [], 1, 0), null)
  // empty window (table after last caption, nothing after) → null
  const blocks2 = [{ index: 0, text: 'Table 1: Only caption' }]
  const pages2 = [page(1, ['Table 1: Only caption'])]
  const mapping2 = mapBlocksToPages(blocks2, pages2)
  const bundle2 = { byIndex: new Map(mapping2.map((m) => [m.index, m])), pages: pages2, blocks: blocks2 }
  assert.equal(surroundingPage(bundle2, [0], 2, 0), null)
})

test('conflicting evidence (two indexes claiming one caption identity) → the other becomes unavailable', () => {
  // minimal contradiction fixture: MANUAL for table 1 AND table 2 both claim
  // the SAME caption paragraph identity (block 2 on page 3)
  const blocks = [
    { index: 0, text: 'Table 1: First' },
    { index: 1, text: 'Prose.' },
    { index: 2, text: 'Table 3: Appendix' },
  ]
  const pages = [page(1, ['Table 1: First']), page(2, ['Prose.']), page(3, ['Table 3: Appendix'])]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  const findings = [
    { id: 'a', ruleCode: 'MANUAL_CAPTION', location: { table_index: 1, paragraph_index: 2 } },
    { id: 'b', ruleCode: 'MANUAL_CAPTION', location: { table_index: 2, paragraph_index: 2 } },
  ]
  const nav = resolveTableNavigations('audit-conflict', findings, bundle)
  // lowest index keeps the authoritative identity; the other is recomputed
  // from independent evidence and lands unavailable (never both on one page
  // through one physical object)
  assert.equal(nav.get(1)!.pageNumber, 3)
  assert.equal(nav.get(1)!.evidenceMethod, 'caption-identity')
  const other = nav.get(2)!
  assert.equal(other.mode, 'stable')
  assert.equal(other.pageNumber, null)
  assert.equal(other.label, 'Table 3 · Page unavailable')
  assert.equal(other.message, OBJECT_UNAVAILABLE_MESSAGE)
})

test('batch with missing bundle or no findings returns empty (stable)', () => {
  const f = collisionFixture()
  assert.equal(resolveTableNavigations(null, findingsFor(f), f).size, 0)
  assert.equal(resolveTableNavigations('audit-x', [], f).size, 0)
  assert.equal(resolveTableNavigations('audit-x', findingsFor(f), null).size, 0)
})

test('uncaptioned table with two uncaptioned predecessors still maps by document order', () => {
  // 5 tables; tables 1 and 2 uncaptioned; captions: t0, t3, t4
  const blocks = [
    { index: 0, text: 'Table 1: First' }, // t0, p1
    { index: 1, text: 'Prose A.' }, // p1
    { index: 2, text: 'Prose B.' }, // p2
    { index: 3, text: 'Table 4: Fourth' }, // t3, p2
    { index: 4, text: 'Prose C.' }, // p3
    { index: 5, text: 'Table 5: Fifth' }, // t4, p3
  ]
  const pages = [
    page(1, ['Table 1: First', 'Prose A.']),
    page(2, ['Prose B.', 'Table 4: Fourth']),
    page(3, ['Prose C.', 'Table 5: Fifth']),
  ]
  const mapping = mapBlocksToPages(blocks, pages)
  const bundle = { byIndex: new Map(mapping.map((m) => [m.index, m])), pages, blocks }
  const findings = [
    { id: 'a', ruleCode: 'MANUAL_CAPTION', location: { table_index: 0, paragraph_index: 0 } },
    { id: 'b', ruleCode: 'TABLE_CAPTION_MISSING', location: { table_index: 1 } },
    { id: 'c', ruleCode: 'TABLE_CAPTION_MISSING', location: { table_index: 2 } },
    { id: 'd', ruleCode: 'MANUAL_CAPTION', location: { table_index: 3, paragraph_index: 3 } },
    { id: 'e', ruleCode: 'MANUAL_CAPTION', location: { table_index: 4, paragraph_index: 5 } },
  ]
  const nav = resolveTableNavigations('audit-multi', findings, bundle)
  // captions anchors = [0, 3, 5]; t1: cLt = 1-0 = 1 → window (0,3) → p1,p2 blocks
  // → {1,2}; prev caption p1 ∈ set → page 1
  assert.equal(nav.get(1)!.pageNumber, 1)
  // t2: cLt = 2-1 = 1 → window (0,3) → same → page 1 (both uncaptioned tables
  // sit between caption 1 and caption 2, anchored to the previous caption page)
  assert.equal(nav.get(2)!.pageNumber, 1)
  assert.equal(nav.get(3)!.pageNumber, 2)
  assert.equal(nav.get(4)!.pageNumber, 3)
  // every table has a distinct page result, no shared evidence
  const pagesUsed = new Set([0, 1, 2, 3, 4].map((i) => nav.get(i)!.pageNumber))
  assert.equal(pagesUsed.size, 3)
})

test('API-shaped violations (snake_case) resolve identically through the batch', () => {
  const f = collisionFixture()
  const apiFindings = [
    violation('MANUAL_CAPTION', { table_index: 0, paragraph_index: 0 }, 'a'),
    violation('MANUAL_CAPTION', { table_index: 1, paragraph_index: 2 }, 'b'),
    violation('TABLE_CAPTION_MISSING', { table_index: f.missingIdx }, 'c'),
    violation('MANUAL_CAPTION', { table_index: f.targetIdx, paragraph_index: 7 }, 'd'),
  ]
  const nav = resolveTableNavigations('audit-api', apiFindings, f)
  assert.equal(nav.get(f.missingIdx)!.pageNumber, 2)
  assert.equal(nav.get(f.targetIdx)!.pageNumber, 3)
})
