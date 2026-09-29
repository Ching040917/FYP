/**
 * Pure fit-page / fit-width scale math for the rendered PDF viewer.
 *
 * `ZOOM_MIN`/`ZOOM_MAX` bound MANUAL zoom only. Fit modes are bounded by the
 * safe maximum alone: a fit scale may go below `ZOOM_MIN` when the viewport is
 * small, because raising it back to the manual minimum would crop the page
 * (Fit page) or overflow the rendering viewport (Fit width). Aspect ratio is
 * preserved by construction — both formulas are a single uniform scale factor.
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
 * padding/scrollbar allowance). Returns `min(width-fit, height-fit)` capped at
 * the safe maximum so the COMPLETE page is shown — never raised to `ZOOM_MIN`.
 * The result is independent of the page number — switching pages or fit modes
 * never resets anything else.
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
  return Math.min(ZOOM_MAX, s)
}

/**
 * Fit-width scale — width-fit only (vertical scrolling is expected). Capped at
 * the safe maximum and NOT raised to `ZOOM_MIN`: in a narrow rendering viewport
 * the manual minimum would make the page wider than the container and force
 * horizontal scrolling.
 */
export function fitWidthScale(pageWidthPt: number, viewportW: number): number {
  if (pageWidthPt <= 0 || viewportW <= 0) return 1
  return Math.min(ZOOM_MAX, viewportW / pageWidthPt)
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
