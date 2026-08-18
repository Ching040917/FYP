/**
 * Exact Figure outline — fixture evaluation (Build 8F).
 *
 * Runs the REAL pdfjs operator-list geometry extractor over the frozen
 * LibreOffice-rendered fixture (bbox-fixture-1.pdf) and resolves figure
 * outlines for the DOCX body figure image indexes. Ground truth (from
 * bbox-fixture-1-expected.json, independently prepared via pypdf):
 *
 *   - body figures image_index 0..2 on page 2 (centered 216x162, left
 *     144x108, rotated 133.7 square) — each must resolve to an EXACT rect
 *     with IoU >= 0.90 against the ground truth;
 *   - the repeated header logo and the decorative inline icon are NEVER
 *     body figures — resolving them as a figure yields NO rect;
 *   - order mismatch (a decorative paint on the mapped page between body
 *     figures) must never produce an approximate outline.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractPageGeometry } from '../src/lib/pdf/pdf-text-extract.ts'
import { resolveFigureOutline, bodyFigureOps, FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE } from '../src/lib/pdf/figure-bbox.ts'
import { rectIoU } from '../src/lib/pdf/object-bbox.ts'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

async function load() {
  const pdf = new Uint8Array(readFileSync(join(fixturesDir, 'bbox-fixture-1.pdf')))
  const expected = JSON.parse(readFileSync(join(fixturesDir, 'bbox-fixture-1-expected.json'), 'utf8'))
  const geometry = await extractPageGeometry(pdf)
  return { expected, geometry }
}

test('fixture: body figures resolve to exact outlines (IoU >= 0.90) with the figure label', async () => {
  const { expected, geometry } = await load()
  const gtFigures = (expected.figures as Array<{ index: number; page: number; bbox: { x: number; y: number; width: number; height: number }; classification: string }>)
    .filter((f) => f.classification === 'exact')

  // The DOCX body figure indexes are 0-based image_index (the fixture meta
  // labels them 1..3 in one-based figure numbering).
  const results: Array<{ index: number; iou: number }> = []
  for (let imageIndex = 0; imageIndex < 3; imageIndex++) {
    const r = resolveFigureOutline({
      finding: { ruleCode: 'IMAGE_CAPTION_MISSING', location: { image_index: imageIndex, paragraph_index: 3 } },
      geometry,
      pageNumber: 2,
    })
    assert.ok(r.rect, `figure ${imageIndex + 1} must resolve exactly (${r.message})`)
    assert.equal(r.label, `Figure ${imageIndex + 1}`)
    assert.equal(r.pageNumber, 2)
    assert.equal(r.message, null)
    const gt = gtFigures.find((f) => f.index === imageIndex + 1)
    assert.ok(gt, `no ground truth for figure ${imageIndex + 1}`)
    const iou = rectIoU(r.rect!, gt.bbox)
    results.push({ index: imageIndex, iou })
    assert.ok(iou >= 0.9, `figure ${imageIndex + 1} IoU ${iou.toFixed(3)} < 0.9`)
  }
  const mean = results.reduce((a, b) => a + b.iou, 0) / results.length
  console.log(`figure outline exact: n=${results.length} meanIoU=${mean.toFixed(3)}`)
})

test('fixture: bodyFigureOps excludes the header logo and decorative icon', async () => {
  const { geometry } = await load()
  const body = bodyFigureOps(geometry)
  // exactly the three real figures; the repeated logo and the small icon
  // are excluded
  assert.equal(body.length, 3, `expected 3 body figures, got ${body.length}`)
  for (const b of body) {
    assert.ok(b.page === 2, 'all body figures live on page 2')
  }
})

test('fixture: repeated header logo never consumes an image_index position', async () => {
  const { geometry } = await load()
  // The logo paints at (99, 742) on every page but is NOT a body figure —
  // it is excluded from the body-op sequence BEFORE ordinals are assigned,
  // so image_index 0 still maps to the FIRST body figure (page 2), never
  // the logo. The logo itself is never outlineable.
  const body = bodyFigureOps(geometry)
  assert.equal(body[0].page, 2, 'index 0 = first body figure on page 2, logo excluded')
  for (const b of body) {
    assert.ok(!(Math.abs(b.e - 99) < 2 && Math.abs(b.f - 742) < 2), 'logo never in body ops')
  }
})

test('fixture: decorative image is unavailable, never an approximate outline', async () => {
  const { geometry } = await load()
  // decorative icon is 28.8x21.6 — resolving it as a figure yields no rect
  const r = resolveFigureOutline({
    finding: { ruleCode: 'IMAGE_ALT_TEXT_MISSING', location: { image_index: 3 } },
    geometry,
    pageNumber: 2,
  })
  assert.equal(r.rect, null)
  assert.equal(r.message, FIGURE_BOUNDARY_UNAVAILABLE_MESSAGE)
})
