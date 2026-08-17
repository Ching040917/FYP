/**
 * Rule-aware Finding Detail presentation helper (narrow, keyed by existing
 * rule codes). Pure functions — no React, no I/O.
 *
 * Backend values are never modified; nothing unsupported is invented; a safe
 * generic fallback covers unknown rules; guidance is never identical to the
 * Expected value. Citation Mismatch evidence is presented as evidence, not as
 * an Actual value.
 *
 * All student-facing wording comes from the SINGLE source
 * `lib/friendly-finding.ts` (Confirmed Issue + Required Action) — no
 * presentation rules are duplicated here.
 */

import {
  cleanMessage,
  friendlyFindingMessage,
  friendlyRequiredAction,
  friendlyValue,
  objectLabel,
} from '../friendly-finding.ts'

export interface RulePresentation {
  issue: string
  expected?: string | null
  actual?: string | null
  /** Citation evidence — the in-text citation snippet, never the Actual label. */
  evidence?: string
  missingRequirement?: string
  affectedElement?: string
  expectedHeadingSequence?: string
  actualHeadingSequence?: string
  requiredAction?: string
}

/** Formatting rules with meaningful Expected/Actual values + a deterministic action. */
const FORMATTING_RULES = new Set([
  'FONT_SIZE',
  'FONT_CONSISTENCY',
  'LINE_SPACING',
  'SPACE_BEFORE',
  'SPACE_AFTER',
  'ALIGNMENT',
  'MARGIN_LEFT',
  'MARGIN_RIGHT',
  'MARGIN_TOP',
  'MARGIN_BOTTOM',
])

const MISSING_REQUIREMENT_RULES: Record<string, string> = {
  TABLE_CAPTION_MISSING: 'Table caption',
  IMAGE_CAPTION_MISSING: 'Figure caption',
  IMAGE_ALT_TEXT_MISSING: 'Figure alt-text',
}

const CITATION_ACTION =
  'Add the matching APA 7 reference entry. If the citation refers to the wrong source or is no longer needed, correct or remove it.'

export function presentationFor(v: {
  rule_code: string
  message: string
  expected_value: string | null
  actual_value: string | null
  location: Record<string, unknown> | null
}): RulePresentation {
  const code = v.rule_code

  if (FORMATTING_RULES.has(code)) {
    return {
      issue: friendlyFindingMessage(code, v.message, v.expected_value, v.actual_value, v.location),
      expected: friendlyValue(cleanMessage(v.expected_value)),
      actual: friendlyValue(cleanMessage(v.actual_value)),
      requiredAction: friendlyRequiredAction(code, v.expected_value, v.actual_value, v.location) ?? undefined,
    }
  }

  if (code === 'CITATION_MISMATCH') {
    // Source-faithful evidence for display (the exact matched span, e.g.
    // `(Garcia, 2018)`) — the raw message's canonical narrative form is
    // never shown as the citation. Canonical identity stays internal.
    return {
      issue: friendlyFindingMessage(code, v.message, v.expected_value, v.actual_value, v.location),
      evidence: v.actual_value ?? undefined,
      requiredAction: CITATION_ACTION,
    }
  }

  if (code === 'MANUAL_CAPTION') {
    return {
      issue: friendlyFindingMessage(code, v.message, v.expected_value, v.actual_value, v.location),
      affectedElement: objectLabel(v.location) ?? 'the object',
      requiredAction: friendlyRequiredAction(code, v.expected_value, v.actual_value, v.location) ?? undefined,
    }
  }

  if (MISSING_REQUIREMENT_RULES[code]) {
    return {
      issue: friendlyFindingMessage(code, v.message, v.expected_value, v.actual_value, v.location),
      missingRequirement: MISSING_REQUIREMENT_RULES[code],
      affectedElement: affectedElementFor(code, v.location),
      requiredAction: friendlyRequiredAction(code, v.expected_value, v.actual_value, v.location) ?? undefined,
    }
  }

  if (code === 'HEADING_HIERARCHY') {
    return headingPresentation(v)
  }

  return genericPresentation(v)
}

export function formattingAction(): undefined {
  // Superseded by friendlyRequiredAction in lib/friendly-finding (single
  // source of student-facing wording). Kept as a no-op export only for
  // backward-compatible imports; remove once nothing imports it.
  return undefined
}

function affectedElementFor(
  code: string,
  location: Record<string, unknown> | null,
): string {
  const loc = (location ?? {}) as Record<string, unknown>
  if (code === 'TABLE_CAPTION_MISSING') {
    const i = loc.table_index
    return typeof i === 'number' ? `Table ${i + 1}` : 'Table'
  }
  const i = loc.image_index
  return typeof i === 'number' ? `Figure ${i + 1}` : 'Figure'
}

function headingLevel(value: string | null): number | null {
  if (!value) return null
  const m = /^H(\d+)$/.exec(value.trim())
  return m ? parseInt(m[1], 10) : null
}

function headingPresentation(v: {
  message: string
  expected_value: string | null
  actual_value: string | null
  location: Record<string, unknown> | null
}): RulePresentation {
  const expectedLevel = headingLevel(v.expected_value)
  const actualLevel = headingLevel(v.actual_value)

  // Orphan first heading: outline must start at H1.
  if (expectedLevel === 1 && actualLevel !== null && actualLevel !== 1) {
    return {
      issue: cleanMessage(v.message),
      expectedHeadingSequence: 'H1 → …',
      actualHeadingSequence: `H${actualLevel}`,
      requiredAction: 'Add an H1 heading at the start of the document.',
    }
  }

  // Skipped level: H{prev} → H{actual} with the intermediate level missing.
  if (expectedLevel !== null && actualLevel !== null && expectedLevel < actualLevel) {
    const prev = expectedLevel - 1
    return {
      issue: cleanMessage(v.message),
      expectedHeadingSequence: `H${prev} → H${expectedLevel} → H${actualLevel}`,
      actualHeadingSequence: `H${prev} → H${actualLevel}`,
      requiredAction: `Add the missing H${expectedLevel} heading between H${prev} and H${actualLevel}.`,
    }
  }

  return genericPresentation(v)
}

/** Safe fallback for rules without a dedicated template — never identical to Expected. */
function genericPresentation(v: {
  message: string
  expected_value: string | null
  actual_value: string | null
}): RulePresentation {
  const expected = friendlyValue(cleanMessage(v.expected_value))
  const actual = friendlyValue(cleanMessage(v.actual_value))
  let requiredAction: string | undefined
  if (expected != null) {
    requiredAction = `Update this element to meet the required specification (${expected}).`
  } else if (actual != null) {
    requiredAction = 'Review this element — it does not meet the required specification.'
  } else {
    requiredAction = 'Review this finding in Microsoft Word and apply the required formatting.'
  }
  return { issue: cleanMessage(v.message), expected, actual, requiredAction }
}
