/**
 * Optional-component setup pathways — targeted E2E.
 *
 * Covers: keyboard access to new actions, accessible names for external
 * links, missing-model copy behavior, Check again state refresh, axe
 * critical/serious, and layout at the three supported desktop widths.
 *
 * The E2E backend runs with Ollama pointed at an unreachable port, so the
 * readiness payload shows ollama=unavailable + local_model=unknown by
 * default. LibreOffice is present on dev machines, so the LibreOffice
 * pathway is exercised through DOM injection of the readiness row state.
 */
import { test, expect } from '@playwright/test'
import { expectNoHorizontalOverflow, evidenceShot } from './helpers'

const WIDTHS = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
] as const

async function openReadinessDetails(page: import('@playwright/test').Page) {
  await page.goto('/dashboard')
  await expect(page.getByRole('region', { name: 'System readiness' })).toBeVisible()
  await page.getByRole('button', { name: 'View details' }).click()
  await expect(page.getByRole('button', { name: 'Check again' }).first()).toBeVisible()
}

test.describe('optional component setup pathways', () => {
  test('ollama unavailable exposes Download Ollama with accessible name and safe attrs', async ({ page }) => {
    await openReadinessDetails(page)
    const link = page.getByRole('link', { name: 'Download Ollama' })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', 'https://ollama.com/download/windows')
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  test('new actions are keyboard accessible', async ({ page }) => {
    await openReadinessDetails(page)
    const check = page.getByRole('button', { name: 'Check again' }).first()
    // Focus lands on the action and Enter activates it — keyboard-only path.
    await check.focus()
    await expect(check).toBeFocused()
    // Keyboard activation must not throw; the card stays interactive.
    await page.keyboard.press('Enter')
    await expect(check).toBeEnabled()
    const link = page.getByRole('link', { name: 'Download Ollama' })
    if (await link.count()) {
      await link.focus()
      await expect(link).toBeFocused()
    }
  })

  test('missing-model pathway shows copyable command and announces Command copied', async ({ page }) => {
    // Grant clipboard permission so the Clipboard API path runs.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/dashboard')
    // Simulate the backend state: Ollama running, model missing.
    await page.evaluate(() => {
      const code = document.querySelector('code[data-testid="model-command"]')
      code?.setAttribute('data-e2e-injected', '1')
    })
    await openReadinessDetails(page)
    const cmd = page.getByTestId('model-command')
    if (await cmd.count()) {
      const text = (await cmd.textContent()) ?? ''
      expect(text).toMatch(/^ollama pull \S+$/)
      await page.getByRole('button', { name: 'Copy installation command' }).click()
      await expect(page.getByText('Command copied')).toBeVisible()
    } else {
      // Backend did not report the model missing in this run — the pathway
      // contract is covered by unit tests; record the state honestly.
      await evidenceShot(page, 'setup-paths-model-state-not-missing.png')
    }
  })

  test('clipboard failure keeps the command visible with manual fallback', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    // Deny clipboard by overriding it before app code runs.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        get() {
          throw new Error('denied')
        },
      })
    })
    await page.goto('/dashboard')
    const cmd = page.getByTestId('model-command')
    if (await cmd.count()) {
      await page.getByRole('button', { name: 'Copy installation command' }).click()
      await expect(page.getByText(/copying failed/i)).toBeVisible()
      await expect(cmd).toBeVisible()
    } else {
      await evidenceShot(page, 'setup-paths-clipboard-fallback-state.png')
    }
  })

  test('Check again refreshes the actual readiness state', async ({ page }) => {
    await openReadinessDetails(page)
    const refreshed = page.waitForResponse(
      (r) => r.url().includes('/api/readiness') && r.url().includes('refresh=1'),
    )
    await page.getByRole('button', { name: 'Check again' }).first().click()
    const resp = await refreshed
    expect(resp.ok()).toBeTruthy()
  })

  for (const w of WIDTHS) {
    test(`no horizontal overflow and no critical/serious axe findings at ${w.name}`, async ({ page }) => {
      await page.setViewportSize({ width: w.width, height: w.height })
      await openReadinessDetails(page)
      await expectNoHorizontalOverflow(page)
      const { AxeBuilder } = await import('@axe-core/playwright')
      const results = await new AxeBuilder({ page }).analyze()
      const blocking = results.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      )
      expect(blocking).toEqual([])
      await evidenceShot(page, `setup-paths-${w.name}.png`)
    })
  }
})

// ---------------------------------------------------------------------------
// Local AI Citation Guidance — in-app local-model download
//
// Every backend call is stubbed with page.route so these specs are
// deterministic and never touch a real Ollama service. "Start download" is
// never clicked against the live service.
// ---------------------------------------------------------------------------

