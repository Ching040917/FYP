/**
 * Guided Fixes (Beta) — presentation + selection helpers.
 *
 * PURE functions only: no React, no I/O, no storage, no network. The
 * backend whitelist (app/services/guided_fix.py) is the authoritative Beta
 * set — mirrored here for presentation only; mutation logic lives on the
 * backend and is never duplicated.
 *
 * Privacy contract:
 *  - selection exists in React state only — never localStorage/sessionStorage;
 *  - nothing here logs findings, document text, or selected values;
 *  - run indexes / internal OOXML terminology are never displayed.
 */

import { alignmentWord, friendlyRuleTitle, friendlyValue } from './friendly-finding.ts'

/** Candidate rule codes only; a finding is eligible ONLY after server Review. */
export const SUPPORTED_FIX_RULES: Readonly<Record<string, true>> = {
  FONT_CONSISTENCY: true,
  FONT_SIZE: true,
  ALIGNMENT: true,
  LINE_SPACING: true,
  SPACE_BEFORE: true,
  SPACE_AFTER: true,
  REFERENCE_HEADING_ALIGNMENT: true,
  REFERENCE_HEADING_BOLD: true,
}

/** Maximum selected findings — matches backend GuidedFixSelectionRequest. */
export const MAX_SELECTED = 20

export const REFERENCE_HEADING_BOLD_PROPERTY = 'Reference List heading bold (all heading text)'

export const CORRECTED_FALLBACK_FILENAME = 'ACA-fixed.docx'

export const GF_INTRO =
  'Guided Fixes creates a corrected copy and never changes your original document. Select candidate formatting findings, then upload the original DOCX for a safety review.'
export const GF_SECONDARY =
  'Only a successful review can confirm a fix is safe. Inspect the corrected copy before submission.'

export const WORKFLOW_STEPS = [
  'Select findings',
  'Upload original',
  'Review verified targets',
  'Apply and verify',
  'Download copy',
] as const

/** The backend's exact safe error details (verbatim contract, verified). */
export const MISMATCH_DETAIL =
  'The selected document does not match the document used for this audit. Upload the original DOCX file and try again.'
export const LEGACY_DETAIL =
  'Guided Fixes is unavailable for audits created before document matching was introduced.'
export const ZERO_DETAIL =
  'Fix cannot be applied safely. Correct the selected findings manually.'
export const GENERIC_FAILURE =
  'Fix cannot be applied safely. Your original document was not changed.'
export const INVALID_DOCX =
  'A valid .docx file is required. Choose a Word document (.docx) and try again.'
export const OVERSIZE_DOCX =
  'This file is larger than the 10 MB limit. Choose a smaller document and try again.'
const PACKAGE_POLICY_DETAIL =
  'This correction is unavailable for signed, protected or macro-enabled documents. Correct the selected findings manually in Word; your original document is unchanged.'


const BOLD_UNAVAILABLE_DETAILS: readonly string[] = [
  'ACA cannot identify one unambiguous Reference List heading. Correct this finding manually; your original document is unchanged.',
  'ACA cannot safely confirm bold formatting for every text segment in this heading. Correct its bold formatting manually; your original document is unchanged.',
  'This correction is unavailable for signed, protected or macro-enabled documents. Correct the heading manually; your original document is unchanged.',
]

/**
 * Translate known backend messages; never expose internal skip codes, raw
 * document structure or unexpected server detail to the user.
 */
export function friendlyGuidedFixError(raw: string | null | undefined): string {
  const detail = (raw ?? '').trim()
  if (!detail) return GENERIC_FAILURE
  const upper = detail.toUpperCase()
  if (upper.includes('EXPECTED_UNRESOLVED') || upper.includes('UNSAFE_STRUCTURE') ||
      upper.includes('TARGET_MISSING') || upper.includes('UNSUPPORTED_RULE') ||
      upper.includes('DOCUMENT_CHANGED') || upper.includes('NO_LOCATION') ||
      upper.includes('ALREADY_COMPLIANT') || upper.includes('TRACEBACK') ||
      upper.includes('REVIEW_ID') || upper.includes('XML') || upper.includes('SHA256')) {
    return GENERIC_FAILURE
  }
  if (detail === MISMATCH_DETAIL || detail === LEGACY_DETAIL || detail === ZERO_DETAIL ||
      detail === PACKAGE_POLICY_DETAIL || BOLD_UNAVAILABLE_DETAILS.includes(detail)) {
    return detail
  }
  if (/does not match the document/i.test(detail)) return MISMATCH_DETAIL
  if (/predates document matching|before document matching/i.test(detail)) return LEGACY_DETAIL
  if (/could not be applied safely|cannot be applied safely/i.test(detail)) return ZERO_DETAIL
  if (/not a valid docx|only \.docx|unsupported file format/i.test(detail)) return INVALID_DOCX
  if (/10mb|exceeds the/i.test(detail)) return OVERSIZE_DOCX
  if (/not completed|not found/i.test(detail)) {
    return 'This audit is not available for Guided Fixes. Refresh the page and try again.'
  }
  return GENERIC_FAILURE
}

/** Ordered selection without duplicates; no-op when already present or at cap. */
export function toggleGuidedSelection(
  current: readonly string[],
  id: string,
): string[] {
  if (current.includes(id)) return current.filter((x) => x !== id)
  if (current.length >= MAX_SELECTED) return [...current]
  return [...current, id]
}

