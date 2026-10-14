/**
 * Reference List alphabetical-order review — frontend contract tests.
 *
 * Covers: Custom Profile editor toggle (source contract + store round
 * trip), default Off, built-in read-only notice, Profile Summary
 * Enabled/Not-checked wording, disclosure wording, adapter category,
 * friendly title/action, entry-preview presentation, Guided Fixes and
 * Local AI ineligibility.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  blankProfilePayload,
  referencesFromUiModel,
  referencesToUiModel,
  summarizeProfile,
} from '../src/lib/custom-profile-store/editor.ts'
import { referencesDisclosure } from '../src/lib/audit/enabled-checks-wording.ts'
import { categoryForRuleCode } from '../src/lib/audit/adapter.ts'
import { presentationFor } from '../src/lib/audit/finding-presentation.ts'
import {
  friendlyRequiredAction,
  friendlyRuleTitle,
} from '../src/lib/friendly-finding.ts'
import { SUPPORTED_FIX_RULES, guidedPresentationFor } from '../src/lib/guided-fixes.ts'
import { isLocalAiCitationEligible } from '../src/lib/local-ai-citation-eligibility.ts'
import type { Violation } from '../src/types/api'

/** The editor page source — the DOM contract its controls must keep. */
const PROFILE_EDITOR = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/pages/ProfileEditor.tsx'),
  'utf8',
)

function orderViolation(): Violation {
  return {
    id: 'v-order',
    rule_code: 'REFERENCE_ORDER',
    severity: 'MINOR',
    location: { paragraph_index: 3 },
    message:
      'This Reference List entry is out of alphabetical order. ' +
      'The Custom profile requires Reference List entries to be arranged alphabetically by author.',
    expected_value: 'Arrange Reference List entries alphabetically by author',
    actual_value: 'Adams, A. (2021). Title.',
  }
}

// ---------------------------------------------------------------------------
// Editor toggle contract
// ---------------------------------------------------------------------------

test('editor displays the alphabetical-order toggle with the approved label', () => {
  assert.ok(PROFILE_EDITOR.includes('id="references-check-reference-order"'))
  assert.ok(PROFILE_EDITOR.includes('Check Reference List alphabetical order'))
  assert.ok(
    PROFILE_EDITOR.includes(
      'Checks adjacent Reference List entries when both author identities can be determined reliably.',
    ),
  )
})

test('built-in profiles stay read-only in the editor', () => {
  assert.ok(PROFILE_EDITOR.includes('Built-in profiles are read-only.'))
})

test('blank profile defaults the toggle off', () => {
  const payload = blankProfilePayload('id-1', 'Blank')
  const refs = payload.references as Record<string, unknown>
  assert.equal(refs.check_reference_order, false)
  const ui = referencesToUiModel(payload.references as never)
  assert.equal(ui.referenceOrderEnabled, false)
})

test('custom profile can enable the toggle and reloads it', () => {
  const payload = blankProfilePayload('id-2', 'Custom')
  const ui = referencesToUiModel(payload.references as never)
  const saved = referencesFromUiModel({ ...ui, referenceOrderEnabled: true })
  assert.equal(saved.check_reference_order, true)
  const reloaded = referencesToUiModel(saved as never)
  assert.equal(reloaded.referenceOrderEnabled, true)
})

test('legacy payload without the toggle reads as off', () => {
  const payload = blankProfilePayload('id-3', 'Legacy')
  const refs = { ...(payload.references as Record<string, unknown>) }
  delete refs.check_reference_order
  const ui = referencesToUiModel(refs as never)
  assert.equal(ui.referenceOrderEnabled, false)
})

// ---------------------------------------------------------------------------
// Profile Summary wording
// ---------------------------------------------------------------------------

test('profile summary shows Enabled when on', () => {
  const payload = blankProfilePayload('id-4', 'Custom')
  ;(payload.references as Record<string, unknown>).check_reference_order = true
  const summary = summarizeProfile(payload as never)
  assert.ok(summary.lines.includes('Reference List alphabetical order'))
})

test('profile summary shows Not checked when off', () => {
  const payload = blankProfilePayload('id-5', 'Custom')
  const summary = summarizeProfile(payload as never)
  assert.ok(summary.lines.includes('Reference List alphabetical order: Not checked'))
})

test('references disclosure names alphabetical order only when enabled', () => {
  const on = referencesDisclosure({ check_reference_order: true } as never)
  assert.ok(on.includes('alphabetical order'))
  const off = referencesDisclosure({ check_reference_order: false } as never)
  assert.ok(!off.includes('alphabetical order'))
  const legacy = referencesDisclosure({} as never)
  assert.ok(!legacy.includes('alphabetical order'))
})

// ---------------------------------------------------------------------------
// Finding presentation
// ---------------------------------------------------------------------------

test('order finding maps to citation_apa', () => {
  assert.equal(categoryForRuleCode('REFERENCE_ORDER'), 'citation_apa')
})

test('friendly title and required action match the approved wording', () => {
  assert.equal(
    friendlyRuleTitle('REFERENCE_ORDER'),
    'Reference List is not in alphabetical order',
  )
  assert.equal(
    friendlyRequiredAction(
      'REFERENCE_ORDER',
      'Arrange Reference List entries alphabetically by author',
      'Adams, A. (2021). Title.',
      { paragraph_index: 3 },
    ),
    'Move this Reference List entry to the correct alphabetical position according to the selected profile.',
  )
})

test('order finding presents the entry preview with the fixed action', () => {
  const pres = presentationFor(orderViolation())
  assert.equal(pres.entryPreview, 'Adams, A. (2021). Title.')
  assert.equal(
    pres.requiredAction,
    'Move this Reference List entry to the correct alphabetical position according to the selected profile.',
  )
})

test('guided fixes remain unavailable for the order rule', () => {
  assert.ok(!SUPPORTED_FIX_RULES.has('REFERENCE_ORDER'))
  const pres = guidedPresentationFor(orderViolation() as never)
  assert.equal(pres.supported, false)
})

test('local AI remains ineligible for the order rule', () => {
  assert.equal(isLocalAiCitationEligible(orderViolation() as never), false)
})
