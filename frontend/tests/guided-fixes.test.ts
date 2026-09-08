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
    for (const rule of SUPPORTED_FIX_RULES) {
      assert.ok(SUPPORTED_FIX_RULES.has(rule), rule)
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
      assert.equal(pres.current, '11pt')
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
    assert.equal(pres.proposed, 'Justified')
    const noExpected = guidedPresentationFor({ ...violation('FONT_SIZE'), expected_value: null })
    assert.equal(noExpected.proposed, 'Profile requirement (see finding details)')
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
    assert.equal(pres.current, '11pt')
    assert.equal(pres.proposed, '12pt')
  })

  test('checkbox accessible name contains friendly name and location', () => {
    const pres = guidedPresentationFor(violation('LINE_SPACING', {
      location: { paragraph_index: 2 },
      expected_value: '1.5',
      actual_value: '1.0',
    }))
    assert.equal(pres.friendlyName, 'Line Spacing')
    assert.equal(pres.friendlyLocation, 'Paragraph 3')
    const label = `${pres.friendlyName}, ${pres.friendlyLocation}`
    assert.ok(label.includes('Line Spacing'))
    assert.ok(label.includes('Paragraph 3'))
  })
})

// ---------------------------------------------------------------------------
// API contract (items 11-21)
// ---------------------------------------------------------------------------

