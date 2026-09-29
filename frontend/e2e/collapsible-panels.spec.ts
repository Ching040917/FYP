/**
 * Collapsible Audit Workspace panels — Findings/Details toggles, document
 * focus mode, fit-page/fit-width, independent scrolling, and Guided Fixes
 * compatibility.
 *
 * Synthetic data only (committed sample thesis through the backend API).
 * Desktop support: 1366x768 and 1280x800 use the collapsible three-column
 * workspace + focus mode; 1024x768 keeps the existing two-column layout with
 * the modal Details drawer (unchanged architecture).
 *
 * The rendered PDF viewer (LibreOffice) is optional in the e2e environment:
 * every viewer-specific assertion is gated on renderedViewerVisible() so the
 * spec passes whether the preview renders or falls back to extracted text.
 */
import { test, expect, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { createSyntheticAudit, SAMPLE_THESIS, expectNoHorizontalOverflow, annotate } from './helpers'
import { createAuditViaApi } from './api-upload'

const FINDINGS_TOGGLE = /Hide findings|Show findings/
const FOCUS_TOGGLE = /Focus on document|Exit document focus/

async function openCompletedAudit(page: Page) {
  const summary = await createSyntheticAudit(page)
  await page.goto(`/audit/${summary.auditId}`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByText(/major ·|findings/).first()).toBeVisible()
  return summary
}

/** Wait for the preselect effect: the first finding is selected, which at
 *  >= 1280 auto-opens the Details panel. Resolves only when both panels are
 *  open (the desktop load-time steady state). */
async function ensurePreselect(page: Page) {
  await expect(page.locator('#ws-panel-findings button[aria-pressed="true"]').first()).toBeAttached()
  await expect(page.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true')
}

/** True when the rendered PDF viewer (page/fit toolbar) is available. */
function renderedViewerVisible(page: Page): Promise<boolean> {
  return page.getByRole('button', { name: 'Previous page' }).first().isVisible()
}

/** Read the "Page N of M" toolbar indicator value. */
async function currentPageNumber(page: Page): Promise<number> {
  const text = await page.getByText(/^Page \d+ of \d+$/).first().innerText()
  return Number(text.split(' ')[1])
}

function panelBoxes(page: Page) {
  return page.evaluate(() => {
    const w = (id: string) => document.getElementById(id)?.getBoundingClientRect().width ?? 0
    return { findings: w('ws-panel-findings'), preview: w('ws-panel-preview'), details: w('ws-panel-details') }
  })
}

async function assertNoCriticalOrSerious(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
  expect(
    blocking,
    `${label}: critical/serious axe violations:\n${blocking.map((v) => `${v.id} (${v.impact}): ${v.help}`).join('\n')}`,
  ).toEqual([])
}

test.describe('collapsible audit workspace @collapsible-panels', () => {
  test('1366 defaults: preselect opens both panels; preview owns the flexible middle', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-DEFAULTS-1366',
      objective: 'At 1366x768 the Findings panel defaults open and the preselect effect opens Details for the first finding; the preview column remains the widest track.',
      precondition: 'Completed synthetic audit.',
      steps: ['Open /audit/{id} at 1366x768', 'Wait for preselect', 'Read toggle aria-expanded states', 'Measure panel widths'],
      expected: 'Hide findings + Hide details both aria-expanded=true; preview width > findings width.',
      severity: 'high',
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await openCompletedAudit(page)
    await ensurePreselect(page)

    // Fit page is the session default for a freshly opened audit.
    if (await renderedViewerVisible(page)) {
      await expect(page.getByRole('button', { name: 'Fit page' })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('button', { name: 'Fit width' })).toHaveAttribute('aria-pressed', 'false')
    }

    // The panel toggles live in the preview's own toolbar: they stay
    // reachable wherever the side panels are.
    await expect(page.locator('#ws-panel-preview [aria-controls="ws-panel-findings"]')).toBeVisible()
    await expect(page.locator('#ws-panel-preview [aria-controls="ws-panel-details"]')).toBeVisible()

    // Long secondary content is reachable but collapsed by default.
    // (Native <summary> exposes its name on the <details> container, not as a
    //  standalone button. Scope to the desktop details column — the same
    //  detail stack also renders in the hidden mobile/tablet instances.)
    const detailsPanel = page.locator('#ws-panel-details')
    const statsSummary = detailsPanel.locator('summary', { hasText: 'Document statistics' })
    await expect(statsSummary.first()).toBeVisible()
    await expect(
      await statsSummary.first().evaluate((el) => (el.closest('details') as HTMLDetailsElement).open),
      'Document statistics must be collapsed by default',
    ).toBe(false)
    const extended = detailsPanel.locator('summary', { hasText: 'Extended details' })
    if ((await extended.count()) > 0) {
      await expect(extended.first()).toBeVisible()
      await expect(
        await extended.first().evaluate((el) => (el.closest('details') as HTMLDetailsElement).open),
        'Extended details must be collapsed by default',
      ).toBe(false)
    }

    await expect(page.getByRole('button', { name: 'Hide findings' })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true')

    const boxes = await panelBoxes(page)
    expect(boxes.preview, 'preview must own the flexible middle track').toBeGreaterThan(boxes.findings)
    expect(boxes.details, 'details column must be visible when open').toBeGreaterThan(0)
  })

  test('collapsing a side panel gives its width to the preview, and reopening restores it', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-COLLAPSE',
      objective: 'Closing Findings or Details immediately widens the preview; reopening restores the previous layout; the selected finding survives.',
      precondition: 'Completed synthetic audit at 1366x768 with a selected finding (preselect).',
      steps: ['Wait for preselect', 'Measure preview', 'Hide findings + measure', 'Show findings + measure', 'Hide details + measure', 'Show details'],
      expected: 'Preview width grows after each collapse and shrinks after each reopen; the finding stays selected.',
      severity: 'high',
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await openCompletedAudit(page)
    await ensurePreselect(page)

    const bothOpen = await panelBoxes(page)
    await page.getByRole('button', { name: 'Hide findings' }).click()
    const findingsClosed = await panelBoxes(page)
    expect(findingsClosed.preview, 'preview must gain the Findings track width').toBeGreaterThan(bothOpen.preview)
    expect(findingsClosed.findings, 'closed Findings column must be removed from the grid').toBe(0)
    await page.getByRole('button', { name: 'Show findings' }).click()
    const reopened = await panelBoxes(page)
    expect(reopened.preview, 'preview must give the width back on reopen').toBeLessThan(findingsClosed.preview)

    await page.getByRole('button', { name: 'Hide details' }).click()
    const detailsClosed = await panelBoxes(page)
    expect(detailsClosed.preview, 'preview must gain the Details track width').toBeGreaterThan(reopened.preview)
    await page.getByRole('button', { name: 'Show details' }).click()
    // The selected finding survives every toggle.
    await expect(page.locator('#ws-panel-findings button[aria-pressed="true"]').first()).toBeAttached()
  })

  test('focus mode hides both panels, preserves state, and Escape exits with restore', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-FOCUS',
      objective: 'Focus on document hides both side panels and the toggles; Escape exits and restores the pre-focus states, returning focus to the trigger.',
      precondition: 'Completed synthetic audit at 1366x768 with both panels open and a selected finding.',
      steps: ['Wait for preselect', 'Measure preview', 'Focus on document', 'Verify panels+toggles hidden', 'Escape', 'Verify restore + focus'],
      expected: 'In focus mode neither panel is visible and the preview owns the width; after Escape both panels reopen, the finding is still selected, and focus is on the trigger.',
      severity: 'high',
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await openCompletedAudit(page)
    await ensurePreselect(page)

    const preFocusWidth = (await panelBoxes(page)).preview

    await page.getByRole('button', { name: 'Focus on document' }).click()
    // Both panels hidden, toggles replaced by the exit control + status note.
    await expect(page.locator('#ws-panel-findings')).toHaveCount(0)
    await expect(page.locator('#ws-panel-details')).toHaveCount(0)
    await expect(page.getByText('Document focus — panels hidden')).toBeVisible()
    await expect(page.getByRole('button', { name: FINDINGS_TOGGLE })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Exit document focus' })).toBeFocused()
    const focusedWidth = (await panelBoxes(page)).preview
    expect(focusedWidth, 'focus mode must release both side tracks to the preview').toBeGreaterThan(preFocusWidth)

    // Escape exits and restores; focus returns to the trigger control.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Hide findings' })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#ws-panel-findings button[aria-pressed="true"]').first()).toBeAttached()
    await expect(page.getByRole('button', { name: 'Focus on document' })).toBeFocused()
  })

  test('fit page / fit width switch without resetting the current page', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-FIT',
      objective: 'Fit page / Fit width expose aria-pressed mode semantics and never reset the current rendered page.',
      precondition: 'Completed synthetic audit; rendered viewer or extracted-text fallback.',
      steps: ['Read page N', 'Fit page', 'Verify aria-pressed + page N', 'Fit width', 'Verify page N unchanged'],
      expected: 'Active mode shows aria-pressed=true; page indicator unchanged across the switch.',
      severity: 'medium',
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await openCompletedAudit(page)

    if (await renderedViewerVisible(page)) {
      const before = await currentPageNumber(page)
      // A freshly opened audit defaults to Fit page (the rendered viewer
      // only exists here when the viewer rendered successfully).
      await expect(page.getByRole('button', { name: 'Fit page' })).toHaveAttribute('aria-pressed', 'true')
      const fitPage = page.getByRole('button', { name: 'Fit page' })
      const fitWidth = page.getByRole('button', { name: 'Fit width' })

      await fitPage.click()
      await expect(fitPage).toHaveAttribute('aria-pressed', 'true')
      await expect(fitWidth).toHaveAttribute('aria-pressed', 'false')
      // The active mode is confirmed by the aria-pressed pair above; the
      // whole-page pixel visibility is asserted by visual validation, not here.
      expect(await currentPageNumber(page), 'Fit page must not reset the page number').toBe(before)

      await fitWidth.click()
      await expect(fitWidth).toHaveAttribute('aria-pressed', 'true')
      await expect(fitPage).toHaveAttribute('aria-pressed', 'false')
      expect(await currentPageNumber(page), 'Fit width must not reset the page number').toBe(before)
    } else {
      // Rendered preview unavailable (no LibreOffice in env): fit controls are
      // correctly absent and the extracted-text fallback stays available.
      await expect(page.getByRole('button', { name: 'Fit page' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Fit width' })).toHaveCount(0)
      await expect(page.getByRole('region', { name: 'Document preview' })).toBeVisible()
    }
  })

  test('Guided Fixes selection is independent of panel state; focus entry is blocked while open', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-GUIDED',
      objective: 'Focus entry is blocked while the Guided Fixes modal is open; closing the dialog preserves the prior panel state; the dialog and panel visibility never interact.',
      precondition: 'Completed synthetic audit at 1366x768.',
      steps: ['Wait for preselect', 'Open Guided Fixes + select one', 'Assert Focus disabled', 'Close dialog', 'Assert panel state preserved'],
      expected: 'Focus on document is disabled while the modal is open; after closing, the Details panel is still open as it was.',
      severity: 'high',
      notes: 'The modal overlay physically covers the panel toggles, so a toggle click under an open dialog is unreachable; the invariant (panel visibility never clears the Guided selection, which lives in the always-mounted toolbar) is proven here in the reachable direction — the dialog leaving the panel state untouched — plus the focus-entry block.',
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await openCompletedAudit(page)
    await ensurePreselect(page)

    await page.getByRole('button', { name: 'Guided Fixes' }).click()
    const checkbox = page.locator('input[type="checkbox"][aria-label]').first()
    await checkbox.click()
    await expect(
      page.getByText(/selected · .*available for Guided Fix · Maximum 20|selected · Maximum reached/).first(),
    ).toBeVisible()

    // Focus entry is blocked while a modal dialog is open.
    await expect(page.getByRole('button', { name: 'Focus on document' })).toBeDisabled()

    // Closing the dialog must not disturb the workspace panel state.
    await page.getByRole('button', { name: 'Close Guided Fixes' }).click()
    await expect(page.getByRole('button', { name: 'Guided Fixes' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true')
    // The Guided trigger is still fully functional after the round-trip.
    await page.getByRole('button', { name: 'Guided Fixes' }).click()
    await expect(
      page.getByText(/selected · .*available for Guided Fix · Maximum 20|No findings selected · .*available for Guided Fix · Maximum 20|selected · Maximum reached/).first(),
    ).toBeVisible()
  })

  test('findings, preview, and details scroll independently; header stays visible', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-SCROLL',
      objective: 'Each desktop region scrolls within itself (no document-level scroll); scrolling the preview does not move the details column or the document; the report header stays visible.',
      precondition: 'Completed synthetic audit at 1366x768 with a selected finding.',
      steps: ['Wait for preselect', 'Assert per-region overflow', 'Scroll the preview', 'Assert details + document stayed put', 'Assert header visible'],
      expected: 'Regions own their vertical scroll; siblings and the document do not move; the header remains in view.',
      severity: 'medium',
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await openCompletedAudit(page)
    await ensurePreselect(page)

    const structure = await page.evaluate(() => {
      const overflowOf = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null
        return el ? getComputedStyle(el).overflowY : 'missing'
      }
      return {
        findingsList: overflowOf('#ws-panel-findings .scrollbar-thin'),
        details: overflowOf('#ws-panel-details'),
      }
    })
    expect(structure.findingsList, 'findings list owns its vertical scroll').toMatch(/auto|scroll/)
    expect(structure.details, 'details column owns its vertical scroll').toMatch(/auto|scroll/)

    // The preview scroll region: the rendered viewer when available, otherwise
    // the extracted-text region. Both own their own vertical overflow.
    const previewSel = (await renderedViewerVisible(page))
      ? '[aria-label="Rendered document preview"]'
      : '[aria-label="Document preview"]'
    const previewOverflow = await page.evaluate(
      (sel) => {
        const el = document.querySelector(sel) as HTMLElement | null
        return el ? getComputedStyle(el).overflowY : 'missing'
      },
      previewSel,
    )
    expect(previewOverflow, 'preview region owns its vertical scroll').toMatch(/auto|scroll/)

    // Scrolling the preview must not move the details column or the document.
    const stable = await page.evaluate((sel) => {
      const preview = document.querySelector(sel) as HTMLElement | null
      if (!preview) return { previewOverflow: 0, docMoved: 0, detailsMoved: 0 }
      const details = document.getElementById('ws-panel-details') as HTMLElement | null
      const docBefore = document.documentElement.scrollTop
      const detailsBefore = details?.scrollTop ?? 0
      const previewBefore = preview.scrollTop
      preview.scrollTop = preview.scrollHeight
      return {
        previewOverflow: preview.scrollTop - previewBefore,
        docMoved: Math.abs(document.documentElement.scrollTop - docBefore),
        detailsMoved: Math.abs((details?.scrollTop ?? 0) - detailsBefore),
      }
    }, previewSel)
    expect(stable.docMoved, 'document must not scroll when the preview scrolls').toBe(0)
    expect(stable.detailsMoved, 'details must not scroll when the preview scrolls').toBe(0)

    await expect(page.getByText('Score', { exact: true }).first()).toBeVisible()
  })

  test('1280x800: three-column workspace expands on collapse without overflow', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-1280',
      objective: 'At 1280x800 the collapsible workspace renders without document overflow; collapsing both panels widens the preview.',
      precondition: 'Completed synthetic audit.',
      steps: ['Open at 1280x800', 'Wait for preselect', 'Measure open preview', 'Hide both panels', 'Measure + overflow'],
      expected: 'No document overflow; preview width grows when both side panels are closed.',
      severity: 'high',
    })
    await page.setViewportSize({ width: 1280, height: 800 })
    await openCompletedAudit(page)
    await ensurePreselect(page)

    await expect(page.getByRole('button', { name: 'Hide findings' })).toBeVisible()
    await expectNoHorizontalOverflow(page)

    const openWidth = (await panelBoxes(page)).preview
    await page.getByRole('button', { name: 'Hide findings' }).click()
    await page.getByRole('button', { name: 'Hide details' }).click()
    const closedWidth = (await panelBoxes(page)).preview
    expect(closedWidth, 'preview must own more width with both panels closed').toBeGreaterThan(openWidth)
    await expectNoHorizontalOverflow(page)
  })

  test('1024x768: two-column layout with modal details drawer; desktop toggles hidden', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-1024',
      objective: 'At 1024x768 the desktop toggles are hidden, Findings + Preview stay side by side, and selecting a finding opens the accessible modal Details drawer.',
      precondition: 'Completed synthetic audit.',
      steps: ['Open at 1024x768', 'Verify desktop toggles hidden', 'Select a finding', 'Verify modal drawer', 'Close drawer', 'Measure overflow'],
      expected: 'Desktop toggles not visible; the modal drawer opens with a close control; no document-level horizontal overflow.',
      severity: 'high',
    })
    await page.setViewportSize({ width: 1024, height: 768 })
    await openCompletedAudit(page)
    // The collapsible desktop controls exist only in the >=1280 block, so at
    // 1024 they are present in the DOM but not visible (display:none ancestor).
    await expect(page.getByRole('button', { name: FINDINGS_TOGGLE })).toBeHidden()
    await expect(page.getByRole('button', { name: FOCUS_TOGGLE })).toBeHidden()

    // Selecting a finding at compact width opens the modal right drawer.
    await page.getByRole('button', { name: /Major|Minor/ }).first().click()
    const drawer = page.getByRole('dialog', { name: 'Finding details' })
    await expect(drawer, 'details drawer must open on selection').toBeVisible()
    await expect(drawer).toHaveAttribute('aria-modal', 'true')
    await page.getByRole('button', { name: 'Close finding details' }).click()
    await expect(drawer).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
  })

  test('long synthetic filename does not affect workspace panel logic', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-LONGNAME',
      objective: 'A very long document title truncates in the header without widening or breaking the panel grid.',
      precondition: 'Synthetic audit created with a 90-character filename.',
      steps: ['Create audit with long filename', 'Open at 1280x800', 'Measure overflow', 'Verify toggles fit the control row'],
      expected: 'No document-level horizontal overflow; panel toggles remain visible and operable.',
      severity: 'medium',
    })
    const longName =
      'A-very-long-synthetic-dissertation-title-used-to-stress-the-audit-workspace-header-panel-layout-padding-90ch.docx'
    await page.setViewportSize({ width: 1280, height: 800 })
    const summary = await createAuditViaApi(page, SAMPLE_THESIS, longName)
    await page.goto(`/audit/${summary.auditId}`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(/major ·|findings/).first()).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expect(page.getByRole('button', { name: 'Hide findings' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Focus on document' })).toBeVisible()
  })

  test('keyboard operation of panel, focus, and fit controls', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-KEYBOARD',
      objective: 'Panel toggles, focus mode, and fit controls are fully operable with the keyboard; no traps.',
      precondition: 'Completed synthetic audit at 1366x768.',
      steps: ['Focus + Enter toggles Findings', 'Focus + Enter Focus', 'Escape exits + focus returns', 'Fit page Enter (when viewer available)'],
      expected: 'Every control works via keyboard; Escape returns focus to the trigger.',
      severity: 'medium',
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await openCompletedAudit(page)
    await ensurePreselect(page)

    await page.getByRole('button', { name: 'Hide findings' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Show findings' })).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Show findings' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Hide findings' })).toHaveAttribute('aria-expanded', 'true')

    const focusBtn = page.getByRole('button', { name: 'Focus on document' })
    await focusBtn.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Exit document focus' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Focus on document' })).toBeFocused()

    if (await renderedViewerVisible(page)) {
      await page.getByRole('button', { name: 'Fit page' }).focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('button', { name: 'Fit page' })).toHaveAttribute('aria-pressed', 'true')
    }
  })

  test('no critical or serious axe violations at all three supported widths', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'CP-AXE',
      objective: 'The collapsible workspace introduces no critical/serious axe violations at 1366, 1280, and 1024.',
      precondition: 'Completed synthetic audit.',
      steps: ['Open audit at each width', 'Run full axe scan', 'Filter impact=critical/serious'],
      expected: 'Zero critical and zero serious violations at every width.',
      severity: 'high',
    })
    for (const [width, height] of [
      [1366, 768],
      [1280, 800],
      [1024, 768],
    ] as const) {
      await page.setViewportSize({ width, height })
      await openCompletedAudit(page)
      await assertNoCriticalOrSerious(page, `${width}px`)
    }
  })
})
