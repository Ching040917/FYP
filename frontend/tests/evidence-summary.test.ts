/**
 * Selected-evidence summary for the Document Preview heading.
 *
 * Pure logic: the summary keeps the exact wording and precedence of the chips
 * that used to occupy their own row above the rendered page, returns `null`
 * whenever nothing is selected (so no empty evidence space is reserved), and
 * never introduces internal identifiers — only the friendly strings the caller
 * supplies.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceSummary } from '../src/lib/audit/evidence-summary.ts'

test('nothing selected -> null (no reserved evidence space)', () => {
  assert.equal(evidenceSummary({}), null)
  assert.equal(evidenceSummary({ citationRects: [], citationLabel: null }), null)
  assert.equal(evidenceSummary({ citationRects: null, highlightMessage: '' }), null)
  assert.equal(
    evidenceSummary({
      objectStatus: { label: null, message: null },
      marginStatus: { label: null, message: null },
      formattingEvidence: null,
      figureOutline: null,
    }),
    null,
  )
})

test('citation evidence keeps the original sentence and tone', () => {
  const summary = evidenceSummary({
    citationRects: [{ page: 1, x: 0, y: 0, width: 1, height: 1 }],
    citationLabel: 'Font size · Page 1 · Paragraph 5',
  })
  assert.deepEqual(summary, {
    text: 'Selected evidence: Font size · Page 1 · Paragraph 5',
    tone: 'destructive',
  })
})

test('highlight fallback message is used only when no citation highlight exists', () => {
  const message = 'The finding is on this page, but an exact visual highlight is unavailable.'
  assert.deepEqual(evidenceSummary({ highlightMessage: message }), { text: message, tone: 'muted' })
  // A citation highlight present without a label suppresses the fallback, as before.
  assert.equal(
    evidenceSummary({
      citationRects: [{ page: 1 }],
      citationLabel: null,
      highlightMessage: message,
    }),
    null,
  )
})

test('formatting, object, figure and margin evidence keep their chip wording', () => {
  assert.deepEqual(
    evidenceSummary({ formattingEvidence: { kind: 'run', pageRects: [] }, formattingLabel: 'Line spacing · Page 2' }),
    { text: 'Selected evidence: Line spacing · Page 2', tone: 'warning' },
  )
  assert.deepEqual(evidenceSummary({ formattingMessage: 'Spacing boundary unavailable.' }), {
    text: 'Spacing boundary unavailable.',
    tone: 'muted',
  })
  assert.deepEqual(evidenceSummary({ objectStatus: { label: 'Table 2', message: null } }), {
    text: 'Selected object: Table 2',
    tone: 'warning',
  })
  assert.deepEqual(evidenceSummary({ objectStatus: { label: 'Figure 3', message: 'Outline unavailable.' } }), {
    text: 'Figure 3 · Outline unavailable.',
    tone: 'muted',
  })
  assert.deepEqual(evidenceSummary({ figureOutline: { label: 'Figure 1' } }), {
    text: 'Selected figure: Figure 1',
    tone: 'warning',
  })
  assert.deepEqual(evidenceSummary({ figureMessage: 'Exact figure boundary unavailable.' }), {
    text: 'Exact figure boundary unavailable.',
    tone: 'muted',
  })
  assert.deepEqual(evidenceSummary({ marginChipLabel: 'Right margin · Section 1 · Pages 1–3' }), {
    text: 'Selected margin: Right margin · Section 1 · Pages 1–3',
    tone: 'warning',
  })
  assert.deepEqual(evidenceSummary({ marginStatus: { label: 'Left margin', message: null } }), {
    text: 'Selected margin: Left margin',
    tone: 'warning',
  })
})

test('margin label and message are additive without repeating the label', () => {
  assert.deepEqual(
    evidenceSummary({ marginStatus: { label: 'Left margin', message: 'Spans pages 2–4' } }),
    { text: 'Selected margin: Left margin · Spans pages 2–4', tone: 'warning' },
  )
  // Without a label the message keeps the original chip's wording.
  assert.deepEqual(evidenceSummary({ marginStatus: { label: null, message: 'No section mapping.' } }), {
    text: 'No section mapping.',
    tone: 'muted',
  })
})

test('independent evidence kinds are joined into one line, first tone wins', () => {
  const summary = evidenceSummary({
    citationRects: [{ page: 1 }],
    citationLabel: 'Calibri vs Times New Roman · Page 1 · Paragraph 4',
    marginChipLabel: 'Right margin · Section 1 · Pages 1–3',
  })
  assert.equal(
    summary?.text,
    'Selected evidence: Calibri vs Times New Roman · Page 1 · Paragraph 4 · Selected margin: Right margin · Section 1 · Pages 1–3',
  )
  assert.equal(summary?.tone, 'destructive')
})

test('the summary is a single line: no newlines from any input', () => {
  const summary = evidenceSummary({ highlightMessage: 'line one\nline two' })
  assert.ok(summary)
  assert.equal(summary.text.includes('\n'), false)
})

test('the summary only ever repeats the friendly strings it was given', () => {
  // The helper owns wording and order, never data: no field is invented, so a
  // caller that passes no index-bearing text can never leak one.
  const friendly = 'Font size · Page 2 · Heading “1.1 Clean Baseline Content”'
  const summary = evidenceSummary({ citationRects: [{ page: 2 }], citationLabel: friendly })
  assert.equal(summary?.text, `Selected evidence: ${friendly}`)
  assert.equal(/run_index|paragraph_index|block_index|style_name/.test(summary!.text), false)
})
