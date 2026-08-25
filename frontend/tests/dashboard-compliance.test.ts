import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const requireNode = createRequire(import.meta.url)

test('Dashboard renders ComplianceSummary exactly once when result exists', () => {
  const src = requireNode('fs').readFileSync(requireNode('path').join(process.cwd(), 'src/pages/Dashboard.tsx'), 'utf8')
  const matches = src.match(/<ComplianceSummary/g) || []
  assert.equal(matches.length, 1, `expected exactly one ComplianceSummary, found ${matches.length}`)
})

test('Dashboard keeps responsive layout and no duplicate InitialGuidance when result exists', () => {
  const src = requireNode('fs').readFileSync(requireNode('path').join(process.cwd(), 'src/pages/Dashboard.tsx'), 'utf8')
  // After fix, the duplicate block with InitialGuidance for result case should be gone.
  // There should be exactly one InitialGuidance usage? Actually there are two branches:
  // - guidanceDismissed !== true ? GuidancePanel : InitialGuidance (when no result)
  // So InitialGuidance appears only once in the result/guidance div, not duplicated.
  const guidanceMatches = src.match(/<InitialGuidance/g) || []
  // Original file had 2 InitialGuidance (one in first guidance div else, one in duplicate). After fix should be 1
  // Actually after fix, first div has InitialGuidance in else branch, total 1
  assert.equal(guidanceMatches.length, 1, `expected one InitialGuidance, found ${guidanceMatches.length}`)
})

test('Dashboard preserves intended summary placement (grid with Intake + Result)', () => {
  const src = requireNode('fs').readFileSync(requireNode('path').join(process.cwd(), 'src/pages/Dashboard.tsx'), 'utf8')
  assert.ok(src.includes('grid grid-cols-1'), 'should keep grid layout')
  assert.ok(src.includes('Intake — upload'), 'should preserve Intake comment')
  assert.ok(src.includes('Result / guidance'), 'should preserve Result / guidance comment')
  // Second duplicate comment should be gone
  assert.ok(!src.includes('Result — concise summary'), 'duplicate comment should be removed')
})
