/**
 * Scenario 1 — Navigation and responsive shell at 1366x768, 1280x800,
 * 1024x768 (Windows desktop viewports). Evidence screenshots land in the
 * ignored e2e/screenshots dir.
 *
 * Route-aware notes:
 *   - App pages (/dashboard, /history, /profiles/custom) render the AppNav
 *     <header>. At supported desktop widths (≥1024) labels are visible
 *     (hidden only below the unsupported 640px breakpoint).
 *   - Landing (/) has a marketing header whose nav holds in-page anchors;
 *     Dashboard/History live in the footer. AppNav is not rendered there.
 */
import { test, expect, type Locator } from '@playwright/test'
import { expectNoHorizontalOverflow, evidenceShot, annotate } from './helpers'

interface NavTarget {
  /** href used to address the link unambiguously. */
  href: string
  /** Accessible name expected where visible labels exist (Landing footer). */
  name?: string
}

interface ShellRoute {
  path: string
  label: string
  reachable: NavTarget[]
  // href expected to carry aria-current="page" in the header nav (AppNav pages).
  currentPageHref?: string
}

const LANDING_TARGETS: NavTarget[] = [
  { href: '#checks', name: 'Checks' },
  { href: '/dashboard', name: 'Dashboard' },
  { href: '/history', name: 'History' },
]

const APP_TARGETS: NavTarget[] = [
  { href: '/' },
  { href: '/dashboard' },
  { href: '/history' },
]

const ROUTES: ShellRoute[] = [
  { path: '/', label: 'landing', reachable: LANDING_TARGETS },
  { path: '/dashboard', label: 'dashboard', reachable: APP_TARGETS, currentPageHref: '/dashboard' },
  { path: '/history', label: 'history', reachable: APP_TARGETS, currentPageHref: '/history' },
  {
    path: '/profiles/custom',
    label: 'profiles-custom',
    reachable: APP_TARGETS,
    // Documented decision: ProfileEditor keeps the existing visual
    // "dashboard section" highlight unchanged (business behaviour), so no
    // separate current-page assertion is made here; the wrong-token check
    // below still applies globally.
  },
]

test.describe('navigation + responsive shell @responsive', () => {
  for (const route of ROUTES) {
    test(`shell: ${route.path} renders without overflow, nav reachable, truthful aria-current`, async ({ page }, testInfo) => {
      annotate(testInfo, {
        id: `NAV-${route.label.toUpperCase()}`,
        objective: `Route ${route.path} renders without horizontal overflow; primary navigation is keyboard-reachable; aria-current reflects the truly active route.`,
        precondition: 'App served at 127.0.0.1:5173 against an isolated backend; synthetic data only.',
        steps: [
          `Open ${route.path}`,
          'Measure document scrollWidth vs clientWidth',
          'Focus each primary navigation link',
          'Read aria-current attributes',
          'Check bounding boxes of major controls stay within viewport width',
        ],
        expected:
          'No horizontal overflow; every primary nav link focusable; active route exposes aria-current="page"; no incorrect aria-current token anywhere.',
        severity: 'high',
      })

      await page.goto(route.path)
      await page.waitForLoadState('networkidle')
      await expect(page.getByRole('banner').first()).toBeVisible()

      // 1. No document-level horizontal overflow.
      const m = await expectNoHorizontalOverflow(page)

      // 2. Primary navigation links remain reachable and unclipped.
      for (const target of route.reachable) {
        let link: Locator
        if (target.name) {
          link = page.getByRole('link', { name: target.name, exact: true }).first()
        } else {
          link = page.getByRole('banner').first().locator(`a[href="${target.href}"]`).first()
        }
        await link.focus()
        await expect(link).toBeFocused()
        const box = await link.boundingBox()
        expect(box, `${target.href || target.name} link must be rendered`).not.toBeNull()
        expect(box!.y).toBeGreaterThanOrEqual(-1)
        expect(box!.x).toBeGreaterThanOrEqual(-1)
        expect(box!.x + box!.width).toBeLessThanOrEqual(m.clientWidth + 1)
      }

      // 3. Truthful aria-current state.
      if (route.currentPageHref) {
        const inHeader = page.getByRole('banner').first().locator(`a[href="${route.currentPageHref}"]`).first()
        await expect(inHeader).toHaveAttribute('aria-current', 'page')
      }
      const wrongCurrents = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[aria-current]'))
          .map((a) => ({ href: (a as HTMLAnchorElement).getAttribute('href'), value: a.getAttribute('aria-current') }))
          .filter((x) => x.value !== 'page'),
      )
      expect(wrongCurrents, 'no link may expose an incorrect aria-current token').toEqual([])

      // 4. No history/home misattribution on routes without their own entry.
      if (!route.currentPageHref) {
        const currents = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[aria-current="page"]')).map((a) => (a as HTMLAnchorElement).getAttribute('href')),
        )
        expect(currents).not.toContain('/history')
        expect(currents).not.toContain('/')
      }

      await evidenceShot(page, `shell-${route.label}-${testInfo.project.name}.png`)
    })
  }
})

