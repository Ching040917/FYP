/**
 * Vertical space — the Audit workspace must use the remaining browser height.
 *
 * Contract under test (one shared workspace height for every panel):
 *   - the workspace starts below the compact report header and ends a small
 *     intentional gap above the viewport bottom (remaining-height layout)
 *   - Findings, Document preview and Finding details share identical top and
 *     bottom coordinates and stretch to the workspace height
 *   - collapsing a panel or entering focus mode never changes that height
 *   - Fit page uses the taller document viewport to draw a LARGER complete
 *     page (no clipping, no internal scroll); Fit width keeps its own
 *     width-only math (vertical scrolling expected) and benefits from collapse
 *   - each region keeps its own scrollbar
 *
 * Synthetic data only (committed sample thesis through the backend API). The
 * rendered PDF viewer is optional in the e2e environment, so viewer-specific
 * assertions are skipped when the page/fit toolbar is unavailable.
 */
import { test, expect, type Page } from '@playwright/test'
import { createSyntheticAudit, expectNoHorizontalOverflow, annotate } from './helpers'

const VIEWPORTS: Array<{ width: number; height: number; label: string }> = [
  { width: 1366, height: 768, label: '1366x768' },
  { width: 1280, height: 800, label: '1280x800' },
  { width: 1024, height: 768, label: '1024x768' },
]

/** Safe gap kept below the workspace so panels never touch the viewport edge. */
const MAX_BOTTOM_GAP_PX = 16
/** The workspace must own this share of the viewport height (measured 74–79%). */
const MIN_WORKSPACE_SHARE = 0.7
/** Two compact toolbar rows (19px title line + 4px gap + 36px controls). */
const MAX_PREVIEW_TOOLBAR_PX = 74

interface Geometry {
  readonly viewportHeight: number
  readonly headerHeight: number
  readonly workspaceTop: number
  readonly workspaceBottom: number
  readonly workspaceHeight: number
  readonly findings: { top: number; bottom: number; height: number } | null
  readonly preview: { top: number; bottom: number; height: number } | null
  readonly details: { top: number; bottom: number; height: number } | null
  readonly toolbarHeight: number
  readonly toolbarRows: number
}

async function openCompletedAudit(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  const summary = await createSyntheticAudit(page)
  await page.goto(`/audit/${summary.auditId}`)
  await page.waitForLoadState('networkidle')
  await expect(page.locator('button[aria-pressed]').first()).toBeAttached()
  // Desktop preselect: the first finding is selected and Details auto-opens
  // at >= 1280, so wait for the real steady state instead of a fixed delay.
  await expect
    .poll(() => page.evaluate(() => document.querySelector('#ws-panel-findings') !== null), { timeout: 15_000 })
    .toBe(true)
  if (width >= 1280) {
    await expect
      .poll(() => page.evaluate(() => document.getElementById('ws-panel-details')?.clientHeight ?? 0), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0)
  }
  return summary
}

/** Wait until the rendered page has actually been painted (non-zero bitmap). */
async function waitForCanvas(page: Page) {
  await expect.poll(async () => (await readViewer(page))?.canvasWidth ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)
}

