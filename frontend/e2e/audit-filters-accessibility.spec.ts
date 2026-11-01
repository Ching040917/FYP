/**
 * Audit filter accessible names — verifies the two Select triggers in the
 * Findings list header have distinct, descriptive accessible names.
 * Applies at all supported desktop viewports (no phone dependency).
 */
import { chromium, test, expect, type Locator, type Page } from '@playwright/test'
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

// Deliberately synthetic responses exercise presentation states; they are
// not evidence that the backend produces these score/finding combinations.
const reportFixture = {
  id: 'redesign-report', filename: 'Report interpretation.docx', file_size: 1024,
  weighted_score: 84, deploy_mode: 'LOCAL', status: 'completed',
  created_at: null, completed_at: null, citation_issues: [],
  violations: [
    { id: 'major', rule_code: 'MARGIN_LEFT', severity: 'MAJOR', location: { section_index: 0 }, message: 'Left margin differs.', actual_value: '1 in', expected_value: '1.5 in' },
    { id: 'minor', rule_code: 'FONT_SIZE', severity: 'MINOR', location: { paragraph_index: 1 }, message: 'Font size differs.', actual_value: '10 pt', expected_value: '12 pt' },
    { id: 'review', rule_code: 'CITATION_REFERENCE_AMBIGUOUS', severity: 'REVIEW', location: { paragraph_index: 2, occurrences: 4, paragraph_indexes: [2, 3, 4, 5] }, message: 'Citation is ambiguous.', actual_value: '(Smith, 2024)', expected_value: null },
  ],
  score_breakdown: [
    { category: 'page_margins', label: 'Page Margins', major: 1, minor: 0, deduction: 10, remaining: 90 },
    { category: 'font_size', label: 'Font Size', major: 0, minor: 1, deduction: 6, remaining: 94 },
  ],
}

