/**
 * PDF text measurement for citation geometry (proportional fonts).
 *
 * Measured glyph-prefix widths replace equal-character interpolation:
 * the citation start/end positions inside a TextItem are derived from the
 * ratio of measured prefix width to measured full-item width, then scaled
 * by the item's REAL advance width from the PDF text layer.
 *
 * Browser: canvas 2D measureText with the item's font size (Times family —
 * the SUC preset font) — real glyph advances, kerning included.
 * Node/tests: uniform advance fallback so pure geometry tests stay
 * deterministic without a canvas; tests may inject their own proportional
 * model.
 */
export type MeasureText = (text: string, fontSize: number) => number

let canvasCtx: CanvasRenderingContext2D | null = null

export const measurePdfText: MeasureText = (text, fontSize) => {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return text.length * 0.5 * fontSize // uniform fallback (Node)
  }
  if (!canvasCtx) {
    canvasCtx = document.createElement('canvas').getContext('2d')
  }
  if (!canvasCtx) return text.length * 0.5 * fontSize
  canvasCtx.font = `${fontSize}px Times, 'Times New Roman', serif`
  return canvasCtx.measureText(text).width
}
