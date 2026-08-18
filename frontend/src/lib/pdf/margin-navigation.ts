/**
 * Margin finding navigation + page-edge marker resolution (Build: Margin
 * page-edge markers).
 *
 * Navigation turns a MARGIN_* finding into a rendered-page navigation
 * decision using the authoritative `location.section_index` and the
 * verified section mapping (SectionRange from section-mapping.ts).
 *
 * Marker resolution decides whether a subtle page-edge band should render
 * on the currently viewed page:
 *   - only for a supported MARGIN_* rule;
 *   - only when the section mapping confidence is EXACT;
 *   - only when the current page is inside the exact affected range;
 *   - side derived safely from the rule code.
 * Approximate, unavailable, historical-null, and out-of-range pages never
 * render a marker.
 *
 * The marker indicates WHICH page edge has a problem — it never visualizes
 * the measured margin width, the required width, or the correction amount.
 * Expected and Actual values remain in Finding Details.
 */
import type { SectionRange } from './section-mapping.ts'

export const MARGIN_RULES: ReadonlySet<string> = new Set([
  'MARGIN_LEFT',
  'MARGIN_RIGHT',
  'MARGIN_TOP',
  'MARGIN_BOTTOM',
])

/** Friendly one-based margin side labels. */
export const MARGIN_SIDE_LABELS: Record<string, string> = {
  MARGIN_LEFT: 'Left margin',
  MARGIN_RIGHT: 'Right margin',
  MARGIN_TOP: 'Top margin',
  MARGIN_BOTTOM: 'Bottom margin',
}

/** Marker side for a rule code — safe default 'left' for unknown rules. */
export type MarginMarkerSide = 'left' | 'right' | 'top' | 'bottom'

const MARGIN_SIDE_MAP: Record<string, MarginMarkerSide> = {
  MARGIN_LEFT: 'left',
  MARGIN_RIGHT: 'right',
  MARGIN_TOP: 'top',
  MARGIN_BOTTOM: 'bottom',
}

export function marginMarkerSide(ruleCode: string): MarginMarkerSide {
  return MARGIN_SIDE_MAP[ruleCode] ?? 'left'
}

export const MARGIN_UNAVAILABLE_MESSAGE =
  'Exact page range is unavailable. Review the section details in Finding Details.'
export const MARGIN_APPROX_MESSAGE = 'Exact page range unavailable'

export interface MarginNavigationDecision {
  /** Navigate to this page (one-based) or null to keep the view stable. */
  navigatePage: number | null
  /** Compact viewer chip label, or null when nothing to show. */
  chipLabel: string | null
  /** Truthful limitation message when the range is not exact. */
  message: string | null
  /** Row label (`Page N · Section M · Left margin` style). */
  rowLabel: string | null
}

export function marginSideLabel(ruleCode: string): string {
  return MARGIN_SIDE_LABELS[ruleCode] ?? 'Page margin'
}

/**
 * Resolve a margin finding's navigation from its section range.
 * `sectionIndex` is authoritative; `range` may be null when the section
 * mapping is unavailable or not yet loaded.
 */
export function resolveMarginNavigation(
  ruleCode: string,
  sectionIndex: number,
  range: SectionRange | null | undefined,
): MarginNavigationDecision {
  const side = marginSideLabel(ruleCode)
  const sectionLabel = `Section ${sectionIndex + 1}`

  if (!range || range.confidence === 'unavailable' || range.startPage === null) {
    return {
      navigatePage: null,
      chipLabel: null,
      message: MARGIN_UNAVAILABLE_MESSAGE,
      rowLabel: `${sectionLabel} · Page unavailable`,
    }
  }

  if (range.confidence === 'exact' && range.endPage !== null) {
    const samePage = range.endPage === range.startPage
    const pageLabel = samePage
      ? `Page ${range.startPage}`
      : `Pages ${range.startPage}–${range.endPage}`
    return {
      navigatePage: range.startPage,
      chipLabel: `${sectionLabel} · ${pageLabel} · ${side}`,
      message: null,
      rowLabel: `Page ${range.startPage} · ${sectionLabel} · ${side}`,
    }
  }

  // Approximate: proven start page only.
  return {
    navigatePage: range.startPage,
    chipLabel: `${sectionLabel} begins on Page ${range.startPage} · ${MARGIN_APPROX_MESSAGE}`,
    message: MARGIN_APPROX_MESSAGE,
    rowLabel: `${sectionLabel} begins on Page ${range.startPage}`,
  }
}

/** Extract a valid zero-based section_index from a finding location. */
export function sectionIndexOf(location: Record<string, unknown> | null | undefined): number | null {
  const idx = location?.section_index
  return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 ? idx : null
}

// ---------------------------------------------------------------------------
// page-edge marker resolution
// ---------------------------------------------------------------------------

export interface MarginMarkerState {
  /** Marker side on the current page, or null when nothing to render. */
  side: MarginMarkerSide | null
  /** Exact affected page range (one-based) the marker belongs to. */
  startPage: number | null
  endPage: number | null
  /** One-based section number (for the chip). */
  sectionNumber: number | null
  /** Friendly side label (for the chip). */
  sideLabel: string | null
  /** Chip text: `Section 1 · Pages 1–3` / `Section 2 · Page 3`. */
  rangeLabel: string | null
}

export interface MarginMarkerInput {
  ruleCode: string
  sectionIndex: number
  range: SectionRange | null | undefined
  /** The currently rendered page (one-based). */
  currentPage: number
}

/** True when the exact range covers the given page. */
export function rangeCoversPage(range: SectionRange, page: number): boolean {
  return (
    range.confidence === 'exact' &&
    range.startPage !== null &&
    range.endPage !== null &&
    page >= range.startPage &&
    page <= range.endPage
  )
}

/**
 * Resolve the page-edge marker for the current page. Returns a marker only
 * when every eligibility rule passes; otherwise side is null (nothing to
 * render). Never throws.
 */
export function resolveMarginMarker(input: MarginMarkerInput): MarginMarkerState {
  const { ruleCode, sectionIndex, range, currentPage } = input
  const noMarker: MarginMarkerState = {
    side: null,
    startPage: null,
    endPage: null,
    sectionNumber: null,
    sideLabel: null,
    rangeLabel: null,
  }

  // 1. Supported rule + valid section index.
  if (!MARGIN_RULES.has(ruleCode)) return noMarker
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0) return noMarker

  // 2. Exact range only (approximate/unavailable/null → no marker).
  if (!range || range.confidence !== 'exact' || range.startPage === null || range.endPage === null) {
    return noMarker
  }

  // 3. Current page must be inside the affected range.
  if (!rangeCoversPage(range, currentPage)) return noMarker

  const side = marginMarkerSide(ruleCode)
  const sideLabel = marginSideLabel(ruleCode)
  const sectionNumber = sectionIndex + 1
  const samePage = range.endPage === range.startPage
  const rangeLabel = samePage
    ? `Section ${sectionNumber} · Page ${range.startPage}`
    : `Section ${sectionNumber} · Pages ${range.startPage}–${range.endPage}`

  return { side, startPage: range.startPage, endPage: range.endPage, sectionNumber, sideLabel, rangeLabel }
}

/**
 * Chip label for a marker state: `Selected margin: Right margin · Section 1
 * · Pages 1–3`. Returns null when there is no marker to announce.
 */
export function marginMarkerChip(state: MarginMarkerState): string | null {
  if (!state.side || !state.sideLabel || !state.rangeLabel) return null
  return `${state.sideLabel} · ${state.rangeLabel}`
}
