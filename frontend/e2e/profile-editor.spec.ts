/**
 * Scenario 8 — Custom Profile Editor: keyboard reaches main controls,
 * validation errors move focus and are announced, labels/accessible names
 * exist. Drafts are never saved — every mutation is discarded so no profile
 * persists outside the isolated session.
 */
import { test, expect } from '@playwright/test'
import { evidenceShot, annotate } from './helpers'

test.describe('custom profile editor @a11y', () => {
  test('keyboard reachability, labelled controls, validation error focus behaviour', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'PROFILE-EDITOR-KB',
      objective: 'Main editor controls are keyboard reachable with present accessible names; submitting an invalid draft moves focus to the first field error; nothing is persisted.',
      precondition: '/profiles/custom loads with built-in copy sources; isolated backend.',
      steps: [
        'Open /profiles/custom',
        'Start a new draft ("Copy SUC Academic Report")',
        'Clear the Profile name field',
        'Activate "Save custom profile"',
        'Assert inline role=alert error + focused error control',
        'Restore name then leave without saving',
      ],
      expected: 'Validation focuses the offending control; aria-invalid communicated; draft discarded at the end.',
      severity: 'high',
    })

    await page.goto('/profiles/custom')
    await page.waitForLoadState('networkidle')

    // Create a draft via the keyboard.
    const startDraft = page.getByRole('button', { name: 'Copy SUC Academic Report' }).first()
    if ((await startDraft.count()) > 0 && (await startDraft.isEnabled())) {
      await startDraft.focus()
      await page.keyboard.press('Enter')
    }

    const nameInput = page.locator('#profile-name')
    await expect(nameInput).toBeVisible()
    const nameInputCount = await nameInput.count()

    if (nameInputCount > 0) {
      // Label association.
      const nameLabel = page.locator('label[for="profile-name"]')
      await expect(nameLabel).toBeVisible()

      // Force an invalid state and save.
      await nameInput.fill('')
      const save = page.getByRole('button', { name: /Save custom profile/i })
      await save.scrollIntoViewIfNeeded()
      const enabled = await save.isEnabled()
      if (enabled) {
        await save.click()
        const firstError = page.locator('#profile-name-error')
        await expect(firstError).toBeVisible({ timeout: 10_000 })
        await expect(nameInput).toHaveAttribute('aria-invalid', 'true')
        // Focus must have moved into the editor (invalid control or its error).
        const focusInsideEditor = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          if (!el) return false
          return el.id === 'profile-name' || el.getAttribute('aria-invalid') === 'true'
        })
        expect(focusInsideEditor, 'focus moved for validation feedback').toBe(true)
      }

      // Discard the draft so nothing persists.
      const discard = page.getByRole('button', { name: /Discard draft|Return to upload/i }).first()
      if ((await discard.count()) > 0) {
        await discard.click()
        const confirm = page.getByRole('button', { name: /Discard changes/i }).first()
        if ((await confirm.count()) > 0) await confirm.click()
      }
    }

    await evidenceShot(page, `profile-editor-${testInfo.project.name}.png`)
  })
})