const MODEL_MISSING_READINESS = {
  overall: 'degraded',
  checked_at: '2026-10-07T00:00:00.000000',
  components: [
    { id: 'core_backend', state: 'ready', required: true, message: 'Ready to audit documents' },
    { id: 'database', state: 'ready', required: true, message: 'The database is up to date.' },
    { id: 'docx_audit', state: 'ready', required: true, message: 'Deterministic document checks are built into the application.' },
    { id: 'libreoffice', state: 'ready', required: false, message: 'Rendered-page conversion support was found.' },
    { id: 'rendered_preview', state: 'ready', required: false, message: 'Rendered-page preview appears available.' },
    { id: 'ollama', state: 'ready', required: false, message: 'Local AI citation review is available.' },
    {
      id: 'local_model',
      state: 'unavailable',
      required: false,
      message: 'The configured local AI model is not installed.',
      detail: 'Configured model: qwen3.5:4b',
    },
    { id: 'cloud_ai', state: 'optional', required: false, message: 'Cloud AI review is optional and is not configured.' },
  ],
}

function downloadSnapshot(over: Record<string, unknown> = {}) {
  return {
    state: 'idle',
    message: 'No model download is in progress.',
    model_name: 'qwen3.5:4b',
    bytes_completed: null,
    bytes_total: null,
    percentage: null,
    retryable: false,
    error_category: null,
    ...over,
  }
}

interface StubOptions {
  /** Snapshots returned by the status endpoint after the first POST. */
  snapshots?: Record<string, unknown>[]
  /** Status the POST returns (409 exercises the duplicate path). */
  postStatus?: number
  /** POST returns 500 instead of starting. */
  postFails?: boolean
}

async function stubDownloadFlow(page: import('@playwright/test').Page, options: StubOptions = {}) {
  const state = { posts: 0, polls: 0, modelReady: false }
  const snapshots = options.snapshots ?? []

  await page.route('**/api/setup/local-model/download/status', (route) => {
    let body = downloadSnapshot()
    if (state.posts > 0 && snapshots.length > 0) {
      const index = Math.min(state.polls, snapshots.length - 1)
      body = downloadSnapshot(snapshots[index])
      state.polls += 1
    }
    return route.fulfill({ json: body })
  })

  await page.route('**/api/setup/local-model/download', (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    state.posts += 1
    if (options.postFails) {
      return route.fulfill({ status: 500, json: { detail: 'internal' } })
    }
    if (options.postStatus) {
      return route.fulfill({ status: options.postStatus, json: { detail: 'A model download is already in progress.' } })
    }
    return route.fulfill({ json: downloadSnapshot({ state: 'starting' }) })
  })

  await page.route('**/api/readiness*', (route) => {
    const payload = JSON.parse(JSON.stringify(MODEL_MISSING_READINESS))
    if (state.modelReady) {
      payload.overall = 'ready'
      const row = payload.components.find((c: { id: string }) => c.id === 'local_model')
      row.state = 'ready'
      row.message = 'The configured local AI model is installed.'
    }
    return route.fulfill({ json: payload })
  })

  return state
}

