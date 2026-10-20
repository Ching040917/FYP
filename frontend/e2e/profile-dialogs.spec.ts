import { test, expect, type Page, type Locator } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { createSyntheticAudit } from './helpers'

const sizes = [
  { width: 1366, height: 768 }, { width: 1280, height: 800 },
  { width: 1024, height: 768 }, { width: 768, height: 800 },
  { width: 683, height: 768 }, { width: 195, height: 667 },
]

async function openSurface(page: Page, saved: boolean) {
  await page.setViewportSize(sizes[0])
  if (saved) {
    const audit = await createSyntheticAudit(page)
    await page.goto(`/audit/${audit.auditId}`)
    await page.waitForLoadState('networkidle')
  } else await page.goto('/dashboard')
  const trigger = page.getByRole('button', { name: saved ? 'Profile details' : 'Review full requirements', exact: true })
  await trigger.click()
  return { trigger, dialog: page.getByRole('dialog', { name: saved ? 'Profile details' : 'Full profile requirements', exact: true }) }
}

async function assertBounds(page: Page, dialog: Locator) {
  const bounds = await dialog.evaluate(el => {
    const d = el.getBoundingClientRect()
    const body = el.querySelector<HTMLElement>('[data-dialog-body]')!
    const close = el.querySelector('button')!.getBoundingClientRect()
    const header = el.querySelector('h2')!.getBoundingClientRect()
    return { x: d.x, right: d.right, top: d.top, bottom: d.bottom, width: innerWidth, height: innerHeight,
      scroll: el.scrollWidth, client: el.clientWidth, bodyScroll: body.scrollWidth, bodyClient: body.clientWidth,
      closeBottom: close.bottom, headerTop: header.top }
  })
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1)
  expect(bounds.top).toBeGreaterThanOrEqual(0)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1)
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1)
  expect(bounds.bodyScroll).toBeLessThanOrEqual(bounds.bodyClient + 1)
  expect(bounds.closeBottom).toBeLessThanOrEqual(bounds.bottom)
  expect(bounds.headerTop).toBeGreaterThanOrEqual(bounds.top)
}

for (const saved of [false, true]) {
  const surface = saved ? 'saved audit Profile details' : 'current Full profile requirements'
  test(`${surface}: complete groups, responsive bounds and final-item scroll`, async ({ page }) => {
    const { trigger, dialog } = await openSurface(page, saved)
    await page.keyboard.press('Escape')
    const backgroundWidths = new Map<number, number>()
    for (const size of sizes) {
      await page.setViewportSize(size)
      backgroundWidths.set(size.width, await page.evaluate(() => document.documentElement.scrollWidth))
    }
    await page.setViewportSize(sizes[0])
    await trigger.click()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveText([
      'Profile overview', 'Formatting exemptions', 'Scored checks', 'Manual review only', 'Not checked', 'Citation settings',
    ])
    await expect(dialog).toContainText(saved ? 'Saved audit profile.' : 'Currently selected profile.')
    await expect(dialog).toContainText('Cover')
    await expect(dialog).toContainText('Displayed equation')
    await expect(dialog).not.toContainText('DISPLAYED EQUATION')
    await expect(dialog).toContainText('14 enabled')
    await expect(dialog).toContainText('not passed results')
    await expect(dialog).toContainText('Unscored')
    for (const size of sizes) {
      await page.setViewportSize(size)
      await assertBounds(page, dialog)
      // The protected first-use guidance already overflows at 195px; a modal must not add overflow.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(backgroundWidths.get(size.width)! + 1)
      const body = dialog.locator('[data-dialog-body]')
      await body.evaluate(el => { el.scrollTop = el.scrollHeight })
      await expect(dialog.getByRole('heading', { name: 'Citation settings' })).toBeVisible()
      const last = saved ? dialog.getByText('APA 7', { exact: true }) : dialog.locator('[data-profile-scope]')
      const lastBox = (await last.boundingBox())!
      const bodyBox = (await body.boundingBox())!
      expect(lastBox.y).toBeGreaterThanOrEqual(bodyBox.y)
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1)
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport()
      const columns = await dialog.locator('section[aria-label="Scored checks"] [data-requirement-groups]').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)
      expect(columns).toBe(size.width >= 1100 ? 2 : 1)
    }
  })

  test(`${surface}: modality, focus, dismissal and exact body-scroll restoration`, async ({ page }) => {
    const { trigger, dialog } = await openSurface(page, saved)
    const close = dialog.getByRole('button', { name: 'Close', exact: true })
    await expect(close).toBeFocused()
    expect(await dialog.locator('[data-dialog-body]').evaluate(el => el.scrollTop)).toBe(0)
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
    }
    await page.evaluate(() => document.querySelector<HTMLElement>('header a, a')!.focus())
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
    await page.mouse.click(2, 2)
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.evaluate(() => document.body.style.setProperty('overflow', 'scroll', 'important'))
    await trigger.click()
    await expect(close).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await page.evaluate(() => [document.body.style.getPropertyValue('overflow'), document.body.style.getPropertyPriority('overflow')])).toEqual(['scroll', 'important'])
    await trigger.click()
    const axe = await new AxeBuilder({ page }).analyze()
    expect(axe.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([])
    await close.click()
    await expect(trigger).toBeFocused()
  })

  test(`${surface}: removed opener uses a stable visible fallback`, async ({ page }) => {
    const { trigger, dialog } = await openSurface(page, saved)
    await trigger.evaluate(el => el.remove())
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await page.evaluate(() => {
      const focused = document.activeElement as HTMLElement
      return focused !== document.body && focused.isConnected && focused.getBoundingClientRect().width > 0
    })).toBe(true)
  })
}

