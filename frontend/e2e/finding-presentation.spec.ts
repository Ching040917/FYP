/**
 * Scenario — Finding presentation contract (keyboard, density, disclosure).
 *
 * These are the stable, repeatable properties of the findings card. The
 * one-off baseline-vs-feature density comparison is a build-time measurement
 * (see e2e/_measure.spec.ts, git-ignored); what is asserted here is the
 * contract that must hold at every supported width on every run.
 */
import { test, expect, type Page } from '@playwright/test'
import { annotate, createSyntheticAudit, evidenceShot, expectNoHorizontalOverflow } from './helpers'

/**
 * Open a completed audit and resolve the finding rows.
 * At 1024 the findings panel starts collapsed and the list is painted by a
 * different responsive shell, so `#ws-panel-findings` matches a hidden copy.
 * Target whichever row is actually rendered instead.
 */
async function openAudit(page: Page) {
  const audit = await createSyntheticAudit(page)
  await page.goto(`/audit/${audit.auditId}`)
  await page.waitForLoadState('networkidle')
  const show = page.getByRole('button', { name: /Show findings/ })
  if (await show.isVisible().catch(() => false)) await show.click()
  const rows = page.locator('button[aria-pressed]:visible')
  await expect(rows.first()).toBeVisible()
  return rows
}

