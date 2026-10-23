/** Mounted custom-profile lifecycle, lossless drafting and accessibility regressions.
 * Storage and network failures below are synthetic fault injection in test-owned
 * browser contexts; successful normalization uses the real validation endpoint.
 */
import { test, expect, type Page } from '@playwright/test'
import { evidenceShot, annotate } from './helpers'
import { AxeBuilder } from '@axe-core/playwright'

test.describe('custom profile editor @a11y', () => {
  test('keyboard submission focuses a linked error summary and its links expose the invalid control', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'PROFILE-EDITOR-KB',
      objective: 'Keyboard Save associates inline errors, focuses the linked summary and exposes invalid controls without empty headings.',
      precondition: 'Isolated browser-local store and profile-validation backend.',
      steps: ['Create a draft', 'Clear its name', 'Save by keyboard', 'Activate the summary link', 'Discard'],
      expected: 'Summary is focused; invalid control is visible below the header; no pre-Save stored record.',
      severity: 'high',
    })
    await page.goto('/profiles/custom')
    const startDraft = page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true })
    await expect(startDraft).toBeEnabled()
    await startDraft.focus()
    await page.keyboard.press('Enter')
    const name = page.locator('#profile-name')
    await expect(name).toBeVisible()
    await expect(name).toBeFocused()
    await name.fill(' ')
    await page.getByRole('button', { name: 'Save custom profile', exact: true }).focus()
    await page.keyboard.press('Enter')
    const summary = page.locator('[aria-labelledby="profile-errors-heading"]')
    await expect(summary).toBeFocused()
    const inline = page.locator('#profile-name-error')
    await expect(inline).toBeVisible()
    const audit = await new AxeBuilder({ page }).analyze()
    expect(audit.violations).toEqual([])
    expect(audit.incomplete.filter((rule) => rule.id === 'aria-prohibited-attr')).toEqual([])
    await summary.getByRole('link', { name: 'Enter a profile name.', exact: true }).click()
    await expect(name).toBeFocused()
    await expect(name).toHaveAttribute('aria-invalid', 'true')
    const bounds = (await name.boundingBox())!
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    const savedCount = await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active') ?? '{"profiles":[]}').profiles.length)
    expect(savedCount).toBe(0)
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click()
    await expect(name).toHaveCount(0)
    await expect(page.locator('#profile-list-heading')).toBeFocused()
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

    // Parent off disables effective checks without erasing configured intent.
    await parent.uncheck()
    await expect(suffixes).toBeDisabled()
    await expect(page.locator('#citation-check-author-year-consistency')).toBeDisabled()
    await expect(page.locator('#citation-check-author-year-consistency')).toBeChecked()
    await parent.check()
    await expect(suffixes).toBeEnabled()
    await expect(page.locator('#citation-check-author-year-consistency')).toBeChecked()

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

test('Reference DOI toggle persists through save and reload', async ({ page }, testInfo) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      await route.continue()
    } else {
      await route.abort()
    }
  })
  await page.goto('/profiles/custom')
  const builtins = page.getByRole('group', { name: 'Built-in profiles', exact: true })
  await expect(builtins).toBeVisible()
  await expect(builtins.getByRole('checkbox')).toHaveCount(0)
  await expect(builtins.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
  const name = 'Reference DOI toggle smoke'
  await page.locator('#profile-name').fill(name)
  const references = page.locator('details').filter({
    has: page.locator('summary').filter({ hasText: /^Reference List$/ }),
  })
  await references.locator('summary').click()
  const toggle = page.getByRole('checkbox', { name: 'Check Reference DOI format', exact: true })
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await page.getByRole('button', { name: /Save custom profile/i }).click()
  await expect(page.getByText(/Profile saved|Saved/i).first()).toBeVisible()
  await page.reload()
  const saved = page.locator('li').filter({ hasText: name })
  await saved.getByRole('button', { name: 'Edit', exact: true }).click()
  await references.locator('summary').click()
  await expect(toggle).toBeChecked()
  await evidenceShot(page, `reference-doi-toggle-${testInfo.project.name}.png`)
})

async function createAndSave(page: Page, name: string) {
  await page.goto('/profiles/custom')
  await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
  await page.locator('#profile-name').fill(name)
  await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
  await expect(page.getByText('Custom profile saved', { exact: true })).toBeVisible()
}