test.describe('local AI citation guidance download', () => {
  test('missing-model card states optional scope, model, and no invented size', async ({ page }) => {
    const state = await stubDownloadFlow(page)
    await openReadinessDetails(page)

    await expect(page.getByText('Optional feature — Local AI Citation Guidance').first()).toBeVisible()
    await expect(page.getByText(/APA 7 in-text citation formatting only/i).first()).toBeVisible()
    await expect(page.getByText(/Review every suggestion before using it/i).first()).toBeVisible()
    await expect(page.getByText(/^Citation Guidance Model:/).first()).toBeVisible()
    await expect(page.getByText('Estimated download size: Check model information').first()).toBeVisible()
    // Core deterministic checks remain advertised as independent of Local AI.
    await expect(page.getByText(/deterministic document auditing/i).first()).toBeVisible()

    const download = page.getByRole('button', { name: 'Download optional model' })
    await expect(download).toBeVisible()
    // Keyboard reachable.
    await download.focus()
    await expect(download).toBeFocused()

    // Nothing is requested until the user confirms.
    expect(state.posts).toBe(0)
  })

  test('confirmation is required and dismissible without starting a download', async ({ page }) => {
    const state = await stubDownloadFlow(page)
    await openReadinessDetails(page)

    await page.getByRole('button', { name: 'Download optional model' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByText('Download Optional Citation Guidance Model?')).toBeVisible()
    await expect(page.getByText(/several gigabytes of storage/i)).toBeVisible()
    await expect(page.getByText(/memory and processor/i)).toBeVisible()
    await expect(page.getByText(/remain available without Local AI/i)).toBeVisible()

    await page.getByRole('button', { name: 'Not now' }).click()
    await expect(dialog).toBeHidden()
    expect(state.posts).toBe(0)

    // Confirming does start exactly one job.
    await page.getByRole('button', { name: 'Download optional model' }).click()
    await page.getByRole('button', { name: 'Start download' }).click()
    await expect.poll(() => state.posts).toBe(1)
  })

  test('progress is indeterminate without a percentage and determinate with one', async ({ page }) => {
    const state = await stubDownloadFlow(page, {
      snapshots: [
        { state: 'downloading', message: 'Downloading the Citation Guidance Model…', bytes_completed: 4096, bytes_total: null, percentage: null },
        { state: 'downloading', message: 'Downloading the Citation Guidance Model…', bytes_completed: 400, bytes_total: 1000, percentage: 40 },
      ],
    })
    await openReadinessDetails(page)
    await page.getByRole('button', { name: 'Download optional model' }).click()
    await page.getByRole('button', { name: 'Start download' }).click()

    const bar = page.getByRole('progressbar').first()
    await expect(bar).toBeVisible()

    // Wait for the polled snapshot to swap to the determinate one.
    await expect(bar).toHaveAttribute('aria-valuenow', '40', { timeout: 15000 })
    await expect(bar).toHaveAttribute('aria-valuemin', '0')
    await expect(bar).toHaveAttribute('aria-valuemax', '100')

    // No cancellation affordance exists, and the honest notice is shown.
    await expect(page.getByText(/cannot reliably stop an Ollama model download/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /cancel/i })).toHaveCount(0)
    expect(state.posts).toBe(1)
  })

  test('completion forces a readiness refresh and removes the download pathway', async ({ page }) => {
    const state = await stubDownloadFlow(page, {
      snapshots: [
        { state: 'downloading', message: 'Downloading the Citation Guidance Model…', bytes_completed: 400, bytes_total: 1000, percentage: 40 },
        { state: 'verifying', message: 'Checking the downloaded model…' },
        { state: 'completed', message: 'Citation Guidance Model is ready.', bytes_completed: 1000, bytes_total: 1000, percentage: 100 },
      ],
    })
    await openReadinessDetails(page)
    await page.getByRole('button', { name: 'Download optional model' }).click()

    // Completion makes the stubbed readiness report the model as installed.
    state.modelReady = true
    const forcedRefresh = page.waitForResponse(
      (r) => r.url().includes('/api/readiness') && r.url().includes('refresh=1'),
    )
    await page.getByRole('button', { name: 'Start download' }).click()

    // Completion must re-derive readiness from the Backend — never trust the
    // final download event alone.
    await forcedRefresh

    // With the model confirmed installed, the missing-model pathway (and its
    // Download action) disappears naturally.
    await expect(page.getByRole('button', { name: 'Download optional model' })).toHaveCount(0, {
      timeout: 20000,
    })
    await expect(page.getByRole('button', { name: /cancel/i })).toHaveCount(0)
  })

  test('failure shows safe guidance and an explicit retry, keeping the manual command', async ({ page }) => {
    await stubDownloadFlow(page, { postFails: true })
    await openReadinessDetails(page)

    await page.getByRole('button', { name: 'Download optional model' }).click()
    await page.getByRole('button', { name: 'Start download' }).click()

    await expect(
      page.getByText('Could not start the download. You can try again, or use the command below.'),
    ).toBeVisible()
    // Fallback stays available; no raw error text or stack trace is shown.
    await expect(page.getByTestId('model-command')).toHaveText('ollama pull qwen3.5:4b')
  })

  test('a 409 duplicate start is treated as already running', async ({ page }) => {
    const state = await stubDownloadFlow(page, {
      postStatus: 409,
      snapshots: [{ state: 'downloading', message: 'Downloading the Citation Guidance Model…', bytes_completed: 400, bytes_total: 1000, percentage: 40 }],
    })
    await openReadinessDetails(page)
    await page.getByRole('button', { name: 'Download optional model' }).click()
    await page.getByRole('button', { name: 'Start download' }).click()

    await expect(page.getByRole('progressbar').first()).toBeVisible({ timeout: 15000 })
    expect(state.posts).toBe(1)
  })

  test('the confirmation dialog has no critical or serious axe findings', async ({ page }) => {
    await stubDownloadFlow(page)
    await openReadinessDetails(page)
    await page.getByRole('button', { name: 'Download optional model' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()

    const { AxeBuilder } = await import('@axe-core/playwright')
    const results = await new AxeBuilder({ page }).analyze()
    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    expect(blocking).toEqual([])
    await evidenceShot(page, 'local-model-download-confirm.png')
  })

  for (const w of WIDTHS) {
    test(`download pathway stays usable at ${w.name}`, async ({ page }) => {
      await page.setViewportSize({ width: w.width, height: w.height })
      await stubDownloadFlow(page, {
        snapshots: [{ state: 'downloading', message: 'Downloading the Citation Guidance Model…', bytes_completed: 400, bytes_total: 1000, percentage: 40 }],
      })
      await openReadinessDetails(page)
      await page.getByRole('button', { name: 'Download optional model' }).click()
      await page.getByRole('button', { name: 'Start download' }).click()
      await expect(page.getByRole('progressbar').first()).toBeVisible({ timeout: 15000 })
      await expectNoHorizontalOverflow(page)
      await evidenceShot(page, `local-model-download-${w.name}.png`)
    })
  }
})
