/**
 * Finding-to-page navigation decisions (pure logic).
 *
 * Every finding is first CLASSIFIED by its location target:
 *   - 'paragraph' — pure paragraph targets (font/size/typography/heading/
 *     citation findings). These may navigate via the paragraph mapping.
 *   - 'structural' — stored Header/Footer definitions, never physical pages.
 *   - 'object' — table/figure/section/margin targets. These are NEVER
 *     forced through paragraph mapping, even when their location also
 *     carries a paragraph_index (image findings record their host
 *     paragraph) — the mapping result would be meaningless for them.
 *   - 'none' — no usable identity at all.
 *
 * Paragraph findings: map only when the completed mapping is exact or
 * approximate; a completed unavailable result is the ONLY case that falls
 * back to Extracted Text. Confidence terminology never surfaces.
 */
import { isPageElementRule, structuralStoryLabel } from '../audit/page-elements.ts'
import type { BlockMapping, MappingConfidence } from './paragraph-mapping.ts'

export type FindingTargetType = 'paragraph' | 'object' | 'structural' | 'none'

export type FindingLike = {
  id: string
  rule_code?: string
  ruleCode?: string
  location?: Record<string, unknown> | null
}

export type NavigationDecision = {
  /** 'preserve' leaves both the preview mode and current page unchanged. */
  mode: 'rendered' | 'text' | 'preserve'
  pageNumber: number | null
  /**
   * User-facing location label, or null when the finding keeps its
   * existing truthful label (object findings, mapping loading).
   */
  locationLabel: string | null
}

/**
 * Object-level identity keys. Findings carrying any of these target a
 * table/figure/section — never a paragraph, regardless of other fields.
 */
const OBJECT_KEYS = ['table_index', 'image_index', 'section_index'] as const

export function classifyFindingTarget(finding: FindingLike): FindingTargetType {
  if (
    finding.location?.structural_story === true ||
    isPageElementRule(finding.rule_code ?? finding.ruleCode ?? '')
  ) return 'structural'
  const location = finding.location
  if (!location) return 'none'
  for (const key of OBJECT_KEYS) {
    if (location[key] !== undefined && location[key] !== null) return 'object'
  }
  const n = location.paragraph_index
  if (typeof n === 'number' && n >= 0) return 'paragraph'
  return 'none'
}

export function getParagraphIndex(finding: FindingLike): number | null {
  if (classifyFindingTarget(finding) === 'structural') return null
  const n = finding.location?.paragraph_index
  return typeof n === 'number' && n >= 0 ? n : null
}

export function resolveFindingNavigation(
  finding: FindingLike,
  mappingByIndex: Map<number, BlockMapping> | null | undefined,
): NavigationDecision {
  const target = classifyFindingTarget(finding)

  if (target === 'structural') {
    return {
      mode: 'preserve',
      pageNumber: null,
      locationLabel: structuralStoryLabel(finding.location ?? {}),
    }
  }

  // Object findings (table/figure/section/margin) are never forced through
  // paragraph mapping — even with a paragraph_index in their location.
  if (target === 'object') {
    return { mode: 'text', pageNumber: null, locationLabel: null }
  }

  const paraIndex = getParagraphIndex(finding)
  if (target === 'none' || paraIndex === null) {
    return { mode: 'text', pageNumber: null, locationLabel: null }
  }

  // Mapping not ready (loading/idle): no page claims yet.
  const mapped = mappingByIndex?.get(paraIndex)
  if (!mapped) {
    return { mode: 'text', pageNumber: null, locationLabel: null }
  }

  if (mapped.confidence === 'unavailable' || mapped.pageNumber === null) {
    // Empty and genuinely unmatched paragraphs are never guessed. The
    // document-wide index stays explicitly labelled "Document paragraph N".
    return {
      mode: 'text',
      pageNumber: null,
      locationLabel: friendlyParagraphLocation(paraIndex, mapped),
    }
  }

  return {
    mode: 'rendered',
    pageNumber: mapped.pageNumber,
    locationLabel: friendlyParagraphLocation(paraIndex, mapped),
  }
}

/**
 * THE friendly paragraph location — one string for every surface.
 *
 * The Findings card, the selected-evidence chip and Finding Details all
 * render THIS value, so they cannot disagree. The paragraph number is the
 * ON-PAGE position from the rendered mapping; the document-wide
 * `paragraph_index` is never shown bare, because "Paragraph 65" reads like
 * an on-page number while the mapping says "Paragraph 3".
 *
 *   rendered mapping, on-page position known → "Page 9 · Paragraph 3"
 *   rendered mapping, only the page known    → "Page 9"
 *   persisted page only (no rendered mapping)→ "Page 3 · Document paragraph 65"
 *   no mapping at all                        → "Document paragraph 65"
 *   mapping completed, paragraph unmatched   → "Document paragraph 65 · Page unavailable"
 *
 * `persistedPage` is the historical `paragraph_page_mapping` fallback used
 * when the rendered preview is unavailable; it carries a page but no
 * on-page ordinal, so the paragraph half stays explicitly document-wide.
 */
export function friendlyParagraphLocation(
  paragraphIndex: number | null | undefined,
  mapped?: BlockMapping | null,
  persistedPage?: number | null,
): string | null {
  // "Document paragraph 65" — the unambiguous document-wide identity. The
  // name keeps the two number spaces ("Paragraph 3" on page 9 vs the 65th
  // paragraph of the document) from ever being confused in the UI.
  const documentWide =
    typeof paragraphIndex === 'number' && paragraphIndex >= 0
      ? `Document paragraph ${paragraphIndex + 1}`
      : null

  if (mapped) {
    if (mapped.confidence === 'unavailable' || mapped.pageNumber === null) {
      return documentWide === null ? null : `${documentWide} · Page unavailable`
    }
    const onPage = mapped.paragraphOnPage
    return onPage === null || onPage === undefined
      ? `Page ${mapped.pageNumber}`
      : `Page ${mapped.pageNumber} · Paragraph ${onPage}`
  }

  if (persistedPage !== null && persistedPage !== undefined) {
    if (documentWide === null) return `Page ${persistedPage}`
    return `Page ${persistedPage} · ${documentWide}`
  }

  return documentWide
}

/** True when the mapping confidence allows page navigation. */
export function isNavigable(confidence: MappingConfidence | undefined): boolean {
  return confidence === 'exact' || confidence === 'approximate'
}
