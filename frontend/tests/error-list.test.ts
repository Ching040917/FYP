/**
 * Findings card — presentation contract.
 *
 * The card is the reader's entry point: it must say what is wrong, where it
 * is, what the value is, and (at most) one line of evidence — and nothing
 * else. These assertions read the component source because the card is the
 * surface where internal markup leaks (¶ markers, category tags, raw rule
 * codes, monospaced raw values) actually reach a user.
 *
 * Negative assertions are the point of this file: they fail when internal
 * information is re-introduced.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CARD = readFileSync(resolve(ROOT, 'src/components/audit/error-list.tsx'), 'utf8')

/** The JSX of the finding row only — excludes the header and filter block. */
const rowJsx = (() => {
  const start = CARD.indexOf('{filtered.map((e, index) => {')
  assert.notEqual(start, -1, 'finding row render not found')
  const end = CARD.indexOf('</ul>', start)
  assert.notEqual(end, -1, 'finding list close not found')
  return CARD.slice(start, end)
})()

/**
 * The same row with comments removed.
 *
 * A negative assertion must judge what the reader SEES. A developer comment
 * that merely names a retired marker is not rendered, so it must not be able
 * to fail the suite — while a real leak in a string literal or JSX text
 * always survives this filter.
 */
const rowRendered = rowJsx
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// ---------------------------------------------------------------------------
// What the card must show
// ---------------------------------------------------------------------------

test('the card shows the friendly title', () => {
  assert.match(rowJsx, /\{e\.title\}/)
})

test('the card shows the severity label from the shared badge', () => {
  assert.match(rowJsx, /severityBadge\(e\.severity\)/)
  assert.match(rowJsx, /\{badge\.label\}/)
  assert.match(rowJsx, /badge\.className/)
  // Severity is icon + text, never colour alone.
  assert.match(rowJsx, /AlertOctagon/)
  assert.match(rowJsx, /AlertTriangle/)
  assert.match(rowJsx, /aria-hidden="true"/)
})

test('the card shows one friendly location', () => {
  assert.match(rowJsx, /locationLabels\?\.get\(e\.id\)/)
  // Exactly one location render — the old card showed two numbering bases.
  assert.equal((rowJsx.match(/locationLabels/g) ?? []).length, 1)
})

