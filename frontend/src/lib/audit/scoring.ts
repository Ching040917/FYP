/**
 * Weighted scoring — ported from reference_project/src/lib/audit/scoring.ts.
 * Re-implements FR-4 scoring on the client (the backend already computed the
 * authoritative score; this is used to derive per-category breakdown for the
 * radar + bar charts).
 */

import type {
  AuditCategory,
  LayoutError,
  ScoreBreakdown,
} from '../../types/audit'

interface CategoryMeta {
  label: string
  majorWeight: number
  minorWeight: number
  /** Maximum deduction this category can contribute */
  cap: number
}

const CATEGORY_META: Record<AuditCategory, CategoryMeta> = {
  page_margins:         { label: 'Page Margins',          majorWeight: 8, minorWeight: 2, cap: 32 },
  heading_hierarchy:    { label: 'Heading Hierarchy',     majorWeight: 8, minorWeight: 2, cap: 32 },
  media_captions:       { label: 'Media Captions',        majorWeight: 6, minorWeight: 2, cap: 28 },
  font_consistency:     { label: 'Font Consistency',      majorWeight: 4, minorWeight: 1, cap: 18 },
  font_size:            { label: 'Font Size Alignment',   majorWeight: 4, minorWeight: 1, cap: 18 },
  paragraph_typography: { label: 'Paragraph Typography',  majorWeight: 4, minorWeight: 1, cap: 20 },
  citation_apa:         { label: 'APA Citations (AI)',    majorWeight: 5, minorWeight: 2, cap: 25 },
}

const CATEGORY_ORDER: AuditCategory[] = [
  'page_margins',
  'heading_hierarchy',
  'media_captions',
  'font_consistency',
  'font_size',
  'paragraph_typography',
  'citation_apa',
]

export interface ScoreResult {
  total: number
  majorCount: number
  minorCount: number
  breakdown: ScoreBreakdown[]
}

export function calculateWeightedScore(
  errors: LayoutError[],
  citationTipCount = 0,
): ScoreResult {
  let majorCount = 0
  let minorCount = 0

  const byCategory = new Map<AuditCategory, { major: number; minor: number }>()
  for (const cat of CATEGORY_ORDER) {
    byCategory.set(cat, { major: 0, minor: 0 })
  }
  for (const e of errors) {
    const bucket = byCategory.get(e.category) ?? { major: 0, minor: 0 }
    if (e.severity === 'major') {
      bucket.major++
      majorCount++
    } else {
      bucket.minor++
      minorCount++
    }
    byCategory.set(e.category, bucket)
  }

  // Add citation findings as minor citation_apa violations
  if (citationTipCount > 0) {
    const bucket = byCategory.get('citation_apa')!
    bucket.minor += citationTipCount
    minorCount += citationTipCount
  }

  let total = 100
  const breakdown: ScoreBreakdown[] = []
  for (const cat of CATEGORY_ORDER) {
    const meta = CATEGORY_META[cat]
    const counts = byCategory.get(cat) ?? { major: 0, minor: 0 }
    const raw = counts.major * meta.majorWeight + counts.minor * meta.minorWeight
    const deduction = Math.min(raw, meta.cap)
    total -= deduction
    breakdown.push({
      category: cat,
      label: meta.label,
      major: counts.major,
      minor: counts.minor,
      deduction,
      remaining: Math.max(0, 100 - deduction),
    })
  }

  return {
    total: Math.max(0, Math.round(total)),
    majorCount,
    minorCount,
    breakdown,
  }
}

/** Human-readable grade band for the hero score. */
export function gradeFor(score: number): { grade: string; label: string; tone: 'success' | 'warning' | 'error' } {
  if (score >= 90) return { grade: 'A', label: 'Excellent', tone: 'success' }
  if (score >= 80) return { grade: 'B', label: 'Good',      tone: 'success' }
  if (score >= 70) return { grade: 'C', label: 'Acceptable', tone: 'warning' }
  if (score >= 60) return { grade: 'D', label: 'Needs Work', tone: 'warning' }
  return                     { grade: 'F', label: 'Critical',   tone: 'error'   }
}