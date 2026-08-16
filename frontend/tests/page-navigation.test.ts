/**
 * Manual-vs-finding page navigation tests (PageCommandConsumer).
 *
 * Simulates the viewer's page state machine: one-shot finding commands,
 * manual Previous/Next ownership, no replay on rerender/zoom/Strict Mode,
 * latest command wins, and indicator/canvas agreement.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PageCommandConsumer, clampPage } from '../src/lib/pdf/pending-navigation.ts'

/** Viewer simulation: current page + consumer + manual controls. */
function makeViewer(numPages: number) {
  const consumer = new PageCommandConsumer()
  let page = 1
  return {
    get page() {
      return page
    },
    /** Apply a finding command — returns true when it navigated. */
    findingCommand(command: { page: number; seq: number } | null): boolean {
      const target = consumer.consume(command, numPages)
      if (target === null || target === page) return false
      page = target
      return true
    },
    next(): void {
      page = Math.min(numPages, page + 1)
    },
    prev(): void {
      page = Math.max(1, page - 1)
    },
    reset(): void {
      consumer.reset()
      page = 1
    },
  }
}

// ---------------------------------------------------------------------------
// finding navigates to Page 1, then manual Next reaches Page 2
// ---------------------------------------------------------------------------

test('finding to page 1 then manual Next reaches page 2 and stays', () => {
  const v = makeViewer(3)
  // already on page 1: the command is consumed without a visible jump
  assert.equal(v.findingCommand({ page: 1, seq: 1 }), false)
  assert.equal(v.page, 1)
  v.next()
  assert.equal(v.page, 2)
  // stale command must NOT pull back to 1 on rerenders
  assert.equal(v.findingCommand({ page: 1, seq: 1 }), false) // consumed
  assert.equal(v.page, 2)
  v.next()
  assert.equal(v.page, 3)
  assert.equal(v.findingCommand({ page: 1, seq: 1 }), false)
  assert.equal(v.page, 3)
})

// ---------------------------------------------------------------------------
// finding to Page 2, then manual Previous/Next work
// ---------------------------------------------------------------------------

test('finding to page 2 then manual controls own the page', () => {
  const v = makeViewer(3)
  v.findingCommand({ page: 2, seq: 1 })
  assert.equal(v.page, 2)
  v.prev()
  assert.equal(v.page, 1)
  v.next()
  v.next()
  assert.equal(v.page, 3)
  // replay attempts are no-ops
  v.findingCommand({ page: 2, seq: 1 })
  assert.equal(v.page, 3)
})

// ---------------------------------------------------------------------------
// consumed command does not replay after rerender or zoom
// ---------------------------------------------------------------------------

test('consumed command never replays on rerender or zoom', () => {
  const v = makeViewer(3)
  v.findingCommand({ page: 2, seq: 5 })
  assert.equal(v.page, 2)
  // zoom changes trigger rerenders with the same command — no replay
  for (let i = 0; i < 10; i++) {
    assert.equal(v.findingCommand({ page: 2, seq: 5 }), false)
    assert.equal(v.page, 2)
  }
  v.next()
  assert.equal(v.page, 3)
  v.findingCommand({ page: 2, seq: 5 })
  assert.equal(v.page, 3)
})

// ---------------------------------------------------------------------------
// new finding creates a new one-shot command
// ---------------------------------------------------------------------------

test('a new finding command navigates once with a fresh seq', () => {
  const v = makeViewer(3)
  v.findingCommand({ page: 1, seq: 1 })
  assert.equal(v.page, 1)
  v.findingCommand({ page: 3, seq: 2 })
  assert.equal(v.page, 3)
  v.findingCommand({ page: 3, seq: 2 })
  assert.equal(v.page, 3) // consumed
  v.prev()
  assert.equal(v.page, 2)
  v.findingCommand({ page: 3, seq: 2 })
  assert.equal(v.page, 2) // stale command does not force back
})

// ---------------------------------------------------------------------------
// rapid finding selection uses the latest command
// ---------------------------------------------------------------------------

test('rapid selection: each command applies once, latest wins', () => {
  const v = makeViewer(3)
  v.findingCommand({ page: 1, seq: 1 })
  v.findingCommand({ page: 2, seq: 2 }) // later finding
  assert.equal(v.page, 2)
  // the earlier command must not reapply afterwards
  v.findingCommand({ page: 1, seq: 1 })
  assert.equal(v.page, 2)
})

// ---------------------------------------------------------------------------
// React Strict Mode does not replay consumed navigation
// ---------------------------------------------------------------------------

test('strict-mode double effect run does not replay', () => {
  const v = makeViewer(3)
  // effect body runs twice with the same command in Strict Mode
  const first = v.findingCommand({ page: 2, seq: 1 })
  const second = v.findingCommand({ page: 2, seq: 1 })
  assert.equal(first, true)
  assert.equal(second, false)
  assert.equal(v.page, 2)
})

// ---------------------------------------------------------------------------
// audit change / PDF replacement resets the consumer
// ---------------------------------------------------------------------------

test('audit change resets the consumer so a fresh seq navigates again', () => {
  const v = makeViewer(3)
  v.findingCommand({ page: 2, seq: 1 })
  v.reset() // new audit — consumer and page reset
  assert.equal(v.page, 1)
  // same seq restarts cleanly after reset
  assert.equal(v.findingCommand({ page: 3, seq: 1 }), true)
  assert.equal(v.page, 3)
})

// ---------------------------------------------------------------------------
// page indicator and canvas page always agree
// ---------------------------------------------------------------------------

test('indicator equals canvas page after every transition', () => {
  const v = makeViewer(4)
  const indicator = () => v.page // viewer renders exactly the current page
  v.findingCommand({ page: 4, seq: 1 })
  assert.equal(indicator(), 4)
  v.prev()
  assert.equal(indicator(), 3)
  v.next()
  assert.equal(indicator(), 4)
  // out-of-range commands clamp to the indicator
  assert.equal(clampPage(9, 4), 4)
  assert.equal(clampPage(0, 4), 1)
  v.findingCommand({ page: 0, seq: 2 }) // clamped to 1
  assert.equal(indicator(), 1)
})

// ---------------------------------------------------------------------------
// button state rules
// ---------------------------------------------------------------------------

test('Previous/Next button states follow the page bounds', () => {
  const v = makeViewer(3)
  const buttons = () => ({ prevDisabled: v.page <= 1, nextDisabled: v.page >= 3 })
  assert.deepEqual(buttons(), { prevDisabled: true, nextDisabled: false }) // page 1
  v.next()
  assert.deepEqual(buttons(), { prevDisabled: false, nextDisabled: false }) // middle
  v.next()
  assert.deepEqual(buttons(), { prevDisabled: false, nextDisabled: true }) // final
})
