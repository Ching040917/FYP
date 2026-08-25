import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isScoreAvailable, formatScore } from '../src/lib/score-display.ts'
import { createRequire } from 'node:module'
const requireNode = createRequire(import.meta.url)

test('isScoreAvailable: null -> false', () => {
  assert.equal(isScoreAvailable(null), false)
})
test('isScoreAvailable: undefined -> false', () => {
  assert.equal(isScoreAvailable(undefined), false)
})
test('isScoreAvailable: 0 -> true (legitimate zero)', () => {
  assert.equal(isScoreAvailable(0), true)
})
test('isScoreAvailable: normal score -> true', () => {
  assert.equal(isScoreAvailable(85), true)
  assert.equal(isScoreAvailable(100), true)
})

test('formatScore: null -> Unavailable', () => {
  assert.equal(formatScore(null), 'Unavailable')
})
test('formatScore: undefined -> Unavailable', () => {
  assert.equal(formatScore(undefined), 'Unavailable')
})
test('formatScore: 0 -> "0" not Unavailable', () => {
  assert.equal(formatScore(0), '0')
  assert.notEqual(formatScore(0), 'Unavailable')
})
test('formatScore: 92 -> "92"', () => {
  assert.equal(formatScore(92), '92')
})
test('formatScore: 100 -> "100"', () => {
  assert.equal(formatScore(100), '100')
})

// Source contract: AuditPage and HistoryPage use shared helper and consistent wording
test('AuditPage uses shared helper and shows Unavailable for null', () => {
  const src = requireNode('fs').readFileSync(requireNode('path').join(process.cwd(), 'src/pages/AuditPage.tsx'), 'utf8')
  assert.ok(src.includes("isScoreAvailable"), 'AuditPage should import isScoreAvailable')
  assert.ok(src.includes("Unavailable"), 'AuditPage should render Unavailable')
  // Ensure old direct {audit.weighted_score} without guard is removed — now guarded
  // Check that score rendering is conditional on isScoreAvailable
  assert.ok(src.includes('isScoreAvailable(audit.weighted_score)'), 'AuditPage conditional on isScoreAvailable')
})

test('HistoryPage ScoreCell uses shared helper', () => {
  const src = requireNode('fs').readFileSync(requireNode('path').join(process.cwd(), 'src/pages/HistoryPage.tsx'), 'utf8')
  assert.ok(src.includes('isScoreAvailable'), 'HistoryPage should import isScoreAvailable')
  assert.ok(src.includes('!isScoreAvailable(score)'), 'HistoryPage ScoreCell should use helper')
  assert.ok(src.includes('Unavailable'), 'HistoryPage should show Unavailable')
})

test('HistoryPage ScoreCell handles 0 correctly (source check for == null not falsy)', () => {
  // Ensure ScoreCell does not use score == falsy check that would treat 0 as missing
  const src = requireNode('fs').readFileSync(requireNode('path').join(process.cwd(), 'src/pages/HistoryPage.tsx'), 'utf8')
  // After fix, the line should be !isScoreAvailable(score), not score == null alone would be okay but helper is stronger
  // Ensure no `!score` or `score ||` pattern that would mis-handle 0
  const scoreCellChunk = src.slice(src.indexOf('function ScoreCell'))
  assert.ok(!scoreCellChunk.includes('!score'), 'ScoreCell should not use !score (would treat 0 as missing)')
  assert.ok(!scoreCellChunk.includes('score ||'), 'ScoreCell should not use score ||')
})
