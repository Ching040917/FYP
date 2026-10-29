import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the complete production component with a deterministic hook scheduler.
// JSX is retained as an element tree; these are handler/state tests, not DOM/focus proof.
const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/components/audit/guided-fixes-panel.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText


class ApiRequestError extends Error {
  constructor(message, status) { super(message); this.status = status }
}
function harness(options = {}) {
  const slots = []
  let cursor = 0
  let dirty = false
  let effects = []
  let tree
  let auditId = 'audit-A'
  const downloads = []
  const calls = []
  const reviewRequests = []
  const writes = []
  const pending = []
  let reviewPending = null
  let applyPending = null
  const finding = { id: 'finding', rule_code: 'ALIGNMENT', severity: 'MINOR', location: { paragraph_index: 0 }, actual_value: 'left', expected_value: 'center', message: 'Alignment' }
  const findings = options.findings ?? [finding]
  const review = options.review ?? { review_id: 'review', items: [{ violation_id: 'finding', before: 'Left', after: 'Center', affected_count: 1, locations: ['Paragraph 1'], property: 'alignment' }], output_filename: 'audit-A.docx', limitations: [], expires_at: '2099-01-01' }
  let generation = 0
  const api = {
    cancelGuidedFixReview: async () => { calls.push('cancel') },
    reviewGuidedFixes: (_auditId, _file, ids) => {
      reviewRequests.push(ids)
      return reviewPending?.promise ?? Promise.resolve(review)
    },
    applyGuidedFixes: () => applyPending?.promise ?? Promise.resolve({ status: 'passed', resolved: findings.map(v => v.id), new_findings: [], before_findings: options.summaries ?? [], after_findings: [], download_token: `token-${++generation}`, output_filename: `${auditId}.docx`, expires_at: '2099-01-01' }),
    downloadGuidedFix: (id, token) => {
      calls.push(`${id}/${token}`)
      const next = Promise.withResolvers()
      pending.push(next)
      return next.promise
    },
  }
  function effect(fn, deps) {
    const index = cursor++
    const old = slots[index]
    if (!old || !deps || deps.some((value, i) => value !== old.deps[i])) {
      effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() } })
    }
  }
  const hooks = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value) => {
        writes.push(value)
        const next = typeof value === 'function' ? value(slots[index]) : value
        if (next !== slots[index]) { slots[index] = next; dirty = true }
      }]
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useMemo(fn) { cursor++; return fn() },
    useId() { const index = cursor++; return slots[index] ??= `fixture-${index}` },
    useEffect: effect,
    useLayoutEffect: effect,
  }
  const exports = {}
  vm.runInNewContext(compiled, {
    exports, requestAnimationFrame: () => 1,
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'fragment' }
      if (name === 'react-dom') return { createPortal: (node) => node }
      if (name === 'react-router-dom') return { useNavigate: () => () => undefined }
      if (name.includes('services/api')) return { api, ApiRequestError, downloadBlob: (...args) => downloads.push(args) }
      if (name.includes('lib/guided-fixes')) return require('../src/lib/guided-fixes.ts')
      if (name.includes('lib/friendly-finding')) return require('../src/lib/friendly-finding.ts')
      if (name.includes('lib/utils')) return { cn: () => '' }
      return new Proxy({}, { get: (_, key) => String(key) })
    },
  })
  function element(type, props) { return { type, props } }
  function render() {
    do {
      dirty = false; cursor = 0; effects = []
      tree = exports.GuidedFixesPanel({ auditId, violations: findings })
      for (const run of effects) run()
    } while (dirty)
  }
  function nodes(node = tree) {
    if (node == null || typeof node === 'boolean') return []
    if (Array.isArray(node)) return node.flatMap(n => nodes(n ?? null))
    if (typeof node !== 'object') return []
    return [node, ...nodes(node.props?.children ?? null)]
  }
  function text(node = tree) {
    if (node == null || typeof node === 'boolean') return ''
    if (Array.isArray(node)) return node.map(n => text(n ?? null)).join(' ')
    return typeof node === 'object' ? text(node.props?.children ?? null) : String(node)
  }
  function button(label) {
    const node = nodes().find(n => n.type === 'Button' && (n.props['aria-label'] === label || text(n).trim() === label))
    assert.ok(node, `Missing button ${label}: ${text()}`)
    return node.props
  }
  function click(label) { const result = button(label).onClick(); render(); return result }
  async function flush() {
    const { promise, resolve } = Promise.withResolvers()
    setImmediate(resolve)
    await promise
    render()
  }
  async function ready(stopAtReview = false) {
    click('Guided Fixes Beta')
    click('Select all candidates in this view')
    click(`Review ${findings.length} selected ${findings.length === 1 ? 'finding' : 'findings'}`)
    nodes().find(n => n.props?.id === 'guided-fixes-file-input').props.onChange({ target: { files: [{ name: 'source.docx' }] } }); render()
    click('Review safety and locations'); await flush()
    if (stopAtReview) return
    click('Apply and verify changes'); await flush()
  }
  render()
  return {
    ready, click, button, text, flush, pending, downloads, calls, writes,
    reviewRequests,
    selection() { click('Guided Fixes Beta'); click('Select all candidates in this view'); return text().replace(/\s+/g, ' ').trim() },
    live() { return nodes().filter(node => node.props?.role === 'status' || node.props?.['aria-live']).map(text).filter(value => value.trim()) },
    switchAudit() { auditId = 'audit-B'; render() },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
    deferReview() { reviewPending = Promise.withResolvers(); return reviewPending },
    deferApply() { applyPending = Promise.withResolvers(); return applyPending },
    review,
  }
}

