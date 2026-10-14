/**
 * Selected-evidence summary for the Document Preview heading.
 *
 * The summary used to be rendered as chips in their own full-width row above
 * the rendered page (38px, 54px when a message wrapped). It is now one compact
 * inline chip on the heading line, so this pure helper owns the wording and
 * precedence: the exact sentences the chips used to show, in the same order,
 * joined into a single line. `null` means "nothing selected" and the heading
 * renders no chip at all (no reserved empty space).
 *
 * No run indexes or other internal identifiers are produced here — only the
 * already-friendly strings the caller passes in.
 */

export type EvidenceTone = 'destructive' | 'warning' | 'muted'

export interface EvidenceSummary {
  /** Full, human-readable summary (the chip ellipsises it visually only). */
  readonly text: string
  /** Accent for the chip icon: citation / structural / informational. */
  readonly tone: EvidenceTone
}

export interface EvidenceSummaryInput {
  /** Exact citation highlight rects; non-empty means the highlight exists. */
  citationRects?: readonly unknown[] | null
  citationLabel?: string | null
  /** Truthful message shown when the exact highlight is unavailable. */
  highlightMessage?: string | null
  /** Formatting evidence rect set; truthy means a formatting highlight exists. */
  formattingEvidence?: unknown
  formattingLabel?: string | null
  formattingMessage?: string | null
  objectStatus?: { label: string | null; message: string | null } | null
  figureOutline?: { label: string } | null
  figureMessage?: string | null
  marginStatus?: { label: string | null; message: string | null } | null
  marginChipLabel?: string | null
}

export function evidenceSummary(input: EvidenceSummaryInput): EvidenceSummary | null {
  const entries: Array<{ text: string; tone: EvidenceTone }> = []
  const add = (text: string | null | undefined, tone: EvidenceTone) => {
    if (text) entries.push({ text, tone })
  }

  const hasCitationRects = !!input.citationRects && input.citationRects.length > 0
  if (hasCitationRects && input.citationLabel) {
    add(`Selected evidence: ${input.citationLabel}`, 'destructive')
  }
  // The fallback message is shown only when no exact citation highlight exists.
  if (!hasCitationRects) {
    add(input.highlightMessage, 'muted')
  }
  if (input.formattingEvidence && input.formattingLabel) {
    add(`Selected evidence: ${input.formattingLabel}`, 'warning')
  } else if (!input.formattingEvidence) {
    add(input.formattingMessage, 'muted')
  }
  if (input.objectStatus && input.objectStatus.label && !input.objectStatus.message) {
    add(`Selected object: ${input.objectStatus.label}`, 'warning')
  } else if (input.objectStatus && input.objectStatus.message) {
    add(`${input.objectStatus.label ? `${input.objectStatus.label} · ` : ''}${input.objectStatus.message}`, 'muted')
  }
  if (input.figureOutline) {
    add(`Selected figure: ${input.figureOutline.label}`, 'warning')
  } else {
    add(input.figureMessage, 'muted')
  }
  let marginLabelAdded = false
  if (input.marginChipLabel) {
    add(`Selected margin: ${input.marginChipLabel}`, 'warning')
    marginLabelAdded = true
  } else if (input.marginStatus && input.marginStatus.label) {
    add(`Selected margin: ${input.marginStatus.label}`, 'warning')
    marginLabelAdded = true
  }
  // The margin message is additive (the original chip set could show the
  // section label AND its message). The label is prefixed only when it is not
  // already on the line, so the joined summary never repeats it.
  if (input.marginStatus && input.marginStatus.message) {
    add(
      marginLabelAdded
        ? input.marginStatus.message
        : `${input.marginStatus.label ? `${input.marginStatus.label} · ` : ''}${input.marginStatus.message}`,
      'muted',
    )
  }

  if (entries.length === 0) return null
  // The chip is a single line by design: collapse any embedded newlines or
  // runs of whitespace so the visible text, the tooltip and the accessible
  // name all remain one continuous sentence.
  const text = entries
    .map((e) => e.text)
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return { text, tone: entries[0].tone }
}

/**
 * Evidence precision for the Selected-evidence details view — coarse,
 * truthful, and derived from the same inputs as `evidenceSummary`:
 *
 * - exact citation evidence: exact highlight rects exist;
 * - paragraph evidence: a formatting highlight exists (run or paragraph);
 * - page-only evidence: an object/figure/margin selection with no
 *   text-level highlight;
 * - visual region unavailable: message-only fallback, no highlight at all.
 */
