/**
 * Finding Details — presentation contract.
 *
 * Details is the evidence pane. Its job is to carry the COMPLETE finding once
 * each: what and where it is, the evidence, exactly one Current/Required
 * comparison, the required action, and the secondary disclosures. The defect
 * this file guards is repetition — the same two values appearing in the issue
 * sentence, the comparison table and the action.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { presentationFor } from '../src/lib/audit/finding-presentation.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

const DETAIL = read('src/components/audit/finding-detail.tsx')
const TABLE = read('src/components/audit/expected-actual-table.tsx')
const PRESENTATION = read('src/lib/audit/finding-presentation.ts')

/** Developer comments are not rendered output. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const violation = (over: Partial<Parameters<typeof presentationFor>[0]> = {}) => ({
  rule_code: 'FONT_SIZE',
  message: 'Font size 14pt != required 12pt',
  expected_value: '12pt',
  actual_value: '14pt',
  location: { paragraph_index: 4 },
  ...over,
})

// ---------------------------------------------------------------------------
// One comparison, labelled Current → Required
// ---------------------------------------------------------------------------

test('the comparison table is labelled Current and Required, not Actual/Expected', () => {
  assert.match(TABLE, />\s*Current\s*</)
  assert.match(TABLE, />\s*Required\s*</)
  assert.doesNotMatch(TABLE, />\s*Actual\s*</)
  assert.doesNotMatch(TABLE, />\s*Expected\s*</)
})

test('Current is presented before Required', () => {
  assert.ok(TABLE.indexOf('Current') < TABLE.indexOf('Required'))
})

test('exactly one comparison block is rendered', () => {
  assert.equal((DETAIL.match(/<ExpectedActualTable/g) ?? []).length, 1)
})

test('the confirmed-issue sentence is suppressed when a comparison is shown', () => {
  // For formatting rules the sentence restates the same two values in prose.
  // Rendering both makes the finding say the same thing three times.
  assert.match(DETAIL, /!\(pres\.expected != null \|\| pres\.actual != null\) && \(/)
  // ...and it survives for rules that have no value comparison.
  assert.match(DETAIL, /Confirmed issue/)
})

test('the comparison shows the complete values, formatted for reading', () => {
  const pres = presentationFor(violation())
  assert.equal(pres.expected, '12 pt')
  assert.equal(pres.actual, '14 pt')
  assert.ok(pres.requiredAction)
})

// ---------------------------------------------------------------------------
// Internal information must not reach the reader
// ---------------------------------------------------------------------------

test('no raw rule code is rendered', () => {
  const rendered = stripComments(DETAIL)
  assert.doesNotMatch(rendered, /Rule reference/)
  assert.doesNotMatch(rendered, /\{v\.rule_code\}/)
})

test('heading levels are spoken as words, not H1/H2 tokens', () => {
  const rendered = stripComments(PRESENTATION)
  assert.doesNotMatch(rendered, /H\$\{/)
  assert.doesNotMatch(rendered, /Add an H1/)
  assert.match(rendered, /Heading 1 → …/)
  assert.match(rendered, /Add a Heading 1/)
  assert.match(rendered, /Add the missing Heading/)
})

test('the detail renders no paragraph index or location payload', () => {
  const rendered = stripComments(DETAIL)
  assert.doesNotMatch(rendered, /run_index/)
  assert.doesNotMatch(rendered, /JSON\.stringify/)
})

// ---------------------------------------------------------------------------
// The check statement must be truthful per severity
// ---------------------------------------------------------------------------

test('each severity states truthfully how the finding was produced', () => {
  assert.match(DETAIL, /case 'major':/)
  assert.match(DETAIL, /case 'minor':/)
  assert.match(DETAIL, /'Automated formatting check'/)
  assert.match(DETAIL, /case 'review':/)
  assert.match(DETAIL, /'Needs a person to check'/)
  assert.match(DETAIL, /'Severity not recognised'/)
  // Only a scored severity claims an automated check.
  assert.match(DETAIL, /\.scored \? \(/)
})

test('the retired comparison wording appears nowhere in the detail surface', () => {
  assert.doesNotMatch(DETAIL, /Not required in this profile/)
})

// ---------------------------------------------------------------------------
// Readable surfaces
// ---------------------------------------------------------------------------

test('comparison cells use a readable border and background, not a hairline tint', () => {
  for (const source of [DETAIL, TABLE]) {
    assert.doesNotMatch(source, /bg-input\/20/)
    assert.match(source, /border-rule-border/)
  }
})

test('secondary disclosures stay reachable', () => {
  assert.match(DETAIL, /<details/)
  assert.match(DETAIL, /Extended details/)
  // The evidence blocks survive the refactor.
  assert.match(DETAIL, /Citation evidence/)
  assert.match(DETAIL, /Reference List entry/)
  assert.match(DETAIL, /Missing requirement/)
  assert.match(DETAIL, /heading sequence/i)
})

test('the detail still names the location and the required action', () => {
  assert.match(DETAIL, />\s*Location\s*</)
  assert.match(DETAIL, /Paragraph \{para\}/)
  assert.match(DETAIL, /Required action/)
})
