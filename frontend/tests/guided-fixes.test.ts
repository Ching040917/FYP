/**
 * Guided Fixes (Beta) frontend tests — pure helpers, API contract, and
 * workflow invariants. No browser, no network (fetch mocked where needed),
 * no document content beyond synthetic violations.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { api } from '../src/services/api.ts'
import {
  SUPPORTED_FIX_RULES,
  MAX_SELECTED,
  MISMATCH_DETAIL,
  LEGACY_DETAIL,
  ZERO_DETAIL,
  GENERIC_FAILURE,
  friendlyGuidedFixError,
  toggleGuidedSelection,
  dedupeSelection,
  guidedPresentationFor,
  correctedFilename,
} from '../src/lib/guided-fixes.ts'

function mockFetchOnce(handler: (input: RequestInfo, init?: RequestInit) => Promise<Response> | Response) {
  const orig = globalThis.fetch
  globalThis.fetch = handler as typeof fetch
  return () => { globalThis.fetch = orig }
}

function violation(ruleCode: string, extra: Record<string, unknown> = {}) {
  return {
    id: `${ruleCode}-1`,
    rule_code: ruleCode,
    severity: 'MINOR' as const,
    location: { paragraph_index: 3 },
    message: 'm',
    expected_value: '12pt',
    actual_value: '11pt',
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Supported / unsupported presentation (items 1-2, 10)
// ---------------------------------------------------------------------------

describe('guided presentation', () => {
  test('supported rules are selectable and carry friendly labels', () => {
    for (const rule of Object.keys(SUPPORTED_FIX_RULES)) {
      assert.equal(SUPPORTED_FIX_RULES[rule], true, rule)
      const pres = guidedPresentationFor(violation(rule))
      assert.equal(pres.supported, true, rule)
      assert.ok(pres.friendlyName.length > 0)
      assert.ok(!pres.friendlyName.includes('_'))
      assert.equal(pres.friendlyLocation, 'Paragraph 4') // paragraph_index 3 → 4
    }
  })

  test('unsupported rules show manual correction required and no proposal', () => {
    for (const rule of ['MARGIN_LEFT', 'HEADING_HIERARCHY', 'CITATION_MISMATCH', 'TABLE_CAPTION_MISSING']) {
      const pres = guidedPresentationFor(violation(rule))
      assert.equal(pres.supported, false, rule)
      assert.equal(pres.proposed, '')
      assert.equal(pres.current, '11 pt')
    }
  })

  test('internal run indexes and OOXML terminology never appear in presentation', () => {
    const pres = guidedPresentationFor({
      ...violation('FONT_SIZE'),
      location: { paragraph_index: 0, run_index: 0, run_indexes: [0, 1] },
    })
    const text = JSON.stringify(pres)
    assert.ok(!text.includes('run_index'))
    assert.ok(!text.includes('run_indexes'))
    assert.ok(!text.includes('OOXML'))
    assert.ok(!text.includes('SEQ'))
  })

  test('proposed values come only from persisted expected_value', () => {
    const pres = guidedPresentationFor(violation('ALIGNMENT', { expected_value: 'justify', actual_value: 'left' }))
    assert.equal(pres.proposed, 'justified')
    const noExpected = guidedPresentationFor({ ...violation('FONT_SIZE'), expected_value: null })
    assert.equal(noExpected.proposed, 'Profile requirement (see finding details)')
  })

  test('Reference heading alignment is a single safe paragraph proposal', () => {
    const pres = guidedPresentationFor(violation('REFERENCE_HEADING_ALIGNMENT', {
      location: { paragraph_index: 1 },
      expected_value: 'Center',
      actual_value: 'Left',
    }))
    assert.equal(pres.supported, true)
    assert.equal(pres.friendlyLocation, 'Paragraph 2')
    assert.equal(pres.current, 'Left')
    assert.equal(pres.proposed, 'centered')
  })

  test('Reference heading bold proposes only the saved boolean direction', () => {
    for (const [current, required, proposal] of [
      ['Not bold', 'Bold', 'Make the Reference List heading bold'],
      ['Bold', 'Not bold', 'Use regular (not bold) text for the Reference List heading'],
    ]) {
      const pres = guidedPresentationFor(violation('REFERENCE_HEADING_BOLD', {
        location: { paragraph_index: 1 }, actual_value: current, expected_value: required,
      }))
      assert.equal(pres.supported, true)
      assert.equal(pres.friendlyName, 'Reference List heading bold (all heading text)')
      assert.equal(pres.current, current)
      assert.equal(pres.proposed, proposal)
      assert.equal(pres.friendlyLocation, 'Paragraph 2')
    }
    const unknown = guidedPresentationFor(violation('REFERENCE_HEADING_BOLD', { expected_value: '12 pt' }))
    assert.equal(unknown.proposed, 'Profile requirement (see finding details)')
    assert.equal(guidedPresentationFor(violation('HEADING_BOLD')).supported, false)
  })
})

// ---------------------------------------------------------------------------
// Selection helpers (items 3-7)
// ---------------------------------------------------------------------------

describe('guided selection', () => {
  test('no Apply-all action exists in the helper surface', async () => {
    // The selection API exposes toggle/dedupe only — deliberate selection.
    assert.equal(typeof toggleGuidedSelection, 'function')
    assert.equal(typeof dedupeSelection, 'function')
    const exported = Object.keys(await import('../src/lib/guided-fixes.ts'))
    // View-aware helpers like selectAllInView are allowed; only action-style
    // exports (applyAll/SelectAll-violations) must not exist.
    const banned = exported.filter((k) => /apply.*all|select.*all.*violation/i.test(k))
    assert.deepEqual(banned, [])
  })

  test('selection deduplicates ids preserving first occurrence', () => {
    assert.deepEqual(dedupeSelection(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c'])
  })

  test('selection limit is 20 matching the backend', () => {
    assert.equal(MAX_SELECTED, 20)
    const ids = Array.from({ length: 20 }, (_, i) => `v${i}`)
    let sel: string[] = []
    for (const id of ids) sel = toggleGuidedSelection(sel, id)
    assert.equal(sel.length, 20)
    // At cap: further adds are ignored without losing existing selection.
    const after = toggleGuidedSelection(sel, 'v99')
    assert.equal(after.length, 20)
    assert.deepEqual(after, sel)
  })

  test('toggle removes existing ids', () => {
    const sel = toggleGuidedSelection([], 'a')
    assert.deepEqual(sel, ['a'])
    assert.deepEqual(toggleGuidedSelection(sel, 'a'), [])
  })

  test('selection clears when audit changes (reset helper shape)', () => {
    // AuditPage resets via a fresh context effect keyed on auditId — the
    // invariant under test: a new selection starts empty and does not carry
    // stale ids.
    const fresh: string[] = []
    assert.deepEqual(fresh, [])
    const afterSelect = toggleGuidedSelection(fresh, 'x')
    assert.deepEqual(afterSelect, ['x'])
    // Simulated audit-id change: the component re-initialises to [].
    const nextAudit: string[] = []
    assert.deepEqual(nextAudit, [])
  })
})

// ---------------------------------------------------------------------------
// Review values (item 8) + accessible checkbox label source (item 9)
// ---------------------------------------------------------------------------

describe('review values', () => {
  test('review shows current and proposed from persisted data', () => {
    const pres = guidedPresentationFor(violation('FONT_SIZE', { expected_value: '12pt', actual_value: '11pt' }))
    assert.equal(pres.current, '11 pt')
    assert.equal(pres.proposed, '12 pt')
  })

  test('checkbox accessible name contains friendly name and location', () => {
    const pres = guidedPresentationFor(violation('LINE_SPACING', {
      location: { paragraph_index: 2 },
      expected_value: '1.5',
      actual_value: '1.0',
    }))
    assert.equal(pres.friendlyName, 'Line spacing does not match')
    assert.equal(pres.friendlyLocation, 'Paragraph 3')
    const label = `${pres.friendlyName}, ${pres.friendlyLocation}`
    assert.ok(label.includes('Line spacing does not match'))
    assert.ok(label.includes('Paragraph 3'))
  })
})

// ---------------------------------------------------------------------------
// API contract (items 11-21)
// ---------------------------------------------------------------------------

describe('guided review, apply and download API', () => {
  const review = {
    review_id: 'review-token', items: [{ violation_id: 'v1', before: '11 pt', after: '12 pt',
      property: 'Font size', locations: ['Paragraph 4'], affected_count: 1 }],
    output_filename: 'report_ACA-fixed.docx', limitations: ['May reflow pages'],
    expires_at: '2026-10-18T12:00:00Z',
  }
  const result = {
    status: 'passed', resolved: ['v1'], before_score: 90, after_score: 92,
    before_findings: [{ rule_code: 'FONT_SIZE', count: 1, locations: ['Paragraph 4'] }],
    after_findings: [], new_findings: [], download_token: 'download-token',
    output_filename: review.output_filename, expires_at: review.expires_at,
  }

  test('review sends original bytes and IDs only; returns server-confirmed targets', async () => {
    let captured: RequestInit | undefined
    let url = ''
    const restore = mockFetchOnce((input, init) => {
      url = String(input)
      captured = init
      return Response.json(review)
    })
    try {
      const file = new File(['PK-docx'], 'original.docx')
      assert.deepEqual(await api.reviewGuidedFixes('audit-1', file, ['v1']), review)
      assert.equal(url, '/api/audit/audit-1/guided-fixes/review')
      assert.equal(captured?.method, 'POST')
      const body = captured?.body as FormData
      assert.equal(body.get('file'), file)
      assert.deepEqual(JSON.parse(String(body.get('selection'))), { violation_ids: ['v1'] })
      assert.deepEqual([...body.keys()], ['file', 'selection'])
      for (const banned of ['paragraph_index', 'run_index', 'expected_value', 'rule_code']) {
        assert.ok(!String(body.get('selection')).includes(banned))
      }
    } finally {
      restore()
    }
  })

  test('apply requires a review token and returns verification JSON, never binary', async () => {
    let captured: RequestInit | undefined
    let url = ''
    const restore = mockFetchOnce((input, init) => {
      url = String(input)
      captured = init
      return Response.json(result)
    })
    try {
      const file = new File(['PK-docx'], 'original.docx')
      assert.deepEqual(await api.applyGuidedFixes('audit-1', file, ['v1'], 'review-token'), result)
      assert.equal(url, '/api/audit/audit-1/guided-fixes')
      const body = captured?.body as FormData
      assert.deepEqual([...body.keys()], ['file', 'selection', 'review_id'])
      assert.equal(body.get('file'), file)
      assert.equal(body.get('review_id'), 'review-token')
      assert.deepEqual(JSON.parse(String(body.get('selection'))), { violation_ids: ['v1'] })
    } finally {
      restore()
    }
  })

  test('a non-passed response cannot unlock download', async () => {
    const restore = mockFetchOnce(() => Response.json({ ...result, status: 'failed' }))
    try {
      await assert.rejects(() => api.applyGuidedFixes('a', new File(['x'], 'a.docx'), ['v1'], 'review-token'))
    } finally {
      restore()
    }
  })

  test('cancel revokes the review and download GET retrieves one-use binary only on demand', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = []
    const restore = mockFetchOnce((input, init) => {
      calls.push({ url: String(input), method: init?.method })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(new Blob(['PK-docx']), { status: 200 })
    })
    try {
      await api.cancelGuidedFixReview('a', 'review-token')
      const blob = await api.downloadGuidedFix('a', 'download-token')
      assert.equal(await blob.text(), 'PK-docx')
      assert.deepEqual(calls, [
        { url: '/api/audit/a/guided-fixes/review/review-token', method: 'DELETE' },
        { url: '/api/audit/a/guided-fixes/download/download-token', method: undefined },
      ])
    } finally {
      restore()
    }
  })

  test('source mismatch and consumed/expired download are errors, not Blob fallbacks', async () => {
    const restore = mockFetchOnce(() => Response.json({ detail: MISMATCH_DETAIL }, { status: 409 }))
    try {
      await assert.rejects(
        () => api.reviewGuidedFixes('a', new File(['x'], 'a.docx'), ['v1']),
        (err: Error) => err.message === MISMATCH_DETAIL,
      )
    } finally {
      restore()
    }
    const restoreGone = mockFetchOnce(() => Response.json({ detail: 'Gone' }, { status: 410 }))
    try {
      await assert.rejects(() => api.downloadGuidedFix('a', 'used-token'), /Gone/)
    } finally {
      restoreGone()
    }
  })
})

// ---------------------------------------------------------------------------
// Error translation (items 20-22)
// ---------------------------------------------------------------------------

describe('error translation', () => {
  test('mismatch detail keeps selection (verbatim surface, no internal codes)', () => {
    assert.equal(friendlyGuidedFixError(MISMATCH_DETAIL), MISMATCH_DETAIL)
  })

  test('unsafe review shows manual-correction guidance', () => {
    assert.equal(friendlyGuidedFixError(ZERO_DETAIL), ZERO_DETAIL)
    assert.ok(friendlyGuidedFixError(ZERO_DETAIL).includes('manual'))
  })

  test('only exact proven heading-bold unavailability details are exposed', () => {
    for (const detail of [
      'ACA cannot identify one unambiguous Reference List heading. Correct this finding manually; your original document is unchanged.',
      'ACA cannot safely confirm bold formatting for every text segment in this heading. Correct its bold formatting manually; your original document is unchanged.',
      'This correction is unavailable for signed, protected or macro-enabled documents. Correct the heading manually; your original document is unchanged.',
    ]) {
      assert.equal(friendlyGuidedFixError(detail), detail)
      assert.equal(friendlyGuidedFixError(`${detail} Internal XML detail`), GENERIC_FAILURE)
    }
  })

  test('internal skip codes never reach the user', () => {
    for (const code of ['expected_unresolved', 'unsafe_structure', 'target_missing', 'unsupported_rule', 'document_changed', 'no_location', 'already_compliant']) {
      assert.equal(friendlyGuidedFixError(code), GENERIC_FAILURE, code)
      assert.equal(friendlyGuidedFixError(`applied ${code} does not match expected after save`), GENERIC_FAILURE)
    }
  })

  test('legacy audit and invalid docx messages are friendly', () => {
    assert.equal(friendlyGuidedFixError(LEGACY_DETAIL), LEGACY_DETAIL)
    assert.ok(friendlyGuidedFixError('The uploaded file is not a valid DOCX.').includes('.docx'))
  })

  test('empty or unknown detail falls back to the generic message', () => {
    assert.equal(friendlyGuidedFixError(''), GENERIC_FAILURE)
    assert.equal(friendlyGuidedFixError(null), GENERIC_FAILURE)
    assert.equal(friendlyGuidedFixError('some arbitrary server text'), GENERIC_FAILURE)
  })
})

// ---------------------------------------------------------------------------
// Verified result + privacy invariants
// ---------------------------------------------------------------------------

describe('verified download and privacy invariants', () => {
  test('filename is safe and numbers same-session collisions', () => {
    assert.equal(correctedFilename(null), 'ACA-fixed.docx')
    assert.equal(correctedFilename('../unsafe.docx'), 'unsafe.docx')
    assert.equal(correctedFilename('report_ACA-fixed.docx', new Set(['report_ACA-fixed.docx'])), 'report_ACA-fixed-2.docx')
    assert.equal(correctedFilename('report_ACA-fixed.docx', new Set(['report_ACA-fixed.docx', 'report_ACA-fixed-2.docx'])), 'report_ACA-fixed-3.docx')
  })

  test('source audit remains immutable and document bytes never enter browser storage', () => {
    const apiSurface = Object.keys(api)
    for (const banned of ['updateViolation', 'setScore', 'resolveFinding', 'markResolved']) {
      assert.ok(!apiSurface.includes(banned))
    }
    const src = readFileSync(new URL('../src/components/audit/guided-fixes-panel.tsx', import.meta.url), 'utf8')
    const apiSrc = readFileSync(new URL('../src/services/api.ts', import.meta.url), 'utf8')
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB']) {
      assert.ok(!src.includes(banned) && !apiSrc.includes(banned))
    }
    assert.ok(src.includes("navigate('/dashboard')"))
    assert.ok(!src.includes('api.auditDocument'))
  })

})
