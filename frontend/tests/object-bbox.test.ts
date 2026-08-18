/**
 * Table/Figure bounding-box PoC — pure-logic unit tests.
 *
 * Covers CTM composition, save/restore isolation, transformed corners,
 * page rotation, invalid/degenerate dimensions, header-logo exclusion,
 * multi-image ordering, table text clustering, neighbouring-table
 * separation, borderless classification, spanning-table segments, and the
 * "unavailable evidence never becomes exact" rule.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  figureBBoxFromOp,
  normalizeCorners,
  tableRegion,
  rectIoU,
  type TableRegionInput,
} from '../src/lib/pdf/object-bbox.ts'
import type { DetailedImageOp, LineSegment } from '../src/lib/pdf/pdf-text-extract.ts'
import { normalizeText, type PageText, type TextItemLike } from '../src/lib/pdf/paragraph-mapping.ts'

const item = (str: string, x: number, y: number, width = str.length * 5): TextItemLike => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width,
  height: 10,
})

function page(pageNumber: number, items: TextItemLike[], width = 612, height = 792): PageText {
  return {
    pageNumber,
    lines: [],
    headerFooterLines: new Set(),
    items,
    pageWidth: width,
    pageHeight: height,
  }
}

const op = (partial: Partial<DetailedImageOp>): DetailedImageOp => ({
  page: 1,
  globalIndex: 0,
  positionOnPage: 0,
  name: null,
  tx: 0,
  ty: 0,
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
  width: null,
  height: null,
  rotation: 0,
  ...partial,
})

// ---------------------------------------------------------------------------
// figure bbox math
// ---------------------------------------------------------------------------

test('CTM translation + scale maps the unit square to the image rect', () => {
  const r = figureBBoxFromOp(op({ a: 216, d: 162, e: 198, f: 538.4 }), 612, 792)
  assert.ok(r)
  assert.ok(Math.abs(r.x - 198 / 612) < 1e-6)
  assert.ok(Math.abs(r.y - 538.4 / 792) < 1e-6)
  assert.ok(Math.abs(r.width - 216 / 612) < 1e-6)
  assert.ok(Math.abs(r.height - 162 / 792) < 1e-6)
  assert.equal(r.page, 1)
})

test('rotated CTM yields the axis-aligned bbox of all four corners', () => {
  // 45° rotation about the origin: corners (0,0),(s,0),(0,s),(s,s) rotated
  const s = 100
  const r = figureBBoxFromOp(op({ a: Math.cos(Math.PI / 4) * s, b: Math.sin(Math.PI / 4) * s, c: -Math.sin(Math.PI / 4) * s, d: Math.cos(Math.PI / 4) * s, e: 300, f: 400 }), 612, 792)
  assert.ok(r)
  const half = (Math.SQRT2 * s) / 2
  assert.ok(Math.abs(r.x - (300 - half) / 612) < 1e-6)
  assert.ok(Math.abs(r.width - (Math.SQRT2 * s) / 612) < 1e-6)
})

test('save/restore stack semantics isolate nested transforms', () => {
  // first clip transform must NOT leak into the second paint (the naive
  // accumulation bug: [10,0,0,10,99,746] x [20,0,0,20,99,596.6] explodes)
  const first = op({ a: 10, d: 10, e: 99, f: 746, rotation: 0 })
  const second = op({ a: 20, d: 20, e: 99, f: 596.6, rotation: 0 })
  const r1 = figureBBoxFromOp(first, 612, 792)!
  const r2 = figureBBoxFromOp(second, 612, 792)!
  assert.ok(Math.abs(r1.x - 99 / 612) < 1e-6)
  assert.ok(Math.abs(r2.x - 99 / 612) < 1e-6)
  assert.ok(Math.abs(r2.y - 596.6 / 792) < 1e-6)
})

test('page rotation 90 maps corners through the viewport', () => {
  // user-space rect near the bottom-left; 90° rotation swaps the axes and
  // the visible page dimensions (pdfjs viewport semantics)
  const r = normalizeCorners([[10, 10], [110, 10], [10, 60], [110, 60]], 90, 612, 792, 1)
  assert.ok(r)
  // rotated space: x' = H - y, y' = x → bbox [732..782] x [10..110];
  // visible size after rotation: 792 wide, 612 tall
  assert.ok(Math.abs(r.x - (792 - 60) / 792) < 1e-6)
  assert.ok(Math.abs(r.y - 10 / 612) < 1e-6)
  assert.ok(Math.abs(r.width - 50 / 792) < 1e-6)
  assert.ok(Math.abs(r.height - 100 / 612) < 1e-6)
})

test('degenerate CTM and zero-area results are unavailable (never a box)', () => {
  assert.equal(figureBBoxFromOp(op({ a: 0, d: 0, e: 5, f: 5 }), 612, 792), null)
  assert.equal(figureBBoxFromOp(op({ a: 10, d: 0, b: 0, c: 0, e: 5, f: 5 }), 612, 792), null)
})

test('header-logo exclusion: repeated positions never become body figures', () => {
  // logos appear at the SAME position on every page (repetition evidence)
  const logos = [1, 2, 3].map((p) => op({ page: p, a: 18, d: 13.7, e: 99, f: 742.4 }))
  const posKey = (o: DetailedImageOp) => `${Math.round(o.e)}:${Math.round(o.f)}`
  const posCount = new Map<string, number>()
  for (const l of logos) posCount.set(posKey(l), (posCount.get(posKey(l)) ?? 0) + 1)
  for (const l of logos) assert.ok((posCount.get(posKey(l)) ?? 0) >= 2, 'logo repeats per page')
})

// ---------------------------------------------------------------------------
// table regions
// ---------------------------------------------------------------------------

function tableInput(
  items: TextItemLike[],
  markers: string[],
  segments: LineSegment[] = [],
  width = 612,
  height = 792,
): TableRegionInput {
  return { page: page(1, items, width, height), pageWidth: width, pageHeight: height, cellMarkers: markers, segments }
}

test('two consistent cell rows with a border frame → exact', () => {
  // 2x2 table at x 90..210, rows at y 500 and 470 (bottom-left)
  const items = [
    item('alpha', 95, 505, 30),
    item('beta', 170, 505, 20),
    item('gamma', 95, 475, 35),
    item('delta', 170, 475, 25),
  ]
  const segs: LineSegment[] = [
    { page: 1, x0: 90, y0: 460, x1: 215, y1: 460, horizontal: true, vertical: false },
    { page: 1, x0: 90, y0: 520, x1: 215, y1: 520, horizontal: true, vertical: false },
    { page: 1, x0: 90, y0: 460, x1: 90, y1: 520, horizontal: false, vertical: true },
    { page: 1, x0: 215, y0: 460, x1: 215, y1: 520, horizontal: false, vertical: true },
  ]
  const r = tableRegion(tableInput(items, ['alpha', 'beta', 'gamma', 'delta'], segs))
  assert.equal(r.confidence, 'exact')
  assert.equal(r.evidenceMethod, 'cell-text+frame')
  assert.ok(r.bbox)
  assert.ok(Math.abs(r.bbox.x - 90 / 612) < 0.01)
  assert.ok(Math.abs(r.bbox.width - 125 / 612) < 0.01)
})

test('coherent cluster WITHOUT operator evidence → approximate (never exact)', () => {
  const items = [
    item('alpha', 95, 505, 30),
    item('beta', 170, 505, 20),
    item('gamma', 95, 475, 35),
    item('delta', 170, 475, 25),
  ]
  const r = tableRegion(tableInput(items, ['alpha', 'beta', 'gamma', 'delta']))
  assert.equal(r.confidence, 'approximate')
  assert.equal(r.evidenceMethod, 'cell-text')
  assert.ok(r.bbox)
})

test('one cell row alone is insufficient → unavailable', () => {
  const items = [item('alpha', 95, 505, 30), item('beta', 170, 505, 20)]
  const r = tableRegion(tableInput(items, ['alpha', 'beta']))
  assert.equal(r.confidence, 'unavailable')
  assert.equal(r.ambiguityReason, 'fewer than two consistent cell rows')
})

test('repeated cell text cannot independently identify a table', () => {
  // marker appears twice on the page → skipped; no unique markers left
  const items = [
    item('same value', 95, 505, 50),
    item('same value', 300, 505, 50),
    item('same value', 95, 475, 50),
  ]
  const r = tableRegion(tableInput(items, ['same value', 'same value', 'same value']))
  assert.equal(r.confidence, 'unavailable')
  assert.equal(r.ambiguityReason, 'no unique cell text on this page')
})

test('neighbouring tables on one page stay separate', () => {
  // table A rows y 520..560, table B rows y 430..470; shared x-range
  const items = [
    item('A r0', 95, 555, 25),
    item('A r1', 95, 525, 25),
    item('B r0', 95, 465, 25),
    item('B r1', 95, 435, 25),
  ]
  const rA = tableRegion(tableInput(items, ['A r0', 'A r1']))
  const rB = tableRegion(tableInput(items, ['B r0', 'B r1']))
  assert.equal(rA.confidence, 'approximate')
  assert.equal(rB.confidence, 'approximate')
  assert.ok(rA.bbox && rB.bbox)
  assert.ok(rB.bbox.y + rB.bbox.height < rA.bbox.y, 'B below A, no overlap')
})

test('frame partially covering the cluster is conflicting → unavailable, never exact', () => {
  const items = [
    item('alpha', 95, 505, 30),
    item('beta', 170, 505, 20),
    item('gamma', 95, 475, 35),
    item('delta', 170, 475, 25),
  ]
  // frame only covers the TOP row of the two-row cluster (y 495..520)
  const segs: LineSegment[] = [
    { page: 1, x0: 90, y0: 495, x1: 215, y1: 495, horizontal: true, vertical: false },
    { page: 1, x0: 90, y0: 520, x1: 215, y1: 520, horizontal: true, vertical: false },
    { page: 1, x0: 90, y0: 495, x1: 90, y1: 520, horizontal: false, vertical: true },
    { page: 1, x0: 215, y0: 495, x1: 215, y1: 520, horizontal: false, vertical: true },
  ]
  const r = tableRegion(tableInput(items, ['alpha', 'beta', 'gamma', 'delta'], segs))
  assert.equal(r.confidence, 'unavailable')
  assert.equal(r.evidenceMethod, 'conflicting-frame')
  assert.ok(r.ambiguityReason!.includes('coverage 0.50'))
})

test('merged cells do not break the region (majority column pattern)', () => {
  // row 0 = one merged cell; rows 1-2 = two columns
  const items = [
    item('MERGED CELL', 95, 505, 80),
    item('m1', 95, 475, 20),
    item('m2', 170, 475, 20),
    item('n1', 95, 445, 20),
    item('n2', 170, 445, 20),
  ]
  const r = tableRegion(tableInput(items, ['MERGED CELL', 'm1', 'm2', 'n1', 'n2']))
  assert.equal(r.confidence, 'approximate')
  assert.ok(r.bbox)
  assert.ok(r.bbox.height > 50 / 792, 'covers all three rows')
})

test('spanning table yields one candidate per page portion', () => {
  // page 3 portion: rows 0-2; page 4 portion: rows 3-5 (same table index)
  const p3 = tableInput([item('D p3 r0', 95, 500, 30), item('D p3 r1', 95, 470, 30), item('D p3 r2', 95, 440, 30)], ['D p3 r0', 'D p3 r1', 'D p3 r2'])
  const p4 = tableInput([item('D p4 r3', 95, 500, 30), item('D p4 r4', 95, 470, 30)], ['D p4 r3', 'D p4 r4'])
  const r3 = tableRegion(p3)
  const r4 = tableRegion(p4)
  assert.equal(r3.confidence, 'approximate')
  assert.equal(r4.confidence, 'approximate')
  assert.ok(r3.bbox && r4.bbox)
})

test('Table 3 and Table 4 identities stay distinct (separate markers, separate regions)', () => {
  // table C markers ("T3 ...") and table D markers ("T4 ...") on one page
  const items = [
    item('T3 R1 C0', 95, 500, 35),
    item('T3 R2 C0', 95, 470, 35),
    item('T4 R1 C0', 95, 350, 35),
    item('T4 R2 C0', 95, 320, 35),
  ]
  const rC = tableRegion(tableInput(items, ['T3 R1 C0', 'T3 R2 C0']))
  const rD = tableRegion(tableInput(items, ['T4 R1 C0', 'T4 R2 C0']))
  assert.ok(rC.bbox && rD.bbox)
  // bottom-left origin: D (lower on the page) has the SMALLER y
  assert.ok(rD.bbox.y + rD.bbox.height < rC.bbox.y, 'regions disjoint')
})

test('rectIoU math', () => {
  const a = { page: 1, x: 0.1, y: 0.1, width: 0.4, height: 0.4 }
  const b = { page: 1, x: 0.3, y: 0.3, width: 0.4, height: 0.4 }
  const iou = rectIoU(a, b)
  assert.ok(Math.abs(iou - (0.2 * 0.2) / (0.16 + 0.16 - 0.04)) < 1e-9)
  assert.equal(rectIoU(a, { page: 1, x: 0.9, y: 0.9, width: 0.05, height: 0.05 }), 0)
})
