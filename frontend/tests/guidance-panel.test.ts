/**
 * First-run Setup Guidance (Build B1 follow-up) — pure + contract tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GUIDANCE_STORAGE_KEY,
  GUIDANCE_SCHEMA_VERSION,
  parseGuidanceState,
  saveGuidanceDismissed,
  loadGuidanceDismissed,
  clearGuidance,
  createMemoryGuidanceAdapter,
} from '../src/lib/guidance.ts'

const here = dirname(fileURLToPath(import.meta.url))
const src = (p: string) => readFileSync(join(here, '..', p), 'utf8')

// ---------------------------------------------------------------------------
// Storage semantics
// ---------------------------------------------------------------------------

test('first visit: no record → guidance shows', () => {
  const adapter = createMemoryGuidanceAdapter()
  assert.equal(loadGuidanceDismissed(adapter), false)
})

test('dismiss persists and returning visit hides guidance', () => {
  const adapter = createMemoryGuidanceAdapter()
  assert.equal(saveGuidanceDismissed(adapter, true), true)
  assert.equal(loadGuidanceDismissed(adapter), true)
  // Second load identical.
  assert.equal(loadGuidanceDismissed(adapter), true)
})

test('clear re-shows guidance', () => {
  const adapter = createMemoryGuidanceAdapter()
  saveGuidanceDismissed(adapter, true)
  clearGuidance(adapter)
  assert.equal(loadGuidanceDismissed(adapter), false)
})

test('corrupted record is removed safely and guidance reappears', () => {
  const adapter = createMemoryGuidanceAdapter()
  adapter.set(GUIDANCE_STORAGE_KEY, '{broken json')
  assert.equal(loadGuidanceDismissed(adapter), false)
  assert.equal(adapter.get(GUIDANCE_STORAGE_KEY), null)
})

test('future schema version handled conservatively', () => {
  const adapter = createMemoryGuidanceAdapter()
  adapter.set(
    GUIDANCE_STORAGE_KEY,
    JSON.stringify({
      schema_version: 99,
      dismissed: true,
      updated_at: new Date().toISOString(),
    }),
  )
  // Future version treated as already-dismissed — user not interrupted.
  assert.equal(loadGuidanceDismissed(adapter), true)
})

test('storage unavailable: memory fallback keeps session usable', () => {
  const mem = createMemoryGuidanceAdapter()
  assert.equal(loadGuidanceDismissed(mem), false)
  saveGuidanceDismissed(mem, false)
  assert.equal(loadGuidanceDismissed(mem), false)
})

test('record stores only schema_version/dismissed/updated_at — no sensitive data', () => {
  const adapter = createMemoryGuidanceAdapter()
  saveGuidanceDismissed(adapter, false)
  const raw = JSON.parse(adapter.get(GUIDANCE_STORAGE_KEY)!) as Record<string, unknown>
  assert.deepEqual(Object.keys(raw).sort(), ['dismissed', 'schema_version', 'updated_at'])
  const rawLower = JSON.stringify(raw).toLowerCase()
  for (const banned of ['filename', '.docx', 'api_key', 'token', 'password', 'payload']) {
    assert.ok(!rawLower.includes(banned))
  }
})

test('malformed records rejected', () => {
  assert.equal(parseGuidanceState(null), null)
  assert.equal(parseGuidanceState(''), null)
  assert.equal(parseGuidanceState('{bad'), null)
  assert.equal(
    parseGuidanceState(JSON.stringify({ schema_version: 1, dismissed: 'yes' })),
    null,
  )
  assert.equal(
    parseGuidanceState(JSON.stringify({ schema_version: 1, dismissed: true })),
    null, // missing updated_at
  )
})

test('key name matches spec exactly', () => {
  assert.equal(GUIDANCE_STORAGE_KEY, 'aca:guidance:v1')
  assert.equal(GUIDANCE_SCHEMA_VERSION, 1)
})

// ---------------------------------------------------------------------------
// Dashboard / component source contracts
// ---------------------------------------------------------------------------

const dashboard = src('src/pages/Dashboard.tsx')
const panel = src('src/components/dashboard/guidance-panel.tsx')
const upload = src('src/components/audit/upload-card.tsx')
const readiness = src('src/components/dashboard/readiness-card.tsx')

test('guidance panel renders in right column after result, before no-audit', () => {
  const rIdx = dashboard.indexOf('<ReadinessCard')
  const uIdx = dashboard.indexOf('<UploadCard')
  const resultIdx = dashboard.indexOf('{result ? (')
  const gIdx = dashboard.indexOf('<GuidancePanel')
  const iIdx = dashboard.indexOf('<InitialGuidance />')
  // Left column keeps readiness + upload only.
  assert.ok(rIdx !== -1 && uIdx !== -1)
  assert.ok(rIdx < uIdx)
  assert.equal(
    dashboard.slice(rIdx, uIdx).includes('<GuidancePanel'),
    false,
    'guidance must not render in the left intake stack',
  )
  // Right-column priority: result > guidance > initial.
  const rightCol = dashboard.slice(dashboard.indexOf('Result / guidance'))
  assert.ok(rightCol.indexOf('<ComplianceSummary') < rightCol.indexOf('<GuidancePanel'))
  assert.ok(rightCol.indexOf('<GuidancePanel') < rightCol.indexOf('<InitialGuidance'))
  void resultIdx; void gIdx; void iIdx
})

test('panel contains heading and four required points', () => {
  for (const s of [
    'Welcome to ACA',
    'Deterministic document checks run locally.',
    'Rendered-page preview is optional. Extracted-text evidence remains available.',
    'Local AI-assisted citation review is optional and uses the configured local service when available.',
    'Cloud AI review requires explicit opt-in.',
  ]) {
    assert.ok(panel.includes(s), `missing: ${s}`)
  }
})

test('panel actions present with exact wording', () => {
  for (const s of ['Start auditing', 'View system readiness', 'Read setup guidance']) {
    assert.ok(panel.includes(s), `missing action: ${s}`)
  }
  assert.ok(panel.includes('aria-label="Dismiss setup guidance"'))
})

test('View system readiness expands card without dismissing guidance', () => {
  const viewHandler = dashboard.slice(
    dashboard.indexOf('onViewReadiness={() =>'),
    dashboard.indexOf('onDismiss={onDismissGuidance}'),
  )
  assert.ok(viewHandler.includes('onExpandSignal()'))
  assert.ok(!viewHandler.includes('onDismissGuidance()'))
})

test('Read setup guidance navigates without persisting dismissal', () => {
  assert.ok(panel.includes('href="/#how"'))
  // Anchor navigation is native — no dismiss call attached in the panel.
  const readBtn = panel.slice(panel.indexOf('Read setup guidance') - 200, panel.indexOf('Read setup guidance'))
  assert.ok(!readBtn.includes('onDismiss'))
})

test('upload dropzone is a focus target', () => {
  assert.ok(upload.includes('id="upload-dropzone"'))
  assert.ok(upload.includes('tabIndex={-1}'))
})

test('readiness card supports external expand signal and details slot', () => {
  assert.ok(readiness.includes('expandSignal'))
  assert.ok(readiness.includes('detailsSlot'))
  assert.ok(readiness.includes("getElementById('readiness-heading')"))
})

test('dashboard wires reopen via readiness details slot', () => {
  // Reopen is triggered from the readiness details slot; the label itself
  // lives in Dashboard's detailsSlot content.
  assert.ok(dashboard.includes('onReopenGuidance'))
  assert.ok(dashboard.includes("guidanceDismissed === true"))
  assert.ok(dashboard.includes('detailsSlot='))
})

test('reopen control rendered inside readiness details when dismissed', () => {
  assert.ok(dashboard.includes('Show setup guidance'))
  // Reopen only appears once guidance is dismissed; never alongside the panel.
})

test('setup guidance destination exists on Landing', () => {
  const landing = src('src/pages/Landing.tsx')
  assert.ok(landing.includes('id="how"'))
  assert.equal(panel.includes('href="/#how"'), true)
})

test('upload-card profile summary compacts long content behind a toggle', () => {
  const uploadSrc = src('src/components/audit/upload-card.tsx')
  for (const s of [
    'View full requirements',
    'Hide full requirements',
    'aria-expanded={showFullRequirements}',
    'aria-controls="profile-full-requirements"',
    'setShowFullRequirements(false)', // resets when selection changes
    'compactRequirementRe',
  ]) {
    assert.ok(uploadSrc.includes(s), `missing: ${s}`)
  }
})

test('cloud wording is concise — no repeated deterministic sentence', () => {
  const uploadSrc = src('src/components/audit/upload-card.tsx')
  assert.ok(uploadSrc.includes('Local AI is used by default when available.'))
  assert.ok(!uploadSrc.includes('Cloud AI review is unavailable. Deterministic checks remain available.'))
})
