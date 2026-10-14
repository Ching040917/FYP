/**
 * Audit context disclosure tests — compact Profile Summary + Selected
 * Evidence (overflow regression fix).
 *
 * Covers: one-line compact contracts, explicit Details controls, full
 * details content (Reference settings incl. alphabetical-order status;
 * evidence precision states), keyboard/ARIA behavior of the shared
 * CompactDisclosure, no tooltip-only access, no Finding-title duplication
 * in the compact bar, and Reference-order wording preservation. Pure
 * logic + source contracts (no DOM), following repository conventions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  DISCLOSURE_GROUP_EVENT,
  isForeignDisclosureEvent,
} from '../src/lib/audit/disclosure-group.ts'
import {
  compactEvidenceText,
  compactPrecisionLabel,
  evidencePage,
  evidencePrecision,
  evidenceTargetLabel,
} from '../src/lib/audit/evidence-summary.ts'
import {
  compactProfileSummary,
  enabledCheckCount,
  marginsDisclosureLine,
  profileDetailSections,
  referenceCheckParts,
  referenceUncheckedParts,
  referencesDisclosure,
} from '../src/lib/audit/enabled-checks-wording.ts'
import type { ProfileSnapshot } from '../src/types/api'

const src = (rel: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), rel), 'utf8')

const DISCLOSURE = src('../src/components/audit/compact-disclosure.tsx')
const AUDIT_PAGE = src('../src/pages/AuditPage.tsx')
const PREVIEW = src('../src/components/audit/document-preview.tsx')

function snapshot(overrides: Record<string, unknown> = {}): ProfileSnapshot {
  return {
    profile_id: 'p1',
    profile_name: 'My Profile',
    profile_version: 1,
    profile_source: 'custom',
    description: '',
    citation_style: 'APA 7',
    institution_specific: false,
    margins: { left_in: null, right_in: null, top_in: null, bottom_in: null },
    references: {},
    ...overrides,
  } as ProfileSnapshot
}

// ---------------------------------------------------------------------------
// Profile Summary: compact + count
// ---------------------------------------------------------------------------

test('compact profile summary prioritizes name and enabled-check count', () => {
  const s = snapshot({
    margins: { left_in: 1, right_in: 1, top_in: 1, bottom_in: 1 },
    references: { check_hanging_indent: true, hanging_indent_in: 0.5 },
  })
  assert.equal(compactProfileSummary(s), 'My Profile · 2 checks enabled')
})

test('compact profile summary is null without a snapshot', () => {
  assert.equal(compactProfileSummary(null), null)
  assert.equal(compactProfileSummary(undefined), null)
})

test('enabled-check count covers margins once plus every enabled reference part', () => {
  assert.equal(enabledCheckCount(null), 0)
  assert.equal(enabledCheckCount(snapshot()), 0)
  assert.equal(
    enabledCheckCount(
      snapshot({ margins: { left_in: 1, right_in: null, top_in: null, bottom_in: null } }),
    ),
    1,
  )
  assert.equal(
    enabledCheckCount(
      snapshot({ references: { check_hanging_indent: true, hanging_indent_in: 0.5 } }),
    ),
    1,
  )
  // Legacy tri-state: stored line spacing without a toggle still counts.
  assert.equal(
    enabledCheckCount(snapshot({ references: { line_spacing: 2.0 } })),
    1,
  )
  assert.equal(
    enabledCheckCount(
      snapshot({
        margins: { left_in: 1, right_in: 1, top_in: 1, bottom_in: 1 },
        references: {
          check_hanging_indent: true,
          hanging_indent_in: 0.5,
          check_reference_order: true,
        },
      }),
    ),
    3,
  )
})

test('margins disclosure wording is unchanged', () => {
  assert.equal(
    marginsDisclosureLine({ left_in: null, right_in: null, top_in: null, bottom_in: null }),
    'Margins: Not checked',
  )
  assert.equal(
    marginsDisclosureLine({ left_in: 1, right_in: 1, top_in: 1, bottom_in: 1 }),
    'Margins: 1 in on all sides',
  )
  assert.equal(
    marginsDisclosureLine({ left_in: 1.5, right_in: null, top_in: null, bottom_in: null }),
    'Margins: 1.5 in left',
  )
})

test('reference parts list carries alphabetical order only when enabled', () => {
  assert.ok(referenceCheckParts({ check_reference_order: true }).includes('alphabetical order'))
  assert.ok(!referenceCheckParts({ check_reference_order: false }).includes('alphabetical order'))
  assert.ok(!referenceCheckParts({}).includes('alphabetical order'))
  assert.ok(!referenceCheckParts(null).includes('alphabetical order'))
})

test('profile details sections expose identity, enabled and not-checked groups', () => {
  const sections = profileDetailSections(
    snapshot({
      references: { check_hanging_indent: true, hanging_indent_in: 0.5, check_reference_order: true },
    }),
  )
  const map = new Map(sections.map((s) => [s.heading, s.items.map((i) => i.text)]))
  assert.deepEqual(map.get('Profile'), ['My Profile'])
  assert.deepEqual(map.get('Source'), ['Custom'])
  assert.ok((map.get('Enabled checks') ?? []).includes('0.5 in hanging indent'))
  assert.ok((map.get('Enabled checks') ?? []).includes('alphabetical order'))
  assert.ok((map.get('Not checked') ?? []).includes('Margins'))
  assert.ok(!(map.get('Not checked') ?? []).includes('Alphabetical order'))
})

test('unchecked parts mirror the enabled parts without overlap', () => {
  const refs = { check_hanging_indent: true, hanging_indent_in: 0.5, check_reference_order: true }
  const on = new Set(referenceCheckParts(refs))
  const off = referenceUncheckedParts(refs)
  assert.ok(off.includes('Margins') === false, 'margins handled by caller')
  assert.ok(off.includes('Alphabetical order') === false)
  assert.ok(off.includes('Reference heading'))
  // No requirement is both enabled and not-checked.
  for (const item of off) assert.ok(!on.has(item), item)
  // Legacy tri-state: stored line spacing without a toggle counts as enabled.
  assert.ok(!referenceUncheckedParts({ line_spacing: 2.0 }).includes('Reference line spacing'))
  assert.ok(referenceUncheckedParts({}).includes('Alphabetical order'))
})

test('profile details expose no raw indexes, keys, or internals', () => {
  const blob = JSON.stringify(profileDetailSections(snapshot()))
  for (const token of ['paragraph_index', 'author_key', 'fingerprint', 'schema_version', 'twip', 'numPr']) {
    assert.ok(!blob.includes(token), token)
  }
})

// ---------------------------------------------------------------------------
// Selected Evidence: compact + precision
// ---------------------------------------------------------------------------

test('compact evidence text prioritizes location and precision, never title or target', () => {
  assert.equal(
    compactEvidenceText({ paragraphIndex: 4, page: 2, precision: 'Paragraph evidence' }),
    'Evidence · Page 2 · Paragraph 5 · Paragraph evidence',
  )
  assert.equal(
    compactEvidenceText({ paragraphIndex: null, page: 3, objectLabel: 'Table 3', precision: 'Page-only evidence' }),
    'Evidence · Page 3 · Table 3 · Page-only evidence',
  )
  assert.equal(
    compactEvidenceText({ paragraphIndex: null, page: null, precision: 'Visual region unavailable' }),
    'Evidence · Visual region unavailable',
  )
})

test('compact precision shortens only the exact-citation form', () => {
  assert.equal(compactPrecisionLabel('Exact citation evidence'), 'Citation evidence')
  assert.equal(compactPrecisionLabel('Paragraph evidence'), 'Paragraph evidence')
  assert.equal(compactPrecisionLabel('Page-only evidence'), 'Page-only evidence')
  assert.equal(compactPrecisionLabel('Visual region unavailable'), 'Visual region unavailable')
})

test('evidence target prefers short location-like labels', () => {
  assert.equal(
    evidenceTargetLabel({ citationRects: [{ page: 1 }] } as never),
    'Citation occurrence',
  )
  assert.equal(
    evidenceTargetLabel({ formattingEvidence: {}, referenceEntry: true, paragraphIndex: 0 } as never),
    'Reference entry',
  )
  assert.equal(
    evidenceTargetLabel({ formattingEvidence: {}, headingEntry: true } as never),
    'References heading',
  )
  assert.equal(
    evidenceTargetLabel({ formattingEvidence: {}, paragraphIndex: 0 } as never),
    'Paragraph 1',
  )
  assert.equal(evidenceTargetLabel({ objectLabel: 'Table 3' }), 'Table 3')
  assert.equal(evidenceTargetLabel({}), '—')
})

test('evidence target never repeats a finding title', () => {
  const title = 'Reference List is not in alphabetical order'
  for (const target of [
    evidenceTargetLabel({ citationRects: [{ page: 1 }] } as never),
    evidenceTargetLabel({ formattingEvidence: {}, referenceEntry: true, paragraphIndex: 3 } as never),
    evidenceTargetLabel({ objectLabel: 'Table 1' }),
  ]) {
    assert.ok(!target.includes(title), target)
    assert.ok(target.length <= 30, `short label: ${target}`)
  }
})

test('evidence precision states are truthful per highlight source', () => {
  assert.equal(evidencePrecision({ citationRects: [{ page: 1 }] } as never), 'Exact citation evidence')
  assert.equal(
    evidencePrecision({ formattingEvidence: { kind: 'paragraph', pageRects: [] } } as never),
    'Paragraph evidence',
  )
  assert.equal(
    evidencePrecision({ formattingEvidence: { kind: 'run', pageRects: [] } } as never),
    'Paragraph evidence',
  )
  assert.equal(
    evidencePrecision({ objectStatus: { label: 'Table 3', message: null } } as never),
    'Page-only evidence',
  )
  assert.equal(
    evidencePrecision({ figureOutline: { label: 'Figure 1' } } as never),
    'Page-only evidence',
  )
  assert.equal(
    evidencePrecision({ marginStatus: { label: 'Margins', message: 'ok' } } as never),
    'Page-only evidence',
  )
  assert.equal(evidencePrecision({ highlightMessage: 'No highlight' }), 'Visual region unavailable')
  assert.equal(evidencePrecision({}), 'Visual region unavailable')
})

test('evidence page prefers citation, then formatting, figure, margin', () => {
  assert.equal(
    evidencePage({
      citationRects: [{ page: 2 }],
      formattingPageRects: [{ page: 3 }],
      figurePage: 4,
      marginStartPage: 5,
    }),
    2,
  )
  assert.equal(evidencePage({ formattingPageRects: [{ page: 3 }] }), 3)
  assert.equal(evidencePage({ figurePage: 4 }), 4)
  assert.equal(evidencePage({ marginStartPage: 5 }), 5)
  assert.equal(evidencePage({}), null)
})

// ---------------------------------------------------------------------------
// Shared disclosure component contract
// ---------------------------------------------------------------------------

test('disclosure controls are recognisable buttons with icons and chevrons', () => {
  assert.ok(DISCLOSURE.includes('variant="outline"'), 'visible border + background')
  assert.ok(DISCLOSURE.includes('<Button'), 'real button semantics')
  assert.ok(DISCLOSURE.includes('icon'), 'lead/target icon slot')
  assert.ok(DISCLOSURE.includes('ChevronDown'), 'collapsed chevron')
  assert.ok(DISCLOSURE.includes('ChevronUp'), 'expanded chevron')
  assert.ok(DISCLOSURE.includes('open ? ChevronUp : ChevronDown'), 'chevron reflects state')
  const BUTTON = src('../src/components/ui/button.tsx')
  assert.ok(BUTTON.includes('focus-visible'), 'visible keyboard focus state via shared Button')
})

test('only one context disclosure stays open at a time', () => {
  assert.equal(DISCLOSURE_GROUP_EVENT, 'aca:compact-disclosure-open')
  assert.equal(isForeignDisclosureEvent(new CustomEvent(DISCLOSURE_GROUP_EVENT, { detail: 'a' }), 'b'), true)
  assert.equal(isForeignDisclosureEvent(new CustomEvent(DISCLOSURE_GROUP_EVENT, { detail: 'a' }), 'a'), false)
  // Listeners register for the group event only, so foreign types never reach the helper.
  assert.ok(DISCLOSURE.includes('DISCLOSURE_GROUP_EVENT, onGroup'), 'group listener wired')
  assert.ok(DISCLOSURE.includes('announceOpen'), 'opening announces')
})

test('dialog renders through the viewport portal layer', () => {
  assert.ok(DISCLOSURE.includes('createPortal'), 'portal rendering')
  assert.ok(DISCLOSURE.includes('document.body'), 'mounted outside workspace columns')
  assert.ok(DISCLOSURE.includes('fixed inset-0'), 'viewport-level overlay')
  assert.ok(DISCLOSURE.includes('z-50'), 'above all workspace columns')
})

test('dialog follows the repository modal contract', () => {
  assert.ok(DISCLOSURE.includes('role="dialog"'), 'dialog role')
  assert.ok(DISCLOSURE.includes('aria-modal="true"'), 'modal semantics')
  assert.ok(DISCLOSURE.includes('aria-labelledby={titleId}'), 'labelled title')
  assert.ok(DISCLOSURE.includes('{panelLabel}'), 'clear visible heading')
  assert.ok(DISCLOSURE.includes('aria-label="Close dialog"'), 'visible Close control')
  assert.ok(DISCLOSURE.includes("e.key === 'Escape'"), 'escape closes')
  assert.ok(DISCLOSURE.includes("e.key !== 'Tab'"), 'focus trap')
  assert.ok(DISCLOSURE.includes('triggerRef.current?.focus?.()'), 'focus returns to trigger')
  assert.ok(DISCLOSURE.includes("document.body.style.overflow = 'hidden'"), 'body scroll lock')
  assert.ok(DISCLOSURE.includes('onClick={close}'), 'overlay click closes')
  assert.ok(DISCLOSURE.includes('stopPropagation'), 'panel clicks stay inside')
})

test('dialog stays readable at any width without page scrolling', () => {
  assert.ok(DISCLOSURE.includes('max-w-[560px]'), 'readable desktop width')
  assert.ok(DISCLOSURE.includes('max-h-[calc(100vh-2rem)]'), 'viewport-capped height')
  assert.ok(DISCLOSURE.includes('overflow-y-auto'), 'internal scrolling for long content')
})

test('long values wrap inside dialogs and sections', () => {
  assert.ok(DISCLOSURE.includes('[overflow-wrap:anywhere]'), 'long tokens wrap, never clip')
  assert.ok(DISCLOSURE.includes('break-words'), 'normal wrapping')
  assert.ok(!DISCLOSURE.includes('overflow-x'), 'no horizontal panel scrolling')
})

test('profile sections render grouped headings with list items', () => {
  assert.ok(DISCLOSURE.includes('<section'), 'grouped sections')
  assert.ok(DISCLOSURE.includes('<h3'), 'section headings')
  assert.ok(DISCLOSURE.includes('<ul'), 'list items, not one sentence')
  assert.ok(DISCLOSURE.includes('<li'), 'individual rows')
})

test('disclosure never relies on a title tooltip for complete content', () => {
  assert.ok(!DISCLOSURE.includes('title='), 'no title attribute in the shared component')
})

// ---------------------------------------------------------------------------
// Page wiring contracts
// ---------------------------------------------------------------------------

test('audit header renders the compact summary with a labelled button', () => {
  assert.ok(AUDIT_PAGE.includes('compactProfileSummary('), 'compact wording helper')
  assert.ok(AUDIT_PAGE.includes('profileDetailSections('), 'grouped details sections')
  assert.ok(AUDIT_PAGE.includes('detailsLabel="Profile details"'), 'explicit control label')
  assert.ok(AUDIT_PAGE.includes('testId="profile-summary-disclosure"'), 'stable test hook')
  assert.ok(AUDIT_PAGE.includes('min-w-0 flex-1'), 'shrinkable one-line wrapper')
  assert.ok(AUDIT_PAGE.includes('SlidersHorizontal'), 'profile icon')
})

test('preview evidence bar is a one-line dialog trigger without title text', () => {
  assert.ok(PREVIEW.includes('compactEvidenceText('), 'location-first compact text')
  assert.ok(PREVIEW.includes('precision: compactPrecisionLabel('), 'precision, not target/title')
  assert.ok(!PREVIEW.includes('target: selectedEvidenceTarget'), 'target excluded from compact bar')
  assert.ok(PREVIEW.includes('testId="preview-evidence-disclosure"'), 'stable test hook')
  assert.ok(!PREVIEW.includes('title={evidence.text}'), 'no tooltip-only access')
  assert.ok(PREVIEW.includes('detailsLabel="Evidence details"'), 'explicit control label')
  assert.ok(PREVIEW.includes("['Evidence target', selectedEvidenceTarget"), 'target in details only')
  assert.ok(PREVIEW.includes("['Availability', selectedEvidenceMessage]"), 'availability message row')
  assert.ok(PREVIEW.includes('evidencePrecision('), 'truthful precision states')
  assert.ok(PREVIEW.includes('friendlyRuleTitle('), 'finding title in details only')
})

test('reference-order profile wording remains present', () => {
  assert.ok(referencesDisclosure({ check_reference_order: true }).includes('alphabetical order'))
  const sections = profileDetailSections(snapshot({ references: { check_reference_order: true } }))
  const enabled = sections.find((s) => s.heading === 'Enabled checks')
  assert.ok(enabled?.items.some((i) => i.text === 'alphabetical order'))
  const unchecked = sections.find((s) => s.heading === 'Not checked')
  assert.ok(!(unchecked?.items.some((i) => i.text === 'Alphabetical order') ?? false))
})
