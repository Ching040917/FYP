/**
 * Local AI Citation Guidance — eligibility gate.
 *
 * The guidance section exists ONLY for a finding that is already eligible
 * under the strict Local AI contract (see local-ai-citation-eligibility.ts,
 * mirrored with the backend helper): paragraph-scoped CITATION_MISMATCH
 * with a real non-negative integer paragraph index, MAJOR/MINOR severity,
 * and a non-empty citation snippet. Everything else — fonts, alignment, line spacing,
 * paragraph spacing, margins, headings, Reference List formatting, year and
 * suffix mismatches, ambiguity, uncited and duplicate entries — renders no
 * section at all, and no "AI is available elsewhere" explanation.
 *
 * This suite pins the SOURCE gate so a future edit cannot re-widen it.
 * The gate must use the shared helper — no duplicated inline predicates.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

const PAGE = read('src/pages/AuditPage.tsx')

/** The CitationSection body only — the rest of the page is irrelevant here. */
const SECTION = (() => {
  const start = PAGE.indexOf('function CitationSection(')
  const end = PAGE.indexOf('const STAT_LABELS')
  assert.ok(start > 0 && end > start, 'CitationSection must exist in AuditPage')
  return PAGE.slice(start, end)
})()

const rendered = SECTION
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('eligibility uses the shared strict helper (no inline code-only gate)', () => {
  assert.match(PAGE, /isLocalAiCitationEligible/)
  assert.match(rendered, /isLocalAiCitationEligible\(selectedViolation\)/)
  assert.match(rendered, /selectedPara !== null|getParagraphIndex\(selectedViolation\)/)
  // The strict predicate lives in the helper module, not inline here.
  assert.doesNotMatch(rendered, /selectedViolation\.rule_code === 'CITATION_MISMATCH'/)
})

test('an ineligible finding renders no section at all', () => {
  // The whole component returns null before any markup is produced.
  assert.match(rendered, /if \(!isCitationSelected\) return null/)
})

test('no "AI is available elsewhere" explanation survives', () => {
  assert.doesNotMatch(rendered, /AI-assisted guidance is available for/)
  assert.doesNotMatch(rendered, /select one from the list to see it/)
  assert.doesNotMatch(rendered, /Select a citation finding from the findings list/)
})

test('the section heading is the agreed Local AI Citation Guidance', () => {
  assert.match(rendered, /aria-label="Local AI Citation Guidance"/)
  assert.match(rendered, /Local AI Citation Guidance/)
  // The old generic heading can never render.
  assert.doesNotMatch(rendered, />\s*AI-assisted guidance\s*</)
})

test('the AI section never mentions the ineligible rule families', () => {
  for (const code of [
    'FONT_SIZE',
    'FONT_CONSISTENCY',
    'ALIGNMENT',
    'LINE_SPACING',
    'SPACE_BEFORE',
    'SPACE_AFTER',
    'MARGIN_LEFT',
    'HEADING_HIERARCHY',
    'REFERENCE_HANGING_INDENT',
    'REFERENCE_NOT_CITED',
    'REFERENCE_DUPLICATE',
    'CITATION_YEAR_SUFFIX_MISMATCH',
    'CITATION_REFERENCE_MISMATCH',
    'CITATION_REFERENCE_AMBIGUOUS',
  ]) {
    assert.doesNotMatch(rendered, new RegExp(code), code)
  }
})

test('the reference text is never sent anywhere: no fetch in the section', () => {
  assert.doesNotMatch(rendered, /fetch\(/)
  assert.doesNotMatch(rendered, /api\./)
})

test('the eligible path still renders the stored guidance', () => {
  assert.match(rendered, /matchedIssue/)
  assert.match(rendered, /splitGuidanceSuggestion/)
  assert.match(rendered, /text_snippet/)
})
