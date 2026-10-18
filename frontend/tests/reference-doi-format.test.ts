import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blankProfilePayload, buildSavePayload, createMemoryStoreAdapter, loadEnvelope,
  persistEnvelope, referencesFromUiModel, referencesToUiModel, upsertAndBump,
} from '../src/lib/custom-profile-store/editor.ts'
import { emptyEnvelope } from '../src/lib/custom-profile-store/store.ts'
import { enabledCheckCount } from '../src/lib/audit/enabled-checks-wording.ts'
import { categoryForRuleCode, normalizeViolationSeverity } from '../src/lib/audit/adapter.ts'
import { presentationFor } from '../src/lib/audit/finding-presentation.ts'
import { friendlyRuleTitle, friendlyRequiredAction } from '../src/lib/friendly-finding.ts'
import { SUPPORTED_FIX_RULES, guidedPresentationFor } from '../src/lib/guided-fixes.ts'
import { isLocalAiCitationEligible } from '../src/lib/local-ai-citation-eligibility.ts'
import type { ProfileSnapshot, Violation } from '../src/types/api.ts'

const REQUIRED = 'https://doi.org/<doi>'
const ACTION = 'Replace the visible DOI text with the configured canonical format. Verify the DOI independently because ACA checks presentation only and does not confirm registration or resolution.'
function finding(actual = 'DOI: 10.1234/AbC12pt'): Violation {
  return {
    id: 'doi-finding', rule_code: 'REFERENCE_DOI_FORMAT', severity: 'MINOR',
    location: { paragraph_index: 1 }, actual_value: actual, expected_value: REQUIRED,
    message: `The visible DOI presentation does not match the selected profile's required format: ${REQUIRED}. ACA checks presentation only, not registration or resolution.`,
  }
}

test('DOI editor defaults off and accepts only literal true when reading', () => {
  const payload = blankProfilePayload('doi-default', 'Custom')
  const refs = payload.references as Record<string, unknown>
  assert.equal(refs.check_doi_format, false)
  assert.equal(referencesToUiModel(refs).doiFormatEnabled, false)
  for (const value of [undefined, null, false, 0, 1, 'true', 'false']) {
    assert.equal(referencesToUiModel({ check_doi_format: value }).doiFormatEnabled, false)
  }
  assert.equal(referencesToUiModel({ check_doi_format: true }).doiFormatEnabled, true)
  assert.ok(!Object.keys(refs).some((key) => /url/i.test(key)))
})
test('custom DOI toggle persists through the normal save and reload path', () => {
  const payload = blankProfilePayload('doi-custom', 'DOI custom')
  payload.references = referencesFromUiModel({ ...referencesToUiModel(payload.references as Record<string, unknown>), doiFormatEnabled: true })
  const draft = {
    id: 'doi-custom', name: 'DOI custom', description: '', payload,
    validationState: 'backend_confirmed' as const, updatedAt: '2026-10-14T00:00:00.000Z',
  }
  const saved = { ...draft, payload: buildSavePayload(draft) }
  const adapter = createMemoryStoreAdapter()
  const envelope = upsertAndBump(emptyEnvelope(), saved, draft.updatedAt)
  assert.equal(persistEnvelope(adapter, envelope, 0).ok, true)
  const reloaded = loadEnvelope(adapter).profiles[0]!.payload
  const reloadedRefs = reloaded.references as Record<string, unknown>
  assert.equal(reloadedRefs.check_doi_format, true)
  assert.equal(referencesToUiModel(reloadedRefs).doiFormatEnabled, true)
})

test('DOI option contributes one enabled check in the profile count', () => {
  const off = { line_spacing: null, hanging_indent_in: null }
  const on = { ...off, check_doi_format: true }
  const snapshot = { profile_name: 'DOI custom', profile_source: 'custom', references: on, margins: {} } as ProfileSnapshot
  assert.equal(enabledCheckCount(snapshot), 1)
  assert.equal(enabledCheckCount({ ...snapshot, references: off }), 0)
})

test('DOI Current and Required remain source-faithful plain text across persisted reload', () => {
  for (const actual of ['DOI: 10.1234/AbC12pt', 'http://dx.doi.org/10.1234/AbC12in', 'doi: 10.1234/numPr', 'DOI:\t10.1234/abcDEF']) {
    const reloaded = JSON.parse(JSON.stringify(finding(actual))) as Violation
    const presentation = presentationFor(reloaded)
    assert.equal(presentation.actual, actual)
    assert.equal(presentation.expected, REQUIRED)
    assert.equal(presentation.entryPreview, undefined)
    assert.equal(presentation.evidence, undefined)
    assert.equal(presentation.requiredAction, ACTION)
    assert.match(presentation.issue, /selected profile/)
    for (const value of [presentation.actual!, presentation.expected!, presentation.requiredAction!]) {
      for (const token of ['<a', '</a>', 'href=', 'target=', 'rel=', 'title=', 'class=', '&lt;', '&gt;']) {
        assert.equal(value.includes(token), false, token)
      }
    }
  }
})

test('DOI title/action/category/severity and manual-only eligibility follow the contract', () => {
  const violation = finding()
  assert.equal(friendlyRuleTitle(violation.rule_code), 'Reference DOI format does not match')
  assert.equal(friendlyRequiredAction(violation.rule_code, REQUIRED, violation.actual_value, violation.location), ACTION)
  assert.equal(categoryForRuleCode(violation.rule_code), 'citation_apa')
  assert.equal(normalizeViolationSeverity(violation.severity), 'minor')
  assert.equal(SUPPORTED_FIX_RULES[violation.rule_code], undefined)
  assert.equal(guidedPresentationFor(violation).supported, false)
  assert.equal(isLocalAiCitationEligible(violation), false)
})
