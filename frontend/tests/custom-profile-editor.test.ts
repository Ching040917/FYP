/**
 * Custom Profile Editor logic (Build 3) tests — pure, no DOM.
 *
 * Covers: creation paths (blank, SUC copy, APA copy), collision-safe names,
 * built-ins preserved (never mutated), blank payload null requirements and
 * safe table-caption policy, client-side validation, revision bumps,
 * persistence revision-gating (stale-write refusal), and the friendly-source
 * label helper.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDurableTestAdapter, readStoredEnvelope } from './custom-profile-fixtures.ts'
import {
  APA_BUILTIN_ID,
  SUC_BUILTIN_ID,
  CITATION_STYLE,
  MAX_DESCRIPTION_LENGTH,
  SAFE_TABLE_ELIGIBILITY,
  blankProfilePayload,
  buildSavePayload,
  captionsFromUiModel,
  captionsToUiModel,
  clientValidate,
  copyProfilePayload,
  friendlySourceName,
  generateProfileId,
  isDirty,
  listsFromUiModel,
  listsToUiModel,
  mergeOpStatus,
  isSuccessOpStatus,
  persistEnvelope,
  referencesFromUiModel,
  referencesToUiModel,
  resolveUniqueName,
  summarizeProfile,
  upsertAndBump,
  REFERENCE_HEADING_TEXT_OPTIONS,
  validateRequirements,
  CITATION_MATCHING_FIELDS,
  DEFAULT_CITATION_MATCHING,
  citationMatchingFromUiModel,
  citationMatchingToUiModel,
  pageElementsFromUiModel,
  pageElementsToUiModel,
  applyPageElementsUiPatch,
  type OpStatus,
} from '../src/lib/custom-profile-store/editor.ts'
import { ACTIVE_KEY, RECOVERY_KEY, emptyEnvelope, serializeEnvelope } from '../src/lib/custom-profile-store/store.ts'

function makeProfile(overrides: Record<string, unknown> = {}) {
  const id = generateProfileId()
  return {
    id,
    name: 'My Profile',
    description: '',
    payload: blankProfilePayload(id, 'My Profile'),
    validationState: 'locally_valid' as const,
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Blank profile payload
// ---------------------------------------------------------------------------

test('blank profile: all deterministic requirements null + safe table policy', async () => { const id = generateProfileId()
const p = blankProfilePayload(id, 'Blank')
assert.equal(p.profile_source, 'custom')
assert.equal(p.citation_style, CITATION_STYLE)
assert.equal(p.profile_version, 1)
assert.equal(p.body.font_family, null)
assert.equal(p.body.font_size_pt, null)
assert.equal(p.body.line_spacing, null)
assert.equal(p.margins.margin_left_in, null)
assert.equal(p.margins.margin_right_in, null)
assert.equal(p.references.line_spacing, null)
assert.equal(p.references.hanging_indent_in, null)
assert.equal(p.captions.space_before_pt, null)
assert.equal(p.captions.space_after_pt, null)
assert.equal(p.lists.space_after_pt, null)
// Safe table-caption policy: never administrative/layout/rubric/unknown.
assert.ok(['administrative', 'scholarly'].includes(p.role_policy.table_eligibility))
assert.equal(p.role_policy.table_eligibility, SAFE_TABLE_ELIGIBILITY) })

test('blank profile: no admin/rubric/unknown caption enabling', async () => { const id = generateProfileId()
const p = blankProfilePayload(id, 'Blank')
const json = JSON.stringify(p).toLowerCase()
assert.ok(!json.includes('"both"'))
assert.ok(!json.includes('rubric')) })

test('copy profile preserves requirements but forces custom identity', async () => { const source = {
  profile_id: SUC_BUILTIN_ID,
  profile_name: 'SUC Academic Report',
  profile_source: 'built_in',
  body: { font_family: 'Times New Roman', font_size_pt: 12 },
  margins: { margin_left_in: null },
}
const id = generateProfileId()
const copy = copyProfilePayload(source, id, 'Copy of SUC')
assert.equal(copy.profile_id, id)
assert.equal(copy.profile_name, 'Copy of SUC')
assert.equal(copy.profile_source, 'custom')
assert.equal(copy.body.font_family, 'Times New Roman')
assert.equal(copy.body.font_size_pt, 12)
assert.deepEqual(copy.margins, { margin_left_in: null }) })

test('copy never mutates the source payload', async () => { const source = {
  profile_id: SUC_BUILTIN_ID,
  profile_name: 'SUC Academic Report',
  profile_source: 'built_in',
  body: { font_family: 'Times New Roman' },
}
const frozen = JSON.stringify(source)
copyProfilePayload(source, generateProfileId(), 'Copy')
assert.equal(JSON.stringify(source), frozen) })

// ---------------------------------------------------------------------------
// Build 5 — References / Captions / Lists UI models
// ---------------------------------------------------------------------------

test('references: null converts to disabled; enabled value round-trips', async () => { const disabled = referencesToUiModel({ line_spacing: null, hanging_indent_in: null })
assert.equal(disabled.lineSpacingEnabled, false)
assert.equal(disabled.lineSpacing, '')
assert.equal(disabled.hangingIndentEnabled, false)
assert.equal(disabled.hangingIndent, '')

const enabled = referencesToUiModel({
  check_hanging_indent: true,
  hanging_indent_in: 0.5,
  check_line_spacing: true,
  line_spacing: 2,
})
assert.equal(enabled.lineSpacingEnabled, true)
assert.equal(enabled.lineSpacing, '2')
assert.equal(enabled.hangingIndentEnabled, true)
assert.equal(enabled.hangingIndent, '0.5')

const back = referencesFromUiModel(enabled)
assert.equal(back.line_spacing, 2)
assert.equal(back.hanging_indent_in, 0.5)
assert.equal(back.check_hanging_indent, true)
assert.equal(back.check_line_spacing, true) })

test('references: disabled saves null values with every check off', async () => { const out = referencesFromUiModel(referencesToUiModel({}))
assert.equal(out.line_spacing, null)
assert.equal(out.check_line_spacing, false)
assert.equal(out.hanging_indent_in, null)
assert.equal(out.check_hanging_indent, false)
assert.equal(out.heading_text, null)
assert.equal(out.check_heading_text, false)
assert.equal(out.font_size_pt, null)
assert.equal(out.check_font_size, false) })

test('references: every check round-trips through the UI model', async () => { const stored = {
  check_heading_text: true,
  heading_text: 'works cited',
  allow_heading_aliases: true,
  check_heading_bold: true,
  heading_bold: true,
  check_heading_alignment: true,
  heading_alignment: 'center',
  check_start_on_new_page: true,
  check_hanging_indent: true,
  hanging_indent_in: 0.5,
  check_line_spacing: true,
  line_spacing: 2,
  check_space_before: true,
  space_before_pt: 0,
  check_space_after: true,
  space_after_pt: 6,
  check_font_family: true,
  font_family: 'Times New Roman',
  check_font_size: true,
  font_size_pt: 12,
  check_alignment: true,
  alignment: 'left',
  check_reference_order: false,
  check_doi_format: false,
}
assert.deepEqual(referencesFromUiModel(referencesToUiModel(stored)), stored) })

test('references: line-spacing check is the rendered state of the tri-state toggle', async () => { // No toggle (historical profile): the rule is on exactly when a value exists.
assert.equal(referencesToUiModel({ line_spacing: 2 }).lineSpacingEnabled, true)
assert.equal(referencesToUiModel({ line_spacing: null }).lineSpacingEnabled, false)
// An explicit false wins, so a switched-off check really turns the rule off.
assert.equal(referencesToUiModel({ check_line_spacing: false, line_spacing: 2 }).lineSpacingEnabled, false)
assert.equal(referencesToUiModel({ check_line_spacing: true, line_spacing: null }).lineSpacingEnabled, true)
// The editor always writes an explicit boolean, never a missing toggle.
const written = referencesFromUiModel(referencesToUiModel({ check_line_spacing: false, line_spacing: 2 }))
assert.equal(written.check_line_spacing, false)
assert.equal(written.line_spacing, 2) })

test('references: the heading word is a fixed vocabulary, stored lowercase', async () => { assert.deepEqual(REFERENCE_HEADING_TEXT_OPTIONS, [
  'references',
  'bibliography',
  'works cited',
  'reference list',
])
assert.equal(referencesToUiModel({ heading_text: 'WORKS CITED' }).headingText, 'works cited')
// Unsupported stored words remain unselected, never become References.
assert.equal(referencesToUiModel({ heading_text: 'sources' }).headingText, '')
assert.equal(referencesToUiModel({}).headingText, '') })

test('references: disabled heading check retains configured aliases', async () => { const aliased = referencesToUiModel({ check_heading_text: true, allow_heading_aliases: true })
assert.equal(aliased.allowHeadingAliases, true)
assert.equal(referencesFromUiModel(aliased).allow_heading_aliases, true)

const switchedOff = referencesFromUiModel({
  ...aliased,
  headingTextEnabled: false,
})
assert.equal(switchedOff.allow_heading_aliases, true)
assert.equal(switchedOff.heading_text, null) })

test('references: alignment values are coerced to the shared vocabulary', async () => { assert.equal(referencesToUiModel({ check_heading_alignment: true, heading_alignment: 'center' }).headingAlignment, 'center')
assert.equal(referencesToUiModel({ heading_alignment: 'middle' }).headingAlignment, '')
assert.equal(referencesToUiModel({}).headingAlignment, '')
assert.equal(referencesToUiModel({}).alignment, '') })

test('captions: null converts to disabled; values round-trip independently', async () => { const disabled = captionsToUiModel({ space_before_pt: null, space_after_pt: null })
assert.equal(disabled.spaceBeforeEnabled, false)
assert.equal(disabled.spaceAfterEnabled, false)

const beforeOnly = captionsFromUiModel(
  { spaceBeforeEnabled: true, spaceBefore: '6', spaceAfterEnabled: false, spaceAfter: '' },
)
assert.equal(beforeOnly.space_before_pt, 6)
assert.equal(beforeOnly.space_after_pt, null)

const afterOnly = captionsFromUiModel(
  { spaceBeforeEnabled: false, spaceBefore: '', spaceAfterEnabled: true, spaceAfter: '12' },
)
assert.equal(afterOnly.space_before_pt, null)
assert.equal(afterOnly.space_after_pt, 12)

const both = captionsToUiModel({ space_before_pt: 6, space_after_pt: 12 })
assert.deepEqual(captionsFromUiModel(both), { space_before_pt: 6, space_after_pt: 12 }) })

test('lists: null converts to disabled; value round-trips; no space-before field', async () => { const disabled = listsToUiModel({ space_after_pt: null })
assert.equal(disabled.spaceAfterEnabled, false)

const enabled = listsToUiModel({ space_after_pt: 6 })
assert.equal(enabled.spaceAfterEnabled, true)
assert.equal(enabled.spaceAfter, '6')

const back = listsFromUiModel(enabled)
assert.equal(back.space_after_pt, 6)
// Lists never write a space-before value.
assert.equal('space_before_pt' in back, false) })

// ---------------------------------------------------------------------------
// Build 5 — validation ranges
// ---------------------------------------------------------------------------

test('references range boundaries: 1.0 and 4.0 valid; outside rejected', async () => { const validPayload = (v: string) => ({
  references: { line_spacing: Number(v), hanging_indent_in: null },
})
assert.deepEqual(validateRequirements(validPayload('1')), [])
assert.deepEqual(validateRequirements(validPayload('4')), [])
assert.ok(
  validateRequirements(validPayload('0.9')).some((e) => e.field === 'references.line_spacing'),
)
assert.ok(
  validateRequirements(validPayload('4.1')).some((e) => e.field === 'references.line_spacing'),
)
assert.ok(
  validateRequirements({ references: { line_spacing: 'abc', hanging_indent_in: null } })
    .some((e) => e.field === 'references.line_spacing'),
) })

test('references disabled → no validation error', async () => { const errors = validateRequirements({
  references: { line_spacing: null, hanging_indent_in: null },
})
assert.ok(!errors.some((e) => e.field === 'references.line_spacing')) })

test('references: a checked value must be a number inside its range', async () => { const withIndent = (v: unknown) => ({
  references: { check_hanging_indent: true, hanging_indent_in: v },
})
assert.deepEqual(validateRequirements(withIndent(0)), [])
assert.deepEqual(validateRequirements(withIndent(4)), [])
assert.ok(validateRequirements(withIndent(4.1)).some((e) => e.field === 'references.hanging_indent_in'))
assert.ok(validateRequirements(withIndent(-1)).some((e) => e.field === 'references.hanging_indent_in'))
assert.ok(validateRequirements(withIndent('half')).some((e) => e.field === 'references.hanging_indent_in'))
// A stored value behind a switched-off check is never validated.
assert.deepEqual(validateRequirements({ references: { check_hanging_indent: false, hanging_indent_in: 99 } }), [])

const withSpacing = (v: unknown) => ({ references: { check_space_before: true, space_before_pt: v } })
assert.deepEqual(validateRequirements(withSpacing(0)), [])
assert.deepEqual(validateRequirements(withSpacing(240)), [])
assert.ok(validateRequirements(withSpacing(241)).some((e) => e.field === 'references.space_before_pt'))

const withFontSize = (v: unknown) => ({ references: { check_font_size: true, font_size_pt: v } })
assert.deepEqual(validateRequirements(withFontSize(12)), [])
assert.ok(validateRequirements(withFontSize(5)).some((e) => e.field === 'references.font_size_pt'))
assert.ok(validateRequirements(withFontSize(73)).some((e) => e.field === 'references.font_size_pt'))

const emptyFont = validateRequirements({ references: { check_font_family: true, font_family: '  ' } })
assert.ok(emptyFont.some((e) => e.field === 'references.font_family')) })

test('references: missing optional alignment stays uncomparable; supplied invalid values reject', async () => { const heading = validateRequirements({
  references: { check_heading_alignment: true, heading_alignment: null },
})
assert.deepEqual(heading, [])
const entries = validateRequirements({ references: { check_alignment: true, alignment: '' } })
assert.ok(entries.some((e) => e.field === 'references.alignment'))
assert.deepEqual(
  validateRequirements({
    references: { check_heading_alignment: true, heading_alignment: 'justify', check_alignment: true, alignment: 'left' },
  }),
  [],
) })

test('caption range boundaries: 0 and 240 valid; outside rejected', async () => { const ok = validateRequirements({
  captions: { space_before_pt: 0, space_after_pt: 240 },
})
assert.deepEqual(ok, [])

const badBefore = validateRequirements({ captions: { space_before_pt: -1, space_after_pt: null } })
assert.ok(badBefore.some((e) => e.field === 'captions.space_before'))

const badAfter = validateRequirements({ captions: { space_before_pt: null, space_after_pt: 241 } })
assert.ok(badAfter.some((e) => e.field === 'captions.space_after'))

const nonNum = validateRequirements({ captions: { space_before_pt: 'x', space_after_pt: null } })
assert.ok(nonNum.some((e) => e.field === 'captions.space_before')) })

test('caption before/after are validated independently', async () => { // Invalid after does not block a valid before.
const errors = validateRequirements({
  captions: { space_before_pt: 6, space_after_pt: 'x' },
})
assert.ok(!errors.some((e) => e.field === 'captions.space_before'))
assert.ok(errors.some((e) => e.field === 'captions.space_after'))

// Disabled sides never produce errors.
const disabled = validateRequirements({ captions: { space_before_pt: null, space_after_pt: null } })
assert.ok(!disabled.some((e) => e.field.startsWith('captions.'))) })

test('list range boundaries: 0 and 240 valid; outside rejected', async () => { assert.deepEqual(validateRequirements({ lists: { space_after_pt: 0 } }), [])
assert.deepEqual(validateRequirements({ lists: { space_after_pt: 240 } }), [])
assert.ok(
  validateRequirements({ lists: { space_after_pt: -0.1 } }).some((e) => e.field === 'lists.space_after'),
)
assert.ok(
  validateRequirements({ lists: { space_after_pt: 240.1 } }).some((e) => e.field === 'lists.space_after'),
)
assert.ok(
  validateRequirements({ lists: { space_after_pt: 'NaN' } }).some((e) => e.field === 'lists.space_after'),
) })

test('list disabled → no validation error', async () => { assert.deepEqual(validateRequirements({ lists: { space_after_pt: null } }), []) })

// ---------------------------------------------------------------------------
// Build 5 — copy preservation + immutability
// ---------------------------------------------------------------------------

test('SUC copy preserves its exact built-in reference/caption/list values', async () => { const id = generateProfileId()
const copy = copyProfilePayload({
  profile_id: SUC_BUILTIN_ID,
  profile_name: 'SUC Academic Report',
  profile_source: 'built_in',
  references: { line_spacing: 2, hanging_indent_in: null },
  captions: { space_before_pt: null, space_after_pt: null },
  lists: { space_after_pt: null },
}, id, 'Copy of SUC Academic Report')
assert.equal(copy.profile_source, 'custom')
assert.equal(copy.references.line_spacing, 2)
assert.equal(copy.references.hanging_indent_in, null)
assert.equal(copy.captions.space_before_pt, null)
assert.equal(copy.captions.space_after_pt, null)
assert.equal(copy.lists.space_after_pt, null) })

test('APA copy preserves its exact built-in reference/caption/list values', async () => { const id = generateProfileId()
const copy = copyProfilePayload({
  profile_id: APA_BUILTIN_ID,
  profile_name: 'APA 7 Student Paper',
  profile_source: 'built_in',
  references: { line_spacing: 2, hanging_indent_in: 0.5 },
  captions: { space_before_pt: null, space_after_pt: null },
  lists: { space_after_pt: null },
}, id, 'Copy of APA 7 Student Paper')
assert.equal(copy.references.line_spacing, 2)
// The stored hanging indent survives the copy verbatim and stays editable.
assert.equal(copy.references.hanging_indent_in, 0.5)
assert.equal(copy.captions.space_before_pt, null)
assert.equal(copy.captions.space_after_pt, null)
assert.equal(copy.lists.space_after_pt, null) })

test('editor never exposes a Table Caption policy selector in requirement payloads', async () => { const ui = referencesToUiModel({ line_spacing: null, hanging_indent_in: null })
assert.ok(!('table_eligibility' in ui))
const ui2 = captionsToUiModel({ space_before_pt: null, space_after_pt: null })
assert.ok(!('table_eligibility' in ui2))
const ui3 = listsToUiModel({ space_after_pt: null })
assert.ok(!('table_eligibility' in ui3))
// Safe policy preserved on the blank/copy paths.
const blank = blankProfilePayload(generateProfileId(), 'B')
assert.equal(blank.role_policy.table_eligibility, SAFE_TABLE_ELIGIBILITY) })


// ---------------------------------------------------------------------------
// Build 5 — summary wording + disabled count
// ---------------------------------------------------------------------------









test('disabled count counts the new nullable requirement fields', async () => { const allDisabled = summarizeProfile(blankProfilePayload(generateProfileId(), 'B'))
// references(2) + captions(2) + lists(1) all null → count them.
assert.ok(allDisabled.disabledCount >= 5)
const s = summarizeProfile({
  body: { font_family: null, font_size_pt: null, allowed_font_combos: null, line_spacing: null, alignment: null, space_before_pt: null, space_after_pt: null, first_line_indent_in: null },
  heading: { inherit_body_font: false, font_family: null, font_size_pt: null, allowed_font_combos: null, alignment: null, space_before_pt: null, space_after_pt: null, level_1: null, level_2: null, level_3: null },
  margins: { margin_left_in: null, margin_right_in: null, margin_top_in: null, margin_bottom_in: null },
  references: { line_spacing: 2, hanging_indent_in: null },
  captions: { space_before_pt: 6, space_after_pt: 12 },
  lists: { space_after_pt: null },
})
// references line_spacing + captions before + captions after are enabled; the rest null.
assert.equal(s.disabledCount >= 6, true) })

// ---------------------------------------------------------------------------
// Collision-safe names
// ---------------------------------------------------------------------------

test('resolveUniqueName appends friendly suffixes case-insensitively', async () => { const names = ['My Profile', 'my profile (2)', 'MY PROFILE (3)']
assert.equal(resolveUniqueName(names, 'My Profile'), 'My Profile (4)') })

test('resolveUniqueName keeps desired name when free', async () => { assert.equal(resolveUniqueName([], 'Untitled custom profile'), 'Untitled custom profile')
assert.equal(resolveUniqueName(['Something else'], 'Untitled custom profile'), 'Untitled custom profile') })

test('resolveUniqueName trims and falls back on blank', async () => { assert.equal(resolveUniqueName([], '   '), 'Untitled custom profile') })

// ---------------------------------------------------------------------------
// Friendly source label
// ---------------------------------------------------------------------------

test('friendlySourceName only resolves known built-ins', async () => { assert.equal(friendlySourceName(SUC_BUILTIN_ID), 'SUC Academic Report')
assert.equal(friendlySourceName(APA_BUILTIN_ID), 'APA 7 Student Paper')
assert.equal(friendlySourceName('custom-uuid-123'), null)
assert.equal(friendlySourceName(undefined), null) })

// ---------------------------------------------------------------------------
// Client-side validation
// ---------------------------------------------------------------------------

test('clientValidate: empty name rejected', async () => { const env = emptyEnvelope()
const draft = makeProfile({ name: '   ' })
const errors = clientValidate(draft, env)
assert.ok(errors.some((e) => e.field === 'general.name')) })

test('clientValidate: duplicate name rejected case-insensitively', async () => { const existing = makeProfile({ name: 'My Profile' })
const env = { ...emptyEnvelope(), profiles: [existing] }
const draft = makeProfile({ name: 'my profile' })
const errors = clientValidate(draft, env)
assert.ok(errors.some((e) => e.field === 'general.name')) })

test('clientValidate: same profile name is not a duplicate', async () => { const existing = makeProfile({ name: 'My Profile' })
const env = { ...emptyEnvelope(), profiles: [existing] }
const draft = makeProfile({ name: 'My Profile', id: existing.id })
const errors = clientValidate(draft, env)
assert.ok(!errors.some((e) => e.field === 'general.name')) })

test('clientValidate: over-long description rejected', async () => { const env = emptyEnvelope()
const draft = makeProfile({ description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) })
const errors = clientValidate(draft, env)
assert.ok(errors.some((e) => e.field === 'general.description')) })

test('clientValidate: valid draft passes', async () => { const env = emptyEnvelope()
const draft = makeProfile({ name: 'Valid Name' })
assert.deepEqual(clientValidate(draft, env), []) })

// ---------------------------------------------------------------------------
// buildSavePayload
// ---------------------------------------------------------------------------

test('buildSavePayload enforces custom source + APA citation + trimmed name', async () => { const draft = makeProfile({
  name: '  My Profile  ',
  description: 'desc',
  payload: {
    profile_id: 'x',
    profile_name: 'old',
    profile_source: 'built_in',
    citation_style: 'Chicago',
    body: { font_family: null },
  },
})
const p = buildSavePayload(draft as never)
assert.equal(p.profile_name, 'My Profile')
assert.equal(p.profile_source, 'custom')
assert.equal(p.citation_style, CITATION_STYLE)
assert.equal(p.description, 'desc') })

// ---------------------------------------------------------------------------
// Revision + persistence (multi-tab safety)
// ---------------------------------------------------------------------------

test('upsertAndBump increments revision and stamps updated_at', async () => { const env = { ...emptyEnvelope(), revision: 4, updated_at: 'old' }
const profile = makeProfile()
const next = upsertAndBump(env, profile, '2026-08-21T00:00:00.000Z')
assert.equal(next.revision, 5)
assert.equal(next.updated_at, '2026-08-21T00:00:00.000Z')
assert.equal(next.profiles.length, 1) })

test('persistEnvelope refuses stale revision writes', async () => { const adapter = createDurableTestAdapter()
const env = { ...emptyEnvelope(), revision: 7 }
adapter.set(ACTIVE_KEY, serializeEnvelope(env))
// Caller expects revision 5 but storage has 7 → stale refusal.
const write = (await persistEnvelope(adapter, { ...env, revision: 8 }, 5))
assert.deepEqual(write, { ok: false, reason: 'stale-revision' }) })

test('persistEnvelope succeeds when expected revision matches', async () => { const adapter = createDurableTestAdapter()
const env = { ...emptyEnvelope(), revision: 7 }
adapter.set(ACTIVE_KEY, serializeEnvelope(env))
const write = (await persistEnvelope(adapter, { ...env, revision: 8 }, 7))
assert.equal(write.ok, true)
const loaded = readStoredEnvelope(adapter)
assert.equal(loaded.revision, 8)
// Recovery holds the previous confirmed active envelope.
const recovery = JSON.parse(adapter.get(RECOVERY_KEY)!) as { revision: number }
assert.equal(recovery.revision, 7) })

test('loadStore on empty storage returns a first-run envelope', async () => { const adapter = createDurableTestAdapter()
const env = readStoredEnvelope(adapter)
assert.equal(env.revision, 0)
assert.equal(env.profiles.length, 0) })

// ---------------------------------------------------------------------------
// Dirty detection
// ---------------------------------------------------------------------------

test('isDirty: fresh unsaved draft is dirty; identical saved draft is not', async () => { assert.equal(isDirty(null, null), false)
const draft = makeProfile({ name: 'A' })
assert.equal(isDirty(draft, null), true)
const stored = { ...draft, name: 'A', description: '' }
assert.equal(isDirty(draft, stored), false)
assert.equal(isDirty({ ...draft, name: 'B' }, stored), true) })


// ---------------------------------------------------------------------------
// Operation status (Build 5 polish) — one active status at a time
// ---------------------------------------------------------------------------

test('Save then Delete shows only Delete success', async () => { const merged = mergeOpStatus({ kind: 'saved' }, { kind: 'deleted' })
assert.equal(merged.kind, 'deleted') })

test('Delete then Save shows only Save success', async () => { const merged = mergeOpStatus({ kind: 'deleted' }, { kind: 'saved' })
assert.equal(merged.kind, 'saved') })

test('repeated identical status is not re-announced (same reference)', async () => { const prev: OpStatus = { kind: 'saved' }
assert.equal(mergeOpStatus(prev, { kind: 'saved' }), prev)
const prevErr: OpStatus = { kind: 'error', message: 'boom' }
assert.equal(mergeOpStatus(prevErr, { kind: 'error', message: 'boom' }), prevErr) })

test('different message with same kind IS re-announced', async () => { const prev: OpStatus = { kind: 'error', message: 'a' }
const merged = mergeOpStatus(prev, { kind: 'error', message: 'b' })
assert.notEqual(merged, prev)
assert.equal(merged.message, 'b') })

test('errors supersede stale success status', async () => { const merged = mergeOpStatus({ kind: 'saved' }, { kind: 'backend-error', errors: ['x'] })
assert.equal(merged.kind, 'backend-error')
const merged2 = mergeOpStatus({ kind: 'deleted' }, { kind: 'error', message: 'stale tab' })
assert.equal(merged2.kind, 'error') })

test('success statuses auto-dismiss; errors do not', async () => { assert.equal(isSuccessOpStatus('saved'), true)
assert.equal(isSuccessOpStatus('deleted'), true)
assert.equal(isSuccessOpStatus('already-gone'), true)
assert.equal(isSuccessOpStatus('idle'), false)
assert.equal(isSuccessOpStatus('error'), false)
assert.equal(isSuccessOpStatus('backend-error'), false) })


// ---------------------------------------------------------------------------
// Citation ↔ Reference List matching controls (citation reference build)
// ---------------------------------------------------------------------------

test('blank custom profile carries the documented citation defaults', async () => { const payload = blankProfilePayload('custom-x', 'X')
assert.deepEqual(payload.citation_matching, {
  check_citations_have_references: true,
  check_references_are_cited: false,
  check_author_year_consistency: true,
  check_year_suffixes: true,
  check_duplicate_references: true,
  flag_ambiguous_matches: true,
  allow_personal_communication: true,
}) })

test('copying a built-in preserves its citation toggles verbatim', async () => { const source = blankProfilePayload('custom-src', 'Src')
;(source.citation_matching as Record<string, boolean>).check_references_are_cited = true
const copy = copyProfilePayload(source, 'custom-copy', 'Copy')
assert.deepEqual(copy.citation_matching, source.citation_matching)
// Never the same object: mutating the copy cannot touch the source.
;(copy.citation_matching as Record<string, boolean>).check_year_suffixes = false
assert.equal((source.citation_matching as Record<string, boolean>).check_year_suffixes, true) })

test('copying a payload without the group adds the defaults', async () => { const legacy: Record<string, unknown> = { profile_id: 'custom-old', profile_name: 'Old' }
const copy = copyProfilePayload(legacy, 'custom-new', 'New')
assert.deepEqual(copy.citation_matching, DEFAULT_CITATION_MATCHING) })

test('save payload always sends the group (never an absent group)', async () => { const profile = makeProfile()
delete (profile.payload as Record<string, unknown>).citation_matching
const payload = buildSavePayload(profile)
assert.deepEqual(payload.citation_matching, DEFAULT_CITATION_MATCHING) })

test('save payload sends the edited toggles, not the defaults', async () => { const profile = makeProfile()
;(profile.payload.citation_matching as Record<string, boolean>).check_references_are_cited = true
;(profile.payload.citation_matching as Record<string, boolean>).check_duplicate_references = false
const payload = buildSavePayload(profile)
assert.equal((payload.citation_matching as Record<string, boolean>).check_references_are_cited, true)
assert.equal((payload.citation_matching as Record<string, boolean>).check_duplicate_references, false) })

test('edited citation and Reference settings survive saving and reloading a custom profile', async () => { const adapter = createDurableTestAdapter()
const profile = makeProfile()
const citation = citationMatchingFromUiModel(citationMatchingToUiModel({
  ...profile.payload.citation_matching,
  check_references_are_cited: true,
  check_duplicate_references: false,
}))
const references = referencesFromUiModel(referencesToUiModel({
  ...profile.payload.references,
  check_heading_text: true,
  heading_text: 'works cited',
  check_hanging_indent: true,
  hanging_indent_in: 0.5,
  check_line_spacing: true,
  line_spacing: 2,
}))
profile.payload.citation_matching = citation
profile.payload.references = references
profile.payload = buildSavePayload(profile)
const saved = upsertAndBump(emptyEnvelope(), profile, '2026-08-21T00:00:00.000Z')
assert.equal((await persistEnvelope(adapter, saved, 0)).ok, true)
const loaded = readStoredEnvelope(adapter).profiles[0].payload
assert.deepEqual(citationMatchingToUiModel(loaded.citation_matching), citationMatchingToUiModel(citation))
assert.deepEqual(referencesToUiModel(loaded.references), referencesToUiModel(references))
assert.equal(loaded.references.heading_text, 'works cited')
assert.equal(loaded.references.hanging_indent_in, 0.5)
assert.equal(loaded.references.line_spacing, 2) })

test('UI model round-trip is boolean-only and default-filled', async () => { const ui = citationMatchingToUiModel({ check_year_suffixes: false, mystery: 'x' })
assert.equal(ui.check_year_suffixes, false)
assert.equal(ui.check_citations_have_references, true)
const payload = citationMatchingFromUiModel(ui)
assert.deepEqual(Object.keys(payload).sort(), [...CITATION_MATCHING_FIELDS].sort())
for (const value of Object.values(payload)) assert.equal(typeof value, 'boolean')
// Unknown keys never survive the round-trip into the payload.
assert.equal('mystery' in payload, false) })

test('client validation rejects non-boolean toggles with the backend field path', async () => { const errors = validateRequirements({
  citation_matching: { check_year_suffixes: 'yes' },
})
assert.deepEqual(errors, [
  { field: 'citation_matching.check_year_suffixes', message: 'Choose true or false for this check.' },
]) })

test('client validation rejects unknown citation fields', async () => { const errors = validateRequirements({ citation_matching: { mystery_toggle: true } })
assert.deepEqual(errors, [
  { field: 'citation_matching.mystery_toggle', message: 'This field is not recognized.' },
]) })

test('client validation rejects a malformed citation group', async () => { const errors = validateRequirements({ citation_matching: ['on'] })
assert.deepEqual(errors, [
  { field: 'citation_matching', message: 'This section is not well formed.' },
]) })




test('page elements: all eight independent toggle combinations round-trip and save', async () => { for (let bits = 0; bits < 8; bits += 1) {
  for (const placement of ['header', 'footer', 'either'] as const) {
    const ui = {
      headerEnabled: Boolean(bits & 1),
      footerEnabled: Boolean(bits & 2),
      pageNumberEnabled: Boolean(bits & 4),
      placement,
    }
    const profile = makeProfile()
    Object.assign(profile.payload, pageElementsFromUiModel(ui))
    assert.deepEqual(pageElementsToUiModel(profile.payload), ui)
    assert.deepEqual(clientValidate(profile, emptyEnvelope()), [])
    const saved = buildSavePayload(profile)
    assert.deepEqual(pageElementsToUiModel(saved), ui)
    assert.deepEqual(saved.headers, { check_header_requirements: ui.headerEnabled })
    assert.deepEqual(saved.footers, { check_footer_requirements: ui.footerEnabled })
    assert.deepEqual(saved.page_numbers, { check_page_number_requirements: ui.pageNumberEnabled, placement })
  }
} })

test('page elements: missing historical settings stay Off/either in blank, copy and Save', async () => { const expected = { headerEnabled: false, footerEnabled: false, pageNumberEnabled: false, placement: 'either' }
const profile = makeProfile()
delete profile.payload.headers
delete profile.payload.footers
delete profile.payload.page_numbers
const original = structuredClone(profile.payload)
assert.deepEqual(pageElementsToUiModel(profile.payload), expected)
assert.deepEqual(pageElementsToUiModel(blankProfilePayload('blank', 'Blank')), expected)
assert.deepEqual(pageElementsToUiModel(copyProfilePayload(profile.payload, 'copy', 'Copy')), expected)
assert.deepEqual(pageElementsToUiModel(buildSavePayload(profile)), expected)
assert.deepEqual(profile.payload, original)
assert.deepEqual(validateRequirements({ headers: {}, footers: {}, page_numbers: {} }), []) })

test('page elements: copies and saved payloads have independent nested settings', async () => { const source = {
  profile_source: 'custom',
  ...pageElementsFromUiModel({ headerEnabled: true, footerEnabled: false, pageNumberEnabled: true, placement: 'footer' }),
}
const original = structuredClone(source)
const copy = copyProfilePayload(source, 'copy', 'Copy')
;(copy.headers as Record<string, unknown>).check_header_requirements = false
;(copy.page_numbers as Record<string, unknown>).placement = 'header'
assert.deepEqual(source, original)
const profile = makeProfile({ payload: source })
const saved = buildSavePayload(profile)
;(saved.footers as Record<string, unknown>).check_footer_requirements = true
assert.deepEqual(source, original) })

test('page elements: raw malformed settings are rejected and never repaired by Save or copy', async () => { for (const [groupKey, field] of [
  ['headers', 'check_header_requirements'],
  ['footers', 'check_footer_requirements'],
  ['page_numbers', 'check_page_number_requirements'],
]) {
  for (const raw of [null, undefined, false, 0, '', [], 'enabled']) {
    const profile = makeProfile()
    profile.payload[groupKey] = raw
    assert.ok(validateRequirements(profile.payload).some((error) => error.field === groupKey))
    assert.deepEqual(buildSavePayload(profile)[groupKey], raw)
    assert.deepEqual(copyProfilePayload(profile.payload, 'copy', 'Copy')[groupKey], raw)
  }
  for (const raw of [null, undefined, 0, 1, '', 'true', [], {}]) {
    const profile = makeProfile()
    profile.payload[groupKey] = { [field]: raw }
    assert.ok(validateRequirements(profile.payload).some((error) => error.field === `${groupKey}.${field}`))
    assert.deepEqual((buildSavePayload(profile)[groupKey] as Record<string, unknown>)[field], raw)
  }
  const profile = makeProfile()
  profile.payload[groupKey] = { [field]: false, unexpected: true }
  assert.ok(validateRequirements(profile.payload).some((error) => error.field === `${groupKey}.unexpected`))
  assert.equal((buildSavePayload(profile)[groupKey] as Record<string, unknown>).unexpected, true)
} })

test('page elements: editing one control preserves unrelated malformed settings for validation', async () => { const raw = {
  profile_source: 'custom',
  headers: { check_header_requirements: false, unexpected: true },
  footers: { check_footer_requirements: 'bad' },
  page_numbers: { check_page_number_requirements: false, placement: 'body', unexpected: true },
}
const original = structuredClone(raw)
const updated = applyPageElementsUiPatch(raw, { headerEnabled: true })
assert.deepEqual(updated.headers, { check_header_requirements: true, unexpected: true })
assert.deepEqual(updated.footers, original.footers)
assert.deepEqual(updated.page_numbers, original.page_numbers)
assert.deepEqual(validateRequirements(updated).map(e => e.field), [
  'headers.unexpected', 'footers.check_footer_requirements',
  'page_numbers.unexpected', 'page_numbers.placement',
])
const placementOnly = applyPageElementsUiPatch(raw, { placement: 'footer' })
assert.deepEqual(placementOnly.page_numbers, { ...raw.page_numbers, placement: 'footer' })
assert.deepEqual(placementOnly.headers, raw.headers)
assert.deepEqual(placementOnly.footers, raw.footers)
assert.deepEqual(raw, original) })

test('page elements: placement is validated even Off, without enabling any other group', async () => { for (const placement of [null, undefined, false, 1, '', 'body', 'Header', []]) {
  const profile = makeProfile()
  profile.payload.page_numbers = { check_page_number_requirements: false, placement }
  assert.ok(validateRequirements(profile.payload).some((error) => error.field === 'page_numbers.placement'))
  assert.deepEqual((buildSavePayload(profile).page_numbers as Record<string, unknown>).placement, placement)
}
for (const placement of ['header', 'footer', 'either'] as const) {
  const profile = makeProfile()
  profile.payload.page_numbers = { check_page_number_requirements: true, placement }
  assert.deepEqual(pageElementsToUiModel(profile.payload), {
    headerEnabled: false, footerEnabled: false, pageNumberEnabled: true, placement,
  })
} })

test('page elements: enabling any group requires an explicit Custom source', async () => { for (const profile_source of ['built_in', 'legacy', undefined]) {
  const errors = validateRequirements({
    profile_source,
    headers: { check_header_requirements: true },
    footers: { check_footer_requirements: true },
    page_numbers: { check_page_number_requirements: true, placement: 'either' },
  })
  assert.deepEqual(errors.map((error) => error.field), [
    'headers.check_header_requirements', 'footers.check_footer_requirements', 'page_numbers.check_page_number_requirements',
  ])
  assert.ok(errors.every((error) => error.message === 'Available only in Custom Profiles'))
  assert.deepEqual(validateRequirements({
    profile_source,
    ...pageElementsFromUiModel({ headerEnabled: false, footerEnabled: false, pageNumberEnabled: false, placement: 'either' }),
  }), [])
} })



test('summary does not duplicate enabled Reference order or DOI requirements', async () => { const summary = summarizeProfile({
  ...blankProfilePayload('summary-reference-checks', 'Reference checks'),
  references: { check_reference_order: true, check_doi_format: true },
})
assert.equal(summary.lines.filter((line) => line.includes('alphabetical order')).length, 1)
assert.equal(summary.lines.filter((line) => line.includes('Reference DOI format')).length, 1)
assert.ok(summary.lines.some((line) => line.includes('presentation only, not registration or resolution'))) })

test('editor summary preserves independent page toggles for all placements', async () => { for (const [placement, label] of [['header', 'Header'], ['footer', 'Footer'], ['either', 'Header or Footer']] as const) {
  const summary = summarizeProfile({
    ...blankProfilePayload('independent-page-checks', 'Independent checks'),
    ...pageElementsFromUiModel({ headerEnabled: false, footerEnabled: true, pageNumberEnabled: true, placement }),
  })
  assert.ok(summary.lines.includes('Headers: Not checked'))
  assert.ok(summary.lines.includes('Footer requirements · Manual review only · Unscored'))
  assert.ok(summary.lines.includes(`Page number requirements · Manual review only · Unscored · Placement: ${label}`))
} })
