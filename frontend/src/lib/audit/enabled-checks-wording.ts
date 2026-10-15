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

export const PAGE_ELEMENTS_HELP_TEXT =
  'Checks stored Normal-pages definitions in every document section. Does not verify rendered visibility or numbering. First-page and even-page definitions are not checked. Unsupported evidence is reported for manual review.'

export type PageElementProfileGroups = Pick<ProfileSnapshot, 'headers' | 'footers' | 'page_numbers'>

/** These are unscored requirements, not additional scored categories. */
export function pageElementCheckParts(groups: PageElementProfileGroups): string[] {
  const parts: string[] = []
  if (groups.headers?.check_header_requirements === true) parts.push('Header requirements')
  if (groups.footers?.check_footer_requirements === true) parts.push('Footer requirements')
  if (groups.page_numbers?.check_page_number_requirements === true) parts.push('Page number requirements')
  return parts
}

/** Shared stored-settings wording for drafts, historical reports and details. */
export function pageElementDisclosureLines(groups: PageElementProfileGroups): string[] {
  const placement = groups.page_numbers?.placement === 'header'
    ? 'Header'
    : groups.page_numbers?.placement === 'footer' ? 'Footer' : 'Header or Footer'
  return [
    groups.headers?.check_header_requirements === true
      ? 'Header requirements · Manual review only · Unscored'
      : 'Headers: Not checked',
    groups.footers?.check_footer_requirements === true
      ? 'Footer requirements · Manual review only · Unscored'
      : 'Footers: Not checked',
    groups.page_numbers?.check_page_number_requirements === true
      ? `Page number requirements · Manual review only · Unscored · Placement: ${placement}`
      : 'Page numbers: Not checked',
  ]
}

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
  const structuralLines = pageElementDisclosureLines(snapshot)
  if (pageElementCheckParts(snapshot).length > 0) structuralLines.push(PAGE_ELEMENTS_HELP_TEXT)
  return `${name} · ${citation} · ${marginsLine} · ${referencesDisclosure(snapshot.references)} · ${structuralLines.join(' · ')}`
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
  if (left == null && right == null && top == null && bottom == null) {
    return 'Margins: Not checked'
  }
  if (left != null && right != null && top != null && bottom != null) {
    return left === right && right === top && top === bottom
      ? `Margins: ${left} in on all sides`
      : `Margins: ${left} in left, ${right} in right, ${top} in top, ${bottom} in bottom`
  }
  const sides = [['left', left], ['right', right], ['top', top], ['bottom', bottom]] as const
  const enabled = sides.filter(([, value]) => value != null)
  if (enabled.length) return `Margins: ${enabled.map(([side, value]) => `${value} in ${side}`).join(', ')}`
  return 'Margins: Not checked'
}

/**
 * Compact stored-profile summary separates scored controls from unscored
 * manual requirements. Counts match their respective detail rows; historical
 * snapshots disclose only controls they actually carry. No live profile lookup.
 */
export function compactProfileSummary(
  snapshot: ProfileSnapshot | null | undefined,
): string | null {
  if (!snapshot) return null
  const manual = manualCheckParts(snapshot).length
  return `${snapshot.profile_name || 'Selected profile'} · ${scoredCheckParts(snapshot).length} scored checks enabled${manual ? ` · ${manual} manual review only (unscored)` : ''}`
}

/** Total enabled stored items, including the separately disclosed manual items. */
export function enabledCheckCount(
  snapshot: ProfileSnapshot | null | undefined,
): number {
  if (!snapshot) return 0
  return scoredCheckParts(snapshot).length + manualCheckParts(snapshot).length
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
  groups?: Array<{ heading: string; items: ProfileDetailSection['items'] }>
  note?: string
}

