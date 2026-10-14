/**
 * Cross-surface consistency.
 *
 * A student meets the same finding in five places: the Findings card, Finding
 * Details, the Document Preview overlay, Guided Fixes, and the PDF. Each must
 * speak with the same voice. This file proves the shared helpers are the ones
 * actually wired into those surfaces, so a surface cannot quietly reintroduce
 * its own private title or value formatting.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  FRIENDLY_RULE_TITLE_CODES,
  friendlyRuleTitle,
} from '../src/lib/friendly-finding.ts'
import { SUPPORTED_FIX_RULES, guidedPresentationFor } from '../src/lib/guided-fixes.ts'
import { normalizeViolationSeverity } from '../src/lib/audit/adapter.ts'
import { severityBadge } from '../src/lib/audit/categories.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

const CARD = read('src/components/audit/error-list.tsx')
const DETAIL = read('src/components/audit/finding-detail.tsx')
const PREVIEW = read('src/components/audit/document-preview.tsx')
const PANEL = read('src/components/audit/guided-fixes-panel.tsx')
const PAGE = read('src/pages/AuditPage.tsx')
const HIGHLIGHT = read('src/lib/pdf/formatting-highlight.ts')
const GUIDED = read('src/lib/guided-fixes.ts')

/** All 31 codes ACA can emit today. */
const PRODUCTION_CODES = [
  'FONT_CONSISTENCY',
  'FONT_SIZE',
  'LINE_SPACING',
  'SPACE_BEFORE',
  'SPACE_AFTER',
  'ALIGNMENT',
  'MARGIN_LEFT',
  'MARGIN_RIGHT',
  'MARGIN_TOP',
  'MARGIN_BOTTOM',
  'HEADING_HIERARCHY',
  'TABLE_CAPTION_MISSING',
  'IMAGE_CAPTION_MISSING',
  'IMAGE_ALT_TEXT_MISSING',
  'MANUAL_CAPTION',
  'CITATION_MISMATCH',
  'CITATION_REFERENCE_MISMATCH',
  'CITATION_YEAR_SUFFIX_MISMATCH',
  'CITATION_REFERENCE_AMBIGUOUS',
  'REFERENCE_NOT_CITED',
  'REFERENCE_DUPLICATE',
  'REFERENCE_ORDER',
  'REFERENCE_HEADING_TEXT',
  'REFERENCE_HEADING_BOLD',
  'REFERENCE_HEADING_ALIGNMENT',
  'REFERENCE_SECTION_NEW_PAGE',
  'REFERENCE_HANGING_INDENT',
  'REFERENCE_SPACE_BEFORE',
  'REFERENCE_SPACE_AFTER',
  'REFERENCE_FONT_FAMILY',
  'REFERENCE_FONT_SIZE',
  'REFERENCE_ALIGNMENT',
]

// ---------------------------------------------------------------------------
// Title map completeness
// ---------------------------------------------------------------------------

test('every one of the 32 production codes has a title, and no others do', () => {
  assert.deepEqual([...FRIENDLY_RULE_TITLE_CODES].sort(), [...PRODUCTION_CODES].sort())
})

test('no production title is a raw rule code', () => {
  for (const code of PRODUCTION_CODES) {
    const title = friendlyRuleTitle(code)
    assert.ok(title, `${code} has no title`)
    assert.notEqual(title, code)
    assert.ok(!title.includes('_'), title)
  }
})

test('the ambiguous-citation title keeps its agreed wording', () => {
  // Pinned by the e2e locator and by design: this one needs a human.
  assert.equal(
    friendlyRuleTitle('CITATION_REFERENCE_AMBIGUOUS'),
    'Citation could match more than one entry',
  )
})

// ---------------------------------------------------------------------------
// Every surface reads the shared helpers
// ---------------------------------------------------------------------------

