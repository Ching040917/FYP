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

/** Backend whitelist — SAFE_RUN_RULES ∪ SAFE_PARA_RULES (guided_fix.py). */
export const SUPPORTED_FIX_RULES: ReadonlySet<string> = new Set([
  'FONT_CONSISTENCY',
  'FONT_SIZE',
  'ALIGNMENT',
  'LINE_SPACING',
  'SPACE_BEFORE',
  'SPACE_AFTER',
])

/** Maximum selected findings — matches backend GuidedFixSelectionRequest. */
export const MAX_SELECTED = 20

export const CORRECTED_FALLBACK_FILENAME = 'ACA_corrected.docx'

/** Stable, user-facing copy for the Beta surface. */
export const BETA_WARNING =
  'Beta feature. ACA creates a corrected copy and never changes your original document. Review the corrected copy before submission.'
export const BETA_SCOPE =
  'Only selected supported formatting issues are considered. Some findings require manual correction.'
/** Concise dialog introduction (replaces the two longer Beta paragraphs). */
export const GF_INTRO =
  'Guided Fixes creates a corrected copy and never changes your original document. Select supported formatting issues, review the proposed changes, then upload the original DOCX.'
export const GF_SECONDARY =
  'Some findings require manual correction. Review the corrected copy before submission.'

/** Non-interactive workflow steps (presentation order is authoritative). */
export const WORKFLOW_STEPS = [
  'Select fixes',
  'Review changes',
  'Upload original',
  'Download copy',
] as const

/** The backend's exact safe error details (verbatim contract, verified). */
export const MISMATCH_DETAIL =
  'The selected document does not match the document used for this audit. Upload the original DOCX file and try again.'
export const LEGACY_DETAIL =
  'Guided Fixes is unavailable for audits created before document matching was introduced.'
export const ZERO_DETAIL =
  'No selected Guided Fix could be applied safely. Review the skipped findings and correct them manually.'
export const GENERIC_FAILURE =
  'Guided Fixes could not create a corrected copy. Your original document was not changed.'
export const INVALID_DOCX =
  'A valid .docx file is required. Choose a Word document (.docx) and try again.'
export const OVERSIZE_DOCX =
  'This file is larger than the 10 MB limit. Choose a smaller document and try again.'

/**
 * Translate a raw backend detail into ordinary-user wording. Never exposes
 * internal skip codes (expected_unresolved, unsafe_structure, target_missing)
 * or OOXML terminology — unknown safe details pass through only when they
 * carry no internal tokens; anything else gets the generic fallback.
 */
export function friendlyGuidedFixError(raw: string | null | undefined): string {
  const detail = (raw ?? '').trim()
  if (!detail) return GENERIC_FAILURE
  const upper = detail.toUpperCase()
  if (upper.includes('EXPECTED_UNRESOLVED') || upper.includes('UNSAFE_STRUCTURE') ||
      upper.includes('TARGET_MISSING') || upper.includes('UNSUPPORTED_RULE') ||
      upper.includes('DOCUMENT_CHANGED') || upper.includes('NO_LOCATION') ||
      upper.includes('ALREADY_COMPLIANT')) {
    return GENERIC_FAILURE
  }
  if (detail === MISMATCH_DETAIL || detail === LEGACY_DETAIL || detail === ZERO_DETAIL) {
    return detail
  }
  if (/does not match the document/i.test(detail)) return MISMATCH_DETAIL
  if (/predates document matching|before document matching/i.test(detail)) return LEGACY_DETAIL
  if (/could not be applied safely/i.test(detail)) return ZERO_DETAIL
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

/** True when the current selection already contains this id. */
export function isGuidedSelected(current: readonly string[], id: string): boolean {
  return current.includes(id)
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

/** Count line: "6 selected · 8 available for Guided Fix · Maximum 20". */
export function guidedCountLine(
  selectedCount: number,
  availableCount: number,
): string {
  if (selectedCount >= MAX_SELECTED) {
    return `${selectedCount} selected · Maximum reached`
  }
  if (selectedCount === 0) {
    return `No findings selected · ${availableCount} available for Guided Fix · Maximum ${MAX_SELECTED}`
  }
  return `${selectedCount} selected · ${availableCount} available for Guided Fix · Maximum ${MAX_SELECTED}`
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
    case 'selecting':
      return 0
    case 'reviewing':
      return 1
    case 'ready_to_upload':
    case 'error':
      return 2
    case 'applying':
    case 'completed':
      return 3
    default:
      return null
  }
}

/**
 * Presentation value for a whitelisted finding. The proposal comes from the
 * persisted `expected_value` ONLY — never edited, never guessed, and never
 * claimed applied before the backend confirms.
 */
export function guidedProposalFor(ruleCode: string, expected: string | null | undefined): string {
  const value = String(expected ?? '').trim()
  if (!value) return 'Profile requirement (see finding details)'
  const upper = ruleCode.toUpperCase()
  if (upper === 'ALIGNMENT') {
    const v = value.toLowerCase()
    if (v === 'center') return 'Centered'
    if (v === 'justify') return 'Justified'
    if (v === 'left') return 'Left-aligned'
    if (v === 'right') return 'Right-aligned'
  }
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
 * Build the Guided Fixes presentation for ONE persisted violation. Supported
 * = rule in the backend whitelist AND the proposal is resolvable from the
 * persisted expected value; everything else shows "Manual correction
 * required". Never fabricates values for unsupported/unresolvable findings.
 */
export function guidedPresentationFor(v: GuidedViolationLike): GuidedFindingPresentation {
  const ruleCode = (v.rule_code ?? '').toUpperCase()
  const friendlyName = ruleCode
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Finding'
  const loc = v.location ?? {}
  const para = typeof loc.paragraph_index === 'number' && loc.paragraph_index >= 0
    ? loc.paragraph_index + 1
    : null
  const friendlyLocation = para !== null ? `Paragraph ${para}` : null
  const current = String(v.actual_value ?? '').trim() || 'Not shown'
  const supported = SUPPORTED_FIX_RULES.has(ruleCode)
  const proposed = supported ? guidedProposalFor(ruleCode, v.expected_value) : ''
  return { ruleCode, supported, friendlyName, friendlyLocation, current, proposed }
}

/** Download filename — safe fallback when the header is absent/unparseable. */
export function correctedFilename(fallback: string | null | undefined): string {
  const name = (fallback ?? '').trim()
  return name ? name : CORRECTED_FALLBACK_FILENAME
}
