/**
 * Scenario 9 — Automated axe-core scans.
 *
 * Acceptance rule (task scope): NO critical or serious axe violations are
 * allowed on the five required routes. No rule is excluded globally; any
 * future narrow exclusion must be individually justified in code comments.
 */
import { test, expect } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { createSyntheticAudit, annotate } from './helpers'

const ROUTES = [
  { name: 'landing', path: '/' },
  { name: 'dashboard', path: '/dashboard' },
  { name: 'history', path: '/history' },
  { name: 'profile-editor', path: '/profiles/custom' },
] as const

async function assertNoCriticalOrSerious(page: Page, label: string, testInfo: TestInfo) {
  const results = await new AxeBuilder({ page }).analyze()
  await testInfo.attach(`${label}-axe.json`, {
    body: JSON.stringify({ violations: results.violations, incomplete: results.incomplete }, null, 2),
    contentType: 'application/json',
  })
  expect(results.violations.filter(v => v.id === 'heading-order'), `${label}: heading-order violations`).toEqual([])
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
        precondition: 'App served with isolated backend; synthetic data only.',
        steps: ['Open route', 'Run full axe-core scan', 'Filter impact=critical/serious'],
        expected: 'Zero critical and zero serious violations.',
        severity: 'high',
        notes: 'Rule of scope: any legitimate pre-existing critical/serious finding must fail here and be reported, never suppressed.',
      })
      await page.goto(route.path)
      await expectNoLoadError(page)
      await assertNoCriticalOrSerious(page, route.name, testInfo)
    })
  }

  test('axe: completed audit view has no critical or serious violations', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'AXE-AUDIT',
      objective: 'Scan the real sample Workspace extracted-text preview before and after selecting a finding.',
      precondition: 'Synthetic audit created via API from the committed sample DOCX.',
      steps: ['Open the completed audit', 'Show extracted text or its automatic fallback', 'Scan before and after selecting a document finding'],
      expected: 'Zero heading-order, critical and serious violations in both states.',
      severity: 'high',
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    const summary = await createSyntheticAudit(page)
    await page.goto(`/audit/${summary.auditId}`)
    await page.waitForLoadState('networkidle')

    const preview = page.locator('#ws-panel-preview')
    await expect(preview.getByText('Loading rendered preview…')).toHaveCount(0)
    const textMode = preview.getByRole('button', { name: 'Extracted text', exact: true })
    if (await textMode.isVisible()) await textMode.click()
    const document = preview.getByRole('region', { name: 'Document preview', exact: true })
    await expect(document).toBeVisible()
    await expect(document.getByRole('heading', { name: 'Literature Review', exact: true })).toBeVisible()
    await expect(document.getByRole('heading', { name: 'Deep Subsection', exact: true })).toBeVisible()

    const initial = await new AxeBuilder({ page }).analyze()
    await testInfo.attach('workspace-initial-axe.json', {
      body: JSON.stringify({ violations: initial.violations, incomplete: initial.incomplete }, null, 2),
      contentType: 'application/json',
    })

    const finding = document.getByRole('button').filter({ hasText: 'This paragraph uses Calibri instead of Times New Roman' })
    await expect(finding).toBeVisible()
    await finding.click()
    await expect(finding).toHaveAttribute('aria-pressed', 'true')
    const details = page.locator('#ws-panel-details')
    await expect(details).toContainText('Font family does not match')
    await expect(details.getByRole('heading', { name: 'What ACA found' })).toBeVisible()
    await expect(details).toContainText('Calibri')
    await expect(details.getByText('Current', { exact: true })).toBeVisible()
    await expect(details.getByText('Required', { exact: true })).toBeVisible()
    await expect(document).toBeVisible()

    const selected = await new AxeBuilder({ page }).analyze()
    await testInfo.attach('workspace-selected-finding-axe.json', {
      body: JSON.stringify({ violations: selected.violations, incomplete: selected.incomplete }, null, 2),
      contentType: 'application/json',
    })
    for (const [label, result] of [['initial', initial], ['selected finding', selected]] as const) {
      expect.soft(result.violations.filter(v => v.id === 'heading-order'), `${label}: heading-order violations`).toEqual([])
      expect.soft(result.violations.filter(v => v.impact === 'critical' || v.impact === 'serious'), `${label}: critical/serious violations`).toEqual([])
    }
  })
})

async function expectNoLoadError(page: Page) {
  await page.waitForLoadState('networkidle')
  const alert = page.locator('[role="alert"]').first()
  await expect(alert).toHaveCount(0)
}