test('long valid profile names and descriptions reflow without truncation or document overflow', async ({ page }) => {
  const name = 'N'.repeat(180)
  const description = 'D'.repeat(500)
  await createAndSave(page, name)
  await page.locator('#profile-description').fill(description)
  await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
  await expect(page.getByText('Custom profile saved', { exact: true })).toBeVisible()
  await expect(page.locator('#profile-name')).toHaveValue(name)
  await expect(page.locator('#profile-description')).toHaveValue(description)
  for (const width of [1366, 1280, 1024, 960]) {
    await page.setViewportSize({ width, height: 768 })
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    )).toBe(true)
  }
})

test.describe('complete grouped editor lifecycle', () => {
  test('copy failure leaves no replacement profile or draft', async ({ page }) => {
    await page.route('**/api/formatting-profiles/suc-academic-report/payload', route => route.fulfill({ status: 503, body: '{}' }))
    await page.goto('/profiles/custom')
    await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
    await expect(page.getByText(/source profile could not be copied/)).toBeVisible()
    await expect(page.locator('#profile-name')).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('custom-profiles:active'))).toBeNull()
  })

  test('new recovery restores complete identity, metadata and unfinished requirement values; discard is final', async ({ page }) => {
    await page.goto('/profiles/custom')
    await page.getByRole('button', { name: 'Copy APA 7 Student Paper', exact: true }).click()
    await page.locator('#profile-name').fill('Unsaved Ω identity')
    await page.locator('#profile-description').fill('Exact unfinished description')
    await page.locator('#profile-body > summary').click()
    await page.locator('#body-line-spacing').fill('2e')
    const recoveryBefore = await page.evaluate(() => {
      const record = Object.keys(sessionStorage).find(key => key.includes('draft'))
      return record ? JSON.parse(sessionStorage.getItem(record)!) : null
    })
    expect(recoveryBefore.schema_version).toBe(2)
    expect(recoveryBefore.profile_id).toBe(recoveryBefore.draft.id)
    expect(recoveryBefore.ui.body.lineSpacing).toBe('2e')
    page.once('dialog', dialog => dialog.accept())
    await page.reload()
    await page.getByRole('button', { name: 'Restore recovered draft', exact: true }).click()
    await expect(page.locator('#profile-name')).toBeFocused()
    await expect(page.locator('#profile-name')).toHaveValue('Unsaved Ω identity')
    await expect(page.locator('#profile-description')).toHaveValue('Exact unfinished description')
    await page.locator('#profile-body > summary').click()
    await expect(page.locator('#body-line-spacing')).toHaveValue('2e')
    expect(await page.evaluate(() => localStorage.getItem('custom-profiles:active'))).toBeNull()
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Restore recovered draft', exact: true })).toHaveCount(0)
    await expect(page.locator('#profile-name')).toHaveCount(0)
  })

  test('all local context changes and AppNav use Save, Discard and Continue; failed Save cannot leave', async ({ page }) => {
    await page.goto('/profiles/custom')
    await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
    await page.locator('#profile-name').fill('')
    for (const action of [
      () => page.getByRole('button', { name: 'Copy APA 7 Student Paper', exact: true }).click(),
      () => page.getByRole('button', { name: 'Return to upload', exact: true }).click(),
      () => page.getByRole('link', { name: 'Dashboard', exact: true }).first().click(),
    ]) {
      await action()
      const dialog = page.getByRole('alertdialog', { name: 'Unsaved changes', exact: true })
      await expect(dialog.getByRole('button', { name: 'Save and continue', exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'Continue editing', exact: true }).click()
      await expect(page.locator('#profile-name')).toHaveValue('')
    }
    await page.getByRole('button', { name: 'Return to upload', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Save and continue', exact: true }).click()
    await expect(page).toHaveURL(/\/profiles\/custom$/)
    await expect(page.locator('[aria-labelledby="profile-errors-heading"]')).toBeFocused()
    await expect(page.locator('#profile-name')).toHaveValue('')
    await page.getByRole('button', { name: 'Return to upload', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.locator('main')).toBeFocused()
  })

  test('browser back is blocked and Save-and-continue persists before departure', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('link', { name: 'Manage custom profiles', exact: true }).click()
    await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
    await page.locator('#profile-name').fill('Saved before leaving')
    await page.goBack()
    const dialog = page.getByRole('alertdialog', { name: 'Unsaved changes', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Save and continue', exact: true }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.locator('main')).toBeFocused()
    const profiles = await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).profiles)
    expect(profiles).toHaveLength(1)
    expect(profiles[0].name).toBe('Saved before leaving')
    expect(profiles[0].validationState).toBe('backend_confirmed')
  })

  test('a dirty cross-tab draft neither rebases nor resurrects an externally deleted profile', async ({ page, context }) => {
    await createAndSave(page, 'Original saved profile')
    await page.locator('#profile-name').fill('Tab A dirty draft')
    const other = await context.newPage()
    await other.goto('/profiles/custom')
    await other.getByRole('button', { name: 'Edit', exact: true }).click()
    await other.locator('#profile-name').fill('Tab B saved version')
    await other.getByRole('button', { name: 'Save custom profile', exact: true }).click()
    await expect(other.getByText('Custom profile saved', { exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Saved profile conflict', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
    await expect(page.locator('#profile-name')).toHaveValue('Tab A dirty draft')
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).profiles[0].name)).toBe('Tab B saved version')
    await other.getByRole('button', { name: 'Delete profile', exact: true }).first().click()
    await other.getByRole('alertdialog').getByRole('button', { name: 'Delete profile', exact: true }).click()
    await expect(other.getByText('Custom profile deleted', { exact: true })).toBeVisible()
    await expect(page.locator('#profile-name')).toHaveValue('Tab A dirty draft')
    await page.getByRole('button', { name: 'Review latest saved version', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Use draft against reviewed revision', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).profiles)).toEqual([])
    await other.close()
  })

  test('late persistent-write failure retains the last confirmed profile and full dirty draft', async ({ page }) => {
    await createAndSave(page, 'Confirmed before failure')
    const before = await page.evaluate(() => localStorage.getItem('custom-profiles:active'))
    await page.locator('#profile-name').fill('Must not claim saved')
    await page.evaluate(() => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage && key.startsWith('custom-profiles:')) throw new DOMException('Synthetic write failure', 'QuotaExceededError')
        return original.call(this, key, value)
      }
    })
    await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
    await expect(page.getByText(/Validated, but not saved to this browser/)).toBeVisible()
    await expect(page.locator('#profile-name')).toHaveValue('Must not claim saved')
    expect(await page.evaluate(() => localStorage.getItem('custom-profiles:active'))).toBe(before)
    await expect(page.getByText('Custom profile saved', { exact: true })).toHaveCount(0)
  })

  test('unavailable local storage is explicit and never exposes a confirmed saved option', async ({ page }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function(key, value) {
        if (this === localStorage) throw new DOMException('Synthetic unavailable storage', 'SecurityError')
        return original.call(this, key, value)
      }
    })
    await page.goto('/profiles/custom')
    await expect(page.getByText(/in-session draft only/)).toBeVisible()
    await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
    await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
    await expect(page.getByText(/Validated, but not saved to this browser/)).toBeVisible()
    await expect(page.getByText('Custom profile saved', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('custom-profiles:active'))).toBeNull()
  })

  test('Reference regular-heading requirement is expressible and disabled values survive Save', async ({ page }) => {
    await page.goto('/profiles/custom')
    await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
    await page.locator('#profile-references > summary').click()
    await page.locator('#references-check-heading-bold').check()
    await page.getByLabel('Required heading state', { exact: true }).selectOption('regular')
    await page.locator('#references-check-line-spacing').check()
    await page.locator('#references-line-spacing').fill('3')
    await page.locator('#references-check-line-spacing').uncheck()
    await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
    await expect(page.getByText('Custom profile saved', { exact: true })).toBeVisible()
    const references = await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).profiles[0].payload.references)
    expect(references.check_heading_bold).toBe(true)
    expect(references.heading_bold).toBe(false)
    expect(references.check_line_spacing).toBe(false)
    expect(references.line_spacing).toBe(3)
  })

  test('expanded controls have accessible names; modal is genuinely inert and restores focus', async ({ page }) => {
    await page.goto('/profiles/custom')
    await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
    await page.getByRole('button', { name: 'Expand all', exact: true }).click()
    const axe = await new AxeBuilder({ page }).analyze()
    expect(axe.violations.filter(violation => ['label', 'label-title-only', 'select-name', 'heading-order'].includes(violation.id))).toEqual([])
    const trigger = page.getByRole('button', { name: 'Return to upload', exact: true })
    await trigger.click()
    const dialog = page.getByRole('alertdialog', { name: 'Unsaved changes', exact: true })
    await expect(dialog.getByRole('button', { name: 'Continue editing', exact: true })).toBeFocused()
    expect(await page.locator('main').evaluate(element => Boolean(element.closest('[inert]')))).toBe(true)
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    expect(await page.locator('main').evaluate(element => Boolean(element.closest('[inert]')))).toBe(false)
  })
})

