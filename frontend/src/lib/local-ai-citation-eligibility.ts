/**
 * Strict eligibility for Local AI Citation Guidance (paragraph-scoped only).
 *
 * Mirrors backend `app/services/ai_citation_eligibility.py`. Pure: no I/O,
 * no network, no storage. Historical unsupported `CitationIssue` rows are
 * never deleted here — callers hide the section for ineligible findings.
 */

import { isMissingReferenceSection } from './friendly-finding.ts'

interface EligibleViolationLike {
  rule_code?: unknown
  severity?: unknown
  location?: unknown
  actual_value?: unknown
}

/**
 * True only for a paragraph-scoped CITATION_MISMATCH finding with a real
 * non-negative integer paragraph index, MAJOR/MINOR severity, and a
 * non-empty citation snippet. Consolidated findings (occurrences > 1)
 * remain eligible as one guidance unit.
 */
export function isLocalAiCitationEligible(violation: EligibleViolationLike | null | undefined): boolean {
  if (!violation || typeof violation !== 'object') return false
  if (violation.rule_code !== 'CITATION_MISMATCH') return false
  const location = violation.location as Record<string, unknown> | null | undefined
  if (!location || typeof location !== 'object' || Array.isArray(location)) return false
  if (isMissingReferenceSection(location)) return false
  // Reference-entry findings carry entry markers; citation findings never do.
  if ('entry_count' in location) return false
  const paragraphIndex = location.paragraph_index
  if (typeof paragraphIndex !== 'number' || !Number.isInteger(paragraphIndex) || paragraphIndex < 0) {
    return false
  }
  if (violation.severity !== 'MAJOR' && violation.severity !== 'MINOR') return false
  if (typeof violation.actual_value !== 'string' || violation.actual_value.trim().length === 0) {
    return false
  }
  return true
}
