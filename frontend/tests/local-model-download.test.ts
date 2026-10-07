/**
 * Local AI Citation Guidance — local-model download tests.
 *
 * Pure logic (status validation, progress text, accessible labels, error
 * guidance) plus source-contract assertions, matching the repo's no-DOM
 * node:test convention. Rendering, keyboard access, widths, and axe are
 * asserted by the Playwright spec in e2e/setup-paths.spec.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  LOCAL_MODEL_COPY,
  NO_CANCEL_NOTICE,
  DOWNLOAD_POLL_INTERVAL_MS,
  adaptDownloadStatus,
  downloadErrorGuidance,
  downloadProgressText,
  formatBytes,
  isDownloadActive,
  progressAriaText,
} from '../src/lib/local-model-download.ts'
import { SETUP_COPY, modelNameFromDetail } from '../src/lib/setup-paths.ts'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')
const cardSrc = read('src/components/dashboard/readiness-card.tsx')
const panelSrc = read('src/components/dashboard/local-model-download-panel.tsx')
const apiSrc = read('src/services/api.ts')

function status(over: Record<string, unknown> = {}) {
  return {
    state: 'downloading',
    message: 'Downloading the Citation Guidance Model\u2026',
    model_name: 'qwen3.5:4b',
    bytes_completed: 400,
    bytes_total: 1000,
    percentage: 40,
    retryable: false,
    error_category: null,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 1/2/3. Optional scope, APA 7 in-text only, core-feature independence
// ---------------------------------------------------------------------------

test('the pathway is presented as an optional feature', () => {
  assert.equal(SETUP_COPY.optionalNote, 'Optional feature')
  assert.match(cardSrc, /\{SETUP_COPY\.optionalNote\}/)
})

test('the pathway names the feature and the model with approved terminology', () => {
  assert.equal(SETUP_COPY.model.title, 'Local AI Citation Guidance')
  assert.equal(SETUP_COPY.ollama.title, 'Local AI Citation Guidance')
  assert.equal(LOCAL_MODEL_COPY.modelLabel, 'Citation Guidance Model')
})

test('scope is APA 7 in-text citation formatting only', () => {
  assert.match(LOCAL_MODEL_COPY.scope, /APA 7 in-text citation formatting only/i)
  assert.match(cardSrc, /\{LOCAL_MODEL_COPY\.scope\}/)
})

test('scope states the model is not required for deterministic auditing', () => {
  assert.match(LOCAL_MODEL_COPY.scope, /not required for deterministic document auditing/i)
})

test('suggestions require human review', () => {
  assert.match(LOCAL_MODEL_COPY.accuracy, /may be incomplete or inaccurate/i)
  assert.match(LOCAL_MODEL_COPY.accuracy, /Review every suggestion before using it/i)
  assert.match(cardSrc, /\{LOCAL_MODEL_COPY\.accuracy\}/)
})

test('core features are named as available without Local AI', () => {
  const copy = LOCAL_MODEL_COPY.confirmReassurance
  for (const feature of [
    'deterministic audits',
    'rendered-page previews',
    'Guided Fixes',
    'PDF report export',
    'Audit History',
  ]) {
    assert.ok(copy.includes(feature), `missing ${feature}`)
  }
  assert.match(copy, /can skip this feature/i)
})

test('no unsupported AI claim appears in the download copy', () => {
  const all = JSON.stringify(LOCAL_MODEL_COPY)
  for (const forbidden of [
    'Full AI Review',
    'Academic AI Auditor',
    'Automatic Citation Fix',
    'Citation Verification',
    'Reference Validator',
    'plagiarism',
    'guaranteed',
  ]) {
    assert.ok(!all.includes(forbidden), `copy claims ${forbidden}`)
  }
})

test('no download size is invented', () => {
  assert.equal(LOCAL_MODEL_COPY.sizeValue, 'Check model information')
  assert.ok(!/\d\s*(GB|MB|gigabyte)/i.test(JSON.stringify(LOCAL_MODEL_COPY)))
})

// ---------------------------------------------------------------------------
// 4/5. Confirmation is required before anything is sent
// ---------------------------------------------------------------------------

test('the download action opens the confirmation instead of starting a job', () => {
  // The pathway button calls onRequest (opens the dialog); it never calls the
  // start API directly.
  assert.match(cardSrc, /onClick=\{downloadUi\.onRequest\}/)
  assert.match(cardSrc, /onConfirm=\{\(\) => void startDownload\(\)\}/)
})

test('the start API is only reachable through startDownload', () => {
  const calls = apiSrc.match(/startLocalModelDownload/g) ?? []
  assert.equal(calls.length, 1, 'exactly one client method definition')
  // In the card, the only start call is inside the confirmed handler.
  const cardCalls = cardSrc.match(/api\.startLocalModelDownload\(\)/g) ?? []
  assert.equal(cardCalls.length, 1)
  const startFn = cardSrc.slice(cardSrc.indexOf('const startDownload = React.useCallback'))
  assert.ok(startFn.indexOf('api.startLocalModelDownload()') < startFn.indexOf('}, [downloadBusy'))
})

test('confirmation copy carries the mandated wording', () => {
  assert.equal(LOCAL_MODEL_COPY.confirmTitle, 'Download Optional Citation Guidance Model?')
  assert.match(LOCAL_MODEL_COPY.confirmIntro, /only to provide suggestions for APA 7/i)
  assert.equal(LOCAL_MODEL_COPY.confirmStart, 'Start download')
  assert.equal(LOCAL_MODEL_COPY.confirmCancel, 'Not now')
})

test('confirmation warns about internet, storage, time, and hardware', () => {
  assert.match(LOCAL_MODEL_COPY.confirmCost, /internet connection/i)
  assert.match(LOCAL_MODEL_COPY.confirmCost, /several gigabytes of storage/i)
  assert.match(LOCAL_MODEL_COPY.confirmCost, /may take some time/i)
  assert.match(LOCAL_MODEL_COPY.confirmHardware, /memory and processor/i)
  assert.match(LOCAL_MODEL_COPY.confirmHardware, /limited memory may run slowly/i)
  // No RAM minimum is ever stated.
  assert.ok(!/\d+\s*(GB|MB)\s*(of\s*)?RAM/i.test(LOCAL_MODEL_COPY.confirmHardware))
})

test('the dialog reuses the accessible ConfirmDialog with detail content', () => {
  assert.match(cardSrc, /<ConfirmDialog/)
  assert.match(cardSrc, /details=\{/)
})

// ---------------------------------------------------------------------------
// 6/7. Status validation
// ---------------------------------------------------------------------------

test('a valid payload adapts', () => {
  const parsed = adaptDownloadStatus(status())
  assert.ok(parsed)
  assert.equal(parsed.state, 'downloading')
  assert.equal(parsed.model_name, 'qwen3.5:4b')
  assert.equal(parsed.percentage, 40)
})

test('malformed and hostile payloads are rejected outright', () => {
  assert.equal(adaptDownloadStatus(null), null)
  assert.equal(adaptDownloadStatus('ready'), null)
  assert.equal(adaptDownloadStatus([]), null)
  assert.equal(adaptDownloadStatus({}), null)
  // Unknown state never silently becomes completed.
  assert.equal(adaptDownloadStatus(status({ state: 'cancelled' })), null)
  assert.equal(adaptDownloadStatus(status({ state: 'done' })), null)
  assert.equal(adaptDownloadStatus(status({ message: '' })), null)
  assert.equal(adaptDownloadStatus(status({ model_name: '' })), null)
  assert.equal(adaptDownloadStatus(status({ model_name: 7 })), null)
  // Out-of-range or negative numbers are rejected, never clamped silently.
  assert.equal(adaptDownloadStatus(status({ percentage: 140 })), null)
  assert.equal(adaptDownloadStatus(status({ percentage: -1 })), null)
  assert.equal(adaptDownloadStatus(status({ bytes_completed: -5 })), null)
  assert.equal(adaptDownloadStatus(status({ error_category: 'secret' })), null)
})

test('null byte and percentage values stay null', () => {
  const parsed = adaptDownloadStatus(
    status({ bytes_completed: null, bytes_total: null, percentage: null }),
  )
  assert.ok(parsed)
  assert.equal(parsed.bytes_completed, null)
  assert.equal(parsed.bytes_total, null)
  assert.equal(parsed.percentage, null)
})

test('retryable defaults to false unless explicitly true', () => {
  assert.equal(adaptDownloadStatus(status())!.retryable, false)
  assert.equal(adaptDownloadStatus(status({ retryable: 'yes' }))!.retryable, false)
  assert.equal(adaptDownloadStatus(status({ retryable: true }))!.retryable, true)
})

test('active vs terminal states drive polling', () => {
  for (const s of ['starting', 'waiting_for_ollama', 'downloading', 'verifying']) {
    assert.equal(isDownloadActive(adaptDownloadStatus(status({ state: s }))), true, s)
  }
  for (const s of ['idle', 'completed', 'failed', 'disconnected']) {
    assert.equal(isDownloadActive(adaptDownloadStatus(status({ state: s }))), false, s)
  }
  assert.equal(isDownloadActive(null), false)
})

test('polling interval is about one second', () => {
  assert.equal(DOWNLOAD_POLL_INTERVAL_MS, 1000)
})

// ---------------------------------------------------------------------------
// 8/9/10. Progress display and accessible semantics
// ---------------------------------------------------------------------------

test('a missing percentage yields indeterminate progress text', () => {
  const parsed = adaptDownloadStatus(
    status({ bytes_completed: 4096, bytes_total: null, percentage: null }),
  )!
  assert.equal(downloadProgressText(parsed), '4.1 kB downloaded')
  assert.match(progressAriaText(parsed), /progress unknown/i)
})

test('valid completed over total yields a percentage', () => {
  const parsed = adaptDownloadStatus(status())!
  assert.equal(downloadProgressText(parsed), '400 bytes of 1.0 kB downloaded (40%)')
  assert.match(progressAriaText(parsed), /40% complete/)
})

test('byte formatting is human-readable and never negative', () => {
  assert.equal(formatBytes(0), '0 bytes')
  assert.equal(formatBytes(999), '999 bytes')
  assert.equal(formatBytes(1000), '1.0 kB')
  assert.equal(formatBytes(3389983735), '3.4 GB')
  assert.equal(formatBytes(null), '')
  assert.equal(formatBytes(-1), '')
})

test('progressbar semantics exist and omit aria-valuenow when indeterminate', () => {
  assert.match(panelSrc, /role="progressbar"/)
  assert.match(panelSrc, /aria-valuemin=\{0\}/)
  assert.match(panelSrc, /aria-valuemax=\{100\}/)
  assert.match(panelSrc, /aria-valuenow=\{determinate \? percentage : undefined\}/)
  assert.match(panelSrc, /aria-valuetext=\{progressAriaText\(status\)\}/)
})

test('state changes are announced but byte updates are not', () => {
  assert.match(panelSrc, /role="status"/)
  assert.match(panelSrc, /aria-live="polite"/)
  // The live region carries the state message only; the byte line is outside it.
  const liveRegion = panelSrc.slice(
    panelSrc.indexOf('aria-live="polite"'),
    panelSrc.indexOf('aria-live="polite"') + 400,
  )
  assert.ok(!liveRegion.includes('progressText'))
})

// ---------------------------------------------------------------------------
// 11/12/13. Completion, failure, retry, fallback
// ---------------------------------------------------------------------------

test('completion refreshes readiness', () => {
  assert.match(cardSrc, /next\?\.state === 'completed'\) void fetchReadiness\(true\)/)
})

test('failure shows safe guidance per category, never provider text', () => {
  const categories = [
    'ollama_unavailable',
    'ollama_error',
    'ollama_disconnected',
    'stalled',
    'verification_failed',
    'malformed_response',
    'unsupported_host',
    'unknown',
  ] as const
  for (const c of categories) {
    const guidance = downloadErrorGuidance(c)
    assert.ok(guidance.length > 0, c)
    assert.ok(!/https?:\/\//.test(guidance), c)
    assert.ok(!/sha256|digest|registry|\\\\/.test(guidance), c)
  }
  assert.equal(
    downloadErrorGuidance(null),
    downloadErrorGuidance('unknown'),
  )
})

test('retry is offered only when the backend marked it retryable', () => {
  assert.match(panelSrc, /\{failed && status\.retryable \?/)
  assert.match(panelSrc, /\{LOCAL_MODEL_COPY\.retryAction\}/)
})

test('the manual command fallback remains rendered', () => {
  assert.match(cardSrc, /data-testid="model-command"/)
  assert.match(cardSrc, /SETUP_COPY\.model\.copyLabel/)
  assert.equal(
    modelNameFromDetail('Configured model: qwen3.5:4b'),
    'qwen3.5:4b',
  )
})

test('the model name shown is backend-sourced, never hardcoded', () => {
  assert.match(cardSrc, /downloadUi\.status\?\.model_name \?\? setup\.modelName \?\? null/)
  assert.ok(!/qwen3\.5/.test(cardSrc))
  assert.ok(!/qwen3\.5/.test(panelSrc))
})

// ---------------------------------------------------------------------------
// 14/15/16. Duplicate prevention, re-attachment, polling hygiene
// ---------------------------------------------------------------------------

test('a duplicate start is blocked while busy or already active', () => {
  assert.match(cardSrc, /if \(downloadBusy \|\| isDownloadActive\(download\)\) return/)
  assert.match(cardSrc, /disabled=\{downloadUi\.busy\}/)
})

test('status is queried once on mount to re-attach to a running job', () => {
  assert.match(cardSrc, /void refreshDownloadStatus\(\)/)
})

test('polling stops on terminal states and clears its timer', () => {
  assert.match(cardSrc, /if \(!isDownloadActive\(download\)\) return/)
  assert.match(cardSrc, /window\.clearTimeout\(pollTimerRef\.current\)/)
})

test('an in-flight status request is guarded', () => {
  assert.match(cardSrc, /if \(downloadPollRef\.current\) return null/)
})

// ---------------------------------------------------------------------------
// 17/18. No cancellation, no raw internals
// ---------------------------------------------------------------------------

test('no Cancel control exists anywhere in the download UI', () => {
  // No user-visible Cancel affordance and no cancellation plumbing — the
  // identifier NO_CANCEL_NOTICE is the honest notice, not a control.
  assert.ok(!/['"]Cancel['"]/.test(panelSrc), 'no Cancel label')
  assert.ok(!/>\s*Cancel\s*</.test(panelSrc), 'no Cancel button text')
  assert.ok(!/cancelDownload|cancel_download|cancelPull/.test(panelSrc))
  assert.ok(!/['"]Cancel['"]/.test(cardSrc), 'dialog dismiss is Not now, not Cancel')
  // The notice itself never uses the word "cancel".
  assert.ok(!/cancel/i.test(NO_CANCEL_NOTICE))
  // The only "cancel"-named thing is the confirmation's dismiss action.
  assert.equal(LOCAL_MODEL_COPY.confirmCancel, 'Not now')
  assert.ok(!/Cancelled|cancelled/.test(panelSrc))
})

test('the honest cannot-stop notice is shown', () => {
  assert.match(NO_CANCEL_NOTICE, /cannot reliably stop/i)
  assert.match(NO_CANCEL_NOTICE, /may continue downloading in the background/i)
  assert.match(panelSrc, /\{NO_CANCEL_NOTICE\}/)
})

test('no raw exception or backend text reaches the panel', () => {
  // The panel renders only the Backend's own safe message and static guidance.
  assert.match(panelSrc, /\{status\.message\}/)
  assert.match(panelSrc, /\{downloadErrorGuidance\(status\.error_category\)\}/)
  assert.ok(!/err\.message|error\.message|String\(e|console\./.test(panelSrc))
  assert.ok(!/catch \(/.test(panelSrc))
})

test('the start route is called without parameters', () => {
  assert.match(apiSrc, /async startLocalModelDownload\(\): Promise<void>/)
  assert.match(apiSrc, /setup\/local-model\/download`,\r?\n\s+\{ method: 'POST' \}/)
})

test('a 409 is treated as already-running rather than an error', () => {
  assert.match(apiSrc, /if \(response\.status === 409\) return/)
})

test('the browser never contacts Ollama directly', () => {
  assert.ok(!/11434/.test(cardSrc))
  assert.ok(!/11434/.test(panelSrc))
  assert.ok(!/11434/.test(apiSrc))
  assert.ok(!/\/api\/pull/.test(apiSrc))
})