test('the card shows the comparison or a labelled single-value line', () => {
  assert.match(rowJsx, /\{comparison && \(/)
  assert.match(rowJsx, /\{comparison\}/)
})


test('the occurrence label renders only when the finding repeats', () => {
  assert.match(rowJsx, /\{occurrences && \(/)
  assert.match(rowJsx, /\{occurrences\}/)
  // The raw count is not rendered directly; it comes pre-formatted.
  assert.doesNotMatch(rowJsx, /occurrences\.occurrences/)
})

test('the row exposes an accessible name and pressed state', () => {
  assert.match(rowJsx, /aria-pressed=\{selected\}/)
  assert.match(rowJsx, /aria-label=\{accessibleName\}/)
  // The name must combine title, severity and location.
  assert.match(rowJsx, /\[e\.title, badge\.label, location\]/)
})

// ---------------------------------------------------------------------------
// What the card must never expose
// ---------------------------------------------------------------------------

test('the card never renders the internal paragraph marker', () => {
  assert.doesNotMatch(rowRendered, /¶/)
  // The old sentinel rendered a bare "?" for a finding with no paragraph.
  assert.doesNotMatch(rowRendered, /e\.position\s*>/)
  assert.doesNotMatch(rowRendered, /\?\s*:\s*'\?'/)
})

test('the card never renders a duplicated category tag', () => {
  assert.doesNotMatch(rowRendered, /CATEGORY_LABELS/)
  // The category survives in the filter, which is where it belongs.
  assert.match(CARD, /Object\.entries\(CATEGORY_LABELS\)/)
})

test('the card never renders a raw rule code or location payload', () => {
  assert.doesNotMatch(rowRendered, /rule_code/)
  assert.doesNotMatch(rowRendered, /paragraph_index/)
  assert.doesNotMatch(rowRendered, /run_index/)
  assert.doesNotMatch(rowRendered, /location\b.*\.map\(/)
  assert.doesNotMatch(rowRendered, /JSON\.stringify/)
})

test('the card never renders a long required action or document statistics', () => {
  assert.doesNotMatch(rowRendered, /e\.suggestion/)
  assert.doesNotMatch(rowRendered, /requiredAction/)
  assert.doesNotMatch(rowRendered, /Document Statistics/)
  assert.doesNotMatch(rowRendered, /word_count|paragraph_count/)
})

test('the card never renders a monospaced raw actual value', () => {
  assert.doesNotMatch(rowRendered, /font-mono/)
  assert.doesNotMatch(rowRendered, /e\.snippet/)
})

test('the retired comparison wording appears nowhere in the card', () => {
  assert.doesNotMatch(CARD, /Not required in this profile/)
})

// ---------------------------------------------------------------------------
// Selection must not move anything
// ---------------------------------------------------------------------------


test('focus is distinguishable from selection', () => {
  // The old focus background equalled the selected background.
  assert.match(rowJsx, /focus-visible:ring-primary/)
  assert.doesNotMatch(rowJsx, /focus-visible:bg-muted\b/)
  assert.doesNotMatch(rowJsx, /ring-primary\/50/)
})

test('the severity filter offers all four severities from the shared badge', () => {
  assert.match(CARD, /severityBadge\(sev\)\.label/)
  for (const sev of ['major', 'minor', 'review', 'unknown']) {
    assert.match(CARD, new RegExp(`'${sev}'`), `filter is missing ${sev}`)
  }
})

// ---------------------------------------------------------------------------
// Filter labels, layout, and the filtered-empty state
// ---------------------------------------------------------------------------

test('filter labels are concise: no "only" suffix on any severity', () => {
  assert.doesNotMatch(CARD, /\{opt\.label\} only/)
  assert.match(CARD, />All severities</)
  // The severity options render the bare badge label ("Major", "Minor",
  // "Manual review", "Unclassified" come from the shared badge).
  assert.match(CARD, /\{opt\.label\}/)
})

test('both filter controls keep their accessible names', () => {
  assert.match(CARD, /aria-label="Filter by severity"/)
  assert.match(CARD, /aria-label="Filter by category"/)
})

test('narrow Findings-panel width stacks the controls instead of clipping them', () => {
  // Wrap + basis: the two controls share a row when there is room and each
  // takes a full row of its own when the panel narrows. The chevrons cannot
  // overlap because no fixed pixel width is used.
  assert.match(CARD, /flex-wrap items-center gap-2/)
  assert.match(CARD, /min-w-0 flex-1 basis-\[/)
  assert.doesNotMatch(CARD, /w-\[120px\]/)
  assert.doesNotMatch(CARD, /w-\[160px\]/)
})

test('the filter icon stays separate and aligned with the controls', () => {
  assert.match(CARD, /<Filter className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" \/>/)
})

test('zero total findings and zero filtered findings read differently', () => {
  assert.match(CARD, /No compliance findings were detected\./)
  assert.match(CARD, /No findings match these filters/)
  assert.match(CARD, /No \$\{severityBadge\(severityFilter\)\.label\} findings/)
})

test('the filtered-empty state states a truthful hidden count and Shows 0 of N', () => {
  assert.match(CARD, /const hiddenCount = totalFindings - filtered\.length/)
  assert.match(CARD, /other findings are hidden by the current filters\./)
  assert.match(CARD, /findings are hidden\./)
  assert.match(CARD, /Showing 0 of \$\{totalFindings\} findings/)
})

test('reset appears only while a filter is active and restores BOTH to All', () => {
  assert.match(CARD, /filtersActive &&/)
  assert.match(CARD, /const resetFilters = \(\) => \{/)
  assert.match(CARD, /setSeverityFilter\('all'\)/)
  assert.match(CARD, /handleCategoryChange\('all'\)/)
  // Reset is a real button: keyboard operable, no audit re-run.
  assert.match(CARD, /<button[\s\S]{0,200}onClick=\{resetFilters\}/)
})

test('the reset control names the action the reader understands', () => {
  assert.match(CARD, /'Reset filters'/)
  assert.match(CARD, /'Show all findings'/)
})
