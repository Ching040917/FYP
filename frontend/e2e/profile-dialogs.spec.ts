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
      'Profile overview', 'Scored checks', 'Manual review only', 'Not checked', 'Formatting exemptions', 'Profile information',
    ])
    const context = dialog.getByText(saved ? 'Saved audit configuration · Read-only. Later profile edits or deletion do not change this snapshot.' : 'Selected profile for your next audit · Read-only. No document results are shown here.', { exact: true })
    await expect(context).toBeVisible()
    await expect(dialog).toContainText('Cover')
    await expect(dialog).toContainText('Displayed equation')
    await expect(dialog).not.toContainText('DISPLAYED EQUATION')
    await expect(dialog.getByRole('region', { name: 'Scored checks', exact: true })).toContainText('14 configured items')
    await expect(dialog).toContainText('not passed results')
    await expect(dialog).toContainText('Unscored')
    const densities = new Map<number, number>()
    for (const size of sizes) {
      await page.setViewportSize(size)
      await assertBounds(page, dialog)
      // The protected first-use guidance already overflows at 195px; a modal must not add overflow.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(backgroundWidths.get(size.width)! + 1)
      const body = dialog.locator('[data-dialog-body]')
      await body.evaluate(el => { el.scrollTop = el.scrollHeight })
      await expect(context).toBeInViewport()
      const last = saved ? dialog.locator('summary').filter({ hasText: 'Profile description' }) : dialog.locator('[data-profile-scope]')
      const lastBox = (await last.boundingBox())!
      const bodyBox = (await body.boundingBox())!
      expect(lastBox.y).toBeGreaterThanOrEqual(bodyBox.y)
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1)
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport()
      const layout = await dialog.locator('section[aria-label="Scored checks"] [data-requirement-groups]').evaluate(el => {
        const groups = Array.from(el.children).map(child => child.getBoundingClientRect())
        return { width: el.clientWidth, minimum: 20 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
          widths: groups.map(group => group.width), columns: new Set(groups.map(group => Math.round(group.x))).size }
      })
      for (const width of layout.widths) expect(width).toBeGreaterThanOrEqual(Math.min(layout.minimum, layout.width) - 1)
      if (densities.has(layout.width)) expect(layout.columns).toBe(densities.get(layout.width))
      densities.set(layout.width, layout.columns)
      expect(layout.columns).toBe(layout.width >= layout.minimum * 2 + 16 ? 2 : 1)
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

  test(`${surface}: disclosure focus stays visible in both directions without scrolling the background`, async ({ page }) => {
    const { trigger, dialog } = await openSurface(page, saved)
    const body = dialog.locator('[data-dialog-body]')
    const summary = dialog.locator('summary').filter({ hasText: 'Profile description' })
    for (const size of [sizes[0], sizes[2], { width: 683, height: 384 }]) {
      await page.setViewportSize(size)
      await body.evaluate(el => { el.scrollTop = 0 })
      const background = await page.evaluate(() => window.scrollY)
      await dialog.getByRole('button', { name: 'Close', exact: true }).focus()
      await page.keyboard.press('Tab')
      await expect(body).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(summary).toBeFocused()
      const visibleFocus = async () => {
        const focus = (await summary.boundingBox())!
        const viewport = (await body.boundingBox())!
        expect(focus.y).toBeGreaterThanOrEqual(viewport.y)
        expect(focus.y + focus.height).toBeLessThanOrEqual(viewport.y + viewport.height)
        expect(await page.evaluate(() => window.scrollY)).toBe(background)
      }
      await visibleFocus()
      await page.keyboard.press('Enter')
      await expect(dialog.locator('details')).toHaveJSProperty('open', true)
      await expect(summary).toBeFocused()
      await page.keyboard.press('Space')
      await expect(dialog.locator('details')).toHaveJSProperty('open', false)
      await body.evaluate(el => { el.scrollTop = 0 })
      await dialog.getByRole('button', { name: 'Close', exact: true }).focus()
      await page.keyboard.press('Shift+Tab')
      await expect(summary).toBeFocused()
      await visibleFocus()
      await body.evaluate(el => { el.scrollTop = el.scrollHeight })
      await page.keyboard.press('Tab')
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    }
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    await trigger.click()
    expect(await body.evaluate(el => el.scrollTop)).toBe(0)
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

test('saved exemptions preserve unknown evidence and keep long values within the dialog', async ({ page }) => {
  const audit = await createSyntheticAudit(page)
  const stored = await (await page.request.get(`/api/audit/${audit.auditId}`)).json()
  // Presentation-only snapshots: these are not backend classification/detection fixtures.
  const longRole = 'A'.repeat(400)
  const cases = [
    [] as string[],
    ['COVER'],
    ['TABLE_OF_CONTENTS_HEADING', 'DEPARTMENT_CONTEXT', longRole, 'UNKNOWN', 'COVER', 'COVER', '', '   '],
  ]
  let roles: string[] = []
  await page.route(`**/api/audit/${audit.auditId}`, route => route.fulfill({
    json: { ...stored, profile_snapshot: { ...stored.profile_snapshot, role_exemptions: roles } },
  }))
  for (const scenario of cases) {
    roles = scenario
    for (const size of [{ width: 1366, height: 768 }, { width: 1024, height: 768 }, { width: 676, height: 339 }]) {
      await page.setViewportSize(size)
      await page.goto(`/audit/${audit.auditId}`)
      await page.getByRole('button', { name: 'Profile details', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Profile details', exact: true })
      const section = dialog.getByRole('region', { name: 'Formatting exemptions', exact: true })
      const list = section.getByRole('list', { name: 'Formatting exemptions', exact: true })
      const expectedCount = new Set(roles.filter(role => role.trim())).size
      if (expectedCount === 0) {
        await expect(list).toHaveCount(0)
        await expect(section.locator('input, select, button')).toHaveCount(0)
      } else {
        const items = list.getByRole('listitem')
        await expect(items).toHaveCount(expectedCount)
        if (roles.includes('DEPARTMENT_CONTEXT')) {
          await expect(items.filter({ hasText: 'DEPARTMENT_CONTEXT' })).toHaveCount(1)
          await expect(items.filter({ hasText: longRole })).toHaveCount(1)
        }
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
          if ((await item.textContent())?.includes(longRole)) expect(bounds.height).toBeGreaterThan(bounds.line * 2)
        }
      }
      await assertBounds(page, dialog)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: 'Profile details', exact: true })).toBeFocused()
    }
  }
})

