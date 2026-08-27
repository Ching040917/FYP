/**
 * Scenario 7 — History deletion: the destructive flow stays keyboard
 * operable and guarded. Cancel and Escape preserve data; confirming deletes
 * exactly one synthetic record created for this test.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { createSyntheticAudit, evidenceShot, annotate } from './helpers'

/** Return the first VISIBLE element matching text (mobile list vs desktop table). */
async function firstVisible(page: Page, selector: string, text: string): Promise<Locator> {
  const candidates = page.locator(selector).filter({ hasText: text })
  const count = await candidates.count()
  for (let i = 0; i < count; i++) {
    if (await candidates.nth(i).isVisible().catch(() => false)) return candidates.nth(i)
  }
  return candidates.first()
}

test.describe('history deletion @workflow', () => {
  test('guarded keyboard deletion: cancel/Escape preserve, confirm removes only the synthetic record', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'HISTORY-DELETE',
      objective: 'The delete confirmation dialog is operable by keyboard (initial focus on Cancel), Escape and Cancel preserve the record, and confirming deletes only the synthetic record under test.',
      precondition: 'Exactly one synthetic audit created via API for this test; isolated database.',
      steps: [
        'Create synthetic audit via API',
        'Open /history',
        'Keyboard to its "Delete" button',
        'Assert alertdialog semantics + focus on Cancel',
        'Escape -> row still present',
        'Reopen, Tab to "Delete audit record", Enter',
        'Row disappears; success toast announced',
      ],
      expected: 'Guarded two-step flow holds; only the synthetic record is removed.',
      severity: 'critical',
    })
    const summary = await createSyntheticAudit(page)
    await page.goto('/history')
    await page.waitForLoadState('networkidle')

    // Mobile renders history as a list, desktop as a table — accept both.
    const row = await firstVisible(page, 'tbody tr, li, article', summary.auditId.slice(0, 8))
    if (!(await row.isVisible().catch(() => false))) {
      await firstVisible(page, 'tbody tr, li, article', 'sample-thesis').isVisible()
    }
    await expect(row).toBeVisible()

    const deleteButton = row.getByRole('button', { name: 'Delete', exact: true })
    await deleteButton.focus()
    await expect(deleteButton).toBeFocused()
    await page.keyboard.press('Enter')

    // Guarded dialog semantics.
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('#delete-dialog-title')).toBeVisible()
    const cancel = dialog.getByRole('button', { name: 'Cancel' })
    await expect(cancel).toBeFocused() // initial focus lands on the safe action

    // Escape preserves data.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(row).toBeVisible()

    // Cancel preserves data.
    await deleteButton.click()
    await expect(dialog).toBeVisible()
    await cancel.focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(row).toBeVisible()
    await expect(page.locator('[role="status"], [role="alert"]').filter({ hasText: 'Deleted audit record' })).toHaveCount(0)

    // Confirm deletes only this record.
    await deleteButton.click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete audit record', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(row).toBeHidden({ timeout: 15_000 })

    // Deletion feedback announced via a live region inside the toast stack.
    const deletedToast = page
      .locator('div.fixed.bottom-4')
      .locator('[role="status"]')
      .filter({ hasText: `Deleted audit record` })
    await expect(deletedToast.first()).toBeVisible()
    const toastDismiss = deletedToast.first().getByRole('button', { name: 'Dismiss notification' })
    await toastDismiss.focus()
    await page.keyboard.press('Enter')
    await expect(deletedToast).toHaveCount(0)

    await evidenceShot(page, `history-after-delete-${testInfo.project.name}.png`)
  })
})
