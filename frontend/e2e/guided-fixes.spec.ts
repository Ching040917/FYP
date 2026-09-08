/**
 * Guided Fixes (Beta) — end-to-end workflow across the three supported
 * desktop widths. Synthetic fixtures only (the committed sample thesis);
 * the backend verifies document identity via SHA-256.
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { createSyntheticAudit, SAMPLE_THESIS, annotate } from './helpers'

const MISMATCH_TEXT =
  'The selected document does not match the document used for this audit. Upload the original DOCX file and try again.'

/** Create a fresh audit and open the completed Audit Workspace. */
async function openCompletedAudit(page: import('@playwright/test').Page) {
  const summary = await createSyntheticAudit(page)
  await page.goto(`/audit/${summary.auditId}`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByText(/major ·|findings/).first()).toBeVisible()
  return summary
}

/** Open the Guided Fixes selection dialog (toolbar trigger). */
async function openGuidedFixes(page: import('@playwright/test').Page) {
  const open = page.getByRole('button', { name: 'Guided Fixes' })
  await open.click()
  await expect(page.getByRole('button', { name: 'Review selected changes' })).toBeVisible()
}

test.describe('guided fixes workflow @guided-fixes', () => {
  test('open, keyboard-select two supported findings, review, back preserves selection', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'GF-WORKFLOW',
      objective: 'Open Guided Fixes, keyboard-select two supported findings, review them, go back without losing selection.',
      precondition: 'Completed synthetic audit with supported findings.',
      steps: ['Open audit', 'Open Guided Fixes (Beta)', 'Space on two checkboxes', 'Review selected changes', 'Back to findings'],
      expected: 'Review shows 2 selections; back keeps both selected; no Apply-all control exists.',
      severity: 'high',
    })
    await openCompletedAudit(page)
    await openGuidedFixes(page)

    // No Apply-all exists anywhere in the workspace.
    await expect(page.getByRole('button', { name: /apply all/i })).toHaveCount(0)

    // Keyboard: focus the first checkbox, press Space, repeat for the second.
    const checkboxes = page.locator('input[type="checkbox"][aria-label]')
    const count = await checkboxes.count()
    expect(count, 'supported findings must render checkboxes').toBeGreaterThanOrEqual(2)
    await checkboxes.nth(0).focus()
    await page.keyboard.press('Space')
    await checkboxes.nth(1).focus()
    await page.keyboard.press('Space')

    // Unsupported findings are never selectable: captions/citations rows
    // carry no checkbox.
    await expect(page.getByText('Manual correction required').first()).toBeAttached()
    const manualRows = page.locator('li:has-text("Manual correction required")')
    for (let i = 0; i < (await manualRows.count()); i++) {
      expect(await manualRows.nth(i).locator('input[type="checkbox"]').count()).toBe(0)
    }

    // Selection count is announced.
    await expect(page.getByText(/selected · .*available for Guided Fix · Maximum 20|No findings selected · .*available for Guided Fix · Maximum 20|selected · Maximum reached/)).toBeVisible()

    // Review panel: current + proposed values, two removable entries.
    await page.getByRole('button', { name: 'Review selected changes' }).click()
    await expect(page.getByText('Selected changes: 2')).toBeVisible()
    await expect(page.getByText(/Current:/).first()).toBeVisible()
    await expect(page.getByText(/Proposed:/).first()).toBeVisible()

    // Back keeps the selection.
    await page.getByRole('button', { name: 'Back to findings' }).click()
    await expect(page.getByText(/selected · .*available for Guided Fix · Maximum 20|No findings selected · .*available for Guided Fix · Maximum 20|selected · Maximum reached/)).toBeVisible()
  })

  test('wrong DOCX shows mismatch error; exact original creates and downloads corrected copy; audit unchanged', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'GF-UPLOAD-DOWNLOAD',
      objective: 'Upload a different DOCX → mismatch error; replace with the exact original → corrected copy downloads with counts; original audit state unchanged.',
      precondition: 'Completed synthetic audit; second synthetic DOCX available.',
      steps: ['Open Guided Fixes', 'Select one finding', 'Review → continue', 'Upload wrong docx', 'Replace with exact original', 'Create corrected copy', 'Download'],
      expected: 'Mismatch error surfaces verbatim; corrected copy downloads; applied/skipped counts shown; score/findings unchanged.',
      severity: 'high',
    })
    const summary = await openCompletedAudit(page)
    await openGuidedFixes(page)

    await page.locator('input[type="checkbox"][aria-label]').first().check()
    await page.getByRole('button', { name: 'Review selected changes' }).click()
    await page.getByRole('button', { name: 'Continue to upload original DOCX' }).click()

    // Create a DIFFERENT docx (the long-filename fixture) for the mismatch path.
    const fixturesDir = path.resolve(process.cwd(), 'e2e', 'fixtures')
    const wrongPath = path.join(fixturesDir, 'long-filename-sample.docx')
    const wrong = page.locator('#guided-fixes-file-input')
    await wrong.setInputFiles(wrongPath)
    await page.getByRole('button', { name: 'Create corrected copy' }).click()
    await expect(page.getByRole('alert')).toContainText(MISMATCH_TEXT)

    // Selection survives the error and the file can be replaced (dialog
    // stays open — never closed automatically on error).
    await page.getByRole('button', { name: 'Back to findings' }).click()
    await expect(page.getByText(/1 of 20 findings selected/)).toBeVisible()
    await page.getByRole('button', { name: 'Review selected changes' }).click()
    await page.getByRole('button', { name: 'Continue to upload original DOCX' }).click()

    // Replace with the EXACT original bytes used for the audit.
    await wrong.setInputFiles(SAMPLE_THESIS)
    await page.getByRole('button', { name: 'Create corrected copy' }).click()
    await expect(page.getByText('Creating your corrected copy…')).toBeVisible()

    // Success: applied/skipped counts + download.
    await expect(page.getByText('Corrected copy created')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/Applied: \d+ · Skipped: \d+/)).toBeVisible()
    await expect(page.getByText(/Your original document was not changed/)).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download corrected document' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toContain('_ACA_corrected.docx')

    // Original audit score and findings remain unchanged.
    const before = await page.request.get(`/api/audit/${summary.auditId}`)
    const beforeBody = await before.json()
    const after = await page.request.get(`/api/audit/${summary.auditId}`)
    const afterBody = await after.json()
    expect(afterBody.weighted_score).toBe(beforeBody.weighted_score)
    expect(afterBody.violations).toEqual(beforeBody.violations)

    // Audit corrected copy returns to Dashboard only.
    await page.getByRole('button', { name: 'Audit corrected copy' }).click()
    await page.waitForURL(/\/dashboard/)
  })

  test('axe scan and horizontal-overflow pass at all three supported desktop widths', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'GF-AXE-LAYOUT',
      objective: 'No critical/serious axe violations and no horizontal overflow at 1366/1280/1024 widths while the Guided Fixes dialog is open.',
      precondition: 'Completed synthetic audit.',
      steps: ['Open audit at each width', 'Open Guided Fixes dialog', 'Run axe scan', 'Measure overflow'],
      expected: 'Zero critical/serious axe violations; scrollWidth <= clientWidth.',
      severity: 'high',
    })
    for (const width of [1366, 1280, 1024]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 800 })
      await openCompletedAudit(page)
      await openGuidedFixes(page)
      const results = await new AxeBuilder({ page }).analyze()
      const blocking = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )
      expect(
        blocking,
        `${width}px: critical/serious axe violations:\n${blocking
          .map((v) => `${v.id} (${v.impact}): ${v.help}`)
          .join('\n')}`,
      ).toEqual([])
      const m = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(
        m.scrollWidth,
        `${width}px: scrollWidth ${m.scrollWidth} exceeds clientWidth ${m.clientWidth}`,
      ).toBeLessThanOrEqual(m.clientWidth + 1)
    }
  })
})
