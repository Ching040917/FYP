/**
 * Enabled-checks score + margin disclosure wording (evidence-based margin
 * policy Build). A score represents ONLY the enabled deterministic checks;
 * it never implies writing quality, factual accuracy, assignment quality,
 * or unsupported requirements were assessed.
 */

import type { ProfileSnapshot, ProfileSnapshotReferences } from '../../types/api'

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
  return `${name} · ${citation} · ${marginsLine} · ${referencesDisclosure(snapshot.references)}`
}

/**
 * Plain-language Reference List requirements from the STORED snapshot.
 *
 * Only ENABLED checks are stated — a stored value whose check is off is not
 * a requirement. Historical v1/v2 snapshots carry no toggles; their line
 * spacing was enforced exactly when a value was stored, which is what an
 * absent `check_line_spacing` reads here.
 */
export function referencesDisclosure(
  refs: ProfileSnapshotReferences | null | undefined,
): string {
  if (!refs) return 'References: Not checked'
  const parts: string[] = []
  if (refs.check_heading_text && refs.heading_text) {
    const word = String(refs.heading_text).trim()
    const shown = word.charAt(0).toUpperCase() + word.slice(1)
    parts.push(
      refs.allow_heading_aliases
        ? `"${shown}" heading (common alternatives accepted)`
        : `"${shown}" heading`,
    )
  }
  if (refs.check_heading_bold) {
    parts.push(refs.heading_bold === false ? 'heading not bold' : 'bold heading')
  }
  if (refs.check_heading_alignment && refs.heading_alignment) {
    const a = String(refs.heading_alignment)
    parts.push(`${a.charAt(0).toUpperCase()}${a.slice(1)}-aligned heading`)
  }
  if (refs.check_start_on_new_page) parts.push('starts on a new page')
  if (refs.check_hanging_indent && refs.hanging_indent_in !== null && refs.hanging_indent_in !== undefined) {
    parts.push(`${refs.hanging_indent_in} in hanging indent`)
  }
  if (refs.check_line_spacing !== false && refs.line_spacing !== null && refs.line_spacing !== undefined) {
    parts.push(
      Math.abs(refs.line_spacing - 2.0) < 0.01
        ? 'double line spacing'
        : `${refs.line_spacing} line spacing`,
    )
  }
  if (refs.check_space_before && refs.space_before_pt !== null && refs.space_before_pt !== undefined) {
    parts.push(`${refs.space_before_pt} pt space before`)
  }
  if (refs.check_space_after && refs.space_after_pt !== null && refs.space_after_pt !== undefined) {
    parts.push(`${refs.space_after_pt} pt space after`)
  }
  if (refs.check_font_family && refs.font_family) parts.push(String(refs.font_family))
  if (refs.check_font_size && refs.font_size_pt !== null && refs.font_size_pt !== undefined) {
    parts.push(`${refs.font_size_pt} pt`)
  }
  if (refs.check_alignment && refs.alignment) parts.push(`${refs.alignment}-aligned entries`)
  if (refs.check_reference_order === true) parts.push('alphabetical order')
  return parts.length > 0 ? `References: ${parts.join(', ')}` : 'References: Not checked'
}