async function readGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const rect = (el: Element | null | undefined) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }
    }
    const visible = (el: Element | null | undefined) =>
      el && el.getBoundingClientRect().height > 0 ? el : null
    const q = (sel: string) => document.querySelector<HTMLElement>(sel)
    const workspace = q('#audit-workspace')
    const tablet = visible(q('#ws-tablet-workspace'))
    const preview = visible(q('#ws-panel-preview')) ?? tablet?.children[1] ?? null
    // Toolbar lines: children are laid out in visual order, so a child whose
    // top is at/after the current line's bottom starts a new line (centered
    // children of different line-heights differ by a pixel in `top` but
    // still share one line).
    const toolbar = preview?.querySelector('header') ?? null
    let toolbarRows = 0
    if (toolbar) {
      let lineBottom = -Infinity
      for (const child of Array.from(toolbar.children)) {
        const r = child.getBoundingClientRect()
        if (r.height === 0) continue
        if (r.top >= lineBottom - 1) {
          toolbarRows += 1
          lineBottom = r.bottom
        } else {
          lineBottom = Math.max(lineBottom, r.bottom)
        }
      }
    }
    return {
      viewportHeight: window.innerHeight,
      headerHeight: Math.round(q('#audit-report > div.border-b')?.getBoundingClientRect().height ?? 0),
      workspaceTop: Math.round(workspace?.getBoundingClientRect().top ?? 0),
      workspaceBottom: Math.round(workspace?.getBoundingClientRect().bottom ?? 0),
      workspaceHeight: Math.round(workspace?.getBoundingClientRect().height ?? 0),
      findings: rect(visible(q('#ws-panel-findings')) ?? tablet?.children[0] ?? null),
      preview: rect(preview),
      details: rect(visible(q('#ws-panel-details'))),
      toolbarHeight: Math.round(toolbar?.getBoundingClientRect().height ?? 0),
      toolbarRows,
    }
  })
}

/** Rendered canvas + scroll container numbers for the fit-mode assertions. */
async function readViewer(page: Page) {
  return page.evaluate(() => {
    const preview = document.querySelector<HTMLElement>('#ws-panel-preview')
    const region = preview?.querySelector<HTMLElement>('div[aria-label="Rendered document preview"].overflow-auto')
    const canvas = preview?.querySelector<HTMLCanvasElement>('canvas[aria-label^="Document page"]')
    if (!region || !canvas) return null
    return {
      regionClientWidth: region.clientWidth,
      regionClientHeight: region.clientHeight,
      regionScrollWidth: region.scrollWidth,
      regionScrollHeight: region.scrollHeight,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    }
  })
}

function renderedViewerVisible(page: Page): Promise<boolean> {
  return page.getByRole('button', { name: 'Previous page' }).first().isVisible()
}

async function assertPanelsAlign(geometry: Geometry, label: string) {
  const panels = [geometry.findings, geometry.preview, geometry.details].filter(
    (p): p is { top: number; bottom: number; height: number } => p !== null,
  )
  expect(panels.length, `${label}: at least the preview panel must be measurable`).toBeGreaterThan(0)
  const tops = panels.map((p) => p.top)
  const bottoms = panels.map((p) => p.bottom)
  const heights = panels.map((p) => p.height)
  expect(Math.max(...tops) - Math.min(...tops), `${label}: panel tops must align (${tops.join(',')})`).toBeLessThanOrEqual(1)
  expect(
    Math.max(...bottoms) - Math.min(...bottoms),
    `${label}: panel bottoms must align (${bottoms.join(',')})`,
  ).toBeLessThanOrEqual(1)
  expect(
    Math.max(...heights) - Math.min(...heights),
    `${label}: panels must share one workspace height (${heights.join(',')})`,
  ).toBeLessThanOrEqual(1)
}

