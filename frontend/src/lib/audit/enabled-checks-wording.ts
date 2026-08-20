/**
 * Enabled-checks score + margin disclosure wording (evidence-based margin
 * policy Build). A score represents ONLY the enabled deterministic checks;
 * it never implies writing quality, factual accuracy, assignment quality,
 * or unsupported requirements were assessed.
 */

import type { ProfileSnapshot } from '../../types/api'

/** Headline suffix for a score that covers only enabled deterministic checks. */
export const ENABLED_CHECKS_SUFFIX = 'for enabled checks'

/** No-findings heading — zero findings does NOT certify academic correctness. */
export const ALL_ENABLED_CHECKS_PASSED = 'All enabled checks passed'

export const ENABLED_CHECKS_CAUTION =
  'No issues were detected by the enabled deterministic checks. Review your ' +
  'course or assignment requirements for formatting rules that are not ' +
  'enabled in this profile.'

/**
 * Presentation-safe profile disclosure line for the report header. Uses the
 * STORED snapshot only (historical audits → legacy-requirements note). Never
 * exposes schema/version/fingerprint/PresetConfig terminology.
 */
export function profileDisclosure(snapshot: ProfileSnapshot | null | undefined): string | null {
  if (!snapshot) return null
  const name = snapshot.profile_name || 'Selected profile'
  const citation = snapshot.citation_style || 'APA 7'
  const m = snapshot.margins ?? {}
  const left = m.left_in
  const right = m.right_in
  const top = m.top_in
  const bottom = m.bottom_in
  let marginsLine: string
  if (left === null && right === null && top === null && bottom === null) {
    marginsLine = 'Margins: Not checked'
  } else if (left !== null && right !== null && top !== null && bottom !== null) {
    marginsLine =
      left === right && right === top && top === bottom
        ? `Margins: ${left} in on all sides`
        : `Margins: ${left} in left, ${right} in right, ${top} in top, ${bottom} in bottom`
  } else if (left !== null) {
    marginsLine = `Margins: ${left} in left`
  } else {
    marginsLine = 'Margins: Not checked'
  }
  return `${name} · ${citation} · ${marginsLine}`
}
