/**
 * Playwright E2E configuration — development-only browser validation.
 *
 * Isolation contract:
 *   - Chromium only, bound to deterministic 127.0.0.1 URLs.
 *   - Backend started with an ephemeral SQLite database under
 *     frontend/e2e/.tmp/<run-id>/ (git-ignored) — never the developer's
 *     ./audit.db production-style database.
 *   - Cloud AI disabled (DEPLOY_MODE=LOCAL) and Ollama pointed at an
 *     unreachable port so the optional AI step degrades instantly; core
 *     audit completion must not depend on it.
 *   - Rendered preview storage redirected into the same ephemeral run dir.
 *   - reuseExistingServer: false guarantees the suite always talks to a
 *     backend running with the isolated DATABASE_URL.
 *   - Artifacts (screenshots/traces/reports) land exclusively in ignored
 *     paths. Browser binaries stay in the user-level Playwright cache,
 *     outside the repository.
 */
import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url)) // <repo>/frontend
const repoRoot = path.resolve(here, '..')
const backendDir = path.join(repoRoot, 'backend')
const backendPython = path.join(backendDir, '.venv', 'Scripts', 'python.exe')

// One ephemeral run directory per suite execution (git-ignored; removed by
// globalTeardown after webServers shut down).
const runId = `run-${process.pid}-${Date.now()}`
const runDir = path.join(here, 'e2e', '.tmp', runId)
fs.mkdirSync(runDir, { recursive: true })
process.env.ACA_E2E_RUN_DIR = runDir

// sqlite URL with an absolute Windows drive path: sqlite:///C:/dir/audit.db
const dbSqliteUrl = `sqlite:///${runDir.replace(/\\/g, '/')}/audit.db`
const baseURL = 'http://127.0.0.1:5173'
const backendURL = 'http://127.0.0.1:8000'

// Shared backend environment: isolated DB + safely degraded optional services.
const backendEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  DATABASE_URL: dbSqliteUrl,
  DEPLOY_MODE: 'LOCAL',
  // Unreachable port -> connection refused immediately -> AI guidance is
  // recorded UNAVAILABLE and the audit still completes deterministically.
  OLLAMA_HOST: 'http://127.0.0.1:9',
  PREVIEW_STORAGE_DIR: path.join(runDir, 'previews'),
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/prepare-tmp.mjs',
  globalTeardown: './e2e/cleanup-tmp.mjs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['./e2e/evidence-reporter.ts'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  // Supported deployment: Windows desktop only (no phone support).
  // Viewports cover typical laptop/desktop windows; 768px retained only as
  // a narrow desktop stress test where appropriate, not as a tablet/mobile target.
  projects: [
    {
      name: 'laptop-primary',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'compact',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 } },
    },
  ],
  webServer: [
    {
      command: `"${backendPython}" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-level warning`,
      url: `${backendURL}/health`,
      cwd: backendDir,
      env: backendEnv,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
      url: `${baseURL}/`,
      cwd: here,
      env: { ...process.env } as Record<string, string>,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
})