test('current unavailable payload discloses a summary only, without invented configuration groups', async ({ page }) => {
  await page.route('**/api/formatting-profiles/*/payload', route => route.fulfill({ status: 503, json: {} }))
  const { dialog, trigger } = await openSurface(page, false)
  await expect(dialog).toContainText('Full profile settings unavailable. Only the listed summary requirements are shown.')
  await expect(dialog).toContainText('Selected profile for your next audit · Read-only.')
  await expect(dialog.getByRole('heading', { name: 'SUC Academic Report', exact: true })).toBeVisible()
  await expect(dialog.getByRole('region', { name: /Scored checks|Manual review only|Not checked/ })).toHaveCount(0)
  await expect(dialog).not.toContainText('configured items')
  await expect(dialog.getByRole('listitem')).toContainText([
    'Margins: Not checked', 'Times New Roman 12 pt', '1.5 line spacing', 'double line spacing',
    'Headers: Not checked', 'Footers: Not checked', 'Page numbers: Not checked',
  ])
  const axe = await new AxeBuilder({ page }).analyze()
  expect(axe.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([])
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})

for (const saved of [false, true]) {
  test(`${saved ? 'saved' : 'current'} empty configuration groups contain no placeholder requirements`, async ({ page }) => {
    const audit = await createSyntheticAudit(page)
    const stored = await (await page.request.get(`/api/audit/${audit.auditId}`)).json()
    const snapshot = {
      ...stored.profile_snapshot, body: {}, heading: {}, captions: {}, lists: {},
      description: '', role_exemptions: [],
      margins: { left_in: null, right_in: null, top_in: null, bottom_in: null },
      references: {}, headers: {}, footers: {}, page_numbers: {},
      citation_matching: {
        check_citations_have_references: false, check_references_are_cited: false,
        check_author_year_consistency: false, check_year_suffixes: false,
        check_duplicate_references: false, flag_ambiguous_matches: false,
        allow_personal_communication: false,
      },
    }
    if (saved) {
      await page.route(`**/api/audit/${audit.auditId}`, route => route.fulfill({ json: { ...stored, profile_snapshot: snapshot } }))
    } else {
      const payload = {
        ...snapshot, heading: { inherit_body_font: false },
        role_policy: { exempt_roles: [], table_eligibility: 'administrative' },
      }
      await page.route('**/api/formatting-profiles/*/payload', route => route.fulfill({ json: { profile: payload } }))
    }
    await page.goto(saved ? `/audit/${audit.auditId}` : '/dashboard')
    await page.getByRole('button', { name: saved ? 'Profile details' : 'Review full requirements', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: saved ? 'Profile details' : 'Full profile requirements', exact: true })
    for (const name of ['Scored checks', 'Manual review only']) {
      const section = dialog.getByRole('region', { name, exact: true })
      await expect(section.getByRole('listitem')).toHaveCount(0)
      await expect(section.getByRole('list')).toHaveCount(0)
      await expect(section.getByText('None', { exact: true })).toBeVisible()
      await expect(section).toContainText('0 configured items')
    }
    await expect(dialog.getByRole('region', { name: 'Not checked', exact: true })).toContainText('Headers: Not checked')
    await expect(dialog.locator('summary')).toHaveCount(0)
    await assertBounds(page, dialog)
  })
}

test('historical partial metadata stays truthful and absent history never loads a current profile', async ({ page }) => {
  const audit = await createSyntheticAudit(page)
  const stored = await (await page.request.get(`/api/audit/${audit.auditId}`)).json()
  let snapshot = {
    ...stored.profile_snapshot, profile_source: 'Unfamiliar source', table_eligibility: 'Unfamiliar table policy',
    profile_version: null, description: '', citation_style: '',
    headers: undefined, footers: undefined, page_numbers: undefined,
    references: { line_spacing: 2 },
  }
  const liveRequests: string[] = []
  await page.route('**/api/formatting-profiles**', route => { liveRequests.push(route.request().url()); return route.abort() })
  await page.route(`**/api/audit/${audit.auditId}`, route => route.fulfill({ json: { ...stored, profile_snapshot: snapshot } }))
  await page.goto(`/audit/${audit.auditId}`)
  await page.getByRole('button', { name: 'Profile details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Profile details', exact: true })
  await expect(dialog).toContainText('Unfamiliar source · Saved snapshot · Read-only')
  await expect(dialog).toContainText('Unfamiliar table policy')
  await expect(dialog.getByRole('term').filter({ hasText: 'Version' })).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: 'Profile information', exact: true })).toContainText('Not recorded')
  await expect(dialog.getByRole('region', { name: 'Scored checks', exact: true })).toContainText('double line spacing')
  const off = dialog.getByRole('region', { name: 'Not checked', exact: true })
  for (const text of ['Headers: Not checked', 'Footers: Not checked', 'Page numbers: Not checked']) await expect(off).toContainText(text)
  await page.keyboard.press('Escape')
  snapshot = null
  await page.reload()
  await expect(page.getByRole('button', { name: 'Profile details', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /^Categories/ }).click()
  await expect(page.getByText('Saved requirements unavailable for this older audit', { exact: true })).toBeVisible()
  expect(liveRequests).toEqual([])
})

