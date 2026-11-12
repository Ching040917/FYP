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
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { isLocalAiCitationEligible } from '../src/lib/local-ai-citation-eligibility.ts'
import { aiProviderLabel, normalizeAiProvider } from '../src/lib/audit/adapter.ts'

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

/** Render the production section and its production helpers without importing
 * the rest of AuditPage (PDF/viewer setup is unrelated to citation guidance). */
function renderCitation(selectedViolation: Record<string, unknown> | null, options: { stored?: boolean; processing?: boolean; status?: string | null } = {}) {
  const source = ts.createSourceFile('AuditPage.tsx', PAGE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const names: Record<string, true> = { getParagraphIndex: true, splitGuidanceSuggestion: true, CitationSection: true }
  const functions = source.statements.filter((node) =>
    ts.isFunctionDeclaration(node) && node.name && names[node.name.text],
  ).map((node) => node.getText(source)).join('\n')
  const compiled = ts.transpileModule(`${functions}\nexport { CitationSection }`, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const require = createRequire(import.meta.url)
  const exports: Record<string, React.ComponentType<Record<string, unknown>>> = {}
  vm.runInNewContext(compiled, {
    exports, require, isLocalAiCitationEligible, aiProviderLabel, normalizeAiProvider,
    MapPin: () => null, ShieldAlert: () => null, Info: () => null, Loader2: () => null, Quote: () => null,
    Badge: ({ children }: { children?: React.ReactNode }) => React.createElement('span', null, children),
  })
  return renderToStaticMarkup(React.createElement(exports.CitationSection, {
    selectedViolation,
    isProcessing: options.processing ?? false,
    audit: {
      ai_provider: 'ollama',
      ai_review_status: options.status === undefined ? 'COMPLETED' : options.status,
      citation_issues: options.stored === false ? [] : [{
        paragraph_index: 2,
        message: "Citation 'Smith (2020)' was found in text.",
        text_snippet: '(Smith, 2020)',
        suggestion: 'Recommended correction\nCheck the author and year.\n\nWhat to verify\nConsult the original source.',
      }],
    },
  }))
}

const eligibleFinding = {
  rule_code: 'CITATION_MISMATCH',
  severity: 'MAJOR',
  location: { paragraph_index: 2 },
  message: "Citation 'Smith (2020)' was found in text.",
  actual_value: '(Smith, 2020)',
}

test('eligible stored guidance has a visible local-runtime label and an emphasized collapsed control', () => {
  const html = renderCitation(eligibleFinding)
  assert.match(html, /Runs locally with Ollama/)
  assert.match(html, /<summary[^>]*>Show AI-assisted guidance<\/summary>/)
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/)
  assert.match(html, /Check the author and year\./)
  assert.match(html, /Consult the original source\./)
  assert.match(html, /Human verification required/)
})

test('the visible citation control stays absent for ineligible findings despite stored guidance', () => {
  for (const finding of [
    null,
    { ...eligibleFinding, rule_code: 'FONT_SIZE' },
    { ...eligibleFinding, severity: 'REVIEW' },
    { ...eligibleFinding, actual_value: '' },
    { ...eligibleFinding, location: { paragraph_index: 2, missing_references_section: true } },
    { ...eligibleFinding, location: {} },
    { ...eligibleFinding, location: { paragraph_index: '2' } },
    { ...eligibleFinding, rule_code: 'REFERENCE_DUPLICATE' },
  ]) {
    assert.equal(renderCitation(finding), '')
  }
})

test('processing and absent stored guidance never offer a generation control', () => {
  for (const options of [
    { processing: true },
    { stored: false },
    { stored: false, status: 'UNAVAILABLE' },
  ]) {
    const html = renderCitation(eligibleFinding, options)
    assert.match(html, /Local AI Citation Guidance/)
    assert.match(html, /Runs locally with Ollama/)
    assert.doesNotMatch(html, /<summary|<button/)
  }
})

test('stored guidance remains matched by the selected finding, not merely its paragraph', () => {
  const html = renderCitation({ ...eligibleFinding, message: 'A different finding in the same paragraph.' })
  assert.doesNotMatch(html, /<summary|Check the author and year/)
})
