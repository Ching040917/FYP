/**
 * Section-mapping session cache (Build: Section page-range navigation).
 *
 * Caches FULLY-RESOLVED section mappings (every section exact or
 * approximate) per audit/PDF session, keyed by `auditId`. A set containing
 * ANY unavailable section is NEVER cached — it may be temporarily
 * unavailable because later evidence (object pages, geometry) has not
 * arrived yet, and must be recomputed on the next use. Dropped on audit
 * change / PDF replacement.
 */
import type { SectionMetadataLike, SectionRange } from './section-mapping.ts'

const done = new Map<string, SectionRange[]>()

/** Cache a fully-resolved set of section ranges for an audit. */
export function cacheSectionRanges(
  auditId: string,
  ranges: SectionRange[],
): void {
  if (!auditId || ranges.length === 0) return
  // Temporary unavailable must not be cached as final: if ANY section is
  // unavailable, later evidence may still resolve it, so the whole set is
  // recomputed on the next use.
  if (ranges.some((r) => r.confidence === 'unavailable')) return
  done.set(auditId, ranges)
}

/** Cached section ranges for an audit, or null. */
export function cachedSectionRanges(auditId: string | null): SectionRange[] | null {
  if (!auditId) return null
  return done.get(auditId) ?? null
}

/** Drop cached section ranges for an audit (audit change / deletion). */
export function dropSectionRangeCache(auditId: string): void {
  done.delete(auditId)
}

/** Rebuild a section-mapping input from the audit + bundle (pure). */
export function sectionMapInput(
  sections: SectionMetadataLike[] | null | undefined,
  byIndex: Map<number, import('./paragraph-mapping.ts').BlockMapping>,
  numPages: number,
  objectPages?: Map<number, number>,
): { sections: SectionMetadataLike[]; byIndex: Map<number, import('./paragraph-mapping.ts').BlockMapping>; numPages: number; objectPages?: Map<number, number> } | null {
  if (!sections || sections.length === 0) return null
  if (!byIndex || byIndex.size === 0) return null
  if (!numPages || numPages < 1) return null
  return { sections, byIndex, numPages, objectPages }
}