test('current exemptions normalize a set without hiding unfamiliar roles or making them controls', async ({ page }) => {
  await page.route('**/api/formatting-profiles/*/payload', async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.profile.role_policy.exempt_roles = ['UNKNOWN', 'DEPARTMENT_CONTEXT', 'COVER', 'UNKNOWN', '', '   ']
    await route.fulfill({ json: body })
  })
  const { dialog } = await openSurface(page, false)
  const list = dialog.getByRole('list', { name: 'Formatting exemptions', exact: true })
  await expect(list.getByRole('listitem')).toHaveCount(3)
  await expect(list.getByRole('listitem').filter({ hasText: 'DEPARTMENT_CONTEXT' })).toHaveCount(1)
  await expect(list.locator('button, a, input, select, textarea, [tabindex]')).toHaveCount(0)
})

test('a fully configured profile presents an empty Not checked section without a false requirement', async ({ page }) => {
  const audit = await createSyntheticAudit(page)
  const stored = await (await page.request.get(`/api/audit/${audit.auditId}`)).json()
  const snapshot = {
    ...stored.profile_snapshot, body: {}, heading: {}, captions: {}, lists: {},
    margins: { left_in: 1, right_in: 1, top_in: 1, bottom_in: 1 },
    references: {
      check_heading_text: true, heading_text: 'References', check_heading_bold: true,
      check_heading_alignment: true, heading_alignment: 'center', check_start_on_new_page: true,
      check_hanging_indent: true, hanging_indent_in: 0.5, check_line_spacing: true, line_spacing: 2,
      check_space_before: true, space_before_pt: 0, check_space_after: true, space_after_pt: 0,
      check_font_family: true, font_family: 'Times New Roman', check_font_size: true, font_size_pt: 12,
      check_alignment: true, alignment: 'left', check_reference_order: true, check_doi_format: true,
    },
    citation_matching: {
      check_citations_have_references: true, check_references_are_cited: true,
      check_author_year_consistency: true, check_year_suffixes: true,
      check_duplicate_references: true, flag_ambiguous_matches: true,
    },
    headers: { check_header_requirements: true }, footers: { check_footer_requirements: true },
    page_numbers: { check_page_number_requirements: true },
  }
  await page.route(`**/api/audit/${audit.auditId}`, route => route.fulfill({ json: { ...stored, profile_snapshot: snapshot } }))
  await page.goto(`/audit/${audit.auditId}`)
  await page.getByRole('button', { name: 'Profile details', exact: true }).click()
  const section = page.getByRole('dialog', { name: 'Profile details', exact: true }).getByRole('region', { name: 'Not checked', exact: true })
  await expect(section.getByRole('listitem')).toHaveCount(0)
  await expect(section.getByRole('list')).toHaveCount(0)
  await expect(section.getByText('None', { exact: true })).toBeVisible()
  await expect(section).toContainText('0 configured items')
})
