/**
 * Scenario 5 — Audit workspace tablist (NOT APPLICABLE on phone).
 * ACA is a Windows desktop application served locally on 127.0.0.1.
 * Phone widths are outside the supported platform.
 * This file is retained as a skipped placeholder so evidence labels
 * do not claim mobile or tablet support.
 */
import { test } from '@playwright/test'

test.describe('audit workspace tabs — NOT APPLICABLE on phone @responsive', () => {
  test('workspace tablist: keyboard reachable (phone-only) — NOT APPLICABLE', async ({}, testInfo) => {
    test.skip(true, 'NOT APPLICABLE — mobile devices are outside the supported platform (Windows desktop only).')
  })
})

/**
 * Desktop scenario — a manual-review (REVIEW) finding in the workspace.
 * The review finding must render with its neutral "Manual review" label and
 * must stay out of the major/minor counts (it is never scored).
 */
import path from 'node:path'
import { expect } from '@playwright/test'
import { annotate, createSyntheticAudit, evidenceShot } from './helpers'

const REVIEW_FIXTURE = path.join(process.cwd(), 'e2e', 'fixtures', 'citation-review-synthetic.docx')

test.describe('audit workspace severity labels @citation', () => {
  test('a REVIEW finding renders as Manual review and is excluded from the counts', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'AUDIT-REVIEW-SEVERITY',
      objective:
        'A manual-review finding (ambiguous citation match) shows the neutral "Manual review" label, never Major/Minor, and is excluded from the major/minor counts.',
      precondition: 'Isolated backend with the committed synthetic review fixture (two same-surname entries).',
      steps: [
        'Upload e2e/fixtures/citation-review-synthetic.docx through the API',
        'Open /audit/:auditId',
        'Read the finding counts line',
        'Read the finding row label',
      ],
      expected: 'Outcome is Manual review needed; counts read "0 Major · 0 Minor · 1 Manual review (unscored)"; the row shows "Manual review".',
      severity: 'medium',
    })

    const audit = await createSyntheticAudit(page, REVIEW_FIXTURE, 'citation-review-synthetic.docx')
    await page.goto(`/audit/${audit.auditId}`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText('Manual review needed', { exact: true })).toBeVisible()
    await expect(page.getByText('0 Major · 0 Minor · 1 Manual review (unscored)', { exact: false })).toBeVisible()

    const row = page.getByRole('button', { name: /Citation could match more than one entry/ }).first()
    await expect(row).toBeVisible()
    await expect(row.getByText('Manual review')).toBeVisible()
    // The review finding is never labelled Major or Minor.
    await expect(row.getByText('Minor', { exact: true })).toHaveCount(0)
    await expect(row.getByText('Major', { exact: true })).toHaveCount(0)

    // Selecting it opens the detail pane with the fixed manual-review action.
    // The text also exists in a hidden responsive container, so match the
    // visible instance explicitly.
    await row.click()
    await expect(
      page.locator('p:visible', { hasText: 'Confirm which listed source this citation refers to.' }).first(),
    ).toBeVisible()
    await expect(
      page.locator('h2:visible', { hasText: 'Citation could match more than one entry' }).first(),
    ).toBeVisible()

    await evidenceShot(page, `audit-review-severity-${testInfo.project.name}.png`)
  })
})
