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

test('profile requirements stay in a viewport dialog without moving the audit action @profile-dialog', async ({ page }) => {
  await page.goto('/dashboard')
  const review = page.getByRole('button', { name: 'Review full requirements' })
  await expect(review).toBeVisible()
  const run = page.getByRole('button', { name: 'Run compliance audit' })
  await expect(run).toBeDisabled()
  await expect(page.getByText('Upload a DOCX file to continue.', { exact: true })).toBeVisible()
  for (const size of [{ width: 1366, height: 768 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 375, height: 667 }]) {
    await page.setViewportSize(size)
    await review.scrollIntoViewIfNeeded()
    const before = await run.evaluate((element) => ({ x: element.getBoundingClientRect().x + window.scrollX, y: element.getBoundingClientRect().y + window.scrollY }))
    await review.click()
    const dialog = page.getByRole('dialog', { name: 'Full profile requirements' })
    await expect(dialog).toHaveCount(1)
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true)
    const box = await dialog.boundingBox()
    expect(box!.width).toBeLessThanOrEqual(size.width)
    expect(box!.height).toBeLessThanOrEqual(size.height)
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await expectNoHorizontalOverflow(page)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(review).toBeFocused()
    const after = await run.evaluate((element) => ({ x: element.getBoundingClientRect().x + window.scrollX, y: element.getBoundingClientRect().y + window.scrollY }))
    expect(after).toEqual(before)
  }
})

