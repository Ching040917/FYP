/**
 * Rule-aware Finding Detail presentation helper (narrow, keyed by existing
 * rule codes). Pure functions — no React, no I/O.
 *
 * Backend values are never modified; nothing unsupported is invented; a safe
 * generic fallback covers unknown rules; guidance is never identical to the
 * Expected value. Citation Mismatch evidence is presented as evidence, not as
 * an Actual value.
 */

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
  IMAGE_CAPTION_MISSING: 'Image caption',
  IMAGE_ALT_TEXT_MISSING: 'Image alt-text',
}

const CITATION_ACTION =
  'Add a matching reference entry, or correct or remove the citation if it does not represent the intended source.'

export function presentationFor(v: {
  rule_code: string
  message: string
  expected_value: string | null
  actual_value: string | null
  location: Record<string, unknown> | null
}): RulePresentation {
  const issue = v.message
  const code = v.rule_code

  if (FORMATTING_RULES.has(code)) {
    return {
      issue,
      expected: v.expected_value,
      actual: v.actual_value,
      requiredAction: formattingAction(code, v.expected_value, v.actual_value),
    }
  }

  if (code === 'CITATION_MISMATCH') {
    return {
      issue,
      evidence: v.actual_value ?? undefined,
      requiredAction: CITATION_ACTION,
    }
  }

  if (MISSING_REQUIREMENT_RULES[code]) {
    return {
      issue,
      missingRequirement: MISSING_REQUIREMENT_RULES[code],
      affectedElement: affectedElementFor(code, v.location),
      requiredAction: v.message,
    }
  }

  if (code === 'HEADING_HIERARCHY') {
    return headingPresentation(v)
  }

  return genericPresentation(v)
}

export function formattingAction(
  code: string,
  expected: string | null,
  actual: string | null,
): string | undefined {
  if (expected == null || actual == null) return undefined
  switch (code) {
    case 'FONT_SIZE':
      return `Change the font size from ${ptLabel(actual)} to ${ptLabel(expected)}.`
    case 'FONT_CONSISTENCY':
      return `Change the font family from ${actual} to ${expected}.`
    case 'LINE_SPACING':
      return `Change the line spacing from ${actual} to ${expected}.`
    case 'SPACE_BEFORE':
      return `Change the space before from ${ptLabel(actual)} to ${ptLabel(expected)}.`
    case 'SPACE_AFTER':
      return `Change the space after from ${ptLabel(actual)} to ${ptLabel(expected)}.`
    case 'ALIGNMENT':
      return `Change the paragraph alignment from ${alignmentLabel(actual)} to ${alignmentLabel(expected)}.`
    case 'MARGIN_LEFT':
      return `Change the left margin from ${inchLabel(actual)} to ${inchLabel(expected)}.`
    case 'MARGIN_RIGHT':
      return `Change the right margin from ${inchLabel(actual)} to ${inchLabel(expected)}.`
    case 'MARGIN_TOP':
      return `Change the top margin from ${inchLabel(actual)} to ${inchLabel(expected)}.`
    case 'MARGIN_BOTTOM':
      return `Change the bottom margin from ${inchLabel(actual)} to ${inchLabel(expected)}.`
    default:
      return undefined
  }
}

/** "12pt" → "12 pt" */
function ptLabel(value: string): string {
  const numeric = value.replace(/pt$/, '').trim()
  return numeric ? `${numeric} pt` : value
}

/** "1.0in" → "1.0 inch", "1.5in" → "1.5 inches" */
function inchLabel(value: string): string {
  const numeric = value.replace(/in$/, '').trim()
  if (!numeric) return value
  return `${numeric} ${parseFloat(numeric) === 1 ? 'inch' : 'inches'}`
}

const ALIGNMENT_LABELS: Record<string, string> = {
  left: 'Left',
  center: 'Center',
  right: 'Right',
  justify: 'Justified',
}

function alignmentLabel(value: string): string {
  return ALIGNMENT_LABELS[value.toLowerCase()] ?? value
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
  return typeof i === 'number' ? `Image ${i + 1}` : 'Image'
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
      issue: v.message,
      expectedHeadingSequence: 'H1 → …',
      actualHeadingSequence: `H${actualLevel}`,
      requiredAction: 'Add an H1 heading at the start of the document.',
    }
  }

  // Skipped level: H{prev} → H{actual} with the intermediate level missing.
  if (expectedLevel !== null && actualLevel !== null && expectedLevel < actualLevel) {
    const prev = expectedLevel - 1
    return {
      issue: v.message,
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
  const expected = v.expected_value
  const actual = v.actual_value
  let requiredAction: string | undefined
  if (expected != null && actual != null) {
    requiredAction = `Adjust the affected element from "${actual}" to "${expected}".`
  } else if (expected != null) {
    requiredAction = 'Update the element to meet the required specification.'
  } else if (actual != null) {
    requiredAction = 'Review this element — it does not meet the required specification.'
  }
  return { issue: v.message, expected, actual, requiredAction }
}
