/**
 * Pure state rules for the collapsible Audit Workspace panels.
 *
 * The React components (AuditPage) consume these functions so the panel,
 * focus-mode, and grid-template logic stays testable without a DOM.
 * Panel visibility is SESSION-ONLY state: it never touches the audit
 * record, the database, or the Guided Fixes selection.
 */

/** Desktop layout breakpoint — three supported desktop widths: 1024/1280/1366. */
export const XL_PANEL_BREAKPOINT_PX = 1280

/** Fixed panel column widths (px) in the workspace grid. */
export const FINDINGS_PANEL_PX = 300
export const DETAILS_PANEL_PX = 340

export interface PanelVisibility {
  findings: boolean
  details: boolean
}

/**
 * Safe panel defaults when opening (or re-opening) an audit at `width`.
 * Findings stays open at every supported width; Details is open by
 * default only at >= 1280 AND when a finding is actually selected —
 * at 1024 the preview must stay wide, so Details starts collapsed
 * there and can be opened on demand.
 */
export function defaultPanelStates(width: number, hasSelection: boolean): PanelVisibility {
  return {
    findings: true,
    details: width >= XL_PANEL_BREAKPOINT_PX && hasSelection,
  }
}

/** Finding selection auto-opens the Details panel at >= 1280 only. */
export function selectionOpensDetails(width: number): boolean {
  return width >= XL_PANEL_BREAKPOINT_PX
}

/**
 * Document focus mode: both side panels hide and the preview owns the
 * workspace width. The pre-focus panel states are returned so exiting
 * restores exactly what the user had (never overwrites their settings).
 */
export function preFocusStates(visible: PanelVisibility): PanelVisibility {
  return { findings: visible.findings, details: visible.details }
}

export function exitFocusMode(pre: PanelVisibility | null): PanelVisibility {
  // No remembered state (component session start) -> safe default.
  return pre ? { ...pre } : { findings: true, details: false }
}

/**
 * Grid template columns for the three-panel workspace. Tracks are emitted
 * only for VISIBLE panels — a closed panel is unmounted from flow (its
 * column gets display:none), so the preview's 1fr track always owns the
 * released width immediately.
 */
export function workspaceGridTemplateColumns(visible: PanelVisibility): string {
  const tracks: string[] = []
  if (visible.findings) tracks.push(`${FINDINGS_PANEL_PX}px`)
  tracks.push('minmax(0, 1fr)')
  if (visible.details) tracks.push(`${DETAILS_PANEL_PX}px`)
  return tracks.join(' ')
}

/** Panel identifiers used for toggle controls. */
export type PanelId = 'findings' | 'details'

/** Concise English label for a panel toggle button. */
export function panelToggleLabel(panel: PanelId, visible: PanelVisibility, focusMode: boolean): string {
  const open = focusMode ? false : visible[panel]
  const name = panel === 'findings' ? 'findings' : 'details'
  return open ? `Hide ${name}` : `Show ${name}`
}

/** aria-expanded is reported for the EFFECTIVE panel state (focus hides both). */
export function panelAriaExpanded(
  panel: PanelId,
  visible: PanelVisibility,
  focusMode: boolean,
): boolean {
  return focusMode ? false : visible[panel]
}

/**
 * Session-only workspace panel state (no persistence, no audit-record
 * writes). `preFocus` remembers the panel visibility that existed before
 * document focus mode so exiting restores it exactly.
 */
export interface PanelSession {
  visible: PanelVisibility
  focusMode: boolean
  preFocus: PanelVisibility | null
}

export type PanelAction =
  | { type: 'toggle-panel'; panel: PanelId }
  | { type: 'enter-focus' }
  | { type: 'exit-focus' }
  /** Opening another audit resets to the width-based safe defaults. */
  | { type: 'audit-change'; width: number }
  /** Desktop finding selection auto-opens Details at >= 1280. */
  | { type: 'auto-open-details' }

export function initialPanelSession(width: number): PanelSession {
  return {
    visible: defaultPanelStates(width, false),
    focusMode: false,
    preFocus: null,
  }
}

export function reducePanelSession(
  state: PanelSession,
  action: PanelAction,
  width: number,
): PanelSession {
  switch (action.type) {
    case 'toggle-panel':
      if (state.focusMode) return state
      return { ...state, visible: { ...state.visible, [action.panel]: !state.visible[action.panel] } }
    case 'enter-focus':
      if (state.focusMode) return state
      return { ...state, visible: { findings: false, details: false }, focusMode: true, preFocus: preFocusStates(state.visible) }
    case 'exit-focus':
      if (!state.focusMode) return state
      return { ...state, visible: exitFocusMode(state.preFocus), focusMode: false, preFocus: null }
    case 'audit-change':
      return { visible: defaultPanelStates(action.width, false), focusMode: false, preFocus: null }
    case 'auto-open-details':
      if (state.focusMode) return state
      if (!selectionOpensDetails(width) || state.visible.details) return state
      return { ...state, visible: { ...state.visible, details: true } }
  }
}
