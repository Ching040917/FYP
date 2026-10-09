/**
 * Student-friendly finding presentation (Part B) — SINGLE source of
 * student-facing wording for Confirmed Issue and Required Action.
 *
 * Raw deterministic messages stay untouched in the backend and persisted
 * findings; this module converts them to plain language. Never exposes:
 * `!=`, `->`, `SEQ field`, `numPr`, raw enum values, internal rule-engine
 * terminology, or mechanical "Adjust the affected element from X to Y"
 * phrasing. Unknown rules fall back to a safely cleaned message.
 * Friendly labels: Table, Figure, Paragraph, Section. Units are normalized
 * ("15.0pt" → "15 pt", "1.5in" → "1.5 in") and capitalization is consistent.
 */

import { extractCitationEvidence } from './pdf/citation-highlight.ts'

/** One-based friendly object label from the violation location. */
export function objectLabel(
  location: Record<string, unknown> | null | undefined,
): string | null {
  const loc = location ?? {}
  if (typeof loc.table_index === 'number') return `Table ${loc.table_index + 1}`
  if (typeof loc.image_index === 'number') return `Figure ${loc.image_index + 1}`
  return null
}

/**
 * Student-facing finding titles — one entry per production rule code.
 *
 * This map is the single source of the reader-visible finding title across
 * the Findings list, Finding Details, the Document Preview, Guided Fixes and
 * (mirrored in Python) the PDF report. It is complete on purpose: with every
 * production code covered, `humanizeRuleCode` is a fallback for unknown codes
 * only and is never visible for a rule ACA can actually emit.
 *
 * Titles describe the mismatch, never the direction of it. `expected_value`
 * is profile- and section-dependent, so "too large" / "too small" would be a
 * claim the data cannot support.
 *
 * Mirrored verbatim by `_RULE_NAME` in backend/app/services/pdf_report.py;
 * backend/tests/test_export_pdf.py enforces the match.
 */
const FRIENDLY_RULE_TITLES: Record<string, string> = {
  FONT_CONSISTENCY: 'Font family does not match',
  FONT_SIZE: 'Font size does not match',
  LINE_SPACING: 'Line spacing does not match',
  SPACE_BEFORE: 'Space before the paragraph does not match',
  SPACE_AFTER: 'Space after the paragraph does not match',
  ALIGNMENT: 'Paragraph alignment does not match',
  MARGIN_LEFT: 'Left page margin does not match',
  MARGIN_RIGHT: 'Right page margin does not match',
  MARGIN_TOP: 'Top page margin does not match',
  MARGIN_BOTTOM: 'Bottom page margin does not match',
  HEADING_HIERARCHY: 'Heading levels skip a step',
  TABLE_CAPTION_MISSING: 'Table caption is missing',
  IMAGE_CAPTION_MISSING: 'Figure caption is missing',
  IMAGE_ALT_TEXT_MISSING: 'Figure alternative text is missing',
  MANUAL_CAPTION: 'Caption was typed instead of inserted',
  CITATION_MISMATCH: 'Citation has no matching Reference List entry',
  CITATION_REFERENCE_MISMATCH: 'Citation year does not match the Reference List entry',
  CITATION_YEAR_SUFFIX_MISMATCH: 'Citation is missing or uses the wrong year suffix',
  CITATION_REFERENCE_AMBIGUOUS: 'Citation could match more than one entry',
  REFERENCE_NOT_CITED: 'Reference List entry is not cited in the text',
  REFERENCE_DUPLICATE: 'Duplicate Reference List entry',
}

/** Every rule code with a bespoke student-facing title (contract tests). */
export const FRIENDLY_RULE_TITLE_CODES: readonly string[] = Object.keys(
  FRIENDLY_RULE_TITLES,
)

/** Friendly title for a rule code, or null when there is no bespoke title. */
export function friendlyRuleTitle(ruleCode: string | null | undefined): string | null {
  const code = (ruleCode ?? '').toUpperCase()
  return FRIENDLY_RULE_TITLES[code] ?? null
}

/** Occurrence count carried by a consolidated finding's location. */
function occurrenceCount(location: Record<string, unknown> | null | undefined): number {
  const n = (location ?? {}).occurrences
  return typeof n === 'number' && n > 1 ? n : 0
}

/**
 * Occurrence label for a consolidated finding, e.g. "3 occurrences".
 * Null unless the finding genuinely repeats — a single hit shows nothing.
 */