test('corrupt and unsupported stores retain bytes until explicit valid reset consent', async ({ page }) => {
  await page.goto('/profiles/custom')
  await page.evaluate(() => {
    localStorage.setItem('custom-profiles:active', '{broken-active')
    localStorage.setItem('custom-profiles:recovery', '{broken-recovery')
  })
  await page.reload()
  await expect(page.getByText(/saved profile store has no usable copy/)).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('custom-profiles:active'))).toBe('{broken-active')
  await page.getByRole('button', { name: 'Reset corrupt profile store', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep stored data', exact: true }).click()
  expect(await page.evaluate(() => localStorage.getItem('custom-profiles:active'))).toBe('{broken-active')
  await page.getByRole('button', { name: 'Reset corrupt profile store', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reset corrupt store', exact: true }).click()
  await expect(page.getByText(/saved profile store has no usable copy/)).toHaveCount(0)
  const reset = await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!))
  expect(reset.profiles).toEqual([])
  expect(reset.selected_id).toBe('builtin:suc-academic-report')
  const future = JSON.stringify({ schema_version: 99, unfamiliar_future_shape: ['retain', 'exactly'] })
  await page.evaluate(value => {
    localStorage.setItem('custom-profiles:active', value)
    localStorage.setItem('custom-profiles:recovery', value)
  }, future)
  await page.reload()
  await expect(page.getByText(/unsupported newer version and is read-only/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset corrupt profile store', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('custom-profiles:active'))).toBe(future)
})

test('legacy payload-only and malformed draft recovery remain quarantined until explicit discard', async ({ page }) => {
  await page.goto('/profiles/custom')
  for (const recovery of [
    JSON.stringify({ schema_version: 1, profile_id: 'new-draft', base_revision: 0, payload: {}, updated_at: new Date().toISOString() }),
    '{broken-recovery',
  ]) {
    await page.evaluate(value => sessionStorage.setItem('custom-profile-draft-recovery:v1', value), recovery)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Restore recovered draft', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true })).toBeDisabled()
    expect(await page.evaluate(() => sessionStorage.getItem('custom-profile-draft-recovery:v1'))).toBe(recovery)
    await page.getByRole('button', { name: 'Discard recovered draft', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true })).toBeEnabled()
    expect(await page.evaluate(() => sessionStorage.getItem('custom-profile-draft-recovery:v1'))).toBeNull()
  }
})

test('successful Save preserves copy requirements and synchronizes wrapper identity and metadata', async ({ page }) => {
  await page.goto('/profiles/custom')
  const [response] = await Promise.all([
    page.waitForResponse(incoming => /\/formatting-profiles\/[^/]+\/payload$/.test(new URL(incoming.url()).pathname) && incoming.ok()),
    page.getByRole('button', { name: 'Copy APA 7 Student Paper', exact: true }).click(),
  ])
  const copiedSource = (await response.json()).profile
  await page.locator('#profile-name').fill('  Ω lossless copy  ')
  await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
  await expect(page.getByText('Custom profile saved', { exact: true })).toBeVisible()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).profiles[0])
  expect(saved.id).toBe(saved.payload.profile_id)
  expect(saved.name).toBe('Ω lossless copy')
  expect(saved.name).toBe(saved.payload.profile_name)
  expect(saved.description).toBe(copiedSource.description)
  expect(saved.description).toBe(saved.payload.description)
  for (const key of ['body', 'heading', 'references', 'role_policy', 'captions', 'lists', 'margins', 'profile_version']) {
    expect(saved.payload[key]).toEqual(copiedSource[key])
  }
})

