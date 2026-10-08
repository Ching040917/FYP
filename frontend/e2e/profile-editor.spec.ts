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

// ---------------------------------------------------------------------------
// Citation ↔ Reference List matching controls (citation reference build)
// ---------------------------------------------------------------------------

test.describe('custom profile citation controls @citation', () => {
  test('the seven citation toggles persist through save + reload and disable dependents', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'PROFILE-CITATION-TOGGLES',
      objective:
        'The Citations and References controls save to the profile payload, reload with the stored values, and disable the dependent checks while the parent check is off.',
      precondition: '/profiles/custom loads; browser-local custom profile store only (no backend profile writes).',
      steps: [
        'Open /profiles/custom',
        'Start a draft from "Copy SUC Academic Report"',
        'Open the "Citations and References" section',
        'Turn "Check Reference List entries are cited in the text" on and "Check same-author, same-year suffixes" off',
        'Save the custom profile',
        'Reload the page and reopen the saved profile',
        'Assert the toggle states came back; then turn the parent check off and assert the dependents disable',
      ],
      expected: 'Saved toggles reload exactly; dependents are disabled while the parent check is off.',
      severity: 'median',
    })

    await page.goto('/profiles/custom')
    await page.waitForLoadState('networkidle')

    const startDraft = page.getByRole('button', { name: 'Copy SUC Academic Report' }).first()
    await expect(startDraft).toBeEnabled()
    await startDraft.click()

    const section = page.locator('details', { hasText: 'Citations and References' }).first()
    await section.locator('summary').click()

    const parent = page.locator('#citation-check-citations-have-references')
    const listed = page.locator('#citation-check-references-are-cited')
    const suffixes = page.locator('#citation-check-year-suffixes')

    await expect(parent).toBeVisible()
    await expect(parent).toBeChecked()
    await expect(listed).not.toBeChecked()

    await listed.check()
    await suffixes.uncheck()

    // Parent off disables the dependent checks (and writes them off).
    await parent.uncheck()
    await expect(suffixes).toBeDisabled()
    await expect(page.locator('#citation-check-author-year-consistency')).toBeDisabled()
    await parent.check()
    await expect(suffixes).toBeEnabled()

    const save = page.getByRole('button', { name: /Save custom profile/i })
    await save.scrollIntoViewIfNeeded()
    await save.click()
    await expect(page.getByText(/Saved|Profile saved/i).first()).toBeVisible({ timeout: 15_000 })

    // Reload: the toggles must come back from the stored payload.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Edit' }).first().click()

    const sectionAfter = page.locator('details', { hasText: 'Citations and References' }).first()
    await sectionAfter.locator('summary').click()
    await expect(page.locator('#citation-check-references-are-cited')).toBeChecked()
    await expect(page.locator('#citation-check-year-suffixes')).not.toBeChecked()
    await expect(page.locator('#citation-check-citations-have-references')).toBeChecked()

    // Clean up: delete the saved profile so nothing lingers in the session.
    await page.getByRole('button', { name: /Delete profile/i }).first().click()
    const confirm = page.getByRole('button', { name: /Delete/i }).last()
    if ((await confirm.count()) > 0) await confirm.click()

    await evidenceShot(page, `profile-editor-citation-toggles-${testInfo.project.name}.png`)
  })
})