test('report outcome and score distinguish completion, review, unknown and historical states', async ({ page }) => {
  let response: Record<string, unknown> = reportFixture
  await page.route('**/api/audit/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/document-blocks')) return route.fulfill({ json: { blocks: null } })
    if (pathname.includes('/rendered')) return route.fulfill({ status: 404 })
    return route.fulfill({ json: { ...response, id: pathname.split('/')[3] } })
  })
  const states = [
    { name: 'mixed', patch: {}, outcome: 'Findings need attention', score: '84', counts: '1 Major · 1 Minor · 1 Manual review (unscored)' },
    { name: 'review', patch: { violations: [reportFixture.violations[2]] }, outcome: 'Manual review needed', score: '84', counts: '0 Major · 0 Minor · 1 Manual review (unscored)' },
    { name: 'zero', patch: { violations: [], weighted_score: 100, score_breakdown: [] }, outcome: 'All enabled checks passed', score: '100', counts: '0 Major · 0 Minor · 0 Manual review (unscored)' },
    { name: 'unknown', patch: { violations: [{ ...reportFixture.violations[0], severity: 'LEGACY' }] }, outcome: 'Findings need review', score: '84', counts: '0 Major · 0 Minor · 0 Manual review (unscored) · 1 Unclassified' },
    { name: 'historical', patch: { weighted_score: null, profile_snapshot: null, score_breakdown: [] }, outcome: 'Findings need attention', score: 'Unavailable', counts: '1 Major · 1 Minor · 1 Manual review (unscored)' },
    { name: 'processing', patch: { status: 'processing', violations: [] }, outcome: 'Findings will appear as checks finish', score: 'Not final', counts: '0 Major · 0 Minor · 0 Manual review (unscored)' },
    { name: 'processing-mixed', patch: { status: 'processing' }, outcome: 'Available findings', score: 'Not final', counts: '1 Major · 1 Minor · 1 Manual review (unscored)' },
    { name: 'failed', patch: { status: 'failed', violations: [] }, outcome: 'No findings available from this incomplete audit', score: 'Not final', counts: '0 Major · 0 Minor · 0 Manual review (unscored)' },
  ]
  for (const state of states) {
    response = { ...reportFixture, ...state.patch }
    await page.goto(`/audit/redesign-${state.name}`)
    const header = page.locator('#audit-report > div.border-b')
    await expect(header).toContainText('Enabled-check score')
    await expect(header).toContainText(state.score)
    await expect(page.getByText(state.outcome, { exact: true }).filter({ visible: true }).first()).toBeVisible()
    await expect(header).toContainText('Only enabled scored checks contribute to the score.')
    await expect(header).toContainText(state.counts)
    if (state.score === 'Not final') {
      await expect(header).not.toContainText('/100')
      await expect(header).not.toContainText('All enabled checks passed')
      await expect(header).toContainText('Available findings')
      await expect(header).not.toContainText('Findings need attention')
    }
    if (state.name === 'zero' || state.name === 'historical') {
      const categories = page.getByRole('button', { name: /^Categories/ })
      await categories.focus()
      await page.keyboard.press('Enter')
      const panel = page.getByRole('dialog', { name: 'Filter findings by category', exact: true })
      await expect(state.name === 'zero' ? panel : panel.getByRole('button', { name: 'Review major findings', exact: true })).toBeFocused()
      await expect(panel.getByText('Category summary unavailable', { exact: true })).toBeVisible()
      if (state.name === 'historical') await expect(panel.getByText('Saved requirements unavailable for this older audit', { exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(categories).toBeFocused()
    }
  }
})

test('filters retain inspected context, order and values across responsive layouts', async ({ page }) => {
  const incoming = [reportFixture.violations[2], reportFixture.violations[0], reportFixture.violations[1]]
  const auditPosts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/audit\/?$/.test(new URL(request.url()).pathname)) auditPosts.push(request.url())
  })
  await page.route('**/api/audit/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/document-blocks')) return route.fulfill({ json: { blocks: null } })
    if (pathname.includes('/rendered')) return route.fulfill({ status: 404 })
    return route.fulfill({ json: { ...reportFixture, violations: incoming, id: pathname.split('/')[3] } })
  })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/audit/redesign-filters')
  const rows = page.locator('button[aria-pressed]:visible')
  const expectServerOrder = async () => {
    await expect(rows).toHaveCount(3)
    for (const [index, severity] of ['Manual review', 'Major', 'Minor'].entries()) {
      await expect(rows.nth(index)).toHaveAccessibleName(new RegExp(`, ${severity},`))
    }
  }
  await expectServerOrder()
  await expect(rows.first()).toHaveAttribute('aria-pressed', 'true')
  await rows.nth(1).click()
  const details = page.locator('#ws-panel-details')
  const current = details.locator('dt').filter({ hasText: /^Current$/ }).locator('..').locator('dd')
  const required = details.locator('dt').filter({ hasText: /^Required$/ }).locator('..').locator('dd')
  await expect(current).toBeVisible()
  await expect(required).toBeVisible()
  const currentBox = (await current.boundingBox())!
  const requiredBox = (await required.boundingBox())!
  expect(Math.abs(currentBox.x - requiredBox.x)).toBeLessThanOrEqual(1)
  expect(requiredBox.y).toBeGreaterThanOrEqual(currentBox.y + currentBox.height)
  const severity = page.getByRole('combobox', { name: 'Filter by severity' })
  const category = page.getByRole('combobox', { name: 'Filter by category' })
  const clear = page.getByRole('button', { name: 'Clear filters', exact: true })
  await expect(clear).toHaveCount(0)
  await severity.click()
  await page.getByRole('option', { name: 'Minor', exact: true }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAccessibleName(/Minor/)
  await expect(page.locator('#ws-panel-details h2')).toContainText('Left page margin')
  await expect(page.getByText('Selected finding is outside these filters.', { exact: true })).toBeVisible()
  await expect(severity).toBeFocused()
  await category.click()
  await page.getByRole('option', { name: 'Font Size', exact: true }).click()
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(severity).toContainText('Minor')
  await expect(category).toContainText('Font Size')
  await page.setViewportSize({ width: 768, height: 768 })
  await expect(severity).toContainText('Minor')
  await expect(category).toContainText('Font Size')
  await page.getByRole('button', { name: 'Show selected finding', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('The selected finding is included in these results.')
  await expectServerOrder()
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await expect(severity).toContainText('All severities')
  await expect(category).toContainText('All categories')
  await expect(clear).toHaveCount(0)
  await severity.click()
  await page.getByRole('option', { name: 'Minor', exact: true }).click()
  await category.click()
  await page.getByRole('option', { name: 'Page Margins', exact: true }).click()
  await expect(rows).toHaveCount(0)
  await expect(clear).toBeVisible()
  await clear.focus()
  await expect(clear).toBeFocused()
  await page.keyboard.press('Enter')
  await expectServerOrder()
  await expect(severity).toContainText('All severities')
  await expect(category).toContainText('All categories')
  await expect(severity).toBeFocused()
  await expect(clear).toHaveCount(0)
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true')
  expect(auditPosts).toEqual([])
  // SPA navigation retains the page instance; both active filters must reset.
  await severity.click()
  await page.getByRole('option', { name: 'Minor', exact: true }).click()
  await category.click()
  await page.getByRole('option', { name: 'Font Size', exact: true }).click()
  await page.evaluate(() => {
    window.history.pushState(null, '', '/audit/redesign-next')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(severity).toContainText('All severities')
  await expect(category).toContainText('All categories')
  await expectServerOrder()
  await expect(clear).toHaveCount(0)
})

test('passive audit polling preserves filters, inspected Details and keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  let auditResponses = 0
  let releaseCompletion!: () => void
  const completionAllowed = new Promise<void>((resolve) => { releaseCompletion = resolve })
  const incoming = [reportFixture.violations[1], reportFixture.violations[0], reportFixture.violations[2]]
  await page.route('**/api/audit/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/document-blocks')) return route.fulfill({ json: { blocks: null } })
    if (pathname.includes('/rendered')) return route.fulfill({ status: 404 })
    const responseNumber = ++auditResponses
    if (responseNumber > 1) await completionAllowed
    return route.fulfill({ json: {
      ...reportFixture, id: 'redesign-polling', violations: incoming,
      status: responseNumber === 1 ? 'processing' : 'completed',
    } })
  })
  try {
    await page.goto('/audit/redesign-polling')
    const score = page.getByRole('group', { name: 'Score covers only the enabled checks' })
    await expect(score).toContainText('Not final')
    const rows = page.locator('button[aria-pressed]:visible')
    await expect(rows).toHaveCount(3)
    await rows.nth(1).click()
    const severity = page.getByRole('combobox', { name: 'Filter by severity' })
    const category = page.getByRole('combobox', { name: 'Filter by category' })
    await severity.click()
    await page.getByRole('option', { name: 'Minor', exact: true }).click()
    await category.click()
    await page.getByRole('option', { name: 'Font Size', exact: true }).click()
    await category.focus()
    await expect(category).toBeFocused()
    await expect.poll(() => auditResponses).toBeGreaterThanOrEqual(2)
    releaseCompletion()
    await expect(score).toContainText(/84\s*\/100/)
    await expect(severity).toContainText('Minor')
    await expect(category).toContainText('Font Size')
    await expect(category).toBeFocused()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAccessibleName(/, Minor,/)
    await expect(page.locator('#ws-panel-details h2')).toContainText('Left page margin')
    await expect(page.getByText('Selected finding is outside these filters.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
    await expect(rows).toHaveCount(3)
    for (const [index, expected] of ['Minor', 'Major', 'Manual review'].entries()) {
      await expect(rows.nth(index)).toHaveAccessibleName(new RegExp(`, ${expected},`))
    }
    await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true')
  } finally {
    releaseCompletion()
  }
})

test('compact explicit transitions focus visible tabs and keep one document heading', async ({ page }) => {
  await page.setViewportSize({ width: 676, height: 337 })
  await page.route('**/api/audit/**', async (route) => {
    if (route.request().url().endsWith('/document-blocks')) return route.fulfill({ json: { blocks: null } })
    if (route.request().url().includes('/rendered')) return route.fulfill({ status: 404 })
    return route.fulfill({ json: {
      ...reportFixture,
      violations: reportFixture.violations.map((finding) => finding.severity === 'MINOR'
        ? { ...finding, actual_value: 'Long_unbroken_current_value_'.repeat(40) }
        : finding),
    } })
  })
  await page.goto('/audit/redesign-report')
  const filename = page.locator('summary').filter({ hasText: reportFixture.filename })
  await expect(filename).toBeVisible()
  await page.getByRole('link', { name: 'Skip to audit report' }).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await expect(filename).toBeFocused()
  await expect.poll(() => filename.evaluate((element) =>
    element.getBoundingClientRect().top - document.querySelector('header')!.getBoundingClientRect().bottom,
  )).toBeGreaterThanOrEqual(4)
  for (const severity of ['Minor', 'Manual review']) {
    const row = page.locator(`#panel-findings button[aria-label*="${severity}"]`)
    await row.focus()
    await page.keyboard.press('Enter')
    const details = page.getByRole('tab', { name: 'Details', exact: true })
    await expect(details).toBeFocused()
    await expect(details).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => details.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(79)
    expect(await details.evaluate((el) => Number.parseFloat(getComputedStyle(el).scrollMarginTop))).toBeGreaterThanOrEqual(80)
    // Preserve a 1px native subpixel allowance for the rectangle, not the CSS clearance.
    if (severity === 'Minor') {
      const value = page.locator('#panel-details dd').filter({ hasText: 'Long_unbroken_current_value_' })
      await expect(value).toHaveText('Long_unbroken_current_value_'.repeat(40))
      const geometry = await value.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const detail = el.closest('[aria-label="Finding detail"]')!.getBoundingClientRect()
        return { scroll: el.scrollWidth, client: el.clientWidth, left: r.left, right: r.right,
          detailLeft: detail.left, detailRight: detail.right, height: r.height, line: Number.parseFloat(getComputedStyle(el).lineHeight) }
      })
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1)
      expect(geometry.left).toBeGreaterThanOrEqual(geometry.detailLeft - 1)
      expect(geometry.right).toBeLessThanOrEqual(geometry.detailRight + 1)
      expect(geometry.height).toBeGreaterThan(geometry.line)
    }
    await page.getByRole('button', { name: 'Back to findings', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Findings', exact: true })).toBeFocused()
    await expect.poll(() => page.getByRole('tab', { name: 'Findings', exact: true }).evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(79)
    expect(await page.getByRole('tab', { name: 'Findings', exact: true }).evaluate((el) => Number.parseFloat(getComputedStyle(el).scrollMarginTop))).toBeGreaterThanOrEqual(80)
    await expect(row).toHaveAttribute('aria-pressed', 'true')
  }
  await page.getByRole('combobox', { name: 'Filter by severity' }).click()
  await page.getByRole('option', { name: 'Minor', exact: true }).click()
  await page.getByRole('tab', { name: 'Details', exact: true }).click()
  await expect(page.locator('#panel-details h2')).toContainText('Citation could match more than one entry')
  await page.getByRole('button', { name: 'Show selected finding', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('The selected finding is included in these results.')
  await expect(page.getByRole('tab', { name: 'Details', exact: true })).toBeFocused()
  await expect(page.locator('#panel-details h2')).toContainText('Citation could match more than one entry')
  await page.getByRole('tab', { name: 'Findings', exact: true }).click()
  await expect(page.getByRole('button', { name: /Citation could match more than one entry, Manual review/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('combobox', { name: 'Filter by severity' })).toContainText('All severities')
  await page.keyboard.press('End')
  await expect(page.getByRole('tab', { name: 'Details', exact: true })).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Document', exact: true })).toBeFocused()
  await expect(page.getByRole('heading', { name: 'Document preview', exact: true })).toHaveCount(1)
})

test('a large report keeps its last finding reachable with native scrolling', async ({ page }) => {
  const violations = Array.from({ length: 120 }, (_, index) => ({
    ...reportFixture.violations[1], id: `finding-${index}`,
    location: { paragraph_index: index }, actual_value: `Current_${'unbroken_'.repeat(40)}${index}`,
  }))
  await page.route('**/api/audit/**', async (route) => {
    if (route.request().url().endsWith('/document-blocks')) return route.fulfill({ json: { blocks: null } })
    if (route.request().url().includes('/rendered')) return route.fulfill({ status: 404 })
    return route.fulfill({ json: { ...reportFixture, filename: `${'Long manuscript name '.repeat(8)}.docx`, violations } })
  })
  await page.goto('/audit/redesign-large')
  const rows = page.locator('button[aria-pressed]:visible')
  await expect(rows).toHaveCount(120)
  await rows.last().scrollIntoViewIfNeeded()
  await rows.last().click()
  await expect(rows.last()).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[aria-label="Finding detail"]:visible')).toContainText(violations[119].actual_value)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
})

test('audit loading is named and request failure retains dashboard recovery', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/audit/redesign-loading', async (route) => {
    await pending
    await route.fulfill({ status: 500, json: { detail: 'Audit unavailable for review' } })
  })
  await page.goto('/audit/redesign-loading')
  await expect(page.getByRole('status', { name: 'Loading audit report' })).toBeVisible()
  release()
  await expect(page.getByText('Audit unavailable for review', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Back to Dashboard', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
})

async function openNativePreview(baseURL: string, profile: string, zoom: '1' | '2') {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    reducedMotion: 'reduce',
    args: [
      '--window-size=1051,798',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-pings',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ],
  })
  try {
    await context.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname
      return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort()
    })
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto('chrome://settings/appearance')
    const zoomControl = page.getByRole('combobox', { name: 'Page zoom' })
    await zoomControl.selectOption(zoom)
    await expect(zoomControl).toHaveValue(zoom)

    await page.goto(`${baseURL}/dashboard`)
    const dimensions = await page.evaluate(() => ({ outer: outerWidth, inner: innerWidth }))
    expect(dimensions.inner / dimensions.outer).toBeLessThan(zoom === '2' ? 0.6 : 1.05)
    if (zoom === '1') expect(dimensions.inner / dimensions.outer).toBeGreaterThan(0.9)
    await expect(page.getByText('SUC Academic Report', { exact: true }).first()).toBeVisible()
    const sampleResponse = page.waitForResponse((response) => response.url().endsWith('/samples/sample-thesis.docx'))
    const auditResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/audit' && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Try with the sample thesis' }).click()
    expect((await sampleResponse).status()).toBe(200)
    const response = await auditResponse
    expect(response.status()).toBe(200)
    const audit = await response.json()
    expect(audit.weighted_compliance_score).toBe(62)
    expect(audit.major_count).toBe(5)
    expect(audit.minor_count).toBe(6)
    expect(audit.paragraph_page_mapping).toBeNull()
    const previewResponse = page.waitForResponse((result) =>
      result.url().endsWith(`/api/audit/${audit.audit_id}/rendered-preview`),
    )
    await page.getByRole('button', { name: `View audit ${audit.audit_id}` }).first().click()
    const preview = await previewResponse
    expect(preview.status()).toBe(409)
    expect(preview.headers()['x-preview-error-category']).toBe('preview_disabled')
    return { context, page, auditId: audit.audit_id as string }
  } catch (error) {
    await context.close()
    throw error
  }
}