test('stale Download for audit A cannot download or overwrite audit B', async () => {
  const h = harness(); await h.ready()
  h.click('Download corrected document'); h.switchAudit()
  const before = h.text()
  const writesBefore = h.writes.length
  h.pending[0].resolve(new Blob(['old'])); await h.flush()
  assert.equal(h.downloads.length, 0)
  assert.equal(h.text(), before)
  assert.equal(h.writes.length, writesBefore, 'stale success/finally must not write any state or announcement')
  assert.doesNotMatch(h.text(), /audit-A.docx|Downloaded|Downloading audit-A/)
  await h.ready()
  h.click('Download corrected document'); h.pending[1].resolve(new Blob(['current'])); await h.flush()
  assert.equal(h.downloads.length, 1)
  assert.equal(h.downloads[0][1], 'audit-B.docx')
})

for (const action of ['close', 'unmount', 'new review', 'new apply']) {
  test(`delayed Download is ignored after ${action}`, async () => {
    const h = harness(); await h.ready(); h.click('Download corrected document')
    if (action === 'unmount') h.unmount()
    else {
      h.click('Close')
      if (action === 'new review' || action === 'new apply') {
        const gate = action === 'new review' ? h.deferReview() : h.deferApply()
        await h.ready(action === 'new review')
        assert.ok(gate)
      }
    }
    const before = h.text()
    const writesBefore = h.writes.length
    h.pending[0].resolve(new Blob(['stale'])); await h.flush()
    assert.equal(h.downloads.length, 0)
    assert.equal(h.text(), before)
    assert.equal(h.writes.length, writesBefore)
    assert.doesNotMatch(h.text(), /Downloaded\. The one-use/)
  })
}

test('older Download settling last cannot disturb a newer Download or filename', async () => {
  const h = harness(); await h.ready(); h.click('Download corrected document'); h.click('Close')
  await h.ready(); h.click('Download corrected document')
  h.pending[1].resolve(new Blob(['new'])); await h.flush()
  const before = h.text()
  h.pending[0].reject(new ApiRequestError('expired old request', 410)); await h.flush()
  assert.equal(h.text(), before)
  assert.equal(h.downloads.length, 1)
  assert.match(h.text(), /Downloaded\. The one-use/)
  assert.doesNotMatch(h.text(), /unavailable or expired/)
})

test('same-context Download is single-flight and succeeds exactly once', async () => {
  const h = harness(); await h.ready()
  const handler = h.button('Download corrected document').onClick
  handler(); handler(); await h.flush()
  assert.equal(h.pending.length, 1)
  h.pending[0].resolve(new Blob(['valid'])); await h.flush()
  assert.equal(h.downloads.length, 1)
  assert.equal(h.button('Download corrected document').disabled, true)
  assert.match(h.text(), /Downloaded\. The one-use link has expired/)
})

test('current Download failure remains recoverable; stale errors cannot overwrite newer review', async () => {
  const h = harness(); await h.ready(); h.click('Download corrected document')
  h.pending[0].reject(new Error('connection interrupted')); await h.flush()
  assert.match(h.text(), /verified download is unavailable or expired/)
  assert.equal(h.button('Download corrected document').disabled, false)
  h.click('Download corrected document'); h.click('Close'); await h.ready()
  const before = h.text()
  h.pending[1].reject(new ApiRequestError('gone', 410)); await h.flush()
  assert.equal(h.text(), before)
  assert.equal(h.downloads.length, 0)
})