/** Dedupe while preserving first occurrence — defensive, mirrors the backend. */
export function dedupeSelection(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * Filtered-view selection: add every *currently visible* supported finding
 * id without duplicates and never past the backend cap. Manual findings are
 * never selected. Deterministic order (caller supplies the view order).
 */
export function selectAllInView(
  current: readonly string[],
  visibleSupportedIds: readonly string[],
  limit: number = MAX_SELECTED,
): string[] {
  const next = [...current]
  const seen = new Set(next)
  for (const id of visibleSupportedIds) {
    if (next.length >= limit) break
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

/** Remove only the given (visible supported) ids — hidden/manual kept. */
export function deselectInView(
  current: readonly string[],
  visibleSupportedIds: readonly string[],
): string[] {
  const target = new Set(visibleSupportedIds)
  return current.filter((id) => !target.has(id))
}

/** Candidate count is not a safety/availability determination. */
export function guidedCountLine(selectedCount: number, candidateCount: number): string {
  if (selectedCount >= MAX_SELECTED) return `${selectedCount} selected · Maximum reached`
  if (selectedCount === 0) {
    return `No findings selected · ${candidateCount} candidates for safety review · Maximum ${MAX_SELECTED}`
  }
  return `${selectedCount} selected · ${candidateCount} candidates for safety review · Maximum ${MAX_SELECTED}`
}

/** Limit notice shown when a select-all attempt was truncated by the cap. */
export function guidedLimitNotice(selectedCount: number, availableCount: number): string | null {
  if (selectedCount < MAX_SELECTED) return null
  if (availableCount <= MAX_SELECTED) return null
  return `${MAX_SELECTED} selected. Guided Fixes can process up to ${MAX_SELECTED} findings at a time.`
}

/** Primary review action label, singular below two selections. */
export function guidedReviewLabel(selectedCount: number): string {
  return selectedCount === 1
    ? 'Review 1 selected change'
    : `Review ${selectedCount} selected changes`
}

/** Workflow indicator step for a stage (null for idle). */
export function workflowStepForStage(stage: string): number | null {
  switch (stage) {
    case 'selecting': return 0
    case 'ready_to_upload':
    case 'error': return 1
    case 'reviewing': return 2
    case 'applying': return 3
    case 'completed': return 4
    default: return null
  }
}

/**
 * Presentation value for a whitelisted finding. The proposal comes from the
 * persisted `expected_value` ONLY — never edited, never guessed, and never
 * claimed applied before the backend confirms.
 */
export function guidedProposalFor(ruleCode: string, expected: string | null | undefined): string {
  const value = friendlyValue(expected)
  if (!value) return 'Profile requirement (see finding details)'
  const upper = ruleCode.toUpperCase()
  if (upper === 'REFERENCE_HEADING_BOLD') {
    if (value === 'Bold') return 'Make the Reference List heading bold'
    if (value === 'Not bold') return 'Use regular (not bold) text for the Reference List heading'
    return 'Profile requirement (see finding details)'
  }
  if (upper === 'ALIGNMENT' || upper === 'REFERENCE_HEADING_ALIGNMENT') return alignmentWord(value)
  if (upper === 'LINE_SPACING') return `${value} line spacing`
  if (upper === 'SPACE_BEFORE') return `${value} spacing before`
  if (upper === 'SPACE_AFTER') return `${value} spacing after`
  return value
}

/** Minimal violation shape the presentation helpers consume (test seam). */
export interface GuidedViolationLike {
  rule_code: string
  expected_value: string | null
  actual_value: string | null
  location: Record<string, unknown> | null
}

export interface GuidedFindingPresentation {
  ruleCode: string
  supported: boolean
  /** Friendly rule name — humanized code, never raw SHOUTY_SNAKE as primary. */
  friendlyName: string
  /** Friendly location when a paragraph identity exists — never run indexes. */
  friendlyLocation: string | null
  /** Current value (persisted actual_value, cleaned) — display only. */
  current: string
  /** Proposed value (persisted expected_value) — display only. */
  proposed: string
}

/**
 * Classify candidates for user selection, NOT eligibility. Display persisted
 * finding values as clues; only the server's review establishes exact targets.
 */
export function guidedPresentationFor(v: GuidedViolationLike): GuidedFindingPresentation {
  const ruleCode = (v.rule_code ?? '').toUpperCase()
  const friendlyName = ruleCode === 'REFERENCE_HEADING_BOLD'
    ? REFERENCE_HEADING_BOLD_PROPERTY
    : friendlyRuleTitle(ruleCode) ?? 'Finding'
  const loc = v.location ?? {}
  const para = typeof loc.paragraph_index === 'number' && loc.paragraph_index >= 0
    ? loc.paragraph_index + 1
    : null
  const friendlyLocation = para !== null ? `Paragraph ${para}` : null
  const current = friendlyValue(v.actual_value) ?? 'Not shown'
  const supported = SUPPORTED_FIX_RULES[ruleCode] === true
  const proposed = supported ? guidedProposalFor(ruleCode, v.expected_value) : ''
  return { ruleCode, supported, friendlyName, friendlyLocation, current, proposed }
}

/** Sanitize the server's suggested name and number local session collisions. */
export function correctedFilename(filename: string | null | undefined, used: ReadonlySet<string> = new Set()): string {
  const supplied = (filename ?? '').split(/[\\/]/).pop() ?? ''
  const name = /^[^<>:"|?*\x00-\x1f]+\.docx$/i.test(supplied) ? supplied : CORRECTED_FALLBACK_FILENAME
  if (!used.has(name)) return name
  const stem = name.slice(0, -5)
  let suffix = 2
  while (used.has(`${stem}-${suffix}.docx`)) suffix++
  return `${stem}-${suffix}.docx`
}
