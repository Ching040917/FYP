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