export function occurrenceLabel(
  location: Record<string, unknown> | null | undefined,
): string | null {
  const n = occurrenceCount(location)
  return n > 0 ? `${n} occurrences` : null
}

/** Duplicate-entry count carried by a duplicate finding's location. */
function duplicateCount(location: Record<string, unknown> | null | undefined): number {
  const n = (location ?? {}).entry_count
  return typeof n === 'number' && n > 1 ? n : 0
}

/**
 * The single document-wide CITATION_MISMATCH: the document has citations but
 * no References section (the backend's root finding). It is identified by the
 * explicit `missing_references_section` flag — never by a missing paragraph
 * index, which would also match findings that simply have no location.
 */
export function isMissingReferenceSection(
  location: Record<string, unknown> | null | undefined,
): boolean {
  return (location ?? {}).missing_references_section === true
}

export function friendlyFindingMessage(
  ruleCode: string | null | undefined,
  message: string | null | undefined,
  expected: string | null | undefined,
  actual: string | null | undefined,
  location: Record<string, unknown> | null = null,
): string {
  const code = (ruleCode ?? '').toUpperCase()
  const exp = friendlyValue(expected)
  const act = friendlyValue(actual)
  const label = objectLabel(location)

  if (code === 'FONT_SIZE' && act && exp) {
    return `This text uses ${act}, but the required font size is ${exp}.`
  }
  if (code === 'FONT_CONSISTENCY' && act && exp) {
    return `This text uses ${act}, but the required font is ${exp}.`
  }
  if (code === 'ALIGNMENT' && act && exp) {
    return `This paragraph is ${alignmentWord(act)}, but ${alignmentWord(exp)} alignment is required.`
  }
  if (code === 'LINE_SPACING' && act && exp) {
    return `This paragraph uses ${act} line spacing, but ${exp} is required.`
  }
  if ((code === 'SPACE_BEFORE' || code === 'SPACE_AFTER') && act && exp) {
    const side = code === 'SPACE_BEFORE' ? 'before' : 'after'
    return `This paragraph has ${act} spacing ${side} it, but ${exp} is required.`
  }
  if (code.startsWith('MARGIN_') && act && exp) {
    const side = code.replace('MARGIN_', '').toLowerCase()
    return `The ${side} margin is ${act}, but the required margin is ${exp}.`
  }
  if (code === 'MANUAL_CAPTION' && label) {
    return (
      `${label} uses manually typed caption text instead of Microsoft Word's ` +
      `built-in caption feature. Automatic numbering and cross-references ` +
      `may not update correctly.`
    )
  }
  if (code === 'TABLE_CAPTION_MISSING' && label) {
    return `${label} does not have a caption.`
  }
  if (code === 'IMAGE_CAPTION_MISSING' && label) {
    return `${label} does not have a caption.`
  }
  if (code === 'IMAGE_ALT_TEXT_MISSING' && label) {
    return `${label} does not have alternative text for screen-reader users.`
  }
  if (code === 'CITATION_MISMATCH') {
    if (isMissingReferenceSection(location)) {
      const count = Number((location as Record<string, unknown>).citation_count)
      const citations = count === 1 ? 'in-text citation' : 'in-text citations'
      return (
        `No References section was found, so ${count} ${citations} could not be ` +
        `checked against a Reference List.`
      )
    }
    // Source-faithful evidence for display (exact matched span, e.g.
    // `(Garcia, 2018)`) — never the message's canonical narrative form.
    const evidence = extractCitationEvidence(message, actual)
    const display = evidence ? evidence.text : (actual ?? cleanMessage(message))
    const times = occurrenceCount(location)
    return (
      `The in-text citation ${display} does not have a matching entry in the References section.` +
      (times ? ` Found ${times} times in the document.` : '')
    )
  }
  if (code === 'CITATION_REFERENCE_MISMATCH') {
    const evidence = extractCitationEvidence(message, actual)
    const display = evidence ? evidence.text : (actual ?? cleanMessage(message))
    const year = exp ?? 'the entry year'
    return `The in-text citation ${display} does not state the same year as its Reference List entry (${year}).`
  }
  if (code === 'CITATION_YEAR_SUFFIX_MISMATCH') {
    const evidence = extractCitationEvidence(message, actual)
    const display = evidence ? evidence.text : (actual ?? cleanMessage(message))
    const year = exp ?? 'the entry year'
    return `The in-text citation ${display} is missing the year suffix used by its Reference List entry (${year}).`
  }
  if (code === 'CITATION_REFERENCE_AMBIGUOUS') {
    const evidence = extractCitationEvidence(message, actual)
    const display = evidence ? evidence.text : (actual ?? cleanMessage(message))
    return (
      `The in-text citation ${display} could match more than one entry with the same author ` +
      `name. Initials are not compared, so this needs a manual check.`
    )
  }
  if (code === 'REFERENCE_NOT_CITED') {
    const entry = act ? `“${act}”` : 'This Reference List entry'
    return `${entry} was not cited anywhere in the text.`
  }
  if (code === 'REFERENCE_DUPLICATE') {
    const count = duplicateCount(location)
    const entry = act ? `“${act}”` : 'A Reference List entry'
    return (
      `${entry} is listed more than once.` + (count ? ` Found ${count} entries.` : '')
    )
  }
  return cleanMessage(message)
}

