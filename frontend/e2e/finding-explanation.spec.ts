import { test, expect } from '@playwright/test'
import { createSyntheticAudit } from './helpers'

test('compact rows retain selected explanations in Details and reading order', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const audit = await createSyntheticAudit(page)
  await page.goto(`/audit/${audit.auditId}`)
  await page.waitForLoadState('networkidle')
  const rows = page.locator('#ws-panel-findings li button')
  const details = page.locator('#ws-panel-details')
  const explanation = details.getByRole('heading', { name: 'What ACA found' }).locator('..').locator('p')
  await expect(explanation).toContainText('Calibri')
  const first = await explanation.innerText()
  await expect(rows.first()).not.toContainText(first)
  expect((await rows.first().boundingBox())!.height).toBeLessThanOrEqual(88)
  await expect(details.getByText('Current', { exact: true })).toBeVisible()
  await expect(details.getByText('Required', { exact: true })).toBeVisible()
  await expect(details.getByText('Required action', { exact: true })).toBeVisible()
  await expect(details).not.toContainText('Proposed correction')
  const text = await details.innerText()
  const labels = ['Font family does not match', 'Automated formatting check', 'Location', 'What ACA found', 'Current', 'Required action']
  const positions = labels.map(label => text.toLowerCase().indexOf(label.toLowerCase()))
  expect(positions.every((pos, i) => pos >= 0 && (i === 0 || pos > positions[i - 1]))).toBe(true)
  await rows.nth(1).focus()
  await page.keyboard.press('Enter')
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await expect(explanation).toContainText('14')
  await expect(explanation).not.toHaveText(first)
})

test('historical empty explanations stay absent; manual long explanations wrap without invented corrections', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const audit = await createSyntheticAudit(page)
  const response = await (await page.request.get(`/api/audit/${audit.auditId}`)).json()
  const longExplanation = 'The saved evidence needs a person to inspect the document formatting and confirm the applicable requirement. '.repeat(12)
  const base = response.violations[0]
  response.violations = [
    { ...base, id: 'historical-empty', rule_code: 'HISTORICAL_CHECK', message: '', actual_value: null, expected_value: null },
    { ...base, id: 'historical-review', rule_code: 'HISTORICAL_CHECK', severity: 'REVIEW', message: longExplanation, actual_value: null, expected_value: null },
    { ...base, id: 'action-only', rule_code: 'HISTORICAL_CHECK', message: 'Review this finding in Microsoft Word and apply the required formatting.', actual_value: null, expected_value: null },
  ]
  await page.route(`**/api/audit/${audit.auditId}`, route => route.fulfill({ json: response }))
  await page.goto(`/audit/${audit.auditId}`)
  const rows = page.locator('#ws-panel-findings li button')
  const details = page.locator('#ws-panel-details')
  await expect(details).toBeVisible()
  await expect(details.getByRole('heading', { name: 'What ACA found' })).toHaveCount(0)
  await rows.nth(1).click()
  await expect(details).toContainText('Needs a person to check')
  await expect(details).toContainText('Manual review')
  const explanation = details.getByRole('heading', { name: 'What ACA found' }).locator('..').locator('p')
  await expect(explanation).toHaveText(longExplanation.trim())
  expect(await explanation.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true)
  expect((await explanation.boundingBox())!.height).toBeGreaterThan(42)
  await expect(details).not.toContainText('Proposed correction')
  await expect(details.getByText('Required action', { exact: true })).toBeAttached()
  await rows.nth(2).click()
  await expect(details.getByRole('heading', { name: 'What ACA found' })).toHaveCount(0)
})
