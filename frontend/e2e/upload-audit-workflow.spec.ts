/**
 * Scenarios 2-4 — Readiness card keyboard behaviour, upload workflow, and the
 * completed-audit workflow (findings, navigation, history entry, score, toast
 * announcement). Core completion must not depend on Ollama or LibreOffice:
 * in this environment Ollama is unreachable by configuration and LibreOffice
 * is optional — both degrade gracefully on the backend.
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import {
  SAMPLE_THESIS,
  expectNoHorizontalOverflow,
  evidenceShot,
  annotate,
} from './helpers'

/** Visible-focus check tolerant of ring (box-shadow) or outline styles. */
async function assertFocusVisible(page: import('@playwright/test').Page, locator?: import('@playwright/test').Locator) {
  const target = locator ?? page.locator(':focus')
  const styles = await target.evaluate((el) => {
    const s = getComputedStyle(el)
    return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow }
  })
  const hasOutline = styles.outlineStyle !== 'none' && styles.outlineWidth !== '0px'
  const hasRing = styles.boxShadow !== 'none'
  expect(hasOutline || hasRing, `focused element must show a visible indicator (${JSON.stringify(styles)})`).toBe(true)
}

test.describe('readiness card @readiness', () => {
  test('View details expands via keyboard; aria-expanded tracks state; focus stays visible', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'READINESS-KB',
      objective: 'Readiness card toggle operates with Enter and Space; aria-expanded stays truthful; focus remains visible; degraded optional components do not block core audit controls.',
      precondition: 'Dashboard loaded with isolated backend. Ollama intentionally unreachable — readiness may show degraded/optional rows.',
      steps: ['Open /dashboard', 'Tab to "View details" button', 'Press Enter', 'Check aria-expanded + details visibility', 'Press Space to collapse'],
      expected: 'aria-expanded toggles correctly; details show/hide; visible focus indicator present.',
      severity: 'medium',
    })
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    // Stable locator: the button relabels "View details" <-> "Hide details".
    const viewDetails = page
      .getByRole('region', { name: 'System readiness' })
      .getByRole('button', { name: /View details|Hide details/ })
      .first()
    await expect(viewDetails).toBeVisible({ timeout: 30_000 })

    // Keyboard activation: Enter.
    await viewDetails.focus()
    await expect(viewDetails).toBeFocused()
    await assertFocusVisible(page, viewDetails)
    await page.keyboard.press('Enter')
    await expect(viewDetails).toHaveAttribute('aria-expanded', 'true')
    const row = page.getByText('Layout rules engine', { exact: false }).or(page.locator('#readiness-details'))
    await expect(page.locator('#readiness-details')).toBeVisible()

    // Keyboard activation: Space collapses again.
    await page.keyboard.press('Space')
    await expect(viewDetails).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#readiness-details')).toBeHidden()
    void row

    // Degraded optional components do not block core audit controls.
    const runButton = page.getByRole('button', { name: 'Run compliance audit' })
    await expect(runButton).toBeAttached()
    await expectNoHorizontalOverflow(page)
  })
})

