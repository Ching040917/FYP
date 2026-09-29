/**
 * Pure fit-page / fit-width scale math for the rendered PDF viewer.
 *
 * Reuses the viewer's existing ZOOM bounds and the fit-width formula
 * (width only, no page 1 reset, no re-render loop). `fitScale` returns
 * the page scale that makes the complete physical page fit the preview
 * viewport (the smaller of width- and height-fit), clamped to the same
 * bounds as manual zoom.
 */

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 3
export const ZOOM_STEP_IN = 1.25
export const ZOOM_STEP_OUT = 0.8

export type FitMode = 'fit-width' | 'fit-page' | 'manual'

/**
 * Fit-page scale: the whole page visible in one viewport.
 * `pageWidthPt`/`pageHeightPt` are scale-1 viewport dimensions;
 * `viewportW`/`viewportH` are the available CSS px (container minus
 * padding/scrollbar allowance). The result is independent of the page
 * number — switching pages or fit modes never resets anything else.
 */
export function fitScale(
  pageWidthPt: number,
  pageHeightPt: number,
  viewportW: number,
  viewportH: number,
): number {
  if (pageWidthPt <= 0 || pageHeightPt <= 0 || viewportW <= 0 || viewportH <= 0) {
    return 1
  }
  const s = Math.min(viewportW / pageWidthPt, viewportH / pageHeightPt)
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s))
}

/** Fit-width scale — the exact existing formula (width-fit, vertical scroll expected). */
export function fitWidthScale(pageWidthPt: number, viewportW: number): number {
  if (pageWidthPt <= 0 || viewportW <= 0) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, viewportW / pageWidthPt))
}

/** Clamp a manual scale into the supported range. */
export function clampScale(scale: number): number {
  if (Number.isNaN(scale) || !Number.isFinite(scale)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

/**
 * Display label for the active zoom mode:
 * - fit-page  -> 'Fit page'
 * - fit-width -> 'Fit width'
 * - manual    -> `NNN%` (the explicitly selected zoom; 'Fit width' before
 *   any zoom control has run — matches the legacy default display)
 */
export function zoomModeLabel(mode: FitMode, scale: number | null): string {
  if (mode === 'fit-page') return 'Fit page'
  if (mode === 'fit-width') return 'Fit width'
  return scale === null ? 'Fit width' : `${Math.round(scale * 100)}%`
}
