/**
 * Human-readable labels & semantic colour classes per audit category.
 *
 * `severityBadge` is the single source of truth for reader-facing severity
 * terminology: the Findings list, Finding Details, the Document Preview chip,
 * the severity filter and the PDF severity labels all derive from it.
 *
 * Contrast is measured, not guessed — the hexes live in `tailwind.config.js`
 * and `frontend/tests/severity-tokens.test.ts` fails the build if any badge
 * text drops below 4.5:1 or any indicator below 3:1 (WCAG 1.4.11).
 *
 * REVIEW findings are neutral (never alarm styling): they are manual-review
 * flags, excluded from the score and from the major/minor counts.
 * Unrecognised/malformed backend tokens render as neutral "Unclassified":
 * visible, never styled as a scored severity, never counted.
 */

import type { AuditCategory, ViolationSeverity } from '../../types/audit'

export const CATEGORY_LABELS: Record<AuditCategory, string> = {
  page_margins: 'Page Margins',
  heading_hierarchy: 'Heading Hierarchy',
  media_captions: 'Media Captions',
  font_consistency: 'Font Consistency',
  font_size: 'Font Size',
  paragraph_typography: 'Paragraph Typography',
  citation_apa: 'APA Citations and References',
}

export interface SeverityBadge {
  /** Reader-facing label. */
  label: string
  /** Badge surface classes: background + text + border (dashed for unknown). */
  className: string
  /** 3:1 stripe colour, for the findings-list severity marker. */
  indicatorClassName: string
  /** 3:1 icon colour, for an inline icon drawn on the badge surface. */
  indicatorTextClassName: string
  /** What this severity means for the reader — shown in Finding Details. */
  meaning: string
  /** False for Manual review and Unclassified: neither is ever scored. */
  scored: boolean
}

const MAJOR_BADGE: SeverityBadge = {
  label: 'Major',
  className: 'bg-severity-major-bg text-severity-major-text border-severity-major-border',
  indicatorClassName: 'bg-severity-major-indicator',
  indicatorTextClassName: 'text-severity-major-indicator',
  meaning: 'Significant compliance issue that may affect the score',
  scored: true,
}

const MINOR_BADGE: SeverityBadge = {
  label: 'Minor',
  className: 'bg-severity-minor-bg text-severity-minor-text border-severity-minor-border',
  indicatorClassName: 'bg-severity-minor-indicator',
  indicatorTextClassName: 'text-severity-minor-indicator',
  meaning: 'Smaller inconsistency that should still be reviewed',
  scored: true,
}

const REVIEW_BADGE: SeverityBadge = {
  label: 'Manual review',
  className: 'bg-severity-review-bg text-severity-review-text border-severity-review-border',
  indicatorClassName: 'bg-severity-review-indicator',
  indicatorTextClassName: 'text-severity-review-indicator',
  meaning: 'Possible issue ACA could not determine reliably',
  scored: false,
}

const UNKNOWN_BADGE: SeverityBadge = {
  label: 'Unclassified',
  className:
    'bg-severity-unknown-bg text-severity-unknown-text border-severity-unknown-border border-dashed',
  indicatorClassName: 'bg-severity-unknown-indicator',
  indicatorTextClassName: 'text-severity-unknown-indicator',
  meaning: 'Severity not recognised',
  scored: false,
}

/**
 * Short tag for a severity badge.
 *
 * Every branch is explicit: a value outside the `ViolationSeverity` union
 * resolves to Unclassified instead of silently falling through to Minor.
 */
export function severityBadge(sev: ViolationSeverity): SeverityBadge {
  switch (sev) {
    case 'major':
      return MAJOR_BADGE
    case 'minor':
      return MINOR_BADGE
    case 'review':
      return REVIEW_BADGE
    case 'unknown':
    default:
      return UNKNOWN_BADGE
  }
}
