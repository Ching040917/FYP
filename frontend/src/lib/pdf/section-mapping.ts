/**
 * Section → rendered page-range mapping (PoC, session-only).
 *
 * Maps authoritative DOCX sections (identified by zero-based
 * `section_index`) to real rendered PDF page ranges using the existing
 * paragraph→page mapping. Nothing is persisted; no navigation changes.
 *
 * Mapping rules:
 *   1. `section_index` is authoritative.
 *   2. Use the first and last reliably mapped ELIGIBLE blocks in the
 *      section (empty/image-only paragraphs are skipped; Table/Figure-only
 *      sections may use verified object-page evidence when supplied).
 *   3. Exact requires BOTH boundaries independently proven and monotonic.
 *   4. Approximate = a proven start page but incomplete end evidence.
 *   5. Continuous breaks may share a page → `startsMidPage`/`endsMidPage`.
 *   6. nextPage/oddPage/evenPage may constrain ordering but NEVER override
 *      contradictory rendered evidence.
 *   7. Validation: start ≤ end, pages within the PDF page count, section
 *      ranges stay monotonic, distinct sections never collapse.
 *   8. A single section never becomes Pages 1-N automatically — both
 *      boundaries must be proven by rendered evidence.
 *   9. Unavailable never defaults to Page 1.
 *
 * Resolution is two-phase to avoid recursion:
 *   phase 1 — compute each section's start/end/confidence (no neighbors);
 *   phase 2 — derive mid-page flags + monotonicity from neighbor results.
 */
import type { BlockMapping } from './paragraph-mapping.ts'

export type SectionConfidence = 'exact' | 'approximate' | 'unavailable'

export interface SectionMetadataLike {
  section_index: number
  start_paragraph_index: number | null
  end_paragraph_index: number | null
  break_type: string
  page_width: number | null
  page_height: number | null
  margin_left: number | null
  margin_right: number | null
  margin_top: number | null
  margin_bottom: number | null
}

export interface SectionMapInput {
  sections: SectionMetadataLike[]
  byIndex: Map<number, BlockMapping>
  /** Verified object pages keyed by block index (Table/Figure-only sections). */
  objectPages?: Map<number, number>
  /** Block text by index — distinguishes empty break paragraphs from real
   *  but unmapped content (end-boundary evidence). */
  blockTexts?: Map<number, string>
  /** Total rendered PDF page count (validation). */
  numPages: number
}

export interface SectionRange {
  sectionIndex: number
  startPage: number | null
  endPage: number | null
  affectedPages: number[]
  startsMidPage: boolean
  endsMidPage: boolean
  confidence: SectionConfidence
  evidenceMethod: string
  ambiguityReason: string | null
}

/** A paragraph is eligible when it maps to a page AND has content. */
function eligiblePage(
  byIndex: Map<number, BlockMapping>,
  objectPages: Map<number, number>,
  blockIndex: number,
): number | null {
  const mapped = byIndex.get(blockIndex)
  if (mapped && mapped.pageNumber !== null && mapped.pageNumber > 0) return mapped.pageNumber
  // Empty / image-only / table-only blocks: use verified object-page evidence.
  const objPage = objectPages.get(blockIndex)
  return objPage !== null && objPage !== undefined && objPage > 0 ? objPage : null
}

function pageWithinDoc(page: number, numPages: number): boolean {
  return page >= 1 && page <= numPages
}

/** Range of block indexes [startInclusive, endInclusive] in a section. */
function sectionBlockRange(
  meta: SectionMetadataLike,
  nextStart: number | null,
  maxBlockIndex: number,
): [number, number] | null {
  const start = meta.start_paragraph_index
  if (start === null || start < 0) return null
  const end = meta.end_paragraph_index ?? (nextStart !== null ? nextStart - 1 : maxBlockIndex)
  return [start, Math.max(start, Math.min(end, maxBlockIndex))]
}

function unavailable(
  sectionIndex: number,
  evidenceMethod: string,
  ambiguityReason: string,
): SectionRange {
  return {
    sectionIndex,
    startPage: null,
    endPage: null,
    affectedPages: [],
    startsMidPage: false,
    endsMidPage: false,
    confidence: 'unavailable',
    evidenceMethod,
    ambiguityReason,
  }
}

/** Phase 1: start/end/confidence without neighbor recursion. */
function resolveCore(input: SectionMapInput, meta: SectionMetadataLike): Omit<SectionRange, 'startsMidPage' | 'endsMidPage'> {
  const objectPages = input.objectPages ?? new Map<number, number>()
  const blockTexts = input.blockTexts ?? new Map<number, string>()

  const ordered = [...input.sections].sort((a, b) => a.section_index - b.section_index)
  const selfPos = ordered.findIndex((s) => s.section_index === meta.section_index)
  const nextStart = selfPos >= 0 && selfPos + 1 < ordered.length ? ordered[selfPos + 1].start_paragraph_index : null
  const maxBlockIndex = Math.max(0, ...input.byIndex.keys())
  const range = sectionBlockRange(meta, nextStart, maxBlockIndex)
  if (!range) return unavailable(meta.section_index, 'no-boundaries', 'missing section boundaries')

  const [lo, hi] = range
  const startCandidates: number[] = []
  const endCandidates: number[] = []
  const hasContent = (i: number): boolean => (blockTexts.get(i) ?? '').trim().length > 0
  for (let i = lo; i <= hi; i++) {
    const p = eligiblePage(input.byIndex, objectPages, i)
    if (p !== null) {
      startCandidates.push(p)
      break
    }
  }
  for (let i = hi; i >= lo; i--) {
    if (!hasContent(i) && !input.byIndex.has(i) && !objectPages.has(i)) continue
    const p = eligiblePage(input.byIndex, objectPages, i)
    if (p !== null) {
      endCandidates.push(p)
      break
    }
    if (hasContent(i)) break
  }

  const startPage = startCandidates[0] ?? null
  const endPage = endCandidates[0] ?? null

  if (startPage !== null && !pageWithinDoc(startPage, input.numPages)) {
    return unavailable(meta.section_index, 'start-out-of-range', 'start page outside PDF')
  }
  if (endPage !== null && !pageWithinDoc(endPage, input.numPages)) {
    return unavailable(meta.section_index, 'end-out-of-range', 'end page outside PDF')
  }
  if (startPage !== null && endPage !== null && startPage > endPage) {
    return unavailable(meta.section_index, 'reversed-boundaries', 'start page after end page')
  }

  if (startPage === null) {
    return unavailable(meta.section_index, 'no-start-evidence', 'no eligible mapped block for section start')
  }
  if (endPage === null) {
    return {
      sectionIndex: meta.section_index,
      startPage,
      endPage: null,
      affectedPages: [startPage],
      confidence: 'approximate',
      evidenceMethod: 'start-block',
      ambiguityReason: 'end-boundary-unmapped',
    }
  }

  const affectedPages: number[] = []
  for (let p = startPage; p <= endPage; p++) affectedPages.push(p)

  return {
    sectionIndex: meta.section_index,
    startPage,
    endPage,
    affectedPages,
    confidence: 'exact',
    evidenceMethod: 'first-last-blocks',
    ambiguityReason: null,
  }
}

/** Map a single section. Uses the cached all-section resolution. */
export function mapSection(input: SectionMapInput, sectionIndex: number): SectionRange {
  const all = mapAllSections(input)
  return all.find((r) => r.sectionIndex === sectionIndex) ?? unavailable(sectionIndex, 'no-section-metadata', 'section index not found')
}

/**
 * Map all sections in document order. Phase 2 derives mid-page flags and
 * monotonicity from the resolved neighbors (no recursion). Phase 3 fills
 * content-less gap sections from two independently proven neighbors.
 */
