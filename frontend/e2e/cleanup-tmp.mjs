/**
 * Best-effort removal of frontend/e2e/.tmp (isolated run databases, preview
 * storage). Runs after Playwright has shut down its webServer processes.
 *
 * IMPORTANT: this runs in-process. It must NOT call process.exit() and must
 * always return normally — otherwise the runner dies before reporters flush
 * their final output.
 */
import { rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default async function () {
  const tmpDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')
  // Freshly killed uvicorn children may hold sqlite handles a moment longer;
  // give the OS time to release them before each attempt.
  await sleep(3000)
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      if (!existsSync(tmpDir)) return
      rmSync(tmpDir, { recursive: true, force: true })
      console.log(`Cleaned ${tmpDir}`)
      return
    } catch (err) {
      if (attempt === 8) {
        console.warn(`Could not fully clean ${tmpDir}: ${err.message} (a later run's globalSetup will remove it)`)
        return
      }
      await sleep(2000 * attempt)
    }
  }
}