/** Enumerates only effective stored controls, never editor defaults. */
function storedControlParts(snapshot: ProfileSnapshot): { enabled: string[]; unchecked: string[] } {
  const enabled: string[] = []
  const unchecked: string[] = []
  for (const [label, group] of [
    ['Body', snapshot.body], ['Headings', snapshot.heading],
    ['Captions', snapshot.captions], ['Lists', snapshot.lists],
  ] as const) {
    if (!group) continue
    const controls = group as Record<string, unknown>
    const combos = controls.allowed_font_combos as Array<[string, number]> | undefined
    if ('font_family' in controls || 'font_size_pt' in controls || combos) {
      const font = combos?.length
        ? combos.map(([family, size]) => `${family} ${size} pt`).join(' or ')
        : [controls.font_family, controls.font_size_pt != null ? `${controls.font_size_pt} pt` : null].filter(Boolean).join(' ')
      if (font) enabled.push(`${label} font: ${font}`)
      else unchecked.push(`${label} font: Not checked`)
    }
    for (const [key, title, unit] of [
      ['line_spacing', 'line spacing', ''],
      ['alignment', 'alignment', ''],
      ['space_before_pt', 'space before', ' pt'],
      ['space_after_pt', 'space after', ' pt'],
      ['first_line_indent_in', 'first-line indent', ' in'],
    ] as const) {
      if (!(key in controls)) continue
      if (controls[key] != null) enabled.push(`${label} ${title}: ${controls[key]}${unit}`)
      else unchecked.push(`${label} ${title}: Not checked`)
    }
    for (const level of ['level_1', 'level_2', 'level_3'] as const) {
      const values = controls[level] as Record<string, unknown> | undefined
      if (!values) continue
      for (const [key, value] of Object.entries(values)) {
        if (value == null) continue
        unchecked.push(`Heading ${level.slice(-1)} ${key.replace(/_/g, ' ')}: ${String(value)} (stored setting; not checked)`)
      }
    }
  }
  return { enabled, unchecked }
}

const CITATION_CHECK_LABELS = {
  check_citations_have_references: 'Citations have matching references',
  check_references_are_cited: 'References are cited',
  check_author_year_consistency: 'Citation author/year consistency',
  check_year_suffixes: 'Citation year suffixes',
  check_duplicate_references: 'Duplicate references',
} as const

function scoredCheckParts(snapshot: ProfileSnapshot): string[] {
  return profileCheckAreas(snapshot).flatMap((area) => area.enabled)
}

function manualCheckParts(snapshot: ProfileSnapshot): string[] {
  const parts = pageElementDisclosureLines(snapshot).filter((line) => !line.endsWith(': Not checked'))
  if (snapshot.citation_matching?.flag_ambiguous_matches === true) parts.push('Ambiguous citation matches · Manual review only · Unscored')
  return parts
}

/**
 * Stored-profile detail groups separate scoring from manual review and show
 * explicit unchecked states. Citation style is context, not a scored check.
 */
export function profileDetailSections(
  snapshot: ProfileSnapshot | null | undefined,
): ProfileDetailSection[] {
  if (!snapshot) return []
  const areas = profileCheckAreas(snapshot)
  const listed = (items: string[], tone: 'check' | 'muted' | 'plain') =>
    items.map((text) => ({ text, tone }))
  const grouped = (kind: 'enabled' | 'unchecked', tone: 'check' | 'muted') => {
    const groups = areas.filter((area) => area[kind].length > 0)
      .map((area) => ({ heading: area.heading, items: listed(area[kind], tone) }))
    const items = groups.flatMap((group) => group.items)
    return { groups, items: items.length ? items : [{ text: 'None', tone: 'muted' as const }] }
  }
  const manual = manualCheckParts(snapshot)
  return [
    {
      heading: 'Profile',
      items: listed([
        snapshot.profile_name || 'Selected profile',
        `Source: ${snapshot.profile_source === 'built_in' ? 'Built-in · Read-only' : 'Custom'} · Version ${snapshot.profile_version}`,
        ...(snapshot.description ? [snapshot.description] : []),
        ...(snapshot.role_exemptions?.length ? [`Formatting exemptions: ${snapshot.role_exemptions.map((role) => role.replace(/_/g, ' ')).join(', ')}`] : []),
        ...(snapshot.table_eligibility ? [`Table classification: ${snapshot.table_eligibility === 'scholarly' ? 'Scholarly' : snapshot.table_eligibility === 'both' ? 'Administrative and scholarly' : 'Administrative'}`] : []),
        ...(snapshot.citation_matching?.allow_personal_communication !== undefined
          ? [`Personal communication citations: ${snapshot.citation_matching.allow_personal_communication ? 'Allowed without a Reference List entry' : 'Require a Reference List entry'}`] : []),
      ], 'plain'),
    },
    {
      heading: 'Scored checks', ...grouped('enabled', 'check'),
      ...(snapshot.references?.check_doi_format === true ? { note: 'The selected profile requires the visible DOI format https://doi.org/<doi>; presentation only, not registration or resolution.' } : {}),
    },
    {
      heading: 'Manual review only · Unscored',
      items: manual.length ? listed(manual, 'muted') : [{ text: 'None', tone: 'muted' }],
      ...(pageElementCheckParts(snapshot).length ? { note: PAGE_ELEMENTS_HELP_TEXT } : {}),
    },
    { heading: 'Not checked', ...grouped('unchecked', 'muted') },
    { heading: 'Citation style', items: [{ text: snapshot.citation_style || 'Not recorded', tone: 'plain' }] },
  ]
}