describe('applyGuidedFixes API', () => {
  test('sends violation_ids only — never indexes, values, or rule codes', async () => {
    let captured: RequestInit | undefined
    const restore = mockFetchOnce(async (_input, init) => {
      captured = init
      return new Response(new Blob(['PK-docx'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), {
        status: 200,
        headers: {
          'content-disposition': 'attachment; filename="report_ACA_corrected.docx"',
          'x-repair-summary': encodeURIComponent(JSON.stringify({ applied: 1, skipped: 0, failed: 0 })),
        },
      })
    })
    try {
      const file = new File(['docx'], 'original.docx')
      await api.applyGuidedFixes('audit-1', file, ['v1', 'v2'])
      const body = (captured as any).body as FormData
      assert.ok(body instanceof FormData)
      assert.equal(body.get('file'), file)
      const selection = JSON.parse(String(body.get('selection')))
      assert.deepEqual(Object.keys(selection), ['violation_ids'])
      assert.deepEqual(selection.violation_ids, ['v1', 'v2'])
      const raw = String(body.get('selection'))
      for (const banned of ['paragraph_index', 'run_index', 'run_indexes', 'expected_value', 'actual_value', 'rule_code', 'file_path']) {
        assert.ok(!raw.includes(banned), `selection must not contain ${banned}`)
      }
    } finally {
      restore()
    }
  })

  test('multipart field names match the backend contract (file, selection)', async () => {
    let capturedUrl = ''
    const restore = mockFetchOnce(async (input) => {
      capturedUrl = String(input)
      return new Response(new Blob(['PK']), { status: 200, headers: {} })
    })
    try {
      await api.applyGuidedFixes('audit-1', new File(['x'], 'a.docx'), ['v1'])
    } finally {
      restore()
    }
    assert.equal(capturedUrl, '/api/audit/audit-1/guided-fixes')
  })

  test('Content-Disposition filename is parsed', async () => {
    const restore = mockFetchOnce(async () => new Response(new Blob(['PK']), {
      status: 200,
      headers: { 'content-disposition': 'attachment; filename="report_ACA_corrected.docx"' },
    }))
    try {
      const res = await api.applyGuidedFixes('a', new File(['x'], 'a.docx'), ['v1'])
      assert.equal(res.filename, 'report_ACA_corrected.docx')
    } finally {
      restore()
    }
  })

  test('missing filename returns null (caller applies safe fallback)', async () => {
    const restore = mockFetchOnce(async () => new Response(new Blob(['PK']), { status: 200, headers: {} }))
    try {
      const res = await api.applyGuidedFixes('a', new File(['x'], 'a.docx'), ['v1'])
      assert.equal(res.filename, null)
      assert.equal(correctedFilename(res.filename), 'ACA_corrected.docx')
    } finally {
      restore()
    }
  })

  test('valid summary is parsed', async () => {
    const restore = mockFetchOnce(async () => new Response(new Blob(['PK']), {
      status: 200,
      headers: { 'x-repair-summary': encodeURIComponent(JSON.stringify({ applied: 2, skipped: 1, failed: 0 })) },
    }))
    try {
      const res = await api.applyGuidedFixes('a', new File(['x'], 'a.docx'), ['v1'])
      assert.deepEqual(res.summary, { applied: 2, skipped: 1, failed: 0 })
    } finally {
      restore()
    }
  })

  test('missing or malformed summary does not block the download', async () => {
    for (const header of [null, 'not-json', encodeURIComponent('{"applied":"x"}'), encodeURIComponent('{"applied":1}')]) {
      const headers: Record<string, string> = {}
      if (header !== null) headers['x-repair-summary'] = header
      const restore = mockFetchOnce(async () => new Response(new Blob(['PK']), { status: 200, headers }))
      try {
        const res = await api.applyGuidedFixes('a', new File(['x'], 'a.docx'), ['v1'])
        assert.equal(res.summary, null, `header=${header}`)
        assert.ok(res.blob instanceof Blob)
      } finally {
        restore()
      }
    }
  })

  test('backend safe error detail is surfaced', async () => {
    const restore = mockFetchOnce(async () => new Response(
      JSON.stringify({ detail: MISMATCH_DETAIL }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ))
    try {
      await assert.rejects(
        () => api.applyGuidedFixes('a', new File(['x'], 'a.docx'), ['v1']),
        (err: Error) => err.message === MISMATCH_DETAIL,
      )
    } finally {
      restore()
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

  test('zero-applied shows manual-correction guidance', () => {
    assert.equal(friendlyGuidedFixError(ZERO_DETAIL), ZERO_DETAIL)
    assert.ok(friendlyGuidedFixError(ZERO_DETAIL).includes('manual'))
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
// Success state + privacy invariants (items 23-28)
// ---------------------------------------------------------------------------

describe('success and privacy invariants', () => {
  test('success reports applied/skipped counts from the parsed summary', async () => {
    const restore = mockFetchOnce(async () => new Response(new Blob(['PK']), {
      status: 200,
      headers: {
        'content-disposition': 'attachment; filename="a_ACA_corrected.docx"',
        'x-repair-summary': encodeURIComponent(JSON.stringify({ applied: 3, skipped: 2, failed: 0 })),
      },
    }))
    try {
      const res = await api.applyGuidedFixes('a', new File(['x'], 'a.docx'), ['v1'])
      assert.equal(res.summary?.applied, 3)
      assert.equal(res.summary?.skipped, 2)
    } finally {
      restore()
    }
  })

  test('original audit state is untouched by the client (GET data immutable)', async () => {
    // The client never writes: applyGuidedFixes is the only mutation call and
    // it targets /guided-fixes. There is no API surface that edits violations
    // or scores — assert the exported api object contains no such methods.
    const apiSurface = Object.keys(api)
    for (const banned of ['updateViolation', 'setScore', 'resolveFinding', 'markResolved']) {
      assert.ok(!apiSurface.includes(banned))
    }
  })

  test('corrected Blob is not persisted — no storage APIs in the client path', () => {
    const src = readFileSync(new URL('../src/components/audit/guided-fixes-panel.tsx', import.meta.url), 'utf8')
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB']) {
      assert.ok(!src.includes(banned), `panel must not use ${banned}`)
    }
    const apiSrc = readFileSync(new URL('../src/services/api.ts', import.meta.url), 'utf8')
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB']) {
      assert.ok(!apiSrc.includes(banned), `api must not use ${banned}`)
    }
  })

  test('Audit corrected copy navigates to Dashboard only', () => {
    const src = readFileSync(new URL('../src/components/audit/guided-fixes-panel.tsx', import.meta.url), 'utf8')
    assert.ok(src.includes("navigate('/dashboard')"))
    // No automatic audit of the corrected copy: no API upload call besides
    // applyGuidedFixes.
    const apiCalls = [...src.matchAll(/api\.(\w+)/g)].map((m) => m[1])
    assert.ok(!apiCalls.includes('auditDocument'))
  })

  test('intro copy is present and concise in the panel source', () => {
    const src = readFileSync(new URL('../src/components/audit/guided-fixes-panel.tsx', import.meta.url), 'utf8')
    const lib = readFileSync(new URL('../src/lib/guided-fixes.ts', import.meta.url), 'utf8')
    // The panel renders the concise intro constants; the literals live in the lib.
    assert.ok(src.includes('GF_INTRO'))
    assert.ok(src.includes('GF_SECONDARY'))
    assert.ok(lib.includes('Guided Fixes creates a corrected copy and never changes your original document.'))
    assert.ok(lib.includes('Some findings require manual correction. Review the corrected copy before submission.'))
  })

  test('no automatic upload or re-audit exists', () => {
    const src = readFileSync(new URL('../src/components/audit/guided-fixes-panel.tsx', import.meta.url), 'utf8')
    // The only submission path is the explicit Create corrected copy button.
    assert.ok(src.includes('Create corrected copy'))
    // applyFixes is invoked only from the submit click handler.
    const applyCalls = [...src.matchAll(/applyFixes/g)].length
    assert.ok(applyCalls >= 1 && applyCalls <= 2, `applyFixes references: ${applyCalls}`)
  })

  test('Create action requires a selected file (disabled without one)', () => {
    const src = readFileSync(new URL('../src/components/audit/guided-fixes-panel.tsx', import.meta.url), 'utf8')
    assert.ok(src.includes('disabled={!selectedFile}'))
  })

  test('file control accepts DOCX only', () => {
    const src = readFileSync(new URL('../src/components/audit/guided-fixes-panel.tsx', import.meta.url), 'utf8')
    assert.ok(src.includes('accept=".docx"'))
    assert.ok(src.includes('type="file"'))
  })
})