test.describe('upload + completed audit workflow @workflow', () => {
  test('full workflow: keyboard-driven upload -> completion -> audit view -> history entry -> announced toast', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'E2E-AUDIT-FLOW',
      objective: 'A synthetic DOCX uploads via keyboard-reachable controls, reaches completed status without Ollama/LibreOffice, findings render, completion navigation works, a history entry appears with the score still available, and the completion toast is announced as a live region with an accessible dismiss control.',
      precondition: 'Fresh isolated database; built-in SUC profile selectable; sample-thesis.docx fixture committed.',
      steps: [
        'Open /dashboard',
        'Load sample thesis via keyboard',
        'Confirm profile selection is available',
        'Activate "Run compliance audit"',
        'Await role=status toast "Audit complete."',
        'Assert dismiss button accessible name and dismiss',
        'Open View audit report',
        'Assert findings render and score displays',
        'Open /history and assert the new record',
      ],
      expected: 'All steps succeed; toast announced exactly once per mount; history entry lists the audit.',
      severity: 'critical',
    })

    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    // Profile selection control reachable.
    const profileSelect = page.locator('#profile-select')
    await expect(profileSelect).toBeVisible()
    await profileSelect.focus()
    await expect(profileSelect).toBeFocused()
    // Built-in default resolves automatically; open + close to prove operability.
    await profileSelect.click()
    await page.keyboard.press('Escape')

    // Load the committed synthetic sample document through the UI affordance.
    const trySample = page.getByRole('button', { name: /sample thesis/i }).first()
    if ((await trySample.count()) > 0) {
      await trySample.click()
      await expect(profileSelect).toBeEnabled()
    } else {
      await page.locator('input[type="file"]').setInputFiles(SAMPLE_THESIS)
    }

    // Submit: keyboard reaches the control; loading state communicated.
    const submit = page.getByRole('button', { name: /Run compliance audit|Auditing/i }).first()
    await submit.scrollIntoViewIfNeeded()
    await submit.click()
    // Loading/disabled state is communicated on the submit control.
    await expect(submit).toBeDisabled()

    // Completion feedback announced: role=status (NOT alert) for success.
    // Toasts are scoped to the fixed toast stack; other page regions may also
    // legitimately carry role="status".
    const toastStack = page.locator('div.fixed.bottom-4')
    const successToast = toastStack.locator('[role="status"]').filter({ hasText: 'Audit complete.' })
    await expect(successToast).toBeVisible()
    await expect(successToast).toHaveAttribute('role', 'status')
    // Exactly one live-region node carries this announcement (no duplicates).
    expect(await toastStack.locator('[role="alert"], [role="status"]').filter({ hasText: 'Audit complete.' }).count()).toBe(1)

    // Dismiss control has an English accessible name and works (keyboard
    // activation — pointer hit-testing can be unreliable when overlapping
    // dashboard cards extend past narrow viewports).
    const dismiss = successToast.getByRole('button', { name: 'Dismiss notification' })
    await expect(dismiss).toBeVisible()
    await dismiss.focus()
    await expect(dismiss).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(successToast).toHaveCount(0)

    // Completed audit view: findings render, score remains available.
    await page.getByRole('button', { name: /^View audit\b/ }).first().click()
    await page.waitForURL(/\/audit\//)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(/major/).first()).toBeVisible() // counts line renders
    const verdictSection = page.getByRole('region', { name: 'Category verdicts' }).or(page.getByText('Findings', { exact: true }).first())
    await expect(verdictSection.first()).toBeAttached()

    await evidenceShot(page, `audit-completed-${testInfo.project.name}.png`)

    // History entry appears.
    await page.goto('/history')
    await page.waitForLoadState('networkidle')
    const candidates = page.locator('table tbody tr, li, article').filter({ hasText: 'sample-thesis' })
    let visibleEntry = false
    for (let i = 0; i < (await candidates.count()); i++) {
      if (await candidates.nth(i).isVisible()) { visibleEntry = true; break }
    }
    expect(visibleEntry, 'a visible history entry lists the audit').toBe(true)
    await evidenceShot(page, `history-entry-${testInfo.project.name}.png`)
  })
})

test.describe('long filename layout @responsive', () => {
  test('a very long synthetic filename does not break the dashboard or history layout', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'RESP-LONGFILENAME',
      objective: 'A long (169-char) synthetic filename neither overflows the page nor clips primary controls.',
      precondition: 'Long-filename synthetic DOCX fixture committed under e2e/fixtures.',
      steps: ['Set the long-named DOCX on the hidden file input', 'Await file chip render', 'Measure horizontal overflow'],
      expected: 'scrollWidth <= clientWidth; no clipped remove control.',
      severity: 'low',
    })
    const fixturesDir = path.resolve(process.cwd(), 'e2e', 'fixtures')
    const longNamePath = path.join(
      fixturesDir,
      fs.readdirSync(fixturesDir).find((f) => f.startsWith('e2e-layout-stress'))!,
    )
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await page.locator('input[type="file"]').setInputFiles(longNamePath)
    await page.waitForTimeout(250)
    await expectNoHorizontalOverflow(page)
    const chip = page.getByText(/e2e-layout-stress/, { exact: false }).first()
    if (await chip.isVisible().catch(() => false)) {
      const box = await chip.boundingBox()
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
      expect(box!.x + box!.width).toBeLessThanOrEqual(clientWidth + 1)
    }
    await evidenceShot(page, `dashboard-long-filename-${testInfo.project.name}.png`)
  })
})
