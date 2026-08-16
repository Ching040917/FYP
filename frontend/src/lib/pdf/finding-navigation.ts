/**
 * Finding-to-page navigation decisions (pure logic).
 *
 * Every finding is first CLASSIFIED by its location target:
 *   - 'paragraph' — pure paragraph targets (font/size/typography/heading/
 *     citation findings). These may navigate via the paragraph mapping.
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
import type { BlockMapping, MappingConfidence } from './paragraph-mapping.ts'

export type FindingTargetType = 'paragraph' | 'object' | 'none'

export type FindingLike = {
  id: string
  location?: Record<string, unknown> | null
}

export type NavigationDecision = {
  /** 'rendered' → switch to Rendered Pages and go to `pageNumber`. */
  mode: 'rendered' | 'text'
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
  const n = finding.location?.paragraph_index
  return typeof n === 'number' && n >= 0 ? n : null
}

export function resolveFindingNavigation(
  finding: FindingLike,
  mappingByIndex: Map<number, BlockMapping> | null | undefined,
): NavigationDecision {
  const target = classifyFindingTarget(finding)

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

  const paragraphNumber = paraIndex + 1

  if (mapped.confidence === 'unavailable' || mapped.pageNumber === null) {
    // Empty paragraphs and genuinely unmatched paragraphs are never guessed.
    return { mode: 'text', pageNumber: null, locationLabel: `Paragraph ${paragraphNumber} · Page unavailable` }
  }

  const paragraphOnPage = mapped.paragraphOnPage ?? null
  const locationLabel =
    paragraphOnPage === null
      ? `Page ${mapped.pageNumber}`
      : `Page ${mapped.pageNumber} · Paragraph ${paragraphOnPage}`

  return { mode: 'rendered', pageNumber: mapped.pageNumber, locationLabel }
}

/** True when the mapping confidence allows page navigation. */
export function isNavigable(confidence: MappingConfidence | undefined): boolean {
  return confidence === 'exact' || confidence === 'approximate'
}
