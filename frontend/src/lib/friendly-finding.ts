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
 * Student-facing finding titles. Only the citation/reference codes carry a
 * bespoke title; everything else falls back to the mechanical rule-code
 * humanization in lib/audit/adapter (never a developer token).
 */
const FRIENDLY_RULE_TITLES: Record<string, string> = {
  CITATION_MISMATCH: 'Citation without a Reference List entry',
  CITATION_REFERENCE_MISMATCH: 'Citation year does not match the Reference List entry',
  CITATION_YEAR_SUFFIX_MISMATCH: 'Citation is missing the year suffix',
  CITATION_REFERENCE_AMBIGUOUS: 'Citation could match more than one entry',
  REFERENCE_NOT_CITED: 'Reference List entry not cited in the text',
  REFERENCE_DUPLICATE: 'Duplicate Reference List entry',
}

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

/** Duplicate-entry count carried by a duplicate finding's location. */
function duplicateCount(location: Record<string, unknown> | null | undefined): number {
  const n = (location ?? {}).entry_count
  return typeof n === 'number' && n > 1 ? n : 0
}

/**
 * A document-wide CITATION_MISMATCH: the document has citations but no
 * References section at all (the backend's single root finding). It carries
 * no per-citation evidence, so it must never be phrased as "the citation X".
 */
export function isMissingReferenceSection(
  location: Record<string, unknown> | null | undefined,
): boolean {
  const loc = location ?? {}
  return typeof loc.citation_count === 'number' && loc.paragraph_index == null
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

/** "15.0pt" → "15 pt"; "1.5in" → "1.5 in"; "2.0" stays "2.0"; else unchanged. */
export function friendlyValue(value: string | null | undefined): string | null {
  if (value == null) return null
  let s = String(value).trim()
  if (/^\d+\.0(?=pt|in\b)/i.test(s)) s = s.replace(/(\d+)\.0(?=pt|in\b)/i, '$1')
  s = s.replace(/(\d)pt\b/i, '$1 pt')
  s = s.replace(/(\d)in\b/i, '$1 in')
  return s || null
}

/** "center" → "centered", "justify" → "justified"; left/right unchanged. */
export function alignmentWord(value: string): string {
  const v = value.trim().toLowerCase()
  if (v === 'center') return 'centered'
  if (v === 'justify' || v === 'justified') return 'justified'
  return v
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
