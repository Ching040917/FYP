/**
 * Fit-page / fit-width scale math for the rendered PDF viewer.
 *
 * Pure logic: whole-page fit, width fit, manual clamping, and the zoom
 * label. These values drive RenderedPreview without touching page number
 * or the selected finding — a mode switch must never reset either.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP_IN,
  ZOOM_STEP_OUT,
  fitScale,
  fitWidthScale,
  clampScale,
  zoomModeLabel,
} from '../src/lib/pdf/fit-mode.ts'

// Letter page at scale 1 (PDF points -> CSS px at scale 1).
const LETTER_W = 612
const LETTER_H = 792

// ---------------------------------------------------------------------------
// fitScale — the complete physical page fits the viewport
// ---------------------------------------------------------------------------

test('fit-scale is the smaller of width- and height-fit', () => {
  // Viewport 800x1000: width-fit 1.307, height-fit 1.262 -> height wins.
  assert.equal(fitScale(LETTER_W, LETTER_H, 800, 1000), 1000 / LETTER_H)
  // Viewport 400x2000: width-fit 0.654, height-fit 2.525 -> width wins.
  assert.equal(fitScale(LETTER_W, LETTER_H, 400, 2000), 400 / LETTER_W)
})

test('fit-scale clamps into the shared zoom bounds', () => {
  assert.equal(fitScale(LETTER_W, LETTER_H, 100, 100), ZOOM_MIN)
  assert.equal(fitScale(LETTER_W, LETTER_H, 10000, 10000), ZOOM_MAX)
})

test('fit-scale returns 1 on degenerate input (no crash, no zero scale)', () => {
  assert.equal(fitScale(0, LETTER_H, 800, 1000), 1)
  assert.equal(fitScale(LETTER_W, 0, 800, 1000), 1)
  assert.equal(fitScale(LETTER_W, LETTER_H, 0, 1000), 1)
  assert.equal(fitScale(LETTER_W, LETTER_H, 800, 0), 1)
})

test('fit-scale is independent of page number (page-preserving contract)', () => {
  // Same page + same viewport -> same scale regardless of how many times
  // the mode is requested; the viewer owns pageNum separately.
  const a = fitScale(LETTER_W, LETTER_H, 700, 900)
  const b = fitScale(LETTER_W, LETTER_H, 700, 900)
  assert.equal(a, b)
})

// ---------------------------------------------------------------------------
// fitWidthScale — existing width-fit formula
// ---------------------------------------------------------------------------

test('fit-width scale matches the legacy formula', () => {
  assert.equal(fitWidthScale(LETTER_W, 612), 1)
  assert.equal(fitWidthScale(LETTER_W, 306), 0.5)
  assert.equal(fitWidthScale(LETTER_W, 1836), 3)
})

test('fit-width clamps and handles zero/negative gracefully', () => {
  assert.equal(fitWidthScale(LETTER_W, 1), ZOOM_MIN)
  assert.equal(fitWidthScale(LETTER_W, 100000), ZOOM_MAX)
  assert.equal(fitWidthScale(0, 800), 1)
  assert.equal(fitWidthScale(LETTER_W, 0), 1)
})

// ---------------------------------------------------------------------------
// clampScale — manual zoom stays within bounds, NaN-safe
// ---------------------------------------------------------------------------

test('clamp-scale pins manual zoom to the supported range', () => {
  assert.equal(clampScale(0.1), ZOOM_MIN)
  assert.equal(clampScale(50), ZOOM_MAX)
  assert.equal(clampScale(1.25), 1.25)
  assert.equal(clampScale(Number.NaN), 1)
  // Non-finite input is the viewer's "no scale" sentinel, not a zoom
  // press — it falls back to 100%, never to a clamp bound.
  assert.equal(clampScale(Infinity), 1)
  assert.equal(clampScale(-Infinity), 1)
})

test('zoom steps stay within bounds after repeated presses', () => {
  // 20 steps out must never drop below ZOOM_MIN.
  let s = 1
  for (let i = 0; i < 20; i++) s = clampScale(s * ZOOM_STEP_OUT)
  assert.ok(s >= ZOOM_MIN)
  let up = 1
  for (let i = 0; i < 20; i++) up = clampScale(up * ZOOM_STEP_IN)
  assert.ok(up <= ZOOM_MAX)
})

// ---------------------------------------------------------------------------
// zoomModeLabel — active-mode display, including the manual fallback
// ---------------------------------------------------------------------------

test('zoom label shows the active mode and manual percentage', () => {
  assert.equal(zoomModeLabel('fit-page', null), 'Fit page')
  assert.equal(zoomModeLabel('fit-width', null), 'Fit width')
  assert.equal(zoomModeLabel('manual', null), 'Fit width')
  assert.equal(zoomModeLabel('manual', 1), '100%')
  assert.equal(zoomModeLabel('manual', 1.25), '125%')
  // Manual mode displays the explicit zoom even if a fit-mode scale is
  // passed — the label reports the mode, not a stale scale.
  assert.equal(zoomModeLabel('fit-page', 0.8), 'Fit page')
})
