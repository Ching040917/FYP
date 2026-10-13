/**
 * General paragraph-evidence resolver — ONE contract for every
 * paragraph-based finding that is not covered by exact span highlighting.
 *
 * Tier policy (locked):
 * - Citation span overlay: only the four CITATION_* codes in
 *   CITATION_SPAN_CODES, only with a source-faithful snippet, only on a
 *   single on-page occurrence (see citation-highlight.ts).
 * - Paragraph envelope: every other paragraph-scoped finding, including
 *   all REFERENCE_* findings. Long Reference entry text NEVER enters the
 *   span matcher — the enclosing paragraph region from real line geometry
 *   is the truthful unit.
 * - Document-level root findings (`missing_references_section === true`)
 *   are explicitly denied an overlay even when they carry a valid
 *   paragraph_index: that index anchors the first citation for navigation
 *   context, but it is NOT evidence for the document-wide cause.
 *
 * Pure logic: no I/O, no network, no storage. Never throws, never guesses.
 */
import { paragraphRegion, REGION_UNAVAILABLE_MESSAGE } from './formatting-highlight.ts'
import { friendlyParagraphLocation } from './finding-navigation.ts'
import { friendlyRuleTitle } from '../friendly-finding.ts'
import type { BlockLike, BlockMapping, PageText } from './paragraph-mapping.ts'
import type { CitationRect } from './citation-highlight.ts'
import type { MeasureText } from './pdf-measure.ts'
import { measurePdfText } from './pdf-measure.ts'

export interface ParagraphFindingLike {
  id: string
  ruleCode?: string | null
  message?: string | null
  location?: Record<string, unknown> | null
}

export interface ParagraphEvidenceBundle {
  byIndex: Map<number, BlockMapping>
  pages: PageText[]
  blocks?: BlockLike[]
}

export interface ParagraphEvidenceResult {
  /** 'paragraph' with rects, or 'none' when no overlay is truthful. */
  kind: 'paragraph' | 'none'
  pageRects: CitationRect[]
  label: string | null
  /** Truthful message when navigation succeeds but no region exists. */
  message: string | null
}

/** Document-level root findings never receive an overlay. */
export const DOCUMENT_ROOT_NO_OVERLAY_MESSAGE =
  'This finding covers the whole document: add a References section. No single paragraph is highlighted as evidence.'

/** True for the document-level missing-References root finding. */
export function isDocumentLevelRoot(location: Record<string, unknown> | null | undefined): boolean {
  return (location ?? {}).missing_references_section === true
}

function getParagraphIndex(location: Record<string, unknown> | null | undefined): number | null {
  const n = location?.paragraph_index
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * Resolve the paragraph-envelope overlay for a selected finding.
 * Consolidated findings resolve to the primary (first) paragraph only —
 * `paragraph_indexes` never fans out into simultaneous overlays.
 */
export function resolveParagraphEvidence(
  finding: ParagraphFindingLike,
  bundle: ParagraphEvidenceBundle | null | undefined,
  measure: MeasureText = measurePdfText,
): ParagraphEvidenceResult {
  const none = (message: string | null): ParagraphEvidenceResult => ({
    kind: 'none',
    pageRects: [],
    label: null,
    message,
  })
  if (!bundle) return none(null)
  // Root denial FIRST: a valid paragraph_index on a document-level finding
  // is navigation context, never overlay evidence.
  if (isDocumentLevelRoot(finding.location)) {
    return none(DOCUMENT_ROOT_NO_OVERLAY_MESSAGE)
  }
  const paraIndex = getParagraphIndex(finding.location)
  if (paraIndex === null) return none(null)

  const mapped = bundle.byIndex.get(paraIndex)
  if (!mapped || mapped.pageNumber === null) return none(null)

  const page = bundle.pages.find((p) => p.pageNumber === mapped.pageNumber)
  if (!page) return none(null)

  const locPart = friendlyParagraphLocation(paraIndex, mapped) ?? ''
  const label = `${friendlyRuleTitle(finding.ruleCode) ?? 'Finding'} · ${locPart}`
  const region = paragraphRegion(bundle, paraIndex, measure)
  if (region && region.length > 0) {
    return { kind: 'paragraph', pageRects: region, label, message: null }
  }
  return { kind: 'paragraph', pageRects: [], label, message: REGION_UNAVAILABLE_MESSAGE }
}