test('old success cannot clear a newer pending Download busy state', async () => {
  const h = harness(); await h.ready(); h.click('Download corrected document'); h.click('Close')
  await h.ready(); h.click('Download corrected document')
  const writesBefore = h.writes.length
  h.pending[0].resolve(new Blob(['old'])); await h.flush()
  assert.equal(h.writes.length, writesBefore)
  assert.equal(h.downloads.length, 0)
  assert.equal(h.button('Downloading…').disabled, true)
  h.pending[1].resolve(new Blob(['current'])); await h.flush()
  assert.equal(h.downloads.length, 1)
})

for (const status of [404, 410]) {
  test(`consumed or expired Download (${status}) does not claim success or resumability`, async () => {
    const h = harness(); await h.ready(); h.click('Download corrected document')
    h.pending[0].reject(new ApiRequestError('unavailable', status)); await h.flush()
    assert.equal(h.downloads.length, 0)
    assert.match(h.text(), /verified download is unavailable or expired/)
    assert.doesNotMatch(h.text(), /Downloaded\. The one-use/)
    assert.equal(h.button('Download corrected document').disabled, true)
    h.click('Close'); await h.ready()
    assert.equal(h.button('Download corrected document').disabled, false)
  })
}

for (const operation of ['review', 'apply']) {
  test(`existing stale ${operation} response remains ignored after audit switch`, async () => {
    const h = harness()
    const gate = operation === 'review' ? h.deferReview() : h.deferApply()
    await h.ready(operation === 'review'); h.switchAudit()
    const before = h.text()
    gate.resolve(operation === 'review' ? h.review : { resolved: ['finding'], new_findings: [], download_token: 'old' })
    await h.flush()
    assert.equal(h.text(), before)
    assert.equal(h.downloads.length, 0)
  })
}

test('Download announcements are current during pending and reset after close and reopen', async () => {
  for (const complete of [false, true]) {
    const h = harness(); await h.ready()
    h.click('Download corrected document')
    assert.deepEqual(h.live(), ['Downloading…'])
    if (complete) {
      h.pending[0].resolve(new Blob(['current'])); await h.flush()
      assert.equal(h.downloads.length, 1)
      assert.deepEqual(h.live(), ['Downloaded. The one-use link has expired.'])
    }
    h.click('Close')
    if (!complete) {
      h.pending[0].resolve(new Blob(['stale'])); await h.flush()
      assert.equal(h.downloads.length, 0)
    }
    h.click('Guided Fixes Beta')
    assert.doesNotMatch(h.live().join(' '), /Downloading|Downloaded|Download is now available|re-audit passed|audit-A\.docx/)
    assert.doesNotMatch(h.text(), /Filename:|verified download is unavailable/)
    assert.equal(h.button('Review 0 selected findings').disabled, true)
  }
})

test('old Download success and finally cannot clear a newer pending or terminal announcement', async () => {
  const h = harness(); await h.ready()
  h.click('Download corrected document'); h.click('Close')
  await h.ready(); h.click('Download corrected document')
  assert.deepEqual(h.live(), ['Downloading…'])
  h.pending[0].resolve(new Blob(['stale'])); await h.flush()
  assert.deepEqual(h.live(), ['Downloading…'])
  h.pending[1].resolve(new Blob(['current'])); await h.flush()
  assert.deepEqual(h.live(), ['Downloaded. The one-use link has expired.'])
  assert.equal(h.downloads.length, 1)
})

test('current failure ends pending announcement without replaying it into a new Review', async () => {
  const h = harness(); await h.ready()
  h.click('Download corrected document')
  assert.deepEqual(h.live(), ['Downloading…'])
  h.pending[0].reject(new Error('interrupted')); await h.flush()
  assert.doesNotMatch(h.live().join(' '), /Downloading/)
  assert.match(h.text(), /verified download is unavailable or expired/)
  h.click('Close')
  await h.ready(true)
  assert.match(h.live().join(' '), /Safety review passed/)
  assert.doesNotMatch(h.live().join(' '), /Downloading|Download is now available/)
  h.click('Apply and verify changes'); await h.flush()
  assert.match(h.text(), /Fix applied; re-audit passed/)
  assert.equal(h.button('Download corrected document').disabled, false)
})

