/**
 * Scenario 9 — Automated axe-core scans.
 *
 * Acceptance rule (task scope): NO critical or serious axe violations are
 * allowed on the five required routes. No rule is excluded globally; any
 * future narrow exclusion must be individually justified in code comments.
 */
import { test, expect } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { createSyntheticAudit, annotate } from './helpers'

const ROUTES = [
  { name: 'landing', path: '/' },
  { name: 'dashboard', path: '/dashboard' },
  { name: 'history', path: '/history' },
  { name: 'profile-editor', path: '/profiles/custom' },
] as const

async function assertNoCriticalOrSerious(page: import('@playwright/test').Page, label: string) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  )
  expect(
    blocking,
    `${label}: critical/serious axe violations found:\n${blocking
      .map((v) => `${v.id} (${v.impact}): ${v.help} — nodes: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`)
      .join('\n')}`,
  ).toEqual([])
}

test.describe('axe scans @axe', () => {
  for (const route of ROUTES) {
    test(`axe: ${route.name} has no critical or serious violations`, async ({ page }, testInfo) => {
      annotate(testInfo, {
        id: `AXE-${route.name.toUpperCase()}`,
        objective: `Automated axe scan of the ${route.name} view reports no critical or serious violations.`,
        precondition: 'App served at 127.0.0.1:5173 with isolated backend; synthetic data only.',
        steps: ['Open route', 'Run full axe-core scan', 'Filter impact=critical/serious'],
        expected: 'Zero critical and zero serious violations.',
        severity: 'high',
        notes: 'Rule of scope: any legitimate pre-existing critical/serious finding must fail here and be reported, never suppressed.',
      })
      await page.goto(route.path)
      await expectNoLoadError(page)
      await assertNoCriticalOrSerious(page, route.name)
    })
  }

  test('axe: completed audit view has no critical or serious violations', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'AXE-AUDIT',
      objective: 'Automated axe scan of a completed audit report view reports no critical or serious violations.',
      precondition: 'Synthetic audit created via API from the committed sample DOCX.',
      steps: ['Create synthetic audit via API', 'Open /audit/{id}', 'Wait for findings', 'Run axe scan'],
      expected: 'Zero critical and zero serious violations.',
      severity: 'high',
    })
    const summary = await createSyntheticAudit(page)
    await page.goto(`/audit/${summary.auditId}`)
    await page.waitForLoadState('networkidle')
    await assertNoCriticalOrSerious(page, 'completed-audit')
  })
})

async function expectNoLoadError(page: import('@playwright/test').Page) {
  await page.waitForLoadState('networkidle')
  const alert = page.locator('[role="alert"]').first()
  await expect(alert).toHaveCount(0)
}