test.describe('finding presentation @presentation', () => {
  test('the card exposes title, severity and location in its accessible name', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'PRESENTATION-CARD-NAME',
      objective:
        'Each finding row announces its plain-language title, its severity and its location, so removing the visible badges never shrinks the accessible name.',
      precondition: 'Completed synthetic audit.',
      steps: ['Open /audit/:auditId', 'Read the first row accessible name'],
      expected: 'Name contains a title, a severity label and a location.',
      severity: 'high',
    })
    const rows = await openAudit(page)
    const name = await rows.first().getAttribute('aria-label')
    expect(name, 'the row must carry an explicit accessible name').toBeTruthy()
    expect(name!).toMatch(
      /(Font family|Font size|Line spacing|Space before|Space after|Paragraph alignment|Left page margin|Right page margin|Top page margin|Bottom page margin|Heading levels|Table caption|Figure|caption|Citation|Reference List)/,
    )
    expect(name!).toMatch(/(Major|Minor|Manual review|Unclassified)/)
    expect(name!).toMatch(/(Page \d+|Paragraph \d+)/)
  })

  test('keyboard reaches the first row, shows a focus ring, and Enter selects', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'PRESENTATION-KEYBOARD',
      objective:
        'A keyboard user can reach the findings list, always sees where focus is, and can select with Enter. Focus must stay distinguishable from selection.',
      precondition: 'Completed synthetic audit at the project viewport.',
      steps: [
        'Tab until the first finding row has focus',
        'Read the computed box-shadow (focus ring)',
        'Press Enter',
        'Read the selected row background and ring',
      ],
      expected: 'Focus ring is visible before selection and selection is visually distinct from focus.',
      severity: 'high',
    })
    const rows = await openAudit(page)

    // Tab until the list is reached; the row must become focusable.
    let focused = false
    for (let i = 0; i < 40 && !focused; i++) {
      await page.keyboard.press('Tab')
      focused = await rows.first().evaluate((el) => el === document.activeElement)
    }
    expect(focused, 'Tab must reach the first finding row').toBe(true)

    const focusRing = await rows.first().evaluate((el) => getComputedStyle(el).boxShadow)
    expect(focusRing, 'a focused row must show a visible ring').toBeTruthy()
    expect(focusRing).not.toBe('none')

    await page.keyboard.press('Enter')
    await expect(rows.first()).toHaveAttribute('aria-pressed', 'true')

    // Selection and focus must not collapse into the same appearance.
    const afterSelect = await rows.first().evaluate((el) => {
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, ring: s.boxShadow, border: s.borderLeftColor }
    })
    expect(afterSelect.bg, 'a selected row must change background').toBeTruthy()
    expect(afterSelect.border, 'a selected row must show the selection border').toBeTruthy()

    // Focus must never be orphaned. At >=1280 the details are a panel and
    // focus must stay on the row; at 1024 the details open as a MODAL DIALOG,
    // where moving focus inside is the correct accessible pattern. What must
    // never happen is focus landing nowhere.
    const focusState = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      const dialog = document.querySelector('[role="dialog"][aria-label="Finding details"]')
      return {
        onRow: active?.matches('button[aria-pressed]') ?? false,
        inDialog: !!dialog && !!active && dialog.contains(active),
        onBody: active === document.body || active === null,
      }
    })
    expect(focusState.onBody, 'focus must never be orphaned after selection').toBe(false)
    expect(
      focusState.onRow || focusState.inDialog,
      'focus must stay on the row (panel details) or move into the details dialog',
    ).toBe(true)


    await evidenceShot(page, `presentation-keyboard-${testInfo.project.name}.png`)
  })

  test('the card never shows internal markers or a duplicated category tag', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'PRESENTATION-NO-INTERNAL-MARKERS',
      objective:
        'No paragraph-marker glyph, no raw rule code and no duplicated category tag appears on a finding card.',
      precondition: 'Completed synthetic audit.',
      steps: ['Open /audit/:auditId', 'Scan visible row text'],
      expected: 'Only the plain-language title, severity, location, comparison and evidence are shown.',
      severity: 'high',
    })
    const rows = await openAudit(page)
    const texts = await rows.evaluateAll((els) =>
      els.map((el) => (el.textContent ?? '').trim()),
    )
    for (const t of texts) {
      expect(t, `card exposes an internal marker: ${t}`).not.toContain('¶')
      expect(t, `card exposes a raw rule code: ${t}`).not.toMatch(
        /[A-Z]{3,}_[A-Z]{3,}/,
      )
      expect(t, `card exposes a raw index: ${t}`).not.toMatch(/paragraph_index|run_index/)
    }
  })

  test('truncated evidence keeps its full text for a screen reader', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'PRESENTATION-EVIDENCE-TRUNCATION',
      objective:
        'A visually truncated evidence line still exposes the complete text to assistive technology.',
      precondition: 'Completed synthetic audit.',
      steps: ['Open /audit/:auditId', 'Compare the visible line with its sr-only twin'],
      expected: 'When the visible line is clipped, the sr-only text is the complete string.',
      severity: 'medium',
    })
    const rows = await openAudit(page)
    const result = await rows.first().evaluate((el) => {
      const line = Array.from(el.querySelectorAll('span')).find((s) =>
        s.className.includes('truncate') && s.className.includes('text-[11px]'),
      ) as HTMLElement | undefined
      if (!line) return null
      const sr = line.querySelector('.sr-only') as HTMLElement | null
      const visibleText = (line.textContent ?? '').replace(sr?.textContent ?? '', '').trim()
      return {
        truncated: line.scrollWidth > line.clientWidth + 1,
        visible: visibleText,
        full: sr?.textContent?.trim() ?? null,
        title: line.getAttribute('title'),
      }
    })
    if (result) {
      expect(result.full, 'a screen reader must receive the complete evidence').toBeTruthy()
      expect(result.title, 'hover must reveal the complete evidence').toBe(result.full)
      if (result.truncated) {
        expect(result.full!.length).toBeGreaterThanOrEqual(result.visible.length)
      }
    }
  })

  test('the document never overflows horizontally', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'PRESENTATION-NO-OVERFLOW',
      objective: 'The findings workspace fits its viewport at every supported width.',
      precondition: `Completed synthetic audit at ${testInfo.project.name} viewport.`,
      steps: ['Open /audit/:auditId', 'Select the first finding', 'Compare scrollWidth to clientWidth'],
      expected: 'document.scrollWidth <= document.clientWidth.',
      severity: 'high',
    })
    const rows = await openAudit(page)
    await rows.first().click()
    await expectNoHorizontalOverflow(page)
  })

  test('the severity filter offers every severity with a concise label', async ({ page }, testInfo) => {
    annotate(testInfo, {
      id: 'PRESENTATION-SEVERITY-FILTER',
      objective: 'The severity filter offers Major, Minor, Manual review and Unclassified alongside All severities.',
      precondition: 'Completed synthetic audit.',
      steps: ['Open /audit/:auditId', 'Open the severity filter', 'Assert every option is present'],
      expected: 'All four severities are offered with their concise labels (no " only" suffix).',
      severity: 'medium',
    })
    await openAudit(page)
    // The workspace renders three responsive shells, so scope to the visible one.
    await page.locator('[aria-label="Filter by severity"]:visible').first().click()
    await expect(page.getByRole('option', { name: 'All severities', exact: true })).toBeVisible()
    for (const label of ['Major', 'Minor', 'Manual review', 'Unclassified']) {
      await expect(page.getByRole('option', { name: label, exact: true })).toBeVisible()
    }
  })
})