/**
 * Concrete Required Action per rule. Object rules give concrete Microsoft
 * Word steps; formatting rules name the exact change; unknown rules never
 * use the mechanical "Adjust the affected element from X to Y" phrasing.
 */
export function friendlyRequiredAction(
  ruleCode: string | null | undefined,
  expected: string | null | undefined,
  actual: string | null | undefined,
  location: Record<string, unknown> | null = null,
): string | null {
  const code = (ruleCode ?? '').toUpperCase()
  const exp = friendlyValue(expected)
  const act = friendlyValue(actual)
  const label = objectLabel(location)

  if (code === 'FONT_SIZE' && act && exp) {
    return `Change the font size from ${act} to ${exp}.`
  }
  if (code === 'FONT_CONSISTENCY' && act && exp) {
    return `Change the font family from ${act} to ${exp}.`
  }
  if (code === 'ALIGNMENT' && act && exp) {
    return `Change the paragraph alignment from ${alignmentWord(act)} to ${alignmentWord(exp)}.`
  }
  if (code === 'LINE_SPACING' && act && exp) {
    return `Change the line spacing from ${act} to ${exp}.`
  }
  if ((code === 'SPACE_BEFORE' || code === 'SPACE_AFTER') && act && exp) {
    const side = code === 'SPACE_BEFORE' ? 'before' : 'after'
    return `Change the space ${side} from ${act} to ${exp}.`
  }
  if (code.startsWith('MARGIN_') && act && exp) {
    const side = code.replace('MARGIN_', '').toLowerCase()
    return `Change the ${side} margin from ${act} to ${exp}.`
  }
  if (code === 'MANUAL_CAPTION' && label) {
    const type = label.startsWith('Table') ? 'Table' : 'Figure'
    return (
      `Delete the manually typed caption. Select ${label}, then use ` +
      `References → Insert Caption in Microsoft Word. Choose the “${type}” ` +
      `label and confirm that Word generates the number automatically.`
    )
  }
  if (code === 'TABLE_CAPTION_MISSING' && label) {
    return (
      `Add a caption for ${label}. Place the cursor above or below the ` +
      `table in Microsoft Word, then use References → Insert Caption and ` +
      `choose the “Table” label.`
    )
  }
  if (code === 'IMAGE_CAPTION_MISSING' && label) {
    return (
      `Add a caption for ${label}. In Microsoft Word, place the cursor ` +
      `below the figure, then use References → Insert Caption and choose ` +
      `the “Figure” label.`
    )
  }
  if (code === 'IMAGE_ALT_TEXT_MISSING' && label) {
    return (
      `Add alternative text for ${label}. Right-click the figure, choose ` +
      `Edit Alt Text, and enter a concise description for screen-reader users.`
    )
  }
  if (code === 'HEADING_HIERARCHY') {
    return null // Finding Detail renders its own heading-sequence action
  }
  // Citation/Reference List matching — fixed copy, never a formatting step.
  if (code === 'CITATION_MISMATCH' && isMissingReferenceSection(location)) {
    return 'Add a References section and list every source cited in the text.'
  }
  if (code === 'CITATION_MISMATCH') {
    return (
      `Add the matching APA 7 reference entry. If the citation refers to the ` +
      `wrong source or is no longer needed, correct or remove it.`
    )
  }
  if (code === 'CITATION_REFERENCE_MISMATCH') {
    return 'Correct the year in the in-text citation or in the Reference List entry so both state the same year.'
  }
  if (code === 'CITATION_YEAR_SUFFIX_MISMATCH') {
    return 'Add the matching year suffix (a, b, …) to the in-text citation, or correct the suffix in the Reference List entry.'
  }
  if (code === 'CITATION_REFERENCE_AMBIGUOUS') {
    return 'Confirm which listed source this citation refers to.'
  }
  if (code === 'REFERENCE_NOT_CITED') {
    return 'Cite this source in the text, or remove the entry.'
  }
  if (code === 'REFERENCE_DUPLICATE') {
    return 'Keep one entry and remove the duplicate.'
  }
  if (exp && act) {
    return `Update this element to meet the required specification (${exp}).`
  }
  if (exp) {
    return `Update this element to meet the required specification (${exp}).`
  }
  if (act) {
    return 'Review this element — it does not meet the required specification.'
  }
  return 'Review this finding in Microsoft Word and apply the required formatting.'
}

