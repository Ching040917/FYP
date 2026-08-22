/**
 * Dashboard spec-panel removal — no stale margin spec remains.
 *
 * Proves the required change and that the authoritative profile summary
 * (UploadCard's Document requirements) stays available.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dashboardSrc = readFileSync(
  join(process.cwd(), 'src', 'pages', 'Dashboard.tsx'),
  'utf8',
)

test('Dashboard no longer contains "Current formatting specification"', () => {
  assert.ok(!dashboardSrc.includes('Current formatting specification'))
})

test('Dashboard no longer contains stale "Left margin" literals', () => {
  assert.ok(!dashboardSrc.includes('Left margin'))
})

test('Dashboard no longer contains the hardcoded "1.5″" margin value', () => {
  assert.ok(!dashboardSrc.includes('1.5″'))
})

test('Document requirements summary remains available via UploadCard', () => {
  const uploadSrc = readFileSync(
    join(process.cwd(), 'src', 'components', 'audit', 'upload-card.tsx'),
    'utf8',
  )
  assert.ok(uploadSrc.includes('Document requirements'))
})
