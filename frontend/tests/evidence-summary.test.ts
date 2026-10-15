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
import { compactEvidenceText, compactPrecisionLabel, evidencePage, evidencePrecision, evidenceSummary, evidenceTargetLabel } from '../src/lib/audit/evidence-summary.ts'

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

test('unmapped structural evidence ignores stale overlays and never guesses a physical page', () => {
  const stale = {
    citationRects: [{ page: 12 }],
    citationLabel: 'Old citation · Page 12',
    highlightMessage: 'Old extracted paragraph fallback.',
    formattingEvidence: { kind: 'paragraph', pageRects: [{ page: 8 }] },
    formattingLabel: 'Old paragraph · Page 8',
    formattingMessage: 'Old formatting message.',
    objectStatus: { label: 'Table 3 · Page 6', message: 'Old object message.' },
    figureOutline: { label: 'Figure 2 · Page 4' },
    figureMessage: 'Old figure message.',
    marginStatus: { label: 'Left margin · Pages 1–3', message: 'Old margin message.' },
    marginChipLabel: 'Left margin · Section 1 · Pages 1–3',
  }
  for (const [story_type, label] of [
    ['header', 'Header'],
    ['footer', 'Footer'],
    ['either', 'Header or Footer'],
  ]) {
    for (const evidence_state of ['missing', 'empty', 'unresolved']) {
      const structuralLocation = {
        structural_story: true,
        section_index: 1,
        story_type,
        story_variant: 'default',
        evidence_state,
      }
      const locationLabel = `Section 2 · ${label} · Normal pages`
      const text = `Structural evidence only · ${locationLabel} · Rendered page could not be determined`
      const input = { ...stale, structuralLocation }
      assert.deepEqual(evidenceSummary(input), { text, tone: 'muted' })
      assert.equal(evidencePrecision(input), 'Structural evidence only')
      assert.equal(compactPrecisionLabel(evidencePrecision(input)), 'Structural evidence only')
      assert.equal(evidencePage({
        structuralLocation,
        citationRects: stale.citationRects,
        formattingPageRects: stale.formattingEvidence.pageRects,
        figurePage: 4,
        marginStartPage: 1,
      }), null)
      assert.equal(evidenceTargetLabel({
        ...input,
        paragraphIndex: 3,
        figureLabel: 'Figure 2',
        objectLabel: 'Table 3',
        marginLabel: 'Left margin',
      }), locationLabel)
      assert.equal(compactEvidenceText({
        structuralLocation,
        paragraphIndex: 3,
        page: 12,
        objectLabel: 'Figure 2',
        precision: 'Page-only evidence',
      }), text)
      assert.doesNotMatch(text, /Page \d|Paragraph|Figure|Table|Page-only|extracted/i)
    }
  }
})

test('incomplete structural identity stays geometry-free instead of inventing a body location', () => {
  const structuralLocation = { structural_story: true }
  const input = {
    structuralLocation,
    citationRects: [{ page: 9 }],
    citationLabel: 'Old citation',
    formattingEvidence: {},
    objectStatus: { label: 'Figure 1', message: null },
  }
  assert.deepEqual(evidenceSummary(input), {
    text: 'Structural evidence only · Rendered page could not be determined',
    tone: 'muted',
  })
  assert.equal(evidencePrecision(input), 'Structural evidence only')
  assert.equal(evidencePage(input), null)
  assert.equal(evidenceTargetLabel(input), 'Stored Header/Footer definition')
})

test('clearing structural selection restores the existing visual evidence precedence', () => {
  const input = {
    structuralLocation: null,
    citationRects: [{ page: 3 }],
    citationLabel: 'Citation · Page 3',
    formattingEvidence: {},
    objectStatus: { label: 'Table 1', message: null },
  }
  assert.equal(evidencePrecision(input), 'Exact evidence')
  assert.equal(evidencePage(input), 3)
  assert.equal(evidenceTargetLabel(input), 'Citation occurrence')
})