test.describe('workspace vertical space @vertical-space', () => {
  test('workspace and every panel fill the remaining viewport height at each supported width', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'VS-HEIGHT',
      objective: 'At 1366x768, 1280x800 and 1024x768 the workspace owns the remaining viewport height below the compact report header, ends within a small safe gap of the viewport bottom, and all measurable panels share identical top/bottom edges.',
      precondition: 'Completed synthetic audit; desktop (>=1024) viewport.',
      steps: ['Open at each viewport', 'Measure header/workspace/panel boxes', 'Assert bottom gap + workspace share', 'Assert panel alignment'],
      expected: 'Workspace share >= 70% of the viewport, bottom gap <= 16px, all panel edges aligned within 1px.',
      severity: 'high',
    })

    for (const vp of VIEWPORTS) {
      await openCompletedAudit(page, vp.width, vp.height)
      const g = await readGeometry(page)
      expect(g.workspaceHeight, `${vp.label}: workspace must own the remaining height`).toBeGreaterThan(
        vp.height * MIN_WORKSPACE_SHARE,
      )
      expect(g.workspaceTop, `${vp.label}: workspace starts below the report header`).toBeGreaterThan(0)
      const bottomGap = vp.height - g.workspaceBottom
      expect(
        bottomGap,
        `${vp.label}: only a small safe gap may remain below the workspace (got ${bottomGap}px; unused space would hide content)`,
      ).toBeGreaterThanOrEqual(0)
      expect(bottomGap, `${vp.label}: workspace must reach the bottom of the viewport`).toBeLessThanOrEqual(
        MAX_BOTTOM_GAP_PX,
      )
      expect(
        g.headerHeight,
        `${vp.label}: the report header stays compact (two rows at 1366/1280, wrapped at 1024)`,
      ).toBeLessThanOrEqual(vp.width >= 1280 ? 88 : 120)
      await assertPanelsAlign(g, vp.label)
      await expectNoHorizontalOverflow(page)
    }
  })

  test('a taller viewport enlarges the workspace and Fit page draws a larger complete page', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'VS-FIT-PAGE',
      objective: 'Fit page recalculates from the taller document viewport: growing the browser height grows the workspace AND the rendered page, and the complete physical page stays visible (no internal scroll, no clipping).',
      precondition: 'Completed synthetic audit with the rendered viewer available at 1366x768.',
      steps: ['Open at 1366x768', 'Measure workspace + canvas', 'Resize to 1366x900', 'Measure again', 'Assert growth + complete page'],
      expected: 'Workspace and canvas both grow with the viewport; canvas fits inside the region content box so nothing is cropped.',
      severity: 'high',
    })
    await openCompletedAudit(page, 1366, 768)
    test.skip(!(await renderedViewerVisible(page)), 'Rendered PDF viewer unavailable in this environment.')
    await waitForCanvas(page)

    const shortGeometry = await readGeometry(page)
    const short = await readViewer(page)
    expect(short, 'rendered viewer must expose a canvas at 1366x768').not.toBeNull()

    await page.setViewportSize({ width: 1366, height: 900 })
    await expect
      .poll(async () => (await readViewer(page))?.canvasHeight ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(short!.canvasHeight)
    const tallGeometry = await readGeometry(page)
    const tall = await readViewer(page)
    expect(tall, 'rendered viewer must expose a canvas at 1366x900').not.toBeNull()

    expect(
      tallGeometry.workspaceHeight,
      'a taller viewport must make the workspace taller',
    ).toBeGreaterThan(shortGeometry.workspaceHeight)
    // Complete page: the canvas fits the region content box (p-4 = 16px per side).
    expect(
      tall!.canvasHeight,
      `Fit page must not crop the page (canvas ${tall!.canvasHeight}px vs region ${tall!.regionClientHeight}px)`,
    ).toBeLessThanOrEqual(tall!.regionClientHeight - 32)
    expect(
      tall!.regionScrollHeight,
      'Fit page must not need vertical scrolling',
    ).toBeLessThanOrEqual(tall!.regionClientHeight)
  })

  test('Fit width keeps width-only math, scrolls vertically, and benefits from panel collapse', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'VS-FIT-WIDTH',
      objective: 'Fit width is unchanged by the vertical work: the page is scaled to the available width only (vertical scrolling expected) and it grows when a side panel is collapsed.',
      precondition: 'Completed synthetic audit with the rendered viewer available at 1280x800.',
      steps: ['Open at 1280x800', 'Select Fit width', 'Assert canvas width == region width - 32 and no horizontal overflow', 'Collapse findings', 'Assert the page widened'],
      expected: 'Width-only fit; vertical scrolling present; wider container yields a wider page.',
      severity: 'high',
    })
    await openCompletedAudit(page, 1280, 800)
    test.skip(!(await renderedViewerVisible(page)), 'Rendered PDF viewer unavailable in this environment.')
    await waitForCanvas(page)

    await page.getByRole('button', { name: 'Fit width', exact: true }).click()
    await expect
      .poll(async () => {
        const v = await readViewer(page)
        return v ? Math.abs(v.canvasWidth - (v.regionClientWidth - 32)) : 99
      }, { timeout: 15_000 })
      .toBeLessThanOrEqual(1)
    const fitted = await readViewer(page)
    expect(fitted, 'rendered viewer must expose a canvas').not.toBeNull()
    expect(
      Math.abs(fitted!.canvasWidth - (fitted!.regionClientWidth - 32)),
      'Fit width must equal the available width minus container padding (unchanged math)',
    ).toBeLessThanOrEqual(1)
    expect(
      fitted!.regionScrollWidth,
      'Fit width must not introduce horizontal scrolling',
    ).toBeLessThanOrEqual(fitted!.regionClientWidth + 1)

    await page.getByRole('button', { name: 'Hide findings' }).click()
    await expect
      .poll(async () => (await readViewer(page))?.canvasWidth ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(fitted!.canvasWidth)
    const widened = await readViewer(page)
    expect(widened, 'rendered viewer must expose a canvas after collapsing').not.toBeNull()
    expect(
      widened!.canvasHeight,
      'Fit width still scrolls vertically (page taller than the region)',
    ).toBeGreaterThan(widened!.regionClientHeight - 32)
  })

  test('collapse and focus mode preserve the shared workspace height and keep the preview toolbar at most two rows', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'VS-PANELS-FOCUS',
      objective: 'Hiding panels or entering focus mode never changes the shared workspace height; the preview toolbar stays at one or two rows at 1366/1280 and the focus preview re-fits to the taller region.',
      precondition: 'Completed synthetic audit at 1366x768.',
      steps: ['Open at 1366x768', 'Measure workspace + toolbar rows', 'Hide findings + details', 'Measure', 'Restore panels', 'Focus on document', 'Measure re-fit + height', 'Escape', 'Measure restore'],
      expected: 'Workspace height stable within 1px; toolbar rows <= 2 at every step; focus height preserved and Escape restores the panels.',
      severity: 'high',
    })
    await openCompletedAudit(page, 1366, 768)
    const open = await readGeometry(page)
    expect(open.toolbarRows, 'toolbar must not wrap beyond two rows with both panels open').toBeLessThanOrEqual(2)
    expect(open.toolbarHeight, 'toolbar must stay compact with both panels open').toBeLessThanOrEqual(
      MAX_PREVIEW_TOOLBAR_PX,
    )

    await page.getByRole('button', { name: 'Hide findings' }).click()
    await page.getByRole('button', { name: 'Hide details' }).click()
    await page.waitForTimeout(1200)
    const collapsed = await readGeometry(page)
    expect(
      Math.abs(collapsed.workspaceHeight - open.workspaceHeight),
      'collapsing panels must not change the workspace height',
    ).toBeLessThanOrEqual(1)
    expect(collapsed.toolbarRows, 'toolbar must not wrap unexpectedly when panels are closed').toBeLessThanOrEqual(2)

    // Restore both panels, then enter focus so the layout really changes
    // (focus from the already-collapsed state would be a no-op).
    await page.getByRole('button', { name: 'Show findings' }).click()
    await page.getByRole('button', { name: 'Show details' }).click()
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('#ws-panel-findings, #ws-panel-details').length), {
        timeout: 15_000,
      })
      .toBe(2)
    const beforeFocus = await readViewer(page)
    await page.getByRole('button', { name: 'Focus on document' }).click()
    await expect
      .poll(
        async () => {
          const v = await readViewer(page)
          return v && beforeFocus ? v.canvasHeight > beforeFocus.canvasHeight : false
        },
        { timeout: 15_000 },
      )
      .toBe(true)
    const focused = await readGeometry(page)
    expect(
      Math.abs(focused.workspaceHeight - open.workspaceHeight),
      'focus mode must preserve the workspace height',
    ).toBeLessThanOrEqual(1)
    expect(focused.preview, 'focus mode keeps the preview panel').not.toBeNull()
    expect(focused.findings, 'focus mode hides the findings panel').toBeNull()
    expect(focused.details, 'focus mode hides the details panel').toBeNull()
    expect(focused.toolbarHeight, 'focus toolbar stays compact (single row)').toBeLessThanOrEqual(
      MAX_PREVIEW_TOOLBAR_PX,
    )
    const afterFocus = await readViewer(page)
    if (beforeFocus && afterFocus) {
      expect(
        afterFocus.regionClientWidth,
        'focus mode gives the preview nearly the full workspace width',
      ).toBeGreaterThan(beforeFocus.regionClientWidth)
      expect(
        afterFocus.canvasHeight,
        'the focus preview re-fits to the taller region instead of keeping the pre-focus scale',
      ).toBeGreaterThan(beforeFocus.canvasHeight)
    }

    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    const restored = await readGeometry(page)
    expect(
      Math.abs(restored.workspaceHeight - open.workspaceHeight),
      'exiting focus restores the same workspace height',
    ).toBeLessThanOrEqual(1)
    expect(restored.findings, 'exiting focus restores the findings panel').not.toBeNull()
    expect(restored.details, 'exiting focus restores the details panel').not.toBeNull()
    await expectNoHorizontalOverflow(page)
  })

  test('Fit page keeps the complete page visible in a short viewport (no minimum-zoom crop)', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'VS-FIT-PAGE-SHORT',
      objective: 'In a viewport too short for the 50% manual minimum, Fit page must still show the complete physical page: the canvas fits the rendering viewport content box and the region never scrolls.',
      precondition: 'Completed synthetic audit at 1366x700 with the rendered viewer available.',
      steps: ['Open at 1366x700', 'Select Fit page', 'Measure canvas + region', 'Assert complete page'],
      expected: 'Canvas inside the content box (padding excluded) with zero region overflow.',
      severity: 'high',
    })
    await openCompletedAudit(page, 1366, 700)
    test.skip(!(await renderedViewerVisible(page)), 'Rendered PDF viewer unavailable in this environment.')
    await waitForCanvas(page)
    await page.getByRole('button', { name: 'Fit page', exact: true }).click()
    await page.waitForTimeout(1200)

    const v = await readViewer(page)
    expect(v, 'rendered viewer must expose a canvas').not.toBeNull()
    expect(
      v!.canvasHeight,
      `complete page: canvas ${v!.canvasHeight}px must fit the content box ${v!.regionClientHeight - 32}px`,
    ).toBeLessThanOrEqual(v!.regionClientHeight - 32)
    expect(v!.canvasWidth).toBeLessThanOrEqual(v!.regionClientWidth - 32)
    expect(
      v!.regionScrollHeight,
      'Fit page must not scroll or crop, even below the manual zoom minimum',
    ).toBeLessThanOrEqual(v!.regionClientHeight)
  })

  test('selected evidence is an inline chip in the preview heading, never its own row', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'VS-EVIDENCE-CHIP',
      objective: 'The selected-evidence summary sits inside the Document Preview heading as one compact, single-line chip: no full-width evidence row above the page, no extra toolbar row, and the full summary stays available as the accessible value and tooltip.',
      precondition: 'Completed synthetic audit at 1366x768 with a finding selected.',
      steps: ['Open at 1366x768', 'Assert chip is inside the heading', 'Assert one-line height', 'Assert no dedicated row between toolbar and page'],
      expected: 'Chip inside <header>, height <= 26px, gap between the page toolbar and the rendering viewport equals the container gap, toolbar stays at <= 2 rows.',
      severity: 'high',
    })
    await openCompletedAudit(page, 1366, 768)
    // The evidence summary follows a real selection (the load-time preselection
    // reads the mapping before citation rects exist), so select the first
    // finding explicitly — the same path a reviewer takes.
    const firstFinding = page.locator('#ws-panel-findings .scrollbar-thin button[aria-pressed]').first()
    await expect(firstFinding).toBeVisible()
    await firstFinding.click()
    // Three preview instances are mounted (mobile/tablet/xl); scope to the
    // visible desktop panel so the locator resolves to one element.
    const chip = page.locator('#ws-panel-preview [data-testid="preview-evidence-chip"]')
    await expect(chip).toBeVisible()

    const info = await page.evaluate(() => {
      const scope = document.querySelector('#ws-panel-preview')
      const header = scope?.querySelector('header')
      // Scope to the visible panel: the mobile/tablet instances are hidden and
      // their chip has a zero-size box.
      const chipEl = scope?.querySelector('[data-testid="preview-evidence-chip"]') ?? null
      const region = scope?.querySelector<HTMLElement>(
        'div[aria-label="Rendered document preview"].overflow-auto',
      )
      const root = region?.parentElement
      const toolbar = root?.children[0]
      return {
        insideHeading: !!header && !!chipEl && header.contains(chipEl),
        chipHeight: Math.round(chipEl?.getBoundingClientRect().height ?? 0),
        chipTitle: chipEl?.getAttribute('title') ?? null,
        chipText: (chipEl?.textContent ?? '').trim(),
        chipWidth: Math.round(chipEl?.getBoundingClientRect().width ?? 0),
        gapToolbarToRegion:
          region && toolbar
            ? Math.round(region.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom)
            : -1,
        containerGap: root ? Number.parseFloat(getComputedStyle(root).rowGap || '0') : -1,
      }
    })

    expect(info.insideHeading, 'the evidence summary must live in the preview heading').toBe(true)
    expect(info.chipHeight, 'one compact line, never a 38px row').toBeLessThanOrEqual(26)
    expect(info.chipTitle, 'full value must be exposed for hover/AT').toBeTruthy()
    expect(info.chipTitle, 'the accessible text is the full summary').toBe(info.chipText)
    expect(info.chipText.length).toBeGreaterThan(0)
    expect(info.chipWidth, 'the chip stays on the heading line').toBeGreaterThan(100)
    expect(
      info.gapToolbarToRegion,
      'no dedicated evidence row may sit between the page toolbar and the rendering viewport',
    ).toBeLessThanOrEqual(info.containerGap + 1)

    const g = await readGeometry(page)
    expect(g.toolbarRows, 'toolbar must stay at one or two rows at 1366').toBeLessThanOrEqual(2)
    expect(g.toolbarHeight).toBeLessThanOrEqual(MAX_PREVIEW_TOOLBAR_PX)
  })

  test('1024 two-column workspace keeps a usable single-row preview toolbar and fills the height', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'VS-1024',
      objective: 'At 1024x768 the two-column layout still uses the remaining height, the preview toolbar stays on one row, and the desktop panel toggles remain hidden.',
      precondition: 'Completed synthetic audit at 1024x768.',
      steps: ['Open at 1024x768', 'Measure workspace + toolbar', 'Assert single toolbar row', 'Assert toggles hidden'],
      expected: 'Workspace >= 70% of the viewport, toolbar on one row, no desktop toggles, no horizontal overflow.',
      severity: 'medium',
    })
    await openCompletedAudit(page, 1024, 768)
    const g = await readGeometry(page)
    expect(g.workspaceHeight).toBeGreaterThan(768 * MIN_WORKSPACE_SHARE)
    expect(g.toolbarRows, 'the 1024 preview toolbar must stay on one row').toBe(1)
    expect(g.toolbarHeight, 'the 1024 preview toolbar stays compact').toBeLessThanOrEqual(44)
    expect(g.findings, 'findings column is visible at 1024').not.toBeNull()
    expect(g.details, 'details is a drawer at 1024, not a column').toBeNull()
    await expect(page.getByRole('button', { name: 'Hide findings' })).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })

  test('details keeps primary evidence above collapsed disclosures and each region scrolls on its own', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'VS-DETAILS',
      objective: 'The Details column shows the primary finding evidence without scrolling, keeps secondary content inside a collapsed disclosure, and scrolls independently of the findings list.',
      precondition: 'Completed synthetic audit at 1366x768 with a selected finding.',
      steps: ['Open at 1366x768', 'Assert primary labels visible', 'Assert disclosure collapsed', 'Open disclosure', 'Assert details scrolls', 'Assert findings list scrolls'],
      expected: 'Primary labels visible; disclosure closed by default; both regions own their vertical scroll.',
      severity: 'medium',
    })
    await openCompletedAudit(page, 1366, 768)

    const primary = await page.evaluate(() => {
      const panel = document.getElementById('ws-panel-details')
      if (!panel) return null
      const bounds = panel.getBoundingClientRect()
      const labels = ['Confirmed issue', 'Expected', 'Actual', 'Required action', 'Location']
      const visible = labels.filter((label) =>
        Array.from(panel.querySelectorAll('*')).some((el) => {
          if (el.children.length > 0) return false
          if (!(el.textContent ?? '').trim().toLowerCase().startsWith(label.toLowerCase())) return false
          const r = el.getBoundingClientRect()
          return r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1
        }),
      )
      return {
        visible,
        disclosures: Array.from(panel.querySelectorAll('details')).map((d) => ({
          open: (d as HTMLDetailsElement).open,
          summary: (d.querySelector('summary')?.textContent ?? '').trim().slice(0, 60),
        })),
      }
    })
    expect(primary, 'details column must be present at 1366x768').not.toBeNull()
    expect(primary!.visible, 'primary evidence must be readable without scrolling').toEqual([
      'Confirmed issue',
      'Expected',
      'Actual',
      'Required action',
      'Location',
    ])
    expect(primary!.disclosures.length, 'secondary detail content uses one disclosure').toBeGreaterThan(0)
    expect(
      primary!.disclosures.every((d) => !d.open),
      `secondary disclosures must start collapsed (${primary!.disclosures.map((d) => d.summary).join(' | ')})`,
    ).toBe(true)

    const scroll = await page.evaluate(() => {
      const details = document.getElementById('ws-panel-details') as HTMLElement | null
      const list = document.querySelector<HTMLElement>('#ws-panel-findings .scrollbar-thin')
      if (!details || !list) return null
      const detailsStyle = getComputedStyle(details)
      const listStyle = getComputedStyle(list)
      const before = details.scrollTop
      details.scrollTop = details.scrollHeight
      const detailsMoved = details.scrollTop - before
      const listTop = list.scrollTop
      list.scrollTop = list.scrollHeight
      return {
        detailsOverflowY: detailsStyle.overflowY,
        listOverflowY: listStyle.overflowY,
        findingsScrollable: list.scrollHeight > list.clientHeight + 1,
        listMoved: list.scrollTop - listTop,
        detailsScrollable: details.scrollHeight > details.clientHeight + 1,
        detailsMoved,
        documentScrolled: document.documentElement.scrollTop,
      }
    })
    expect(scroll, 'details and findings regions must be present').not.toBeNull()
    expect(scroll!.detailsOverflowY).toMatch(/auto|scroll/)
    expect(scroll!.listOverflowY).toMatch(/auto|scroll/)
    expect(scroll!.findingsScrollable, 'the findings list must own its scroll').toBe(true)
    expect(scroll!.listMoved, 'the findings list must scroll internally').toBeGreaterThan(0)
    expect(
      scroll!.documentScrolled,
      'scrolling an inner region must never scroll the document',
    ).toBe(0)
  })
})