export type EvidencePrecision =
  | 'Exact citation evidence'
  | 'Paragraph evidence'
  | 'Page-only evidence'
  | 'Visual region unavailable'

export function evidencePrecision(input: EvidenceSummaryInput): EvidencePrecision {
  if (input.citationRects && input.citationRects.length > 0) return 'Exact citation evidence'
  if (input.formattingEvidence) return 'Paragraph evidence'
  if (
    input.figureOutline ||
    (input.objectStatus && (input.objectStatus.label || input.objectStatus.message)) ||
    input.marginChipLabel ||
    (input.marginStatus && (input.marginStatus.label || input.marginStatus.message))
  ) {
    return 'Page-only evidence'
  }
  return 'Visual region unavailable'
}

/** First known physical page across the highlight sources, if any. */export function evidencePage(input: {
  citationRects?: readonly { page: number }[] | null
  formattingPageRects?: readonly { page: number }[] | null
  figurePage?: number | null
  marginStartPage?: number | null
}): number | null {
  if (input.citationRects && input.citationRects.length > 0) return input.citationRects[0].page
  if (input.formattingPageRects && input.formattingPageRects.length > 0) {
    return input.formattingPageRects[0].page
  }
  if (input.figurePage != null) return input.figurePage
  if (input.marginStartPage != null) return input.marginStartPage
  return null
}

export interface EvidenceTargetLabelInput {
  citationRects?: readonly unknown[] | null
  formattingEvidence?: unknown
  /** True when the selected finding is a Reference List rule. */
  referenceEntry?: boolean
  /** True when the selected finding targets the Reference heading. */
  headingEntry?: boolean
  /** Zero-based paragraph identity; rendered one-based. */
  paragraphIndex?: number | null
  figureLabel?: string | null
  objectLabel?: string | null
  marginLabel?: string | null
}

/**
 * Short evidence-target label for the details view — a location-like name
 * such as `Citation occurrence`, `Reference entry`, `References heading`,
 * `Paragraph 1` or `Table 1`. Never the complete Finding title and never
 * a full entry excerpt; those already have their own rows. Falls back to
 * the short object/margin label when one applies, else '—'.
 */
export function evidenceTargetLabel(input: EvidenceTargetLabelInput): string {
  if (input.citationRects && input.citationRects.length > 0) return 'Citation occurrence'
  if (input.formattingEvidence) {
    if (input.headingEntry) return 'References heading'
    if (input.referenceEntry) return 'Reference entry'
    if (input.paragraphIndex != null) return `Paragraph ${input.paragraphIndex + 1}`
    return 'Paragraph'
  }
  const label = input.figureLabel ?? input.objectLabel ?? input.marginLabel ?? null
  return label ?? '—'
}

export interface CompactEvidenceParts {
  /** Zero-based paragraph identity; rendered one-based. */
  paragraphIndex: number | null
  page: number | null
  /** Object-level location (Table/Figure/margin) when no paragraph applies. */
  objectLabel?: string | null
  /** Short evidence precision for the compact bar (see `compactPrecisionLabel`). */
  precision: string
}

/**
 * Compact one-line Selected-evidence text: lead plus physical page,
 * paragraph/object location and evidence precision — never the Finding
 * title (already visible in Finding Details) and never the full target
 * text (available in the details view). Only the compact presentation is
 * built here; stored text is untouched.
 */
export function compactEvidenceText(parts: CompactEvidenceParts): string {
  const slots: string[] = ['Evidence']
  if (parts.page != null) slots.push(`Page ${parts.page}`)
  if (parts.paragraphIndex != null) {
    slots.push(`Paragraph ${parts.paragraphIndex + 1}`)
  } else if (parts.objectLabel) {
    slots.push(parts.objectLabel)
  }
  if (parts.precision) slots.push(parts.precision)
  return slots.join(' · ')
}

/**
 * Short precision wording for the compact bar. The details view keeps the
 * full `EvidencePrecision` label; the bar shortens only the exact-citation
 * form to match the compact examples.
 */
export function compactPrecisionLabel(precision: EvidencePrecision): string {
  return precision === 'Exact citation evidence' ? 'Citation evidence' : precision
}
