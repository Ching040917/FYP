/**
 * Helper: human-readable labels & colors per audit category.
 * Ported from reference_project/src/lib/audit/categories.ts.
 */

import type { AuditCategory } from '../../types/audit'

export const CATEGORY_LABELS: Record<AuditCategory, string> = {
  page_margins: 'Page Margins',
  heading_hierarchy: 'Heading Hierarchy',
  media_captions: 'Media Captions',
  font_consistency: 'Font Consistency',
  font_size: 'Font Size',
  paragraph_typography: 'Paragraph Typography',
  citation_apa: 'APA Citations',
}

export const CATEGORY_DESCRIPTIONS: Record<AuditCategory, string> = {
  page_margins: 'Physical page boundaries: top, bottom, left, right per school spec.',
  heading_hierarchy: 'Tree structure of H1–H6 headings; flags skipped levels and orphans.',
  media_captions: 'Every table and image must carry a numbered caption + alt-text.',
  font_consistency: 'Body and heading typefaces must be uniform throughout the document.',
  font_size: 'Body 12pt, headings per spec, with ±0.5pt tolerance.',
  paragraph_typography: 'Line spacing, paragraph spacing, and body alignment rules.',
  citation_apa: 'AI-driven APA 7th-edition in-text citation format audit.',
}

/** Short tag for severity badge */
export const severityBadge = (sev: 'major' | 'minor') =>
  sev === 'major'
    ? { label: 'Major', className: 'bg-rose-500/15 text-rose-300 border-rose-500/30' }
    : { label: 'Minor', className: 'bg-amber-500/15 text-amber-300 border-amber-500/30' }

/** Map category to a colour for the bar-chart legend */
export const categoryColor: Record<AuditCategory, string> = {
  page_margins: '#ffb4ab',
  heading_hierarchy: '#fbbf24',
  media_captions: '#ffb2b7',
  font_consistency: '#c0c1ff',
  font_size: '#a5b4fc',
  paragraph_typography: '#4edea3',
  citation_apa: '#908fa0',
}