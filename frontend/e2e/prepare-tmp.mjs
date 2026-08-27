/**
 * Runs before any webServer starts. Deletes stale e2e/.tmp leftovers from
 * previous runs (their file handles are long released by now) and ensures
 * the directory exists for this run. Runs in-process — must return normally.
 */
import { rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export default async function () {
  const tmpDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // Stale locks are harmless here — this run creates its own subdirectory.
  }
  mkdirSync(tmpDir, { recursive: true })
}
