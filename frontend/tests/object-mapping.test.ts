/**
 * Table/Figure page-mapping PoC tests.
 *
 * Fixture e2e (object-fixture-1: 3 tables — captions above/below + missing;
 * 2 body figures + header image + decorative logo; repeated cell text;
 * spanning table) plus pure unit cases for every rule and ambiguity path.
 * Ground truth (expected.json) was authored independently of the mapper.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractPageText, extractImageOpOrder } from '../src/lib/pdf/pdf-text-extract.ts'
import { mapBlocksToPages, normalizeText, type PageText, type TextItemLike } from '../src/lib/pdf/paragraph-mapping.ts'
import {
  mapTableObjects,
  mapFigureObjects,
  type ObjectMapInput,
  type ObjectMappingResult,
} from '../src/lib/pdf/object-mapping.ts'

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))

// ---------------------------------------------------------------------------
// fixture e2e
// ---------------------------------------------------------------------------

async function loadFixture() {
  const pdf = new Uint8Array(readFileSync(`${fixturesDir}/object-fixture-1.pdf`))
  const blocks = JSON.parse(readFileSync(`${fixturesDir}/object-fixture-1-blocks.json`, 'utf8'))
  const meta = JSON.parse(readFileSync(`${fixturesDir}/object-fixture-1-meta.json`, 'utf8'))
  const expected = JSON.parse(readFileSync(`${fixturesDir}/object-fixture-1-expected.json`, 'utf8'))
  const pages = await extractPageText(pdf)
  const mapping = mapBlocksToPages(blocks, pages)
  const input: ObjectMapInput = {
    byIndex: new Map(mapping.map((m) => [m.index, m])),
    pages,
    blocks,
    docxOrder: meta.docx_order,
    tables: meta.tables,
    figures: meta.figures.map((f: Record<string, unknown>) => ({
      imageIndex: f.image_index as number,
      hostParagraphIndex: (f.host_paragraph_index as number | null) ?? null,
      caption: (f.caption as { text: string; above: boolean } | null) ?? null,
      decorative: f.decorative === true,
      inHeaderFooter: f.in_header_footer === true,
    })),
    drawingOrder: meta.drawing_order,
    relsOrder: meta.rels_order,
    imageOps: await extractImageOpOrder(pdf),
  }
  return { input, expected }
}

function count(results: ObjectMappingResult[], expectedByIndex: Map<number, number | null>) {
  let exact = 0
  let approximate = 0
  let unavailable = 0
  const incorrect: Array<{ index: number; got: number | null; want: number | null }> = []
  for (const r of results) {
    const want = expectedByIndex.get(r.targetIndex) ?? null
    if (r.confidence === 'exact') exact += 1
    else if (r.confidence === 'approximate') approximate += 1
    else unavailable += 1
    if (r.pageNumber !== want) incorrect.push({ index: r.targetIndex, got: r.pageNumber, want })
  }
  return { exact, approximate, unavailable, incorrect }
}

test('object fixture: tables map with zero incorrect assignments', async () => {
  const { input, expected } = await loadFixture()
  const results = mapTableObjects(input)
  const want = new Map(expected.tables.map((t: { index: number; page: number }) => [t.index, t.page]))
  const c = count(results, want)
  console.log(`tables: exact=${c.exact} approximate=${c.approximate} unavailable=${c.unavailable} incorrect=${c.incorrect.length}`)
  assert.deepEqual(c.incorrect, [])
  // caption above → exact; no caption → approximate surroundings; spanning
  // with caption below → exact start page
  assert.equal(results[0].confidence, 'exact')
  assert.equal(results[0].evidenceMethod, 'caption')
  assert.equal(results[1].confidence, 'approximate')
  assert.equal(results[2].pageNumber, 3) // start page of the spanning table
})

test('object fixture: figures map with zero incorrect assignments', async () => {
  const { input, expected } = await loadFixture()
  const results = mapFigureObjects(input)
  const want = new Map(expected.figures.map((f: { index: number; page: number | null }) => [f.index, f.page]))
  const c = count(results, want)
  console.log(`figures: exact=${c.exact} approximate=${c.approximate} unavailable=${c.unavailable} incorrect=${c.incorrect.length}`)
  assert.deepEqual(c.incorrect, [])
  // decorative logo excluded, never assigned a page
  assert.equal(results[0].evidenceMethod, 'excluded-decorative')
  assert.equal(results[0].pageNumber, null)
  // fig1 via caption; fig2 (no caption, image-only host) via op order
  assert.equal(results[1].pageNumber, 2)
  assert.equal(results[2].pageNumber, 2)
  assert.equal(results[2].evidenceMethod, 'image-op-order')
  assert.equal(results[2].confidence, 'exact') // rels == drawing == op order
})

// ---------------------------------------------------------------------------
// unit: table rules
// ---------------------------------------------------------------------------

const page = (pageNumber: number, texts: string[]): PageText => ({
  pageNumber,
  lines: texts.map((t) => ({ text: normalizeText(t), y: 100 })),
  headerFooterLines: new Set(),
  items: texts.map((t, i) => ({ str: t, transform: [1, 0, 0, 1, 90, 700 - i * 20], width: t.length * 5, height: 10 })),
  pageWidth: 595,
  pageHeight: 842,
})

const item = (str: string, x: number, y: number): TextItemLike => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width: str.length * 5,
  height: 10,
})

function baseInput(overrides: Partial<ObjectMapInput> = {}): ObjectMapInput {
  const merged = {
    pages: [
      page(1, ['Paragraph A before.', 'Paragraph B after.', 'same cell value']),
      page(2, ['Paragraph C.', 'unique-cell-text-here']),
    ],
    blocks: [
      { index: 0, text: 'Paragraph A before.' },
      { index: 1, text: 'Paragraph B after.' },
      { index: 2, text: 'same cell value' },
      { index: 3, text: 'Paragraph C.' },
      { index: 4, text: 'unique-cell-text-here' },
    ],
    docxOrder: [
      { kind: 'paragraph', index: 0 },
      { kind: 'table', index: 0 },
      { kind: 'paragraph', index: 1 },
      { kind: 'table', index: 1 },
      { kind: 'paragraph', index: 2 },
      { kind: 'paragraph', index: 3 },
      { kind: 'paragraph', index: 4 },
    ],
    tables: [] as ObjectMapInput['tables'],
    figures: [] as ObjectMapInput['figures'],
    drawingOrder: [] as number[],
    imageOps: [] as ObjectMapInput['imageOps'],
    ...overrides,
  }
  // mapping must be recomputed from the MERGED pages/blocks
  const mapping = mapBlocksToPages(merged.blocks, merged.pages)
  return {
    ...merged,
    byIndex: new Map(mapping.map((m) => [m.index, m])),
  }
}

test('caption mapping is exact only when label AND identity agree', () => {
  // caption text is a mapped paragraph but its label does NOT match the
  // table identity ('Paragraph C.' ≠ 'Table 2') → caption is ignored
  const withCaption = baseInput({
    tables: [{ index: 1, cells: [], caption: { text: 'Paragraph C.', above: false } }],
  })
  const r = mapTableObjects(withCaption).find((x) => x.targetIndex === 1)!
  assert.notEqual(r.evidenceMethod, 'caption')
  assert.equal(r.confidence, 'approximate')
  assert.equal(r.pageNumber, 1) // surroundings: before block1 p1, after block2 p1
})

test('unique cell text maps approximately; repeated cell text alone is unavailable', () => {
  const t = baseInput({
    tables: [
      { index: 0, cells: [['same cell value', 'same cell value']], caption: null },
      { index: 1, cells: [['unique-cell-text-here']], caption: null },
    ],
  })
  const results = mapTableObjects(t)
  // repeated cell text is on page 1 but also the block on page 1... doc-wide
  // 'same cell value' appears on page 1 AND in blocks on page 2? only page 1
  // has the text → unique → page 1 approximate
  assert.equal(results[0].pageNumber, 1)
  assert.equal(results[0].confidence, 'approximate')
  assert.equal(results[0].evidenceMethod, 'cell-text')
})

test('cell text appearing on multiple pages is ambiguous → unavailable', () => {
  const t = baseInput({
    tables: [{ index: 0, cells: [['same cell value']], caption: null }],
    pages: [
      page(1, ['same cell value']),
      page(2, ['same cell value']),
      page(3, ['Paragraph C.']),
    ],
  })
  const r = mapTableObjects(t)[0]
  assert.equal(r.pageNumber, null)
  assert.equal(r.confidence, 'unavailable')
})

test('missing-caption table needs BOTH boundaries consistent', () => {
  // consistent: before p1, after p1 → p1
  const same = baseInput({
    tables: [{ index: 0, cells: [['never-on-any-page']], caption: null }],
  })
  assert.equal(mapTableObjects(same)[0].pageNumber, 1)
  // spanning: before p1, after p2 → start page 1
  const span = baseInput({
    docxOrder: [
      { kind: 'paragraph', index: 0 },
      { kind: 'table', index: 0 },
      { kind: 'paragraph', index: 3 }, // p2
    ],
    tables: [{ index: 0, cells: [['never-on-any-page']], caption: null }],
  })
  assert.equal(mapTableObjects(span)[0].pageNumber, 1)
  // inconsistent: before p1, after p3 (gap) → unavailable
  const gap = baseInput({
    docxOrder: [
      { kind: 'paragraph', index: 0 },
      { kind: 'table', index: 0 },
      { kind: 'paragraph', index: 5 }, // p3
    ],
    tables: [{ index: 0, cells: [['never-on-any-page']], caption: null }],
    pages: [page(1, ['Paragraph A before.']), page(2, ['Paragraph C.']), page(3, ['Paragraph D tail.'])],
    blocks: [
      { index: 0, text: 'Paragraph A before.' },
      { index: 3, text: 'Paragraph C.' },
      { index: 5, text: 'Paragraph D tail.' },
    ],
  })
  const r = mapTableObjects(gap)[0]
  assert.equal(r.pageNumber, null)
  assert.equal(r.ambiguityReason, 'inconsistent-surroundings')
})

test('missing-caption table with one missing boundary is unavailable', () => {
  const t = baseInput({
    docxOrder: [{ kind: 'table', index: 0 }, { kind: 'paragraph', index: 3 }],
    tables: [{ index: 0, cells: [['never-on-any-page']], caption: null }],
  })
  const r = mapTableObjects(t)[0]
  assert.equal(r.confidence, 'unavailable')
  assert.equal(r.ambiguityReason, 'missing-boundary')
})

// ---------------------------------------------------------------------------
// unit: figure rules
// ---------------------------------------------------------------------------

const figInput = (overrides: Partial<ObjectMapInput> = {}): ObjectMapInput => {
  const merged = {
    pages: [page(1, ['Body text before.', 'Figure 1: Chart']), page(2, ['Body text after.'])],
    blocks: [
      { index: 0, text: 'Body text before.' },
      { index: 1, text: 'Figure 1: Chart' },
      { index: 2, text: 'Body text after.' },
    ],
    docxOrder: [
      { kind: 'paragraph', index: 0 },
      { kind: 'figure', index: 0 },
      { kind: 'paragraph', index: 1 },
      { kind: 'figure', index: 1 },
      { kind: 'paragraph', index: 2 },
    ],
    tables: [] as ObjectMapInput['tables'],
    figures: [
      { imageIndex: 0, hostParagraphIndex: null, caption: { text: 'Figure 1: Chart', above: false }, decorative: false, inHeaderFooter: false },
      { imageIndex: 1, hostParagraphIndex: 2, caption: null, decorative: false, inHeaderFooter: false },
    ],
    drawingOrder: [0, 1],
    relsOrder: [0, 1],
    imageOps: [
      { page: 1, globalIndex: 0, positionOnPage: 0, name: null, tx: 110, ty: 710 },
      { page: 2, globalIndex: 1, positionOnPage: 0, name: null, tx: 130, ty: 730 },
    ],
    ...overrides,
  }
  const mapping = mapBlocksToPages(merged.blocks, merged.pages)
  return {
    ...merged,
    byIndex: new Map(mapping.map((m) => [m.index, m])),
  }
}

test('figure caption mapping is exact with label agreement', () => {
  const r = mapFigureObjects(figInput())[0]
  assert.equal(r.pageNumber, 1)
  assert.equal(r.confidence, 'exact')
  assert.equal(r.evidenceMethod, 'caption')
})

test('host paragraph mapping resolves a figure page', () => {
  const r = mapFigureObjects(figInput())[1]
  assert.equal(r.pageNumber, 2)
  assert.equal(r.evidenceMethod, 'host-paragraph')
})

test('image-only host (unmapped) falls back to op order', () => {
  const input = figInput({
    figures: [
      { imageIndex: 0, hostParagraphIndex: null, caption: null, decorative: false, inHeaderFooter: false },
      { imageIndex: 1, hostParagraphIndex: null, caption: null, decorative: false, inHeaderFooter: false },
    ],
    pages: [page(1, ['Body text before.']), page(2, ['Body text after.'])],
  })
  const results = mapFigureObjects(input)
  // op 0 on p1 → fig0; op 1 on p2 → fig1
  assert.equal(results[0].pageNumber, 1)
  assert.equal(results[0].evidenceMethod, 'image-op-order')
  assert.equal(results[1].pageNumber, 2)
})

test('op-order mismatch (counts differ) → unavailable, never guessed', () => {
  const input = figInput({
    figures: [
      { imageIndex: 0, hostParagraphIndex: null, caption: null, decorative: false, inHeaderFooter: false },
    ],
    imageOps: [
      { page: 1, globalIndex: 0, positionOnPage: 0, name: null, tx: 100, ty: 700 },
      { page: 2, globalIndex: 1, positionOnPage: 0, name: null, tx: 100, ty: 700 },
    ],
  })
  const r = mapFigureObjects(input)[0]
  assert.equal(r.confidence, 'unavailable')
  assert.equal(r.ambiguityReason, 'op-order-mismatch')
})

test('repeated-position header images are excluded from body order', () => {
  const input = figInput({
    figures: [
      { imageIndex: 0, hostParagraphIndex: null, caption: null, decorative: false, inHeaderFooter: false },
      { imageIndex: 1, hostParagraphIndex: null, caption: null, decorative: false, inHeaderFooter: false },
    ],
    drawingOrder: [0, 1],
    relsOrder: [0, 1],
    imageOps: [
      { page: 1, globalIndex: 0, positionOnPage: 0, name: null, tx: 90, ty: 746 }, // header on p1
      { page: 2, globalIndex: 1, positionOnPage: 0, name: null, tx: 90, ty: 746 }, // header on p2
      { page: 1, globalIndex: 2, positionOnPage: 1, name: null, tx: 110, ty: 710 }, // body fig0
      { page: 2, globalIndex: 3, positionOnPage: 1, name: null, tx: 130, ty: 730 }, // body fig1
    ],
  })
  const results = mapFigureObjects(input)
  assert.equal(results[0].pageNumber, 1) // header ops excluded, body order intact
  assert.equal(results[1].pageNumber, 2)
  assert.equal(results[0].confidence, 'exact') // rels == drawing == body op order
})

test('decorative and header images are separately classified, never assigned pages', () => {
  const input = figInput({
    figures: [
      { imageIndex: 0, hostParagraphIndex: null, caption: null, decorative: true, inHeaderFooter: false },
      { imageIndex: 1, hostParagraphIndex: null, caption: null, decorative: false, inHeaderFooter: true },
    ],
  })
  const results = mapFigureObjects(input)
  assert.equal(results[0].pageNumber, null)
  assert.equal(results[0].evidenceMethod, 'excluded-decorative')
  assert.equal(results[1].pageNumber, null)
  assert.equal(results[1].evidenceMethod, 'excluded-header')
})
