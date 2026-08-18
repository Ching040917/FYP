/**
 * Table/Figure bounding-box PoC — fixture evaluation.
 *
 * Runs the pdfjs geometry extractor + bbox mappers over the frozen
 * LibreOffice-rendered fixture (bbox-fixture-1.pdf) and compares against
 * the INDEPENDENTLY prepared ground truth (pypdf content-stream parse,
 * see make-bbox-ground-truth.py). Reports exact / approximate /
 * unavailable / incorrect counts and IoU stats for exact results.
 *
 * Ground truth expectations:
 *  - figures 1..3 on page 2 (216x162 centered, 144x108 left, rotated
 *    133.7x133.7 right); header logo (18x13.7, repeated) is NOT a figure;
 *    the small decorative icon (28.8x21.6) is not a body figure;
 *  - table 0 (bordered, page 1), table 2 (bordered+merged, page 1),
 *    table 3 spanning pages 3-4 (one segment per page);
 *  - table 1 (borderless, page 1) has NO border evidence → approximate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractPageGeometry, extractPageText } from '../src/lib/pdf/pdf-text-extract.ts'
import { figureBBoxFromOp, tableRegion, rectIoU } from '../src/lib/pdf/object-bbox.ts'
import type { DetailedImageOp } from '../src/lib/pdf/pdf-text-extract.ts'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

interface GTF { index: number; page: number; bbox: { x: number; y: number; width: number; height: number }; classification: string }
interface GTT { index: number; page: number; bbox: { x: number; y: number; width: number; height: number }; classification: string }

async function load() {
  const pdf = new Uint8Array(readFileSync(join(fixturesDir, 'bbox-fixture-1.pdf')))
  const meta = JSON.parse(readFileSync(join(fixturesDir, 'bbox-fixture-1-meta.json'), 'utf8'))
  const expected = JSON.parse(readFileSync(join(fixturesDir, 'bbox-fixture-1-expected.json'), 'utf8'))
  const geometry = await extractPageGeometry(pdf)
  const pageTexts = await extractPageText(pdf)
  return { pdf, meta, expected, geometry, pageTexts }
}

test('fixture evaluation: figures — zero incorrect, exact with IoU >= 0.90', async () => {
  const { geometry, expected } = await load()
  const gtFigures = (expected.figures as GTF[]).filter((f) => f.classification === 'exact')

  // header-logo exclusion: repeated position across pages
  const allOps = geometry.flatMap((g) => g.imageOps)
  const posCount = new Map<string, number>()
  for (const o of allOps) {
    const key = `${Math.round(o.e)}:${Math.round(o.f)}`
    posCount.set(key, (posCount.get(key) ?? 0) + 1)
  }
  const bodyOps = allOps.filter((o) => (posCount.get(`${Math.round(o.e)}:${Math.round(o.f)}`) ?? 0) < 2)

  // skip decorative small icon (28.8x21.6) and logo; body figures >= 40pt
  const figureOps = bodyOps.filter((o) => Math.abs(o.a) >= 40 && Math.abs(o.d) >= 40)
  assert.equal(figureOps.length, 3, `expected 3 body figures, got ${figureOps.length}`)

  const pageGeom = (page: number) => geometry.find((g) => g.pageNumber === page)!
  const results: Array<{ index: number; iou: number; page: number }> = []
  const incorrect: string[] = []
  for (const op of figureOps) {
    const g = pageGeom(op.page)
    const bbox = figureBBoxFromOp(op, g.pageWidth, g.pageHeight)
    assert.ok(bbox, 'figure op must yield a bbox')
    // identity by SIZE FINGERPRINT (rotated square vs 144x108 are close in
    // area — area ranking is ambiguous; exact dims are not)
    const w = Math.abs(op.a)
    const h = Math.abs(op.d)
    let index = 0
    if (Math.abs(w - 216) < 2 && Math.abs(h - 162) < 2) index = 1
    else if (Math.abs(w - 144) < 2 && Math.abs(h - 108) < 2) index = 2
    else if (Math.abs(w - h) < 2 && Math.abs(w - 133.7) < 3) index = 3
    assert.notEqual(index, 0, 'figure op must match a known size fingerprint')
    const gt = gtFigures.find((f) => f.index === index && f.page === op.page)
    assert.ok(gt, `no ground truth for figure ${index} page ${op.page}`)
    const iou = rectIoU(bbox, gt.bbox)
    results.push({ index, iou, page: op.page })
    if (iou < 0.9) incorrect.push(`figure ${index}: iou ${iou.toFixed(3)}`)
  }

  const ious = results.map((r) => r.iou)
  const mean = ious.reduce((a, b) => a + b, 0) / ious.length
  console.log(`figure exact: n=${results.length} meanIoU=${mean.toFixed(3)} minIoU=${Math.min(...ious).toFixed(3)}`)
  assert.deepEqual(incorrect, [], `incorrect figure boxes: ${incorrect.join('; ')}`)
  assert.ok(mean >= 0.9)
  assert.ok(Math.min(...ious) >= 0.9)
})

test('fixture evaluation: header logo and decorative image never become body figures', async () => {
  const { geometry } = await load()
  const allOps = geometry.flatMap((g) => g.imageOps)
  // the logo paint is 18x13.7 at the same position on every page
  const logo = allOps.filter((o) => Math.abs(o.a - 18) < 0.5 && Math.abs(o.d - 13.7) < 0.5)
  assert.equal(logo.length, geometry.length, 'logo repeats on every page')
  for (const l of logo) {
    const g = geometry.find((x) => x.pageNumber === l.page)!
    const bbox = figureBBoxFromOp(l, g.pageWidth, g.pageHeight)
    assert.ok(bbox && bbox.height < 0.05, 'logo box is tiny')
  }
  // decorative icon is 28.8x21.6 (below the 40pt body threshold)
  const deco = allOps.filter((o) => Math.abs(o.a - 28.8) < 0.5)
  assert.equal(deco.length, 1, 'exactly one decorative icon')
})

test('fixture evaluation: bordered tables exact against ground truth (IoU >= 0.90)', async () => {
  const { meta, expected, geometry, pageTexts } = await load()
  const gtTables = (expected.tables as GTT[]).filter((t) => t.classification === 'exact')

  const cellsOf = (idx: number) => {
    const t = meta.tables.find((x: { index: number }) => x.index === idx)
    assert.ok(t, `no meta for table ${idx}`)
    return (t.cells as string[][]).flat().filter((c) => c && c.trim())
  }
  const itemsOf = (page: number) => pageTexts.find((p) => p.pageNumber === page)
  const geomOf = (page: number) => geometry.find((g) => g.pageNumber === page)

  const results: Array<{ index: number; page: number; iou: number }> = []
  const incorrect: string[] = []

  // table 0 and table 2 on page 1 (both bordered)
  for (const idx of [0, 2]) {
    const g = geomOf(1)!
    const r = tableRegion({
      page: itemsOf(1)!,
      pageWidth: g.pageWidth,
      pageHeight: g.pageHeight,
      cellMarkers: cellsOf(idx),
      segments: g.segments,
    })
    assert.equal(r.confidence, 'exact', `table ${idx} should be exact (${r.evidenceMethod})`)
    assert.ok(r.bbox)
    const gt = gtTables.find((t) => t.index === idx && t.page === 1)!
    const iou = rectIoU(r.bbox, gt.bbox)
    results.push({ index: idx, page: 1, iou })
    if (iou < 0.9) incorrect.push(`table ${idx}: iou ${iou.toFixed(3)}`)
  }

  // table 3 spans pages 3-4: one exact segment per page
  for (const page of [3, 4]) {
    const g = geomOf(page)!
    const r = tableRegion({
      page: itemsOf(page)!,
      pageWidth: g.pageWidth,
      pageHeight: g.pageHeight,
      cellMarkers: cellsOf(3),
      segments: g.segments,
    })
    assert.equal(r.confidence, 'exact', `table 3 page ${page} should be exact (${r.evidenceMethod})`)
    assert.ok(r.bbox)
    const gt = gtTables.find((t) => t.index === 3 && t.page === page)!
    const iou = rectIoU(r.bbox, gt.bbox)
    results.push({ index: 3, page, iou })
    if (iou < 0.9) incorrect.push(`table 3 page ${page}: iou ${iou.toFixed(3)}`)
  }

  const ious = results.map((r) => r.iou)
  const mean = ious.reduce((a, b) => a + b, 0) / ious.length
  console.log(`table exact: n=${results.length} meanIoU=${mean.toFixed(3)} minIoU=${Math.min(...ious).toFixed(3)}`)
  assert.deepEqual(incorrect, [], `incorrect table boxes: ${incorrect.join('; ')}`)
  assert.ok(mean >= 0.9)
  assert.ok(Math.min(...ious) >= 0.9)
})

test('fixture evaluation: borderless table is approximate, never exact', async () => {
  const { meta, geometry, pageTexts } = await load()
  const cellsOf = (idx: number) => {
    const t = meta.tables.find((x: { index: number }) => x.index === idx)
    return (t.cells as string[][]).flat().filter((c) => c && c.trim())
  }
  const g = geometry.find((x) => x.pageNumber === 1)!
  const r = tableRegion({
    page: pageTexts.find((p) => p.pageNumber === 1)!,
    pageWidth: g.pageWidth,
    pageHeight: g.pageHeight,
    cellMarkers: cellsOf(1),
    segments: g.segments,
  })
  assert.equal(r.confidence, 'approximate')
  assert.equal(r.evidenceMethod, 'cell-text')
  assert.ok(r.bbox)
})

test('fixture evaluation: Table 3 and Table 4 identities remain distinct', async () => {
  // table 2 (index 2) and table 3 (index 3) never share a region
  const { meta, geometry, pageTexts } = await load()
  const cellsOf = (idx: number) => {
    const t = meta.tables.find((x: { index: number }) => x.index === idx)
    return (t.cells as string[][]).flat().filter((c) => c && c.trim())
  }
  const g = geometry.find((x) => x.pageNumber === 3)!
  const r = tableRegion({
    page: pageTexts.find((p) => p.pageNumber === 3)!,
    pageWidth: g.pageWidth,
    pageHeight: g.pageHeight,
    cellMarkers: cellsOf(3), // "T4 ..." markers
    segments: g.segments,
  })
  assert.equal(r.confidence, 'exact')
  // markers "T3 ..." never appear on page 3 (table 2 lives on page 1)
  const p3text = pageTexts.find((p) => p.pageNumber === 3)!
  const t3Marker = cellsOf(2).find((c) => c.startsWith('T3'))
  assert.ok(!(p3text.items ?? []).some((it) => it.str.includes(t3Marker!)))
})
