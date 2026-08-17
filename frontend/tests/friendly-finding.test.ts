/**
 * Student-friendly finding presentation tests (Part B).
 *
 * Raw deterministic messages stay untouched; the presenter converts to
 * plain language, names object labels (Table/Figure), gives concrete
 * Microsoft Word steps, and strips developer-style tokens from fallback
 * output. Banned tokens never appear: `!=`, `->`, `SEQ field`, `numPr`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  friendlyFindingMessage,
  friendlyRequiredAction,
  friendlyValue,
  cleanMessage,
  objectLabel,
} from '../src/lib/friendly-finding.ts'

test('FONT_SIZE uses plain language without !=', () => {
  const out = friendlyFindingMessage('FONT_SIZE', 'Normal font size 15.0pt != required 12pt', '12pt', '15.0pt')
  assert.equal(out, 'This text uses 15 pt, but the required font size is 12 pt.')
  assert.ok(!out.includes('!='))
})

test('FONT_CONSISTENCY uses plain language', () => {
  const out = friendlyFindingMessage('FONT_CONSISTENCY', "Font 'Arial' does not match required 'Times New Roman'", 'Times New Roman', 'Arial')
  assert.equal(out, 'This text uses Arial, but the required font is Times New Roman.')
})

test('ALIGNMENT uses plain language with friendly words', () => {
  const out = friendlyFindingMessage('ALIGNMENT', "Alignment 'center' != required 'justify'", 'justify', 'center')
  assert.equal(out, 'This paragraph is centered, but justified alignment is required.')
  assert.ok(!out.includes('!='))
})

test('LINE_SPACING keeps decimal values and plain language', () => {
  const out = friendlyFindingMessage('LINE_SPACING', 'Line spacing 2.0 != required 1.5', '1.5', '2.0')
  assert.equal(out, 'This paragraph uses 2.0 line spacing, but 1.5 is required.')
})

test('SPACE_BEFORE and SPACE_AFTER use plain language', () => {
  const before = friendlyFindingMessage('SPACE_BEFORE', 'Space before 18pt != required 0pt', '0pt', '18pt')
  const after = friendlyFindingMessage('SPACE_AFTER', 'Space after 18pt != required 6pt', '6pt', '18pt')
  assert.equal(before, 'This paragraph has 18 pt spacing before it, but 0 pt is required.')
  assert.equal(after, 'This paragraph has 18 pt spacing after it, but 6 pt is required.')
})

test('MARGIN rules name the side in plain language', () => {
  const left = friendlyFindingMessage('MARGIN_LEFT', 'Page margin left 1.25in != required 1.5in', '1.5in', '1.25in')
  assert.equal(left, 'The left margin is 1.25 in, but the required margin is 1.5 in.')
  const top = friendlyFindingMessage('MARGIN_TOP', 'x', '1.0in', '2.0in')
  assert.equal(top, 'The top margin is 2 in, but the required margin is 1 in.')
})

test('MANUAL_CAPTION: Confirmed Issue and Required Action match the spec', () => {
  const loc = { table_index: 3 }
  const issue = friendlyFindingMessage('MANUAL_CAPTION', 'Table 4 has a manually typed caption. Use Word semantics.', null, null, loc)
  assert.equal(
    issue,
    "Table 4 uses manually typed caption text instead of Microsoft Word's built-in caption feature. Automatic numbering and cross-references may not update correctly.",
  )
  const action = friendlyRequiredAction('MANUAL_CAPTION', null, null, loc)
  assert.equal(
    action,
    'Delete the manually typed caption. Select Table 4, then use References → Insert Caption in Microsoft Word. Choose the “Table” label and confirm that Word generates the number automatically.',
  )
  assert.ok(action!.includes('References → Insert Caption'))
})

test('MANUAL_CAPTION for a figure uses the Figure label', () => {
  const loc = { image_index: 1 }
  const issue = friendlyFindingMessage('MANUAL_CAPTION', 'x', null, null, loc)
  assert.ok(issue.startsWith('Figure 2 uses manually typed caption text'))
  const action = friendlyRequiredAction('MANUAL_CAPTION', null, null, loc)
  assert.ok(action!.includes('Select Figure 2'))
  assert.ok(action!.includes('the “Figure” label'))
})

test('missing caption/alt-text rules name the object plainly', () => {
  assert.equal(
    friendlyFindingMessage('TABLE_CAPTION_MISSING', 'Table 3 has no caption.', null, null, { table_index: 2 }),
    'Table 3 does not have a caption.',
  )
  assert.equal(
    friendlyFindingMessage('IMAGE_CAPTION_MISSING', 'Image 2 has no caption.', null, null, { image_index: 1 }),
    'Figure 2 does not have a caption.',
  )
  assert.equal(
    friendlyFindingMessage('IMAGE_ALT_TEXT_MISSING', 'Image 2 has no alt-text.', null, null, { image_index: 1 }),
    'Figure 2 does not have alternative text for screen-reader users.',
  )
  assert.ok(
    !friendlyRequiredAction('IMAGE_ALT_TEXT_MISSING', null, null, { image_index: 1 })!.includes('->'),
  )
})

test('required actions give concrete Microsoft Word steps', () => {
  const manual = friendlyRequiredAction('MANUAL_CAPTION', null, null, { table_index: 0 })!
  assert.ok(manual.includes('References → Insert Caption'))
  const table = friendlyRequiredAction('TABLE_CAPTION_MISSING', null, null, { table_index: 2 })!
  assert.ok(table.includes('References → Insert Caption'))
  const alt = friendlyRequiredAction('IMAGE_ALT_TEXT_MISSING', null, null, { image_index: 0 })!
  assert.ok(alt.includes('Edit Alt Text'))
  const font = friendlyRequiredAction('FONT_SIZE', '12pt', '15pt')!
  assert.equal(font, 'Change the font size from 15 pt to 12 pt.')
})

test('no presentation output contains banned tokens', () => {
  const samples = [
    friendlyFindingMessage('FONT_SIZE', 'x != y', '12pt', '15pt'),
    friendlyFindingMessage('ALIGNMENT', "Alignment 'center' != required 'justify'", 'justify', 'center'),
    friendlyFindingMessage('LINE_SPACING', 'Line spacing 2.0 != required 1.5', '1.5', '2.0'),
    friendlyFindingMessage('MARGIN_LEFT', 'Page margin left 1.25in != required 1.5in', '1.5in', '1.25in'),
    friendlyFindingMessage('MANUAL_CAPTION', 'x', null, null, { table_index: 0 }),
    cleanMessage("Manual 'Table N' text without Caption style or SEQ field"),
    cleanMessage('Heading level skipped: H1 -> H3 (missing H2)'),
    friendlyRequiredAction('MANUAL_CAPTION', null, null, { table_index: 0 }) ?? '',
  ]
  for (const s of samples) {
    assert.ok(!s.includes('!='), `banned != in: ${s}`)
    assert.ok(!s.includes('->'), `banned -> in: ${s}`)
    assert.ok(!s.includes('=>'), `banned => in: ${s}`)
    assert.ok(!/SEQ\s+field/i.test(s), `banned SEQ field in: ${s}`)
    assert.ok(!/numPr/i.test(s), `banned numPr in: ${s}`)
  }
})

test('generic fallback never uses the mechanical Adjust-the-element phrasing', () => {
  const action = friendlyRequiredAction('SOME_UNKNOWN_RULE', '12pt', '15pt')
  assert.equal(action, 'Update this element to meet the required specification (12 pt).')
  assert.ok(!action!.includes('Adjust the affected element'))
})

test('objectLabel is one-based and friendly', () => {
  assert.equal(objectLabel({ table_index: 0 }), 'Table 1')
  assert.equal(objectLabel({ image_index: 4 }), 'Figure 5')
  assert.equal(objectLabel(null), null)
  assert.equal(objectLabel({ paragraph_index: 2 }), null)
})

test('unknown rules fall back to a cleaned message', () => {
  const out = friendlyFindingMessage('HEADING_HIERARCHY', 'Heading level skipped: H1 -> H3 (missing H2)', null, null)
  assert.ok(!out.includes('->'))
  assert.ok(out.includes('H1 to H3'))
  const out2 = friendlyFindingMessage(null, 'Normal font size 15.0pt != required 12pt', null, null)
  assert.ok(!out2.includes('!='))
})

test('friendlyValue humanizes units and keeps bare decimals', () => {
  assert.equal(friendlyValue('15.0pt'), '15 pt')
  assert.equal(friendlyValue('1.5in'), '1.5 in')
  assert.equal(friendlyValue('2.0'), '2.0')
  assert.equal(friendlyValue('1.5'), '1.5')
  assert.equal(friendlyValue(null), null)
})

test('cleanMessage never mutates the source raw message', () => {
  const raw = 'Normal font size 15.0pt != required 12pt'
  const out = cleanMessage(raw)
  assert.equal(raw, 'Normal font size 15.0pt != required 12pt') // source untouched
  assert.equal(out, 'Normal font size 15.0pt is not required 12pt')
})
