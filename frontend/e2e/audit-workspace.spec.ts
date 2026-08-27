/**
 * Scenario 5 — Audit workspace tablist (NOT APPLICABLE on phone).
 * ACA is a Windows desktop application served locally on 127.0.0.1.
 * Phone widths are outside the supported platform.
 * This file is retained as a skipped placeholder so evidence labels
 * do not claim mobile or tablet support.
 */
import { test } from '@playwright/test'

test.describe('audit workspace tabs — NOT APPLICABLE on phone @responsive', () => {
  test('workspace tablist: keyboard reachable (phone-only) — NOT APPLICABLE', async ({}, testInfo) => {
    test.skip(true, 'NOT APPLICABLE — mobile devices are outside the supported platform (Windows desktop only).')
  })
})