test('selected deletion persists the namespaced fallback and moves focus to a surviving target', async ({ page }) => {
  await createAndSave(page, 'Selected custom profile')
  await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem('custom-profiles:active')!)
    store.selected_id = `custom:${store.profiles[0].id}`
    localStorage.setItem('custom-profiles:active', JSON.stringify(store))
    localStorage.setItem('custom-profiles:recovery', JSON.stringify(store))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Delete profile', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete custom profile?', exact: true })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).selected_id)).toMatch(/^custom:/)
  await page.getByRole('button', { name: 'Delete profile', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete profile', exact: true }).click()
  await expect(page.locator('#profile-list-heading')).toBeFocused()
  const focusBounds = await page.locator('#profile-list-heading').boundingBox()
  expect(focusBounds).not.toBeNull()
  const viewport = page.viewportSize()!
  expect(focusBounds!.y).toBeGreaterThanOrEqual(0)
  expect(focusBounds!.y + focusBounds!.height).toBeLessThanOrEqual(viewport.height)
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!))
  expect(saved.profiles).toEqual([])
  expect(saved.selected_id).toBe('builtin:suc-academic-report')
  await page.reload()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).selected_id)).toBe('builtin:suc-academic-report')
})

test('unreachable validation never leaves, claims success or removes the draft', async ({ page }) => {
  await page.route('**/api/formatting-profiles/validate', route => route.fulfill({ status: 503, body: '{}' }))
  await page.goto('/profiles/custom')
  await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
  await page.locator('#profile-name').fill('Retain after network failure')
  await page.getByRole('button', { name: 'Return to upload', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page).toHaveURL(/\/profiles\/custom$/)
  await expect(page.locator('#profile-name')).toHaveValue('Retain after network failure')
  await expect(page.getByText(/Validation is unavailable/)).toBeVisible()
  await expect(page.getByText('Custom profile saved', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('custom-profiles:active'))).toBeNull()
})

test('existing-draft recovery retains its original revision after another tab saves', async ({ page, context }) => {
  await createAndSave(page, 'Saved recovery baseline')
  const originRevision = await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).revision)
  await page.locator('#profile-name').fill('Recovered exact Ω name')
  await page.locator('#profile-description').fill('Recovered exact description')
  await page.locator('#profile-body > summary').click()
  await page.locator('#body-line-spacing').fill('2e')
  const other = await context.newPage()
  await other.goto('/profiles/custom')
  await other.getByRole('button', { name: 'Edit', exact: true }).click()
  await other.locator('#profile-name').fill('Another tab confirmed')
  await other.getByRole('button', { name: 'Save custom profile', exact: true }).click()
  await expect(other.getByText('Custom profile saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Saved profile conflict', exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('custom-profile-draft-recovery:v1')!).base_revision)).toBe(originRevision)
  page.once('dialog', dialog => dialog.accept())
  await page.reload()
  await page.getByRole('button', { name: 'Restore recovered draft', exact: true }).click()
  await expect(page.locator('#profile-name')).toBeFocused()
  await expect(page.locator('#profile-name')).toHaveValue('Recovered exact Ω name')
  await expect(page.locator('#profile-description')).toHaveValue('Recovered exact description')
  await expect(page.getByRole('region', { name: 'Saved profile conflict', exact: true })).toBeVisible()
  await page.locator('#profile-body > summary').click()
  await expect(page.locator('#body-line-spacing')).toHaveValue('2e')
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('custom-profile-draft-recovery:v1')!).base_revision)).toBe(originRevision)
  await other.close()
})

