/**
 * Rendered-PDF cache deletion contract (Build 9A, Blocker 2).
 *
 * Blocker 2 requirement: frontend successful deletion must invalidate the
 * rendered-PDF cache for that audit, and a FAILED API deletion must NOT
 * clear local state or the cache.
 *
 * The cache is a module-private Map in use-rendered-pdf.ts reachable only
 * through the React hook (which imports the browser-only api.ts, so it
 * cannot be imported in Node tests). The behavioral contract is therefore
 * asserted from the HistoryPage delete handler source:
 *   1. the cache drop is called ONLY after `await api.deleteAudit(...)`
 *      resolves (a rejection short-circuits before the drop, so a failed
 *      deletion can never clear the cache);
 *   2. the drop lives in the success try block, never in a finally;
 *   3. the drop targets the deleted audit's id.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const HISTORY_SOURCE = join(HERE, '..', 'src', 'pages', 'HistoryPage.tsx')

test('HistoryPage drops the cache only after the API delete resolves', () => {
  const src = readFileSync(HISTORY_SOURCE, 'utf8')

  // 1. The handler awaits the API call BEFORE touching the cache.
  const awaitBeforeDrop = /await\s+api\.deleteAudit\(audit\.id\)[\s\S]{0,400}?dropRenderedPdfCache\(audit\.id\)/
  assert.match(
    src,
    awaitBeforeDrop,
    'dropRenderedPdfCache(audit.id) must appear after await api.deleteAudit(audit.id) in handleDelete',
  )

  // 2. The drop is inside the success try block of handleDelete, NOT in a finally.
  const handler = /const handleDelete = async[\s\S]*?\n  \}/m.exec(src)?.[0] ?? src
  const tryBlock = /try\s*\{([\s\S]*?)\}\s*catch\s*\(/m.exec(handler)?.[1] ?? ''
  assert.ok(
    tryBlock.includes('dropRenderedPdfCache'),
    'dropRenderedPdfCache must be inside the try block (success only)',
  )
  assert.ok(
    !/finally\s*\{[\s\S]*dropRenderedPdfCache/.test(handler),
    'dropRenderedPdfCache must not be in a finally block',
  )
})
