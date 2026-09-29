/**
 * Collapsible Audit Workspace panel-state rules.
 *
 * Pure logic: width-based safe defaults, panel toggles, document focus
 * mode (pre-state capture + restore), Escape/audit-change reset, and the
 * grid-template / aria / label helpers. Guided Fixes state is never part
 * of this reducer — verify the invariants that keep panel visibility
 * independent from it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialPanelSession,
  reducePanelSession,
  workspaceGridTemplateColumns,
  panelToggleLabel,
  panelAriaExpanded,
  defaultPanelStates,
  selectionOpensDetails,
  FINDINGS_PANEL_PX,
  DETAILS_PANEL_PX,
} from '../src/lib/audit/workspace-panels.ts'

// ---------------------------------------------------------------------------
// Phase 6 — safe defaults at the three supported desktop widths
// ---------------------------------------------------------------------------

test('at 1366: findings open, details open only with a selection', () => {
  assert.deepEqual(defaultPanelStates(1366, false), { findings: true, details: false })
  assert.deepEqual(defaultPanelStates(1366, true), { findings: true, details: true })
})

test('at 1280 (breakpoint boundary): findings open, details open only with a selection', () => {
  assert.deepEqual(defaultPanelStates(1280, true), { findings: true, details: true })
  assert.deepEqual(defaultPanelStates(1279, true), { findings: true, details: false })
})

test('at 1024: findings may remain open, details start collapsed', () => {
  assert.deepEqual(defaultPanelStates(1024, true), { findings: true, details: false })
  assert.ok(!selectionOpensDetails(1024))
})

test('initial session: no focus mode, no pre-focus state', () => {
  const s = initialPanelSession(1366)
  assert.equal(s.focusMode, false)
  assert.equal(s.preFocus, null)
  assert.deepEqual(s.visible, defaultPanelStates(1366, false))
})

// ---------------------------------------------------------------------------
// Toggle: independent, selection/preview state untouched by construction
// ---------------------------------------------------------------------------

test('toggling findings does not touch details, open or closed', () => {
  // No selection yet: details starts closed at 1366; the findings toggle
  // must not change it.
  let s = initialPanelSession(1366)
  assert.equal(s.visible.details, false)
  s = reducePanelSession(s, { type: 'toggle-panel', panel: 'findings' }, 1366)
  assert.equal(s.visible.findings, false)
  assert.equal(s.visible.details, false)
  // Toggle again reopens.
  s = reducePanelSession(s, { type: 'toggle-panel', panel: 'findings' }, 1366)
  assert.equal(s.visible.findings, true)
  // After a selection auto-opens details, the findings toggle still leaves it.
  s = reducePanelSession(s, { type: 'auto-open-details' }, 1366)
  s = reducePanelSession(s, { type: 'toggle-panel', panel: 'findings' }, 1366)
  assert.equal(s.visible.findings, false)
  assert.equal(s.visible.details, true)
  // Toggle again reopens.
  s = reducePanelSession(s, { type: 'toggle-panel', panel: 'findings' }, 1366)
  assert.equal(s.visible.findings, true)
})

test('toggling details closes it while findings stays open', () => {
  let s = initialPanelSession(1280)
  s = reducePanelSession(s, { type: 'auto-open-details' }, 1280)
  assert.equal(s.visible.details, true)
  s = reducePanelSession(s, { type: 'toggle-panel', panel: 'details' }, 1280)
  assert.equal(s.visible.details, false)
  assert.equal(s.visible.findings, true)
})

test('both panels can be closed independently', () => {
  let s = initialPanelSession(1366)
  s = reducePanelSession(s, { type: 'auto-open-details' }, 1366)
  s = reducePanelSession(s, { type: 'toggle-panel', panel: 'findings' }, 1366)
  s = reducePanelSession(s, { type: 'toggle-panel', panel: 'details' }, 1366)
  assert.deepEqual(s.visible, { findings: false, details: false })
})

// ---------------------------------------------------------------------------
// Auto-open details on selection (>= 1280 only, idempotent)
// ---------------------------------------------------------------------------

test('auto-open details only at >= 1280 and only when details is closed', () => {
  let s = initialPanelSession(1366)
  assert.equal(s.visible.details, false)
  s = reducePanelSession(s, { type: 'auto-open-details' }, 1366)
  assert.equal(s.visible.details, true)
  // Idempotent: no change when already open.
  const before = s
  s = reducePanelSession(s, { type: 'auto-open-details' }, 1366)
  assert.equal(s, before)
  // Below the breakpoint: selection never opens details.
  s = initialPanelSession(1024)
  s = reducePanelSession(s, { type: 'auto-open-details' }, 1024)
  assert.equal(s.visible.details, false)
})

// ---------------------------------------------------------------------------
// Document focus mode: capture, restore, re-entry
// ---------------------------------------------------------------------------

test('enter focus hides both panels and remembers the pre-focus state', () => {
  let s = initialPanelSession(1366)
  s = reducePanelSession(s, { type: 'auto-open-details' }, 1366)
  s = reducePanelSession(s, { type: 'enter-focus' }, 1366)
  assert.equal(s.focusMode, true)
  assert.deepEqual(s.visible, { findings: false, details: false })
  assert.deepEqual(s.preFocus, { findings: true, details: true })
})

test('exit focus restores exactly the pre-focus visibility', () => {
  let s = initialPanelSession(1366)
  s = reducePanelSession(s, { type: 'toggle-panel', panel: 'details' }, 1366)
  s = reducePanelSession(s, { type: 'enter-focus' }, 1366)
  s = reducePanelSession(s, { type: 'exit-focus' }, 1366)
  assert.equal(s.focusMode, false)
  assert.equal(s.preFocus, null)
  // Pre-focus state was findings open + details open (toggled above).
  assert.deepEqual(s.visible, { findings: true, details: true })
})

test('exit focus after both panels were closed restores both closed', () => {
  let s = initialPanelSession(1280)
  s = reducePanelSession(s, { type: 'toggle-panel', panel: 'findings' }, 1280)
  s = reducePanelSession(s, { type: 'enter-focus' }, 1280)
  s = reducePanelSession(s, { type: 'exit-focus' }, 1280)
  assert.deepEqual(s.visible, { findings: false, details: false })
})

test('toggles are inert during focus mode; exit-focus without enter is a no-op', () => {
  let s = initialPanelSession(1366)
  s = reducePanelSession(s, { type: 'enter-focus' }, 1366)
  const before = s
  s = reducePanelSession(s, { type: 'toggle-panel', panel: 'findings' }, 1366)
  assert.equal(s, before)
  const noFocus = initialPanelSession(1366)
  s = reducePanelSession(noFocus, { type: 'exit-focus' }, 1366)
  assert.equal(s, noFocus)
})

// ---------------------------------------------------------------------------
// Audit-change reset — session state never leaks across audits
// ---------------------------------------------------------------------------

test('audit-change resets visibility, focus mode, and pre-focus state', () => {
  let s = initialPanelSession(1366)
  s = reducePanelSession(s, { type: 'enter-focus' }, 1366)
  s = reducePanelSession(s, { type: 'audit-change', width: 1024 }, 1024)
  assert.equal(s.focusMode, false)
  assert.equal(s.preFocus, null)
  assert.deepEqual(s.visible, defaultPanelStates(1024, false))
})

// ---------------------------------------------------------------------------
// Grid template — closed panel tracks vanish, preview owns the width
// ---------------------------------------------------------------------------

test('grid template omits closed panel tracks', () => {
  assert.equal(
    workspaceGridTemplateColumns({ findings: true, details: true }),
    `${FINDINGS_PANEL_PX}px minmax(0, 1fr) ${DETAILS_PANEL_PX}px`,
  )
  assert.equal(
    workspaceGridTemplateColumns({ findings: false, details: true }),
    `minmax(0, 1fr) ${DETAILS_PANEL_PX}px`,
  )
  assert.equal(
    workspaceGridTemplateColumns({ findings: true, details: false }),
    `${FINDINGS_PANEL_PX}px minmax(0, 1fr)`,
  )
  assert.equal(
    workspaceGridTemplateColumns({ findings: false, details: false }),
    'minmax(0, 1fr)',
  )
})

// ---------------------------------------------------------------------------
// Toggle labels + aria-expanded (effective state during focus mode)
// ---------------------------------------------------------------------------

test('toggle labels flip with visibility and focus mode', () => {
  const open = { findings: true, details: true }
  assert.equal(panelToggleLabel('findings', open, false), 'Hide findings')
  assert.equal(panelToggleLabel('details', open, false), 'Hide details')
  const closed = { findings: false, details: false }
  assert.equal(panelToggleLabel('findings', closed, false), 'Show findings')
  assert.equal(panelToggleLabel('details', closed, false), 'Show details')
  // Focus mode reports both as hidden even though the session still holds
  // the pre-focus state.
  assert.equal(panelToggleLabel('findings', open, true), 'Show findings')
  assert.equal(panelAriaExpanded('findings', open, true), false)
  assert.equal(panelAriaExpanded('details', open, false), true)
})