export function mapAllSections(input: SectionMapInput): SectionRange[] {
  const ordered = [...input.sections].sort((a, b) => a.section_index - b.section_index)

  // Phase 1 — core ranges.
  const cores = ordered.map((meta) => resolveCore(input, meta))
  const byIndex = new Map(cores.map((c) => [c.sectionIndex, c]))

  // Phase 2 — flags + monotonicity.
  const phased = cores.map((core, i) => {
    const meta = ordered[i]
    let { startsMidPage, endsMidPage } = { startsMidPage: false, endsMidPage: false }
    const { startPage, endPage } = core

    // Monotonicity: this section's start must not regress before the
    // previous section's start (distinct sections never collapse).
    if (i > 0) {
      const prev = byIndex.get(ordered[i - 1].section_index)
      if (
        prev && prev.startPage !== null && startPage !== null && startPage < prev.startPage
      ) {
        return {
          ...core,
          startsMidPage: false,
          endsMidPage: false,
          confidence: 'unavailable' as const,
          evidenceMethod: 'first-last-blocks',
          ambiguityReason: 'section range regresses before previous section',
        }
      }
    }

    // Mid-page flags. OOXML `w:sectPr/w:type` describes how THIS section
    // STARTS: continuous → starts on the same page as the previous section.
    // endsMidPage is driven by the NEXT section's break type.
    if (meta.break_type === 'continuous' && i > 0) {
      const prev = byIndex.get(ordered[i - 1].section_index)
      if (prev && prev.endPage !== null && startPage !== null && prev.endPage === startPage) {
        startsMidPage = true
      }
    }
    if (i + 1 < ordered.length) {
      const nextMeta = ordered[i + 1]
      if (nextMeta.break_type === 'continuous') {
        const next = byIndex.get(nextMeta.section_index)
        if (next && next.startPage !== null && endPage !== null && next.startPage === endPage) {
          endsMidPage = true
        }
      }
    }

    return { ...core, startsMidPage, endsMidPage }
  })

  // Phase 3 — content-less gap sections. A section with NO eligible mapped
  // block (all EMPTY / field-only / invisible-TOC content) cannot prove its
  // own page from inside. It is NOT invented: when BOTH neighbors are
  // independently proven exact AND this section has a page-advancing break
  // (nextPage/oddPage/evenPage), the section occupies exactly the pages
  // strictly between the previous section's proven end and the next
  // section's proven start — provided that gap is non-empty and inside the
  // real PDF. Conflicting or unbounded gaps stay unavailable.
  const finalRanges = [...phased]
  for (let i = 0; i < phased.length; i++) {
    const core = phased[i]
    if (core.confidence !== 'unavailable' && core.confidence !== 'approximate') continue
    if (core.ambiguityReason !== 'no eligible mapped block for section start') continue
    const meta = ordered[i]
    if (!['nextPage', 'oddPage', 'evenPage'].includes(meta.break_type)) continue
    if (i === 0 || i + 1 >= phased.length) continue // needs both neighbors
    const prev = byIndex.get(ordered[i - 1].section_index)
    const next = byIndex.get(ordered[i + 1].section_index)
    if (
      !prev || !next ||
      prev.confidence !== 'exact' || next.confidence !== 'exact' ||
      prev.endPage === null || next.startPage === null
    ) continue
    const gapStart = prev.endPage + 1
    const gapEnd = next.startPage - 1
    if (gapStart > gapEnd) continue // adjacent sections — no blank page
    if (gapStart < 1 || gapEnd > input.numPages) continue // outside real PDF
    const affected: number[] = []
    for (let p = gapStart; p <= gapEnd; p++) affected.push(p)
    finalRanges[i] = {
      sectionIndex: core.sectionIndex,
      startPage: gapStart,
      endPage: gapEnd,
      affectedPages: affected,
      startsMidPage: false,
      endsMidPage: false,
      confidence: 'exact',
      evidenceMethod: 'gap-between-neighbors',
      ambiguityReason: null,
    }
  }

  return finalRanges
}
