/**
 * Audit filter accessible names — verifies the two Select triggers in the
 * Findings list header have distinct, descriptive accessible names.
 * Applies at all supported desktop viewports (no phone dependency).
 */
import { test, expect } from '@playwright/test'
import { createSyntheticAudit, annotate } from './helpers'

test.describe('audit filters — accessible names @a11y', () => {
  test('both filter comboboxes have distinct accessible names', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'FILTER-NAMES',
      objective: 'Both audit filter controls expose distinct English accessible names via aria-label and remain operable.',
      precondition: 'Completed synthetic audit; Findings list rendered.',
      steps: ['Create audit via API', 'Open /audit/{id}', 'Locate comboboxes by accessible name', 'Assert distinct names and operability'],
      expected: 'Two comboboxes found: "Filter by severity" and "Filter by category", distinct and enabled.',
      severity: 'high',
    })
    const summary = await createSyntheticAudit(page)
    await page.goto(`/audit/${summary.auditId}`)
    await page.waitForLoadState('networkidle')

    const severityFilter = page.getByRole('combobox', { name: 'Filter by severity' })
    const categoryFilter = page.getByRole('combobox', { name: 'Filter by category' })

    await expect(severityFilter).toBeVisible()
    await expect(categoryFilter).toBeVisible()
    await expect(severityFilter).toBeEnabled()
    await expect(categoryFilter).toBeEnabled()

    // Distinct names
    const severityName = await severityFilter.getAttribute('aria-label')
    const categoryName = await categoryFilter.getAttribute('aria-label')
    expect(severityName).toBe('Filter by severity')
    expect(categoryName).toBe('Filter by category')
    expect(severityName).not.toBe(categoryName)

    // Operability: opening each combobox shows options
    await severityFilter.click()
    await expect(page.getByRole('option', { name: 'All severities' })).toBeVisible()
    await page.keyboard.press('Escape')
    await categoryFilter.click()
    await expect(page.getByRole('option', { name: 'All categories' })).toBeVisible()
    await page.keyboard.press('Escape')
  })
})
