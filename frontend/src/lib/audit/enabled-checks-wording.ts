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
  const marginsLine = marginsDisclosureLine(snapshot.margins)
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
  const parts = referenceCheckParts(refs)
  const requirements = parts.length > 0 ? `References: ${parts.join(', ')}` : 'References: Not checked'
  return refs.check_doi_format === true
    ? `${requirements}. The selected profile requires the visible DOI format https://doi.org/<doi>; presentation only, not registration or resolution.`
    : requirements
}

/**
 * The enabled Reference List requirement phrases behind
 * `referencesDisclosure`, as a list. The disclosure joins them; the
 * enabled-check count counts them — one condition set, never two.
 */
export function referenceCheckParts(
  refs: ProfileSnapshotReferences | null | undefined,
): string[] {
  if (!refs) return []
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
  if (refs.check_doi_format === true) parts.push('Reference DOI format')
  return parts
}

/** Plain-language Margin requirements from the STORED snapshot. */
export function marginsDisclosureLine(
  margins: ProfileSnapshot['margins'] | null | undefined,
): string {
  const m: { left_in?: number | null; right_in?: number | null; top_in?: number | null; bottom_in?: number | null } =
    margins ?? {}
  const left = m.left_in
  const right = m.right_in
  const top = m.top_in
  const bottom = m.bottom_in
  if (left === null && right === null && top === null && bottom === null) {
    return 'Margins: Not checked'
  }
  if (left !== null && right !== null && top !== null && bottom !== null) {
    return left === right && right === top && top === bottom
      ? `Margins: ${left} in on all sides`
      : `Margins: ${left} in left, ${right} in right, ${top} in top, ${bottom} in bottom`
  }
  if (left !== null) {
    return `Margins: ${left} in left`
  }
  return 'Margins: Not checked'
}

/**
 * Compact one-line Profile Summary for the Audit Report header:
 * `<name> · <N> checks enabled`, rendered next to a profile icon and the
 * explicit details control. `null` when there is no stored snapshot. N
 * counts the enabled requirement items the details view lists: one for
 * the Margin group when any side is set, plus one per enabled Reference
 * List requirement. Only the compact presentation adapts — the stored
 * text never changes.
 */
export function compactProfileSummary(
  snapshot: ProfileSnapshot | null | undefined,
): string | null {
  if (!snapshot) return null
  return `${snapshot.profile_name || 'Selected profile'} · ${enabledCheckCount(snapshot)} checks enabled`
}

/** Number of enabled check items behind `compactProfileSummary`. */
export function enabledCheckCount(
  snapshot: ProfileSnapshot | null | undefined,
): number {
  if (!snapshot) return 0
  let count = 0
  const m = snapshot.margins ?? {}
  if (m.left_in != null || m.right_in != null || m.top_in != null || m.bottom_in != null) {
    count += 1
  }
  count += referenceCheckParts(snapshot.references).length
  return count
}

/**
 * Friendly names of the Reference List checks that are currently OFF —
 * the exact mirror of `referenceCheckParts`, so an enabled requirement
 * and its not-checked counterpart can never drift apart.
 */
export function referenceUncheckedParts(
  refs: ProfileSnapshotReferences | null | undefined,
): string[] {
  const off: string[] = []
  if (!(refs?.check_heading_text && refs?.heading_text)) off.push('Reference heading')
  if (refs?.check_heading_bold !== true) off.push('Bold Reference heading')
  if (!(refs?.check_heading_alignment && refs?.heading_alignment)) {
    off.push('Aligned Reference heading')
  }
  if (refs?.check_start_on_new_page !== true) off.push('References start on a new page')
  if (!(refs?.check_hanging_indent && refs?.hanging_indent_in != null)) {
    off.push('Hanging indent')
  }
  if (!(refs?.check_line_spacing !== false && refs?.line_spacing != null)) {
    off.push('Reference line spacing')
  }
  if (!(refs?.check_space_before && refs?.space_before_pt != null)) {
    off.push('Space before entries')
  }
  if (!(refs?.check_space_after && refs?.space_after_pt != null)) {
    off.push('Space after entries')
  }
  if (!(refs?.check_font_family && refs?.font_family)) off.push('Reference font')
  if (!(refs?.check_font_size && refs?.font_size_pt != null)) off.push('Reference font size')
  if (!(refs?.check_alignment && refs?.alignment)) off.push('Reference entry alignment')
  if (refs?.check_reference_order !== true) off.push('Alphabetical order')
  if (refs?.check_doi_format !== true) off.push('Reference DOI format: Not checked')
  return off
}

export interface ProfileDetailSection {
  heading: string
  items: Array<{ text: string; tone: 'check' | 'plain' | 'muted' }>
}

/**
 * Grouped Profile-details sections for the dialog: identity (Profile,
 * Source), Enabled checks as individual rows, and Not checked as
 * individual rows — including the alphabetical-order status in whichever
 * group it belongs to. No indexes, keys, or internal values are exposed.
 */
export function profileDetailSections(
  snapshot: ProfileSnapshot | null | undefined,
): ProfileDetailSection[] {
  if (!snapshot) return []
  const refs = snapshot.references
  const enabled = referenceCheckParts(refs)
  const margins = snapshot.margins ?? {}
  const marginsSet =
    margins.left_in != null || margins.right_in != null ||
    margins.top_in != null || margins.bottom_in != null
  if (marginsSet) enabled.push(marginsDisclosureLine(snapshot.margins))
  const unchecked = referenceUncheckedParts(refs)
  if (!marginsSet) unchecked.push('Margins')
  const listed = (items: string[], tone: 'check' | 'muted') =>
    items.length > 0
      ? items.map((text) => ({ text, tone }) as { text: string; tone: 'check' | 'muted' })
      : [{ text: 'None', tone: 'muted' } as { text: string; tone: 'muted' }]
  return [
    {
      heading: 'Profile',
      items: [{ text: snapshot.profile_name || 'Selected profile', tone: 'plain' }],
    },
    {
      heading: 'Source',
      items: [{ text: snapshot.profile_source === 'built_in' ? 'Built-in' : 'Custom', tone: 'plain' }],
    },
    { heading: 'Enabled checks', items: listed(enabled, 'check') },
    { heading: 'Not checked', items: listed(unchecked, 'muted') },
  ]
}