async function tabUntil(page: Page, selector: string, key: 'Tab' | 'Shift+Tab' = 'Tab') {
  for (let i = 0; i < 90; i++) {
    await page.keyboard.press(key)
    if (await page.evaluate((target) => document.activeElement?.matches(target) ?? false, selector)) return
  }
  throw new Error(`Keyboard focus did not reach ${selector}`)
}

async function expectVisiblePreviewFocus(target: Locator) {
  await expect(target).toBeFocused()
  await expect.poll(() => target.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const header = document.querySelector('header')?.getBoundingClientRect()
    const preview = element.closest('[role="region"][aria-label="Document preview"]')?.getBoundingClientRect()
    if (!header || !preview || !element.matches(':focus-visible')) return false
    const style = getComputedStyle(element)
    const x = rect.left + rect.width / 2
    const points = [rect.top + 3, rect.bottom - 3]
    return style.boxShadow !== 'none'
      && rect.top - 3 >= Math.max(header.bottom, preview.top)
      && rect.bottom + 3 <= Math.min(innerHeight, preview.bottom)
      && points.every((y) => {
        const hit = document.elementFromPoint(x, y)
        return hit !== null && (hit === element || element.contains(hit))
      })
  })).toBe(true)
}

async function obscureFocusedPreviewBlock(page: Page, target: Locator) {
  const box = await target.boundingBox()
  if (!box) throw new Error('Focused paragraph has no visible bounds')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 300)
  await expect.poll(() => target.evaluate((element) =>
    element.getBoundingClientRect().top - document.querySelector('header')!.getBoundingClientRect().bottom,
  )).toBeLessThan(0)
}

