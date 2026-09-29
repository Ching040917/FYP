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
