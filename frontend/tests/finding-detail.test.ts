/** Finding Detail values remain complete and readable. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { presentationFor } from '../src/lib/audit/finding-presentation.ts'


const violation = (over: Partial<Parameters<typeof presentationFor>[0]> = {}) => ({
  rule_code: 'FONT_SIZE',
  message: 'Font size 14pt != required 12pt',
  expected_value: '12pt',
  actual_value: '14pt',
  location: { paragraph_index: 4 },
  ...over,
})


test('the comparison shows the complete values, formatted for reading', () => {
  const pres = presentationFor(violation())
  assert.equal(pres.expected, '12 pt')
  assert.equal(pres.actual, '14 pt')
  assert.ok(pres.requiredAction)
})

test('structural detail provides a concise comparison and manual action from stored evidence', () => {
  const stored = violation({
    rule_code: 'HEADER_CONTENT_REQUIRED',
    message: 'Historical action referring to effective Normal-pages definitions',
    expected_value: 'Historical structural requirement',
    actual_value: 'Historical structural observation',
    location: { structural_story: true, section_index: 2, story_type: 'header', story_variant: 'default', evidence_state: 'unresolved' },
  })
  const pres = presentationFor(stored)
  assert.equal(pres.actual, 'ACA could not check this requirement from the supported document content.')
  assert.equal(pres.expected, 'Text or a supported field in this section’s normal-pages header.')
  assert.equal(pres.requiredAction, 'In Word, check this section’s header. Verify the rendered document manually.')
  assert.equal(pres.evidence, undefined)
  assert.equal(pres.entryPreview, undefined)
  assert.equal(stored.actual_value, 'Historical structural observation')
})