async function guidedCandidateLabels(page: Page) {
  await page.getByRole('button', { name: /^Guided Fixes/ }).filter({ visible: true }).first().click()
  const dialog = page.getByRole('dialog', { name: /Guided Fixes/ })
  await expect(dialog).toBeVisible()
  const labels = await dialog.locator('input[type="checkbox"][aria-label]')
    .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label')))
  await dialog.getByRole('button', { name: 'Close Guided Fixes' }).click()
  return labels
}

test('native 200% preview selection keeps keyboard focus visible', async ({ baseURL }, testInfo) => {
  testInfo.setTimeout(120_000)
  if (!baseURL) throw new Error('A task-owned backend and frontend are required')
  const { context, page, auditId } = await openNativePreview(baseURL, testInfo.outputPath('native-200-profile'), '2')
  try {
    const before = await (await page.request.get(`${baseURL}/api/audit/${auditId}`)).json()
    const candidates = await guidedCandidateLabels(page)
    await page.reload()
    await tabUntil(page, '#tab-findings')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Document', exact: true })).toBeFocused()
    await tabUntil(page, '[data-block-index="6"]')
    const middle = page.locator('#panel-document [data-block-index="6"]')
    await expectVisiblePreviewFocus(middle)
    await page.keyboard.press('Enter')
    await expect(middle).toHaveAttribute('aria-pressed', 'true')
    await expectVisiblePreviewFocus(middle)
    await obscureFocusedPreviewBlock(page, middle)
    await page.keyboard.press('Enter')
    await expectVisiblePreviewFocus(middle)

    await tabUntil(page, '[data-block-index="9"]')
    const later = page.locator('#panel-document [data-block-index="9"]')
    await expectVisiblePreviewFocus(later)
    await page.keyboard.press('Space')
    await expect(later).toHaveAttribute('aria-pressed', 'true')
    await expectVisiblePreviewFocus(later)
    await tabUntil(page, '[data-block-index="6"]', 'Shift+Tab')
    await obscureFocusedPreviewBlock(page, middle)
    await page.keyboard.press('Enter')
    await expect(middle).toHaveAttribute('aria-pressed', 'true')
    await expectVisiblePreviewFocus(middle)
    await tabUntil(page, '[data-block-index="0"]', 'Shift+Tab')
    const first = page.locator('#panel-document [data-block-index="0"]')
    await page.keyboard.press('Enter')
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await expectVisiblePreviewFocus(first)
    await tabUntil(page, '[data-block-index="6"]')
    await page.keyboard.press('Enter')
    await expectVisiblePreviewFocus(middle)

    await tabUntil(page, '#tab-document', 'Shift+Tab')
    await page.keyboard.press('ArrowLeft')
    const selectedFinding = page.locator('#panel-findings button[aria-label="Heading levels skip a step, Major, Document paragraph 7"]')
    await expect(selectedFinding).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('ArrowRight')
    await tabUntil(page, '[data-block-index="6"]')
    await expect(middle).toHaveAttribute('aria-pressed', 'true')
    await expectVisiblePreviewFocus(middle)

    let leftPreview = false
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab')
      if (await page.evaluate(() => !document.activeElement?.closest('[role="region"][aria-label="Document preview"]'))) {
        leftPreview = true
        break
      }
    }
    expect(leftPreview).toBe(true)
    expect(await (await page.request.get(`${baseURL}/api/audit/${auditId}`)).json()).toEqual(before)
    expect(await guidedCandidateLabels(page)).toEqual(candidates)
  } finally {
    await context.close()
  }
})

