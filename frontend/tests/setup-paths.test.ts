/**
 * Optional-component setup pathways — pure logic + source-contract tests.
 *
 * Covers: pathway gating per readiness state, exact official URLs, safe
 * external attributes, model command derivation from backend detail, and
 * the no-auto-execution contract (no download/install/execution calls).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OFFICIAL_URLS,
  SETUP_COPY,
  SETUP_COMPONENTS,
  EXTERNAL_LINK_ATTRS,
  isLibreOfficeMissing,
  isOllamaMissing,
  isModelMissing,
  modelNameFromDetail,
  modelInstallCommand,
} from '../src/lib/setup-paths.ts'

// --- 2/6. Exact approved official URLs -------------------------------------

test('LibreOffice URL is exactly the approved HTTPS URL', () => {
  assert.equal(OFFICIAL_URLS.libreoffice, 'https://www.libreoffice.org/download/')
})

test('Ollama URL is exactly the approved HTTPS URL', () => {
  assert.equal(OFFICIAL_URLS.ollama, 'https://ollama.com/download/windows')
})

test('official URLs are https and not shortened', () => {
  for (const u of Object.values(OFFICIAL_URLS)) {
    assert.ok(u.startsWith('https://'))
    assert.ok(!u.includes('bit.ly') && !u.includes('tinyurl'))
  }
})

// --- 1/5. Pathway gating -----------------------------------------------------

test('LibreOffice unavailable shows the download pathway', () => {
  assert.equal(isLibreOfficeMissing({ id: 'libreoffice', state: 'unavailable' }), true)
})

test('LibreOffice ready hides download guidance', () => {
  assert.equal(isLibreOfficeMissing({ id: 'libreoffice', state: 'ready' }), false)
})

test('LibreOffice unknown does not claim missing', () => {
  assert.equal(isLibreOfficeMissing({ id: 'libreoffice', state: 'unknown' }), false)
  assert.equal(isLibreOfficeMissing({ id: 'libreoffice', state: 'optional' }), false)
})

test('Ollama unavailable shows the download pathway', () => {
  assert.equal(isOllamaMissing({ id: 'ollama', state: 'unavailable' }), true)
})

test('Ollama ready hides download guidance', () => {
  assert.equal(isOllamaMissing({ id: 'ollama', state: 'ready' }), false)
})

test('Ollama unknown does not claim missing', () => {
  assert.equal(isOllamaMissing({ id: 'ollama', state: 'unknown' }), false)
})

test('model missing requires ollama ready (causal pair)', () => {
  const row = { id: 'local_model', state: 'unavailable', detail: 'Configured model: qwen3.5:4b' }
  assert.equal(isModelMissing(row, [{ id: 'ollama', state: 'ready' }]), true)
  // Ollama unreachable → model unknown upstream; never confirmed-missing here.
  assert.equal(isModelMissing(row, [{ id: 'ollama', state: 'unavailable' }]), false)
  // Model ready → nothing to install.
  assert.equal(
    isModelMissing(
      { id: 'local_model', state: 'ready', detail: 'Configured model: qwen3.5:4b' },
      [{ id: 'ollama', state: 'ready' }],
    ),
    false,
  )
})

// --- 8/9. Model command from authoritative backend detail --------------------

test('model name is parsed from backend detail, not hardcoded', () => {
  assert.equal(modelNameFromDetail('Configured model: qwen3.5:4b'), 'qwen3.5:4b')
  assert.equal(modelNameFromDetail('Configured model:  llama3 '), 'llama3')
})

test('unparseable detail yields no command (never guessed)', () => {
  assert.equal(modelNameFromDetail(null), null)
  assert.equal(modelNameFromDetail(''), null)
  assert.equal(modelNameFromDetail('some other detail'), null)
})

test('copy command contains the exact model command', () => {
  assert.equal(modelInstallCommand('qwen3.5:4b'), 'ollama pull qwen3.5:4b')
})

test('command is a shell command string, not a URL', () => {
  const cmd = modelInstallCommand('qwen3.5:4b')
  assert.ok(!cmd.includes('http'))
  assert.ok(cmd.startsWith('ollama pull '))
})

// --- 15. Safe external attributes --------------------------------------------

test('external links use safe attributes', () => {
  assert.equal(EXTERNAL_LINK_ATTRS.target, '_blank')
  assert.equal(EXTERNAL_LINK_ATTRS.rel, 'noopener noreferrer')
})

// --- Wording / security invariants --------------------------------------------

test('pathway copy states core audit remains available', () => {
  assert.match(SETUP_COPY.libreoffice.body, /deterministic audit checks/i)
  assert.match(SETUP_COPY.ollama.body, /deterministic audit checks/i)
})

test('model copy states optional, internet, time, storage, no auto-download', () => {
  const b = SETUP_COPY.model.body
  assert.match(b, /optional/i)
  assert.match(b, /internet access/i)
  assert.match(b, /substantial disk storage/i)
  assert.match(b, /does not start the download automatically/i)
})

test('third-party note discloses external terms and privacy', () => {
  assert.match(SETUP_COPY.thirdPartyNote, /terms and privacy policies/i)
})

// --- 16/17. Source contract: no execution, no untrusted URLs -------------------

const cardSrc = readFileSync(
  join(process.cwd(), 'src', 'components', 'dashboard', 'readiness-card.tsx'),
  'utf8',
)

test('no automatic installer, download, or command execution in the card', () => {
  assert.ok(!/exec\s*\(|spawn|child_process|Shell\.Execute|Start-Process/.test(cardSrc))
  assert.ok(!/\.msi|\.exe['"]|\.dmg/.test(cardSrc))
  assert.ok(!/window\.open\s*\(/.test(cardSrc))
  assert.ok(!/\bfetch\s*\(\s*OFFICIAL_URLS/.test(cardSrc))
})

test('official URLs are not taken from API/readiness data', () => {
  // URLs flow only from the constants file; detail is used for the model name only.
  assert.ok(cardSrc.includes('OFFICIAL_URLS.libreoffice'))
  assert.ok(cardSrc.includes('OFFICIAL_URLS.ollama'))
  assert.ok(!cardSrc.includes('OFFICIAL_URLS[row.id]'))
  assert.ok(!/row\.detail\s*===?\s*['"]http/.test(cardSrc))
})

test('clipboard API is used for copy with failure fallback kept visible', () => {
  assert.ok(cardSrc.includes('navigator.clipboard'))
  assert.match(cardSrc, /copyFailedLabel/)
  // command stays rendered (code element) regardless of copy state
  assert.ok(cardSrc.includes('data-testid="model-command"'))
})

test('copy feedback is announced via live region', () => {
  assert.match(cardSrc, /aria-live="polite"/)
})

test('Check again reuses the card readiness refresh', () => {
  assert.match(cardSrc, /onCheckAgain=\{\(\) => void fetchReadiness\(true\)\}/)
  assert.ok(cardSrc.includes('disabled={refreshing}'))
})

test('ready state does not render pathways (gating lives in setupPathwayFor)', () => {
  // setupPathwayFor returns null unless state === 'unavailable'
  assert.match(cardSrc, /row\.state !== 'unavailable'\) return null/)
})
