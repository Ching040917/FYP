/**
 * Conservative table-page resolution for TABLE_CAPTION_MISSING.
 *
 * The page is resolved from matching SAME-PAGE boundary anchors. No table
 * bounding geometry is available, so this is a *resolved navigation page*,
 * never an authoritative physical table page.
 *
 * Contract (mirrored in backend/app/services/table_page_resolution.py):
 *
 *   both anchors mapped, SAME page          -> resolved page = that page
 *   both anchors mapped, adjacent pages      -> unavailable (never a span guess)
 *   both anchors mapped, any other gap       -> unavailable
 *   only one anchor mapped                   -> unavailable
 *   neither anchor mapped                    -> unavailable
 *
 * The ONLY resolving case is both anchors on the same physical page. A
 * truthful "unavailable" is always preferable to a guessed page.
 *
 * Legacy audits (no persisted anchors) have NO authoritative backend evidence.
 * Their surrounding-block window may resolve ONLY under the identical strict
 * same-page rule: both reliable boundary paragraphs must map to one page.
 * A different page, one-sided evidence, empty evidence, or an ambiguous
 * multi-page window is unavailable.
 */
import type { BlockMapping } from './paragraph-mapping.ts'

export type TablePageEvidenceReason =
  | 'resolved'
  | 'inconsistent-surroundings'
  | 'missing-boundary'
  | 'no-evidence'

export interface TablePageResolution {
  /** Resolved one-based page, or null when the evidence proves no single page. */
  page: number | null
  reason: TablePageEvidenceReason
}

const UNAVAILABLE_NO_EVIDENCE: TablePageResolution = { page: null, reason: 'no-evidence' }

function pageOf(index: unknown, byIndex: Map<number, BlockMapping> | null | undefined): number | null {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
  const mapped = byIndex?.get(index)
  const page = mapped?.pageNumber ?? null
  return typeof page === 'number' && page >= 1 ? page : null
}

/**
 * Resolve the page for a finding carrying both persisted anchors.
 * Returns `resolved` only when BOTH anchors map to the SAME page.
 */
export function resolveTablePageFromAnchors(
  location: Record<string, unknown> | null | undefined,
  byIndex: Map<number, BlockMapping> | null | undefined,
): TablePageResolution {
  if (!location) return UNAVAILABLE_NO_EVIDENCE
  const prevPage = pageOf(location.previous_anchor_paragraph_index, byIndex)
  const nextPage = pageOf(location.next_anchor_paragraph_index, byIndex)

  if (prevPage === null && nextPage === null) return UNAVAILABLE_NO_EVIDENCE
  if (prevPage === null || nextPage === null) return { page: null, reason: 'missing-boundary' }
  if (prevPage !== nextPage) return { page: null, reason: 'inconsistent-surroundings' }
  return { page: prevPage, reason: 'resolved' }
}

/**
 * Legacy path for audits WITHOUT persisted anchors.
 *
 * `windowPages` are the mapped pages of the reliable surrounding blocks
 * (between the bracketing caption anchors). Strict same-page rule only:
 * every reliable surrounding block on one page → that page; otherwise
 * unavailable. A multi-page window never resolves.
 */
export function resolveTablePageFromSurroundings(
  windowPages: number[],
): TablePageResolution {
  const reliable = windowPages.filter((p) => typeof p === 'number' && p >= 1)
  if (reliable.length === 0) return UNAVAILABLE_NO_EVIDENCE
  const unique = new Set(reliable)
  if (unique.size !== 1) return { page: null, reason: 'inconsistent-surroundings' }
  const [only] = unique
  return { page: only, reason: 'resolved' }
}

/** True when the finding carries at least one persisted anchor key. */
export function hasPersistedAnchors(location: Record<string, unknown> | null | undefined): boolean {
  if (!location) return false
  return (
    location.previous_anchor_paragraph_index !== undefined ||
    location.next_anchor_paragraph_index !== undefined
  )
}