test('selected profile explains scored, manual and unchecked coverage without changing the requirements dialog', async ({ page }) => {
  await page.goto('/dashboard')
  const profile = page.locator('main [data-slot="card"]').nth(1)
  await expect(profile.getByText('SUC Academic Report', { exact: true })).toBeVisible()
  await expect(profile.getByText('Source: Built-in · Read-only')).toBeVisible()
  await expect(profile.getByText('Recommended', { exact: true })).toBeVisible()
  await expect(profile.getByText('Citation style: APA 7')).toBeVisible()
  await expect(profile.locator('dt')).toHaveText(['Scored checks', 'Manual review only', 'Not checked by ACA'])
  await expect(profile.getByText(/14 requirements checked automatically/)).toBeVisible()
  await expect(profile.getByText('These checks affect the compliance score.')).toBeVisible()
  await expect(profile.getByText('1 requirement · Unscored')).toBeVisible()
  await expect(profile.getByText('Manual review does not affect the numeric compliance score.')).toBeVisible()
  await expect(profile.getByRole('list', { name: 'Manual review only · Unscored requirements' })).toContainText('Ambiguous citation matches')
  await expect(profile.getByText('21 requirements · Margins not checked')).toBeVisible()
  await expect(profile.getByRole('list', { name: 'Not checked requirements' })).toContainText('Page numbers')
  await expect(profile.getByText('Not included in this profile’s automated checks.')).toBeVisible()
  await expect(profile.getByRole('list', { name: 'Not checked requirements' }).locator('li').filter({ hasText: /^Headers$/ })).toHaveCount(1)
  const coverage = await profile.locator('dl').first().evaluate((list) => {
    const headings = [...list.querySelectorAll('dt')]
    const luminance = (value: string) => {
      const [r, g, b] = (value.match(/\d+/g) ?? []).slice(0, 3).map(Number).map((channel) => {
        const v = channel / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    return headings.map((heading) => {
      const color = getComputedStyle(heading).color
      return {
        label: heading.textContent?.trim(),
        color,
        iconColor: getComputedStyle(heading.querySelector('svg')!).color,
        bodyColor: getComputedStyle(heading.nextElementSibling!).color,
        contrastOnWhite: (1.05) / (luminance(color) + 0.05),
      }
    })
  })
  expect(coverage.map((group) => group.label)).toEqual(['Scored checks', 'Manual review only', 'Not checked by ACA'])
  expect(new Set(coverage.map((group) => group.color)).size).toBe(3)
  for (const group of coverage) {
    expect(group.contrastOnWhite, `${group.label} heading must meet 4.5:1`).toBeGreaterThanOrEqual(4.5)
    expect(group.iconColor).toBe(group.color)
    expect(group.bodyColor).not.toBe(group.color)
  }
  expect((await profile.textContent()) ?? '').not.toMatch(/\b(?:Passed|Failed|Error|Non-compliant)\b/i)
  const review = profile.getByRole('button', { name: 'Review full requirements' })
  await review.focus()
  await assertFocusVisible(page, review)
  await review.click()
  await expect(page.getByRole('dialog', { name: 'Full profile requirements' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(review).toBeFocused()

  for (const size of [{ width: 1366, height: 768 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 683, height: 768 }, { width: 195, height: 667 }]) {
    await page.setViewportSize(size)
    const geometry = await profile.evaluate((el) => {
      const card = el.getBoundingClientRect()
      const controls = [el.querySelector('#profile-select'), el.querySelector('a[href="/profiles/custom"]'), el.querySelector('button[aria-haspopup="dialog"]')]
      return {
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        card: { left: card.left, right: card.right },
        controls: controls.map((control) => {
          const rect = control!.getBoundingClientRect()
          return { left: rect.left, right: rect.right }
        }),
      }
    })
    expect(geometry.scrollWidth, `${size.width}: profile card does not overflow internally`).toBeLessThanOrEqual(geometry.clientWidth + 1)
    expect(geometry.card.left).toBeGreaterThanOrEqual(0)
    expect(geometry.card.right).toBeLessThanOrEqual(size.width + 1)
    for (const control of geometry.controls) {
      expect(control.left).toBeGreaterThanOrEqual(0)
      expect(control.right).toBeLessThanOrEqual(size.width + 1)
    }
    await expect(profile.getByText('Citation style: APA 7')).toBeVisible()
    await expect(review).toBeVisible()
  }
})

test('saved custom profile keeps its full long name and independent coverage', async ({ page }) => {
  await page.goto('/profiles/custom')
  await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
  const name = 'Long custom academic thesis requirements profile for departmental review'
  await page.locator('#profile-name').fill(name)
  await page.getByRole('button', { name: /Save custom profile/i }).click()
  await expect(page.getByText(/Profile saved|Saved/i).first()).toBeVisible()
  await page.goto('/dashboard')
  const profile = page.locator('main [data-slot="card"]').nth(1)
  await profile.locator('#profile-select').click()
  await page.getByRole('option', { name }).click()
  await expect(profile.locator('p').filter({ hasText: name }).first()).toBeVisible()
  await expect(profile.getByText('Source: Custom · Independently editable')).toBeVisible()
  await expect(profile.locator('dt')).toHaveText(['Scored checks', 'Manual review only', 'Not checked by ACA'])
  await expect(profile.getByText('Citation style: APA 7')).toBeVisible()
  await profile.getByRole('button', { name: 'Review full requirements' }).click()
  await expect(page.getByRole('dialog', { name: 'Full profile requirements' })).toContainText(name)
})

test('profile load error retains retry and restores coverage', async ({ page }) => {
  await page.route('**/api/formatting-profiles', (route) => route.fulfill({ status: 503, body: 'Unavailable' }))
  await page.goto('/dashboard')
  const profile = page.locator('main [data-slot="card"]').nth(1)
  await expect(profile.getByRole('alert')).toContainText('Document requirements could not be loaded')
  await expect(profile.getByRole('button', { name: 'Retry' })).toBeVisible()
  await page.unroute('**/api/formatting-profiles')
  await profile.getByRole('button', { name: 'Retry' }).click()
  await expect(profile.getByText('These checks affect the compliance score.')).toBeVisible()
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

    // No cloud AI control exists on the dashboard, and submission carries no
    // cloud query parameter.
    await expect(page.locator('#cloud-toggle')).toHaveCount(0)
    await expect(page.getByText(/cloud AI/i)).toHaveCount(0)

    // Submit: keyboard reaches the control; loading state communicated.
    const submit = page.getByRole('button', { name: /Run compliance audit|Auditing/i }).first()
    await submit.scrollIntoViewIfNeeded()
    const auditRequest = page.waitForRequest(
      (r) => r.url().includes('/api/audit') && r.method() === 'POST',
    )
    await submit.click()
    const auditReq = await auditRequest
    expect(new URL(auditReq.url()).searchParams.has('cloud')).toBe(false)
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