test('native 100% preview preserves modal focus and pointer selection', async ({ baseURL }, testInfo) => {
  testInfo.setTimeout(120_000)
  if (!baseURL) throw new Error('A task-owned backend and frontend are required')
  const { context, page, auditId } = await openNativePreview(baseURL, testInfo.outputPath('native-100-profile'), '1')
  try {
    const before = await (await page.request.get(`${baseURL}/api/audit/${auditId}`)).json()
    const candidates = await guidedCandidateLabels(page)
    await page.reload()
    await tabUntil(page, '[data-block-index="6"]')
    const middle = page.locator('#ws-tablet-document [data-block-index="6"]')
    await expectVisiblePreviewFocus(middle)
    await page.keyboard.press('Enter')
    const detail = page.getByRole('dialog', { name: 'Finding details' })
    await expect(detail).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close finding details' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(middle).toHaveAttribute('aria-pressed', 'true')
    await expectVisiblePreviewFocus(middle)

    const pointer = page.locator('#ws-tablet-document [data-block-index="4"]')
    await pointer.click()
    await expect(detail).toBeVisible()
    await expect(pointer).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    const finding = page.locator('#ws-tablet-findings button[aria-label="Font size does not match, Minor, Document paragraph 5"]')
    await expect(finding).toHaveAttribute('aria-pressed', 'true')
    expect(await (await page.request.get(`${baseURL}/api/audit/${auditId}`)).json()).toEqual(before)
    expect(await guidedCandidateLabels(page)).toEqual(candidates)
  } finally {
    await context.close()
  }
})