/** Semantic areas shared by compact selection summaries and complete stored details. */
export function profileCheckAreas(snapshot: ProfileSnapshot): Array<{
  heading: string; enabled: string[]; unchecked: string[]
}> {
  const controls = storedControlParts(snapshot)
  const areas = ['Body', 'Headings', 'Captions', 'Lists'].map((label) => ({
    heading: label === 'Body' ? 'Body text' : label,
    enabled: controls.enabled.filter((text) => text.startsWith(`${label} `)),
    unchecked: controls.unchecked.filter((text) => text.startsWith(`${label} `) || (label === 'Headings' && text.startsWith('Heading '))),
  }))
  const margins = marginsDisclosureLine(snapshot.margins)
  const marginOff = margins.endsWith(': Not checked')
  const uncheckedMargins = marginOff ? [margins] : (['left', 'right', 'top', 'bottom'] as const)
    .filter((side) => snapshot.margins?.[`${side}_in`] == null)
    .map((side) => `${side.charAt(0).toUpperCase()}${side.slice(1)} margin: Not checked`)
  areas.splice(2, 0, { heading: 'Margins', enabled: marginOff ? [] : [margins], unchecked: uncheckedMargins })
  areas.push({
    heading: 'Reference List',
    enabled: referenceCheckParts(snapshot.references),
    unchecked: referenceUncheckedParts(snapshot.references),
  })
  const matching = snapshot.citation_matching
  areas.push({
    heading: 'Citations and references',
    enabled: Object.entries(CITATION_CHECK_LABELS).filter(([key]) => matching?.[key as keyof typeof CITATION_CHECK_LABELS] === true).map(([, label]) => label),
    unchecked: [
      ...Object.entries(CITATION_CHECK_LABELS).filter(([key]) => matching?.[key as keyof typeof CITATION_CHECK_LABELS] !== true).map(([, label]) => `${label}: Not checked`),
      ...(matching?.flag_ambiguous_matches === true ? [] : ['Ambiguous citation matches: Not checked']),
    ],
  })
  areas.push({
    heading: 'Page elements',
    enabled: [],
    unchecked: pageElementDisclosureLines(snapshot).filter((line) => line.endsWith(': Not checked')),
  })
  return areas
}

export function selectedProfileSummary(snapshot: ProfileSnapshot): Array<{
  heading: string; text: string; items?: Array<{ label: string; value: string }>
}> {
  const areas = profileCheckAreas(snapshot)
  const scored = areas.filter((area) => area.enabled.length > 0)
  const count = scored.reduce((total, area) => total + area.enabled.length, 0)
  const structural = [
    { label: 'Headers', enabled: snapshot.headers?.check_header_requirements === true },
    { label: 'Footers', enabled: snapshot.footers?.check_footer_requirements === true },
    { label: 'Page numbers', enabled: snapshot.page_numbers?.check_page_number_requirements === true },
  ]
  const manualItems = structural.filter((item) => item.enabled).map(({ label }) => ({ label, value: 'Manual review' }))
  if (snapshot.page_numbers?.check_page_number_requirements === true) {
    manualItems.push({
      label: 'Placement',
      value: snapshot.page_numbers.placement === 'header' ? 'Header' : snapshot.page_numbers.placement === 'footer' ? 'Footer' : 'Header or Footer',
    })
  }
  if (snapshot.citation_matching?.flag_ambiguous_matches === true) {
    manualItems.push({ label: 'Ambiguous citation matches', value: 'Manual review' })
  }
  const offCount = areas.reduce((total, area) => total + area.unchecked.length, 0)
  const marginsOff = marginsDisclosureLine(snapshot.margins).endsWith(': Not checked')
  const manualCount = manualCheckParts(snapshot).length
  return [
    { heading: 'Scored checks', text: `${count} enabled${scored.length ? ` · ${scored.map((area) => area.heading).join(', ')}` : ''}` },
    { heading: 'Manual review only · Unscored', text: manualCount ? `${manualCount} requirement${manualCount === 1 ? '' : 's'}` : 'None', items: manualItems },
    {
      heading: 'Not checked',
      text: offCount ? `${offCount} requirement${offCount === 1 ? '' : 's'}${marginsOff ? ' · Margins not checked' : ''}` : 'No other requirements',
      items: [...structural.filter((item) => !item.enabled).map(({ label }) => ({ label, value: 'Not checked' })), { label: 'Margins', value: marginsDisclosureLine(snapshot.margins).replace(/^Margins: /, '') }],
    },
    { heading: 'Citation style', text: snapshot.citation_style || 'Not recorded' },
  ]
}