test('saved Profile details uses stored identity and values, never a live-profile request', async ({ page }) => {
  const audit = await createSyntheticAudit(page)
  const response = await (await page.request.get(`/api/audit/${audit.auditId}`)).json()
  const name = 'Saved historical custom profile for a long departmental thesis requirements review'
  response.profile_snapshot.profile_name = name
  response.profile_snapshot.profile_source = 'custom'
  response.profile_snapshot.description = 'Historical requirements kept after the current profile is edited or deleted.'
  await page.route(`**/api/audit/${audit.auditId}`, route => route.fulfill({ json: response }))
  const liveRequests: string[] = []
  await page.route('**/api/formatting-profiles**', route => { liveRequests.push(route.request().url()); return route.abort() })
  await page.setViewportSize(sizes[0])
  await page.goto(`/audit/${audit.auditId}`)
  await page.getByRole('button', { name: 'Profile details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Profile details', exact: true })
  await expect(dialog).toContainText(name)
  await expect(dialog).toContainText('Custom · Saved snapshot · Read-only')
  await expect(dialog).toContainText('Times New Roman')
  expect(liveRequests).toEqual([])
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.keyboard.press('Escape')
  await page.locator('#ws-tablet-findings li button').first().click()
  await expect(page.getByRole('dialog', { name: 'Finding details', exact: true })).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Close finding details' }).click()
  await page.getByRole('button', { name: 'Profile details', exact: true }).click()
  await expect(dialog).toContainText(name)
})

