/**
 * Section-mapping session cache (Build: Section page-range navigation).
 *
 * Caches SUCCESSFUL section mappings (confidence exact or approximate)
 * per audit/PDF session, keyed by `auditId`. Temporary loading failures
 * (no bundle yet, no PDF) are NEVER cached — they are recomputed on the
 * next use. Dropped on audit change / PDF replacement.
 */
import type { SectionMetadataLike, SectionRange } from './section-mapping.ts'

const done = new Map<string, SectionRange[]>()

/** Cache a resolved set of section ranges for an audit (successes only). */
export function cacheSectionRanges(
  auditId: string,
  ranges: SectionRange[],
): void {
  if (!auditId || ranges.length === 0) return
  const successful = ranges.filter((r) => r.confidence !== 'unavailable')
  if (successful.length === 0) return
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
