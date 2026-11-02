/**
 * Scrollable regions — verifies the two meaningful scrollable regions in
 * the Audit view are keyboard accessible without excessive tab stops.
 */
import { test, expect } from '@playwright/test'
import { createSyntheticAudit, annotate } from './helpers'

test.describe('scrollable regions — keyboard access @a11y', () => {
  test('detail and preview regions are focusable and scrollable via keyboard', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'SCROLL-KEYBOARD',
      objective: 'The extracted preview owns keyboard scrolling when rendered preview is unavailable.',
      precondition: 'Completed synthetic audit with findings; desktop viewport (≥1280).',
      steps: ['Create audit via API', 'Tab to the extracted preview', 'Scroll with keyboard', 'Check paragraph focus and pointer selection'],
      expected: 'The preview scrolls without moving the window or hiding keyboard focus.',
      severity: 'medium',
    })
    const summary = await createSyntheticAudit(page)
    const renderedResponse = await page.request.get(`/api/audit/${summary.auditId}/rendered-preview`)
    expect(renderedResponse.status()).toBe(409)
    expect(renderedResponse.headers()['x-preview-error-category']).toBe('preview_disabled')
    await page.goto(`/audit/${summary.auditId}`)
    await page.waitForLoadState('networkidle')

    const banner = page.getByRole('region', { name: 'Rendered document preview', exact: true })
    await expect(banner).toBeVisible()
    await expect(banner).not.toHaveAttribute('tabindex', '0')
    await expect(banner).toContainText('Page-rendered preview is unavailable. The extracted-text preview remains available.')
    const bannerScroll = await banner.evaluate((element) => ({
      client: element.clientHeight,
      height: element.scrollHeight,
      overflow: getComputedStyle(element).overflowY,
    }))
    expect(bannerScroll.height).toBeLessThanOrEqual(bannerScroll.client + 1)
    expect(['auto', 'scroll']).not.toContain(bannerScroll.overflow)

    const preview = page.getByRole('region', { name: 'Document preview', exact: true })
    await expect(preview).toHaveCount(1)
    await expect(preview).toHaveAttribute('tabindex', '0')
    const maxScroll = await preview.evaluate((element) => element.scrollHeight - element.clientHeight)
    expect(maxScroll).toBeGreaterThan(0)
    const scrollTop = () => preview.evaluate((element) => element.scrollTop)
    const waitForScrollIdle = async () => {
      let previous = await scrollTop()
      let stable = 0
      await expect.poll(async () => {
        const current = await scrollTop()
        stable = Math.abs(current - previous) < 0.1 ? stable + 1 : 0
        previous = current
        return stable
      }, { timeout: 5000, intervals: [100] }).toBeGreaterThanOrEqual(3)
    }
    const pressScrollKey = async (key: string) => {
      await waitForScrollIdle()
      const end = preview.evaluate((element) => {
        const { promise, resolve } = Promise.withResolvers<number>()
        element.addEventListener('scrollend', () => resolve(element.scrollTop), { once: true })
        return promise
      })
      await page.keyboard.press(key)
      await end
      await waitForScrollIdle()
      return scrollTop()
    }
    const focusedBlockVisible = () => preview.evaluate((container) => {
      const focused = document.activeElement
      if (!(focused instanceof HTMLElement) || !container.contains(focused)) return false
      const rect = focused.getBoundingClientRect()
      const bounds = container.getBoundingClientRect()
      const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0
      const top = Math.max(bounds.top + container.clientTop, header, 0)
      const bottom = Math.min(bounds.top + container.clientTop + container.clientHeight, window.innerHeight)
      return rect.bottom > top && rect.top < bottom
    })

    for (let i = 0; i < 100 && !(await preview.evaluate((element) => element === document.activeElement)); i++) {
      await page.keyboard.press('Tab')
    }
    await expect(preview).toBeFocused()
    expect(await preview.evaluate((element) => element.matches(':focus-visible') && getComputedStyle(element).boxShadow !== 'none')).toBe(true)
    const windowY = await page.evaluate(() => window.scrollY)
    await page.keyboard.press('Home')
    await expect.poll(scrollTop).toBeLessThanOrEqual(1)
    const down = await pressScrollKey('PageDown')
    expect(down).toBeGreaterThan(1)
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - windowY)).toBeLessThanOrEqual(1)
    const up = await pressScrollKey('PageUp')
    expect(up).toBeLessThan(down)
    const end = await pressScrollKey('End')
    expect(Math.abs(end - maxScroll)).toBeLessThanOrEqual(1)
    const home = await pressScrollKey('Home')
    expect(home).toBeLessThanOrEqual(1)
    const arrowDown = await pressScrollKey('ArrowDown')
    expect(arrowDown).toBeGreaterThan(0)
    const arrowUp = await pressScrollKey('ArrowUp')
    expect(arrowUp).toBeLessThan(arrowDown)
    await expect(preview).toBeFocused()
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - windowY)).toBeLessThanOrEqual(1)

    await page.keyboard.press('Shift+Tab')
    await expect(preview).not.toBeFocused()
    await page.keyboard.press('Tab')
    await expect(preview).toBeFocused()
    await page.keyboard.press('Tab')
    const blocks = preview.locator('button[data-block-index]')
    expect(await blocks.count()).toBeGreaterThan(1)
    const first = blocks.first()
    const last = blocks.last()
    await expect(first).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    for (const key of ['PageDown', 'End', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown']) {
      await pressScrollKey(key)
      await expect(first).toBeFocused()
      expect(await focusedBlockVisible()).toBe(true)
    }
    for (let i = 0; i < 100 && !(await last.evaluate((element) => element === document.activeElement)); i++) {
      await page.keyboard.press('Tab')
    }
    await expect(last).toBeFocused()
    for (const key of ['PageUp', 'Home', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp']) {
      await pressScrollKey(key)
      await expect(last).toBeFocused()
      expect(await focusedBlockVisible()).toBe(true)
    }
    await page.keyboard.press('Tab')
    expect(await preview.evaluate((element) => element.contains(document.activeElement))).toBe(false)
    await page.keyboard.press('Shift+Tab')
    await expect(last).toBeFocused()

    const beforeWheel = await scrollTop()
    const bounds = await preview.boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    await page.mouse.wheel(0, -300)
    await expect.poll(scrollTop).toBeLessThan(beforeWheel)
    const pointerBlock = blocks.nth(1)
    await pointerBlock.click()
    await expect(pointerBlock).toHaveAttribute('aria-pressed', 'true')

    const detailRegion = page.getByRole('region', { name: 'Finding details' }).first()
    await expect(detailRegion).toBeVisible()
    await expect(detailRegion).toHaveAttribute('tabindex', '0')
    expect(await detailRegion.getAttribute('aria-label')).not.toBe(await preview.getAttribute('aria-label'))
    for (let i = 0; i < 100 && !(await detailRegion.evaluate((element) => element === document.activeElement)); i++) {
      await page.keyboard.press('Tab')
    }
    await expect(detailRegion).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(detailRegion).toBeFocused()
  })
})