test('Save-and-create starts the next draft against the completed Save revision', async ({ page }) => {
  await page.goto('/profiles/custom')
  await page.getByRole('button', { name: 'Copy SUC Academic Report', exact: true }).click()
  await page.locator('#profile-name').fill('First saved before creation')
  await page.getByRole('button', { name: 'Copy APA 7 Student Paper', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page.locator('#profile-name')).not.toHaveValue('First saved before creation')
  await page.locator('#profile-name').fill('Second saved without false conflict')
  await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
  await expect(page.getByText('Custom profile saved', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).profiles.map((profile: { name: string }) => profile.name))).toEqual([
    'First saved before creation', 'Second saved without false conflict',
  ])
})

test('editing the target in another tab invalidates an open deletion consent', async ({ page, context }) => {
  await createAndSave(page, 'Deletion consent original')
  await page.getByRole('button', { name: 'Delete profile', exact: true }).first().click()
  const deletion = page.getByRole('alertdialog', { name: 'Delete custom profile?', exact: true })
  await expect(deletion).toBeVisible()
  const other = await context.newPage()
  await other.goto('/profiles/custom')
  await other.getByRole('button', { name: 'Edit', exact: true }).click()
  await other.locator('#profile-name').fill('Newer unseen saved target')
  await other.getByRole('button', { name: 'Save custom profile', exact: true }).click()
  await expect(other.getByText('Custom profile saved', { exact: true })).toBeVisible()
  await deletion.getByRole('button', { name: 'Delete profile', exact: true }).click()
  await expect(deletion).toBeVisible()
  await expect(deletion.getByText('The profile was not deleted (stale-revision). Recheck saved profiles before trying again.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).profiles[0].name)).toBe('Newer unseen saved target')
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click()
  await other.close()
})

test('creation and profile switching keep focus on the visible editor instead of BODY', async ({ page }) => {
  await createAndSave(page, 'Focus first profile')
  await page.getByRole('button', { name: 'Start with blank formatting and APA citation defaults', exact: true }).click()
  await expect(page.locator('#profile-name')).toBeFocused()
  await page.locator('#profile-name').fill('Focus second profile')
  await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
  await expect(page.getByText('Custom profile saved', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
  await expect(page.locator('#profile-name')).toBeFocused()
  const bounds = (await page.locator('#profile-name').boundingBox())!
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height)
})

test('conflict reload preserves saved identity through another update and deletion', async ({ page, context }) => {
  await createAndSave(page, 'Identity profile A')
  const other = await context.newPage()
  await createAndSave(other, 'Identity profile B')
  const identities = await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).profiles.map(
    (profile: { id: string; name: string }) => ({ id: profile.id, name: profile.name }),
  ))
  const aId = identities.find((profile: { name: string }) => profile.name === 'Identity profile A')!.id
  const bId = identities.find((profile: { name: string }) => profile.name === 'Identity profile B')!.id
  await other.locator('li').filter({ hasText: 'Identity profile A' }).getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('#profile-name').fill('Complete local draft A')
  await page.locator('#profile-description').fill('Keep the local description until explicit discard')
  await page.locator('#profile-body > summary').click()
  await page.locator('#body-line-spacing').fill('2e')
  await other.locator('#profile-description').fill('First external saved A')
  await other.getByRole('button', { name: 'Save custom profile', exact: true }).click()
  await expect(other.getByText('Custom profile saved', { exact: true })).toBeVisible()
  const conflict = page.getByRole('region', { name: 'Saved profile conflict', exact: true })
  await expect(conflict).toBeVisible()
  await expect(page.locator('#profile-name')).toHaveValue('Complete local draft A')
  await expect(page.locator('#profile-description')).toHaveValue('Keep the local description until explicit discard')
  await expect(page.locator('#body-line-spacing')).toHaveValue('2e')
  await page.getByRole('button', { name: 'Reload saved version', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(conflict).toHaveCount(0)
  await expect(page.locator('#profile-name')).toHaveValue('Identity profile A')
  await expect(page.locator('#profile-description')).toHaveValue('First external saved A')
  await expect(page.locator('#body-line-spacing')).toHaveValue('1.5')

  // A clean editor must still follow A, not become unbound or select B.
  await other.locator('#profile-description').fill('Second external saved A')
  await other.getByRole('button', { name: 'Save custom profile', exact: true }).click()
  await expect(other.getByText('Custom profile saved', { exact: true })).toBeVisible()
  await expect(page.locator('#profile-description')).toHaveValue('Second external saved A')
  await expect(page.locator('#profile-name')).toHaveValue('Identity profile A')
  const latestRevision = await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).revision)
  await page.locator('#profile-description').fill('Saved A after reload')
  await expect.poll(() => page.evaluate(() => {
    const raw = sessionStorage.getItem('custom-profile-draft-recovery:v1')
    if (!raw) return null
    const recovery = JSON.parse(raw)
    return { id: recovery.profile_id, revision: recovery.base_revision }
  })).toEqual({ id: aId, revision: latestRevision })
  await page.getByRole('button', { name: 'Save custom profile', exact: true }).click()
  await expect(page.getByText('Custom profile saved', { exact: true })).toBeVisible()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).profiles)
  expect(saved.find((profile: { id: string }) => profile.id === aId).description).toBe('Saved A after reload')
  expect(saved.find((profile: { id: string }) => profile.id === bId).name).toBe('Identity profile B')
  await expect(other.locator('#profile-description')).toHaveValue('Saved A after reload')
  await other.getByRole('button', { name: 'Delete profile', exact: true }).last().click()
  await other.getByRole('alertdialog').getByRole('button', { name: 'Delete profile', exact: true }).click()
  await expect(other.getByText('Custom profile deleted', { exact: true })).toBeVisible()
  await expect(page.locator('#profile-name')).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('custom-profiles:active')!).profiles.map(
    (profile: { id: string }) => profile.id,
  ))).toEqual([bId])
  await other.close()
})