test('Findings card and Finding Details both read the shared title map', () => {
  assert.match(PAGE, /friendlyRuleTitle\(v\.rule_code\)/)
  assert.match(DETAIL, /friendlyRuleTitle\(v\.rule_code\)/)
  // Neither surface keeps a private label table.
  assert.doesNotMatch(DETAIL, /Record<string, string>\s*=\s*\{/)
})

test('Guided Fixes reads the shared title map, with no private label table', () => {
  assert.match(GUIDED, /friendlyRuleTitle\(ruleCode\)/)
  assert.match(PANEL, /friendlyRuleTitle\(v\.rule_code\)/)
  assert.doesNotMatch(PANEL, /REVIEW_TITLES/)
  // No inline humanisation left behind.
  assert.doesNotMatch(GUIDED, /\.split\('_'\)/)
})

test('formatting highlights read the shared title map', () => {
  assert.match(HIGHLIGHT, /friendlyRuleTitle\(ruleCode\)/)
  assert.doesNotMatch(HIGHLIGHT, /FORMATTING_LABELS/)
})

test('Guided Fixes values read the shared value helpers', () => {
  assert.match(GUIDED, /friendlyValue\(/)
  assert.match(GUIDED, /alignmentWord\(/)
  assert.doesNotMatch(GUIDED, /String\(v\.actual_value \?\? ''\)\.trim\(\)/)
})

test('severity labels come from the shared badge on card, detail and preview', () => {
  for (const source of [CARD, DETAIL, PREVIEW]) {
    assert.match(source, /severityBadge\(/)
  }
  // The preview chip no longer decides its own severity colours.
  assert.doesNotMatch(PREVIEW, /border-destructive\/30 bg-destructive\/10/)
  assert.doesNotMatch(PREVIEW, /border-warning\/30 bg-warning\/10/)
})

// ---------------------------------------------------------------------------
// Guided Fixes behaviour must be untouched
// ---------------------------------------------------------------------------

test('the Guided Fixes whitelist is exactly the seven safe formatting rules', () => {
  assert.deepEqual(
    [...SUPPORTED_FIX_RULES].sort(),
    [
      'ALIGNMENT',
      'FONT_CONSISTENCY',
      'FONT_SIZE',
      'LINE_SPACING',
      'SPACE_AFTER',
      'SPACE_BEFORE',
    ].sort(),
  )
})

test('citation and reference findings stay manual-only', () => {
  for (const code of [
    'CITATION_MISMATCH',
    'CITATION_REFERENCE_MISMATCH',
    'CITATION_YEAR_SUFFIX_MISMATCH',
    'CITATION_REFERENCE_AMBIGUOUS',
    'REFERENCE_NOT_CITED',
    'REFERENCE_DUPLICATE',
  ]) {
    assert.equal(SUPPORTED_FIX_RULES.has(code), false, code)
    const pres = guidedPresentationFor({
      rule_code: code,
      expected_value: null,
      actual_value: null,
      location: null,
    })
    assert.equal(pres.supported, false, code)
    assert.equal(pres.proposed, '', code)
  }
})

test('no unknown-severity fallback can enable a Guided Fix', () => {
  // Eligibility is decided by the rule whitelist alone; severity is not an
  // input to the selection surface at all.
  assert.doesNotMatch(GUIDED, /severity/i)
  const pres = guidedPresentationFor({
    rule_code: 'FONT_SIZE',
    expected_value: '12pt',
    actual_value: '14pt',
    location: null,
  })
  assert.equal(pres.supported, true)
})

// ---------------------------------------------------------------------------
// Severity terminology across the preview
// ---------------------------------------------------------------------------

test('an unrecognised severity normalises to Unclassified, never Minor', () => {
  for (const token of ['ARCHIVE', 'CRITICAL', '', null, undefined, 'n/a']) {
    assert.equal(normalizeViolationSeverity(token as never), 'unknown')
    assert.equal(severityBadge('unknown').label, 'Unclassified')
  }
})

test('the preview shows Manual review for a REVIEW finding', () => {
  assert.match(PREVIEW, /SeverityChip severity="review"/)
  assert.equal(severityBadge('review').label, 'Manual review')
  assert.notEqual(severityBadge('review').className, severityBadge('minor').className)
})

test('the preview has a chip for every severity it can receive', () => {
  // major, minor and review are all reachable from the block's violations.
  assert.match(PREVIEW, /severity="major"/)
  assert.match(PREVIEW, /severity="minor"/)
  assert.match(PREVIEW, /severity="review"/)
})