test('saved formatting exemptions expose separate noninteractive list items without changing the audit', async ({ page }) => {
  const audit = await createSyntheticAudit(page)
  const before = await (await page.request.get(`/api/audit/${audit.auditId}`)).json()
  const writes: string[] = []
  page.on('request', request => {
    if (/^(POST|PUT|PATCH|DELETE)$/.test(request.method()) && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url())
  })
  await page.setViewportSize(sizes[0])
  await page.goto(`/audit/${audit.auditId}`)
  const trigger = page.getByRole('button', { name: 'Profile details', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Profile details', exact: true })
  const list = dialog.getByRole('list', { name: 'Formatting exemptions', exact: true })
  const items = list.getByRole('listitem')
  await expect(items).toHaveText([
    'Cover', 'Displayed equation', 'Empty', 'Field only', 'Figure host', 'Subtitle',
    'Table of contents entry', 'Table of contents heading', 'Title', 'Unknown (no proven content role)',
  ])
  await expect(items).toHaveCount(before.profile_snapshot.role_exemptions.length)
  await expect(list.getByRole('button')).toHaveCount(0)
  await expect(list.getByRole('link')).toHaveCount(0)
  expect(await items.evaluateAll(elements => elements.every(el => (el as HTMLElement).tabIndex < 0))).toBe(true)
  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    expect(await list.evaluate(el => el.contains(document.activeElement))).toBe(false)
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  const after = await (await page.request.get(`/api/audit/${audit.auditId}`)).json()
  expect(after.profile_snapshot).toEqual(before.profile_snapshot)
  expect(after.violations).toEqual(before.violations)
  expect(after.weighted_score).toBe(before.weighted_score)
  expect(after.status).toBe(before.status)
  expect(writes).toEqual([])
})

test('saved formatting exemptions preserve set order, omit empty sections and wrap long unmapped labels', async ({ page }) => {
  const audit = await createSyntheticAudit(page)
  const stored = await (await page.request.get(`/api/audit/${audit.auditId}`)).json()
  // Presentation-only snapshots: these are not backend classification/detection fixtures.
  const longRole = 'A'.repeat(400)
  const cases = [
    { roles: [] as string[], labels: [] as string[] },
    { roles: ['COVER'], labels: ['Cover'] },
    {
      roles: ['TABLE_OF_CONTENTS_HEADING', 'DEPARTMENT_CONTEXT', longRole, 'UNKNOWN', 'COVER', 'COVER', '', '   '],
      labels: ['Table of contents heading', 'Department context', `A${'a'.repeat(399)}`, 'Unknown (no proven content role)', 'Cover'],
    },
  ]
  let roles: string[] = []
  await page.route(`**/api/audit/${audit.auditId}`, route => route.fulfill({
    json: { ...stored, profile_snapshot: { ...stored.profile_snapshot, role_exemptions: roles } },
  }))
  for (const scenario of cases) {
    roles = scenario.roles
    for (const size of [{ width: 1366, height: 768 }, { width: 1024, height: 768 }, { width: 676, height: 339 }]) {
      await page.setViewportSize(size)
      await page.goto(`/audit/${audit.auditId}`)
      await page.getByRole('button', { name: 'Profile details', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Profile details', exact: true })
      const section = dialog.getByRole('region', { name: 'Formatting exemptions', exact: true })
      const list = section.getByRole('list', { name: 'Formatting exemptions', exact: true })
      if (scenario.labels.length === 0) {
        await expect(section).toHaveCount(0)
      } else {
        const items = list.getByRole('listitem')
        await expect(items).toHaveText(scenario.labels)
        await expect(items).toHaveCount(scenario.labels.length)
        for (const item of await items.all()) {
          await item.scrollIntoViewIfNeeded()
          const bounds = await item.evaluate(el => {
            const r = el.getBoundingClientRect()
            const container = el.parentElement!.getBoundingClientRect()
            return { left: r.left, right: r.right, containerLeft: container.left, containerRight: container.right,
              scroll: el.scrollWidth, client: el.clientWidth, height: r.height, line: Number.parseFloat(getComputedStyle(el).lineHeight) }
          })
          expect(bounds.left).toBeGreaterThanOrEqual(bounds.containerLeft - 1)
          expect(bounds.right).toBeLessThanOrEqual(bounds.containerRight + 1)
          expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1)
          if (await item.textContent() === scenario.labels[2] && scenario.labels.length > 1) expect(bounds.height).toBeGreaterThan(bounds.line * 2)
        }
        // A single short item does not stretch across the section.
        if (scenario.labels.length === 1) {
          const item = (await items.first().boundingBox())!
          const container = (await list.boundingBox())!
          expect(Math.abs(item.x - container.x)).toBeLessThanOrEqual(1)
          expect(item.width).toBeLessThan(container.width / 2)
        }
      }
      await assertBounds(page, dialog)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: 'Profile details', exact: true })).toBeFocused()
    }
  }
})
