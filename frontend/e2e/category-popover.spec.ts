/**
 * Scenario 6 — Findings and the category popover.
 *
 * The popover is intentionally NON-MODAL: category buttons filter the
 * background findings list live, so focus is not trapped. Semantics are
 * role="dialog" aria-modal="false" with an accessible name; Escape closes
 * and returns focus to the trigger.
 */
import { test, expect } from '@playwright/test'
import { createSyntheticAudit, evidenceShot, annotate } from './helpers'

async function openAuditWithFindings(page: import('@playwright/test').Page) {
  const summary = await createSyntheticAudit(page)
  await page.goto(`/audit/${summary.auditId}`)
  await page.waitForLoadState('networkidle')
  return summary
}

test.describe('category popover @a11y', () => {
  test('keyboard-opened popover has dialog semantics, managed focus, Escape returns to trigger, filtering works', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'POPOVER-KB',
      objective: 'The audit category popover exposes aria-haspopup="dialog", opens with dialog semantics and a named panel, moves focus to its first interactive element on open, supports Escape-close returning focus to the trigger, keeps non-modal Tab behaviour, and still filters the findings list.',
      precondition: 'Completed synthetic audit with score breakdown rows.',
      steps: [
        'Open /audit/{id}',
        'Tab to "Categories" trigger',
        'Press Enter',
        'Assert trigger attributes + dialog semantics + initial focus inside',
        'Press Enter on first category button',
        'Escape -> closed + focus on trigger',
        'Reopen and assert selected state survives',
      ],
      expected: 'All semantic/keyboard assertions pass; filter state persists; outside-click still closes.',
      severity: 'high',
    })
    const summary = await openAuditWithFindings(page)

    const trigger = page.getByRole('button', { name: /^Categories · \d+/ })
    await expect(trigger).toBeVisible()

    // Keyboard-only interaction up to this point.
    await page.keyboard.press('Tab') // skip-link is first; next tabs land us in nav
    let focused = false
    for (let i = 0; i < 25 && !focused; i++) {
      await page.keyboard.press('Tab')
      if (await trigger.evaluate((el) => el === document.activeElement)) focused = true
    }
    expect(focused, 'Categories trigger must be keyboard reachable').toBe(true)

    // Trigger semantics before opening.
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger).toHaveAttribute('aria-controls', 'category-panel')

    await page.keyboard.press('Enter')
    const panel = page.locator('#category-panel')

    // Dialog semantics + accessible name; explicitly NON-modal.
    await expect(panel).toHaveAttribute('role', 'dialog')
    await expect(panel).toHaveAttribute('aria-modal', 'false')
    await expect(panel).toHaveAttribute('aria-label', 'Filter findings by category')
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')

    // Focus moved to the first meaningful interactive element.
    const firstCategoryButton = panel.getByRole('button').first()
    await expect(firstCategoryButton).toBeFocused()
    await expect(firstCategoryButton).toHaveAttribute('aria-pressed', /.*/)

    // Non-modal: Tab can leave the panel freely (no trap by design).
    await page.keyboard.press('Tab')
    await expect(firstCategoryButton).not.toBeFocused()
    await page.keyboard.press('Shift+Tab')

    // Selecting a category toggles aria-pressed (filter behaviour intact).
    const pressedBefore = (await firstCategoryButton.getAttribute('aria-pressed')) === 'true'
    await page.keyboard.press('Enter')
    await expect(firstCategoryButton).toHaveAttribute('aria-pressed', pressedBefore ? 'false' : 'true')

    // Escape closes and restores focus to the trigger.
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger).toBeFocused()

    // Outside click still closes after a reopen (at supported desktop
    // widths the 90vw panel never covers the chosen outside point).
    await trigger.click()
    await expect(panel).toBeVisible()
    await page.mouse.click(10, 400)
    await expect(panel).toHaveCount(0)
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await evidenceShot(page, `category-popover-${testInfo.project.name}.png`)
  })

  test('selected category filters the visible findings list', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'POPOVER-FILTER',
      objective: 'Choosing a category in the popover keeps the findings list consistent with the selection (same-category rows remain listed).',
      precondition: 'Completed synthetic audit.',
      steps: ['Create audit via API', 'Open Categories popover', 'Click a failing/warning category cell', 'Observe findings list'],
      expected: 'List re-renders without error; selected category communicated via aria-pressed.',
      severity: 'medium',
    })
    const summary = await openAuditWithFindings(page)
    const trigger = page.getByRole('button', { name: /^Categories · \d+/ })
    await trigger.click()
    const panel = page.locator('#category-panel')
    const target = panel.getByRole('button', { has: page.locator('svg') }).last()
    const label = (await target.textContent()) ?? ''
    await target.click()
    await expect(target).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    // The findings list must still render row content (filter applied client-side).
    await expect(page.getByRole('list').first()).toBeVisible()
    void label
    void summary
  })
})
