import type { BlockMapping } from '../pdf/paragraph-mapping.ts'
import type { SectionMetadataLike } from '../pdf/section-mapping.ts'

const PAGE_ELEMENT_RULES: Record<string, true> = {
  HEADER_CONTENT_REQUIRED: true,
  FOOTER_CONTENT_REQUIRED: true,
  PAGE_NUMBER_FIELD_REQUIRED: true,
}

const STORY_LABELS: Record<string, string> = {
  header: 'Header', footer: 'Footer', either: 'Header or Footer',
}

export function isPageElementRule(code: string): boolean {
  return PAGE_ELEMENT_RULES[code.toUpperCase()] === true
}

export function structuralStoryLabel(location: Record<string, unknown>): string | null {
  if (location.structural_story !== true || location.story_variant !== 'default') return null
  const index = location.section_index
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
  const label = typeof location.story_type === 'string' ? STORY_LABELS[location.story_type] : null
  return typeof label === 'string' ? `Section ${index + 1} · ${label} · Normal pages` : null
}

export const STRUCTURAL_PAGE_UNAVAILABLE = 'Rendered page could not be determined'
export const STRUCTURAL_HIGHLIGHT_UNAVAILABLE = 'No exact Header/Footer highlight is available.'

/** A later paragraph cannot prove the section's first rendered page. */
export function sectionFirstRenderedPage(
  location: Record<string, unknown>,
  sections: readonly SectionMetadataLike[] | null | undefined,
  blocks: readonly { index: number; text: string }[] | null | undefined,
  mapping: ReadonlyMap<number, BlockMapping> | null | undefined,
  numPages: number,
): number | null {
  if (!structuralStoryLabel(location) || !sections || !blocks || !mapping ||
      !Number.isInteger(numPages) || numPages < 1) return null
  const candidates = sections.filter(s => s.section_index === location.section_index)
  if (candidates.length !== 1) return null
  const section = candidates[0]
  const start = section.start_paragraph_index
  if (start === null || !Number.isInteger(start) || start < 0) return null
  const end = section.end_paragraph_index
  if (end !== null && (!Number.isInteger(end) || end < start)) return null
  const first = blocks.filter(block => block.index === start)
  if (first.length !== 1 || typeof first[0].text !== 'string' || !first[0].text.trim()) return null
  const mapped = mapping.get(start)
  const page = mapped?.pageNumber
  return mapped?.confidence === 'exact' && typeof page === 'number' &&
    Number.isInteger(page) && page >= 1 && page <= numPages ? page : null
}