/**
 * Reader-facing Current/Required value. Pure formatting of one value — no
 * rule logic, no direction claims, no case changes.
 *
 * "15.0pt" → "15 pt" · "1.5in" → "1.5 in" · "2.0cm" → "2 cm" · "12.0mm" →
 * "12 mm" · "2.0" stays "2.0" (a bare line-spacing multiple has no unit to
 * attach one to). Apostrophes and font names pass through untouched.
 */
export function friendlyValue(value: string | null | undefined): string | null {
  if (value == null) return null
  let s = String(value).trim()
  if (!s) return null
  // Drop a meaningless trailing ".0" only when a real unit follows. The unit
  // alternation is word-bounded on every branch, so "2.0inside" or "3mmy" can
  // never be mistaken for a measurement.
  s = s.replace(/(\d+)\.0(?=pt\b|in\b|cm\b|mm\b)/i, '$1')
  s = s.replace(/(\d)(pt|in|cm|mm)\b/i, '$1 $2')
  return s
}


/**
 * Short "Current → Required" comparison for one finding.
 *
 * Returns null unless BOTH sides survive formatting: an arrow with a missing
 * side ("14 pt → ", " → 12 pt") claims a comparison the data cannot make.
 * Callers render a labelled fallback instead — see `comparisonText`.
 *
 * "14pt"/"12pt" → "14 pt → 12 pt" · "Arial"/"Times New Roman" → pass through ·
 * "left"/"justify" → "left → justified" · "0"/"6pt" → "0 → 6 pt".
 */
export function friendlyComparison(
  actual: string | null | undefined,
  expected: string | null | undefined,
): string | null {
  const from = friendlyValue(actual)
  const to = friendlyValue(expected)
  if (!from || !to) return null
  // Alignment values read as words, not enum tokens: "left → justified".
  return `${alignmentWord(from)} → ${alignmentWord(to)}`
}

/**
 * The single comparison line for a finding card.
 *
 * Four states, and the wording never overstates what the data shows:
 *   both sides      → "14 pt → 12 pt"
 *   Current only    → "Current: 14 pt"
 *   Required only   → "Required: 12 pt"
 *   neither         → null (the caller renders no line at all)
 *
 * A missing Required value means ACA has nothing to state, NOT that the
 * property is unnecessary — so the single-value fallback always names which
 * side it has rather than implying the other side does not apply.
 */
export function comparisonText(
  actual: string | null | undefined,
  expected: string | null | undefined,
): string | null {
  const both = friendlyComparison(actual, expected)
  if (both) return both
  const from = friendlyValue(actual)
  const to = friendlyValue(expected)
  if (from) return `Current: ${from}`
  if (to) return `Required: ${to}`
  return null
}

/**
 * Alignment values read as English words: "center" → "centered",
 * "justify"/"justified" → "justified". Left and right are unchanged.
 *
 * Any other value is returned with its ORIGINAL casing intact. This is a
 * comparison helper, not a case-folding one — routing font names through it
 * must not turn "Arial → Times New Roman" into "arial → times new roman".
 */
export function alignmentWord(value: string): string {
  const trimmed = value.trim()
  const v = trimmed.toLowerCase()
  if (v === 'center') return 'centered'
  if (v === 'justify' || v === 'justified') return 'justified'
  return trimmed
}

/** Cleaned raw message: no developer tokens, internal terms, or raw enums. */
export function cleanMessage(message: string | null | undefined): string {
  if (!message) return ''
  return String(message)
    .replace(/!=/g, 'is not')
    .replace(/->/g, 'to')
    .replace(/=>/g, 'to')
    .replace(/\bSEQ\s+field\b/gi, 'automatic caption numbering')
    .replace(/\bnumPr\b/gi, 'list formatting')
    .replace(/\bdocPr@descr\b/gi, 'image description')
    .replace(/\s+/g, ' ')
    .trim()
}