test('audit switch and duplicate activation do not duplicate or contaminate live status', async () => {
  const h = harness(); await h.ready()
  const download = h.button('Download corrected document').onClick
  download(); download(); await h.flush()
  assert.equal(h.pending.length, 1)
  assert.deepEqual(h.live(), ['Downloading…'])
  h.switchAudit()
  h.click('Guided Fixes Beta')
  const before = h.live()
  h.pending[0].resolve(new Blob(['old audit'])); await h.flush()
  assert.deepEqual(h.live(), before)
  assert.doesNotMatch(h.live().join(' '), /Downloading|Downloaded|Download is now available/)
  assert.equal(h.downloads.length, 0)
})

const fontFinding = (id, paragraph, runs) => ({
  id, rule_code: 'FONT_CONSISTENCY', severity: 'MINOR',
  location: { paragraph_index: paragraph, run_index: runs[0], run_indexes: runs },
  actual_value: 'Calibri', expected_value: 'Times New Roman', message: 'Synthetic font finding',
})

for (const [name, findings, locations] of [
  ['single finding', [fontFinding('a', 0, [0])], 1],
  ['one grouped finding', [fontFinding('a', 0, [0, 1])], 2],
  ['two single-location findings', [fontFinding('a', 0, [0]), fontFinding('b', 1, [0])], 2],
  ['two grouped findings', [fontFinding('a', 0, [0, 1]), fontFinding('b', 1, [0, 1, 2])], 5],
  ['two properties sharing target locations', [fontFinding('a', 0, [0, 1]), { ...fontFinding('b', 0, [0, 1]), rule_code: 'FONT_SIZE' }], 2],
]) {
  test(`rendered grouped wording: ${name} in selection, Review and verified result`, async () => {
    const review = {
      review_id: 'review', output_filename: 'source_corrected.docx', limitations: [], expires_at: '2099-01-01',
      items: findings.map(v => ({ violation_id: v.id, before: v.actual_value, after: v.expected_value,
        affected_count: v.location.run_indexes.length, locations: [`Paragraph ${v.location.paragraph_index + 1}`], property: v.rule_code })),
    }
    const summaries = findings.map(v => ({ rule_code: v.rule_code, count: v.location.run_indexes.length,
      locations: v.location.run_indexes.map(() => `Paragraph ${v.location.paragraph_index + 1}`) }))
    const h = harness({ findings, review, summaries })
    const noun = findings.length === 1 ? 'finding' : 'findings'
    const location = `${locations} affected ${locations === 1 ? 'location' : 'locations'}`
    assert.ok(h.selection().includes(`${findings.length} ${noun} selected · ${location}`))
    assert.equal(h.button(`Review ${findings.length} selected ${noun}`).disabled, false)
    h.click('Close Guided Fixes')
    await h.ready(true)
    assert.ok(h.text().replace(/\s+/g, ' ').includes(`Safety review passed for ${findings.length} selected ${noun} · ${location}`))
    assert.deepEqual(h.reviewRequests, [findings.map(v => v.id)])
    h.click('Apply and verify changes'); await h.flush()
    const result = h.text().replace(/\s+/g, ' ')
    assert.ok(result.includes(`${findings.length} selected ${noun} resolved · ${location} · No new findings.`))
    for (const summary of summaries) {
      assert.ok(result.includes(`1 finding · ${summary.count} ${summary.count === 1 ? 'occurrence' : 'occurrences'}`))
    }
    assert.doesNotMatch(result, /Paragraph 1, Paragraph 1/)
  })
}

for (const [name, location] of [
  ['missing', null], ['empty run list', { paragraph_index: 0, run_indexes: [] }],
  ['incomplete aggregate', { paragraph_index: 0, paragraph_indexes: [0], occurrences: 3, run_indexes: [0] }],
]) {
  test(`rendered selection keeps ${name} location quantity unavailable without changing candidate selection`, () => {
    const h = harness({ findings: [{ ...fontFinding('a', 0, [0]), location }] })
    assert.ok(h.selection().includes('1 finding selected · Location count unavailable'))
    assert.equal(h.button('Review 1 selected finding').disabled, false)
    assert.doesNotMatch(h.text(), /0 affected locations/)
  })
}

test('rendered empty selection uses singular candidate grammar and does not invent a location quantity', () => {
  const h = harness()
  h.click('Guided Fixes Beta')
  assert.ok(h.text().includes('No findings selected · 1 candidate for safety review · Maximum 20'))
  assert.equal(h.button('Review 0 selected findings').disabled, true)
  assert.doesNotMatch(h.text(), /0 affected locations|1 candidates/)
})