test('Landing keeps the principal links and footer without a second audit CTA', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Start an audit', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open Dashboard', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Start an audit', exact: true })).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'View audit history', exact: true })).toHaveCount(1)
  await expect(page.getByText('No uncontrolled or in-place document rewriting. Eligible fixes require review and create a separate corrected copy.', { exact: true })).toBeVisible()
})

test('Landing explains how eligible fixes preserve the original', async ({ page }) => {
  await page.goto('/')
  const privacy = page.locator('#privacy')
  await expect(privacy.getByRole('heading', { name: 'Local-first and original-preserving', exact: true })).toBeVisible()
  await expect(privacy.getByText('Original document preserved', { exact: true })).toBeVisible()
  await expect(privacy.getByText('Your original DOCX is preserved. Eligible fixes require review and are written to a separate corrected copy.', { exact: true })).toBeVisible()
})

for (const route of ['/dashboard', '/history', '/profiles/custom']) {
  test(`shared footer on ${route} describes guided corrections without changing the original`, async ({ page }) => {
    await page.goto(route)
    const footer = page.getByRole('contentinfo')
    await expect(footer.getByText(/Detection, location, and guided corrections while preserving the original document\./)).toBeVisible()
    await expect(footer.getByText('Local-first processing · original document preserved', { exact: true })).toBeVisible()
    await expect(footer.getByText(/suggestions only|never rewriting|read-only document review/i)).toHaveCount(0)
  })
}

test('retained Dashboard and History links start at the top and preserve browser Back', async ({ page }) => {
  await page.goto('/')
  const footer = page.getByRole('contentinfo')
  const scrollY = () => page.evaluate(() => window.scrollY)
  const destination = [
    { name: 'Dashboard', path: '/dashboard', main: '#dashboard-main' },
    { name: 'History', path: '/history', main: '#history-main' },
  ]

  for (const entry of destination) {
    const link = footer.getByRole('link', { name: entry.name, exact: true })
    await link.scrollIntoViewIfNeeded()
    await expect.poll(scrollY).toBeGreaterThan(400)
    const previousScroll = await scrollY()
    if (entry.name === 'Dashboard') {
      await link.focus()
      await expect(link).toBeFocused()
      expect(await link.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none')
      await page.keyboard.press('Enter')
    } else {
      await link.click()
    }
    await expect(page).toHaveURL(new RegExp(`${entry.path}$`))
    await expect(page.locator(entry.main)).toBeVisible()
    await expect.poll(scrollY).toBe(0)
    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await expect.poll(scrollY).toBe(previousScroll)
  }

  await page.getByRole('link', { name: 'Start an audit', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect.poll(scrollY).toBe(0)
  await footer.getByRole('link', { name: 'History', exact: true }).click()
  await expect(page).toHaveURL(/\/history$/)
  await expect.poll(scrollY).toBe(0)
  await page.goBack()
  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('link', { name: 'View audit history', exact: true }).click()
  await expect(page).toHaveURL(/\/history$/)
  await expect.poll(scrollY).toBe(0)
})
