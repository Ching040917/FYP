/**
 * Setup Readiness — presentation helpers (Build B1).
 *
 * Pure, deterministic: validates the Backend readiness payload and maps it
 * to safe display rows. Never renders raw IDs, hosts, paths, keys, provider
 * responses, or malformed data. Malformed input is rejected — it can never
 * become "ready".
 */

export type ReadinessOverall = 'ready' | 'degraded' | 'blocked'
export type ReadinessState =
  | 'ready'
  | 'unavailable'
  | 'optional'
  | 'misconfigured'
  | 'unknown'

export interface ReadinessComponentRow {
  id: string
  state: ReadinessState
  required: boolean
  message: string
  detail: string | null
  /** Friendly display name (known ids) or 'Additional component'. */
  label: string
  /** Friendly state label or 'Could not confirm'. */
  stateLabel: string
}

export interface ReadinessModel {
  overall: ReadinessOverall
  rows: ReadinessComponentRow[]
  checkedAt: string
}

const KNOWN_LABELS: Record<string, string> = {
  core_backend: 'Core application',
  database: 'Local audit database',
  docx_audit: 'Document checking',
  libreoffice: 'Rendered-page support',
  rendered_preview: 'Page preview',
  ollama: 'Local AI review',
  local_model: 'Local AI model',
  cloud_ai: 'Optional cloud AI',
}

const STATE_LABELS: Record<string, string> = {
  ready: 'Ready',
  unavailable: 'Unavailable',
  optional: 'Optional',
  misconfigured: 'Action needed',
  unknown: 'Could not confirm',
}

const COMPONENT_ORDER = [
  'core_backend',
  'database',
  'docx_audit',
  'libreoffice',
  'rendered_preview',
  'ollama',
  'local_model',
  'cloud_ai',
]

const VALID_OVERALL = new Set(['ready', 'degraded', 'blocked'])
const VALID_STATES = new Set(['ready', 'unavailable', 'optional', 'misconfigured', 'unknown'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate + adapt a raw readiness payload.
 * Returns null when the payload cannot be trusted; malformed data never
 * becomes ready. Tolerates reordering and unknown future ids/states.
 */
export function adaptReadiness(raw: unknown): ReadinessModel | null {
  if (!isRecord(raw)) return null
  const overall = raw.overall
  if (typeof overall !== 'string' || !VALID_OVERALL.has(overall)) return null
  if (!Array.isArray(raw.components)) return null
  const checkedAt = raw.checked_at
  if (typeof checkedAt !== 'string' || checkedAt.length === 0) return null

  const rows: ReadinessComponentRow[] = []
  for (const c of raw.components) {
    if (!isRecord(c)) continue
    const id = c.id
    if (typeof id !== 'string' || id.length === 0) continue
    const required = c.required === true
    const message = c.message
    if (typeof message !== 'string') continue
    const stateRaw = c.state
    const state: ReadinessState =
      typeof stateRaw === 'string' && VALID_STATES.has(stateRaw)
        ? (stateRaw as ReadinessState)
        : 'unknown'
    const detail = typeof c.detail === 'string' && c.detail.length > 0 ? c.detail : null
    rows.push({
      id,
      state,
      required,
      message,
      detail,
      label: KNOWN_LABELS[id] ?? 'Additional component',
      stateLabel: STATE_LABELS[state] ?? 'Could not confirm',
    })
  }

  // Deterministic ordering: known ids first in contract order, unknown ids
  // after, each stable by id.
  rows.sort((a, b) => {
    const ai = COMPONENT_ORDER.indexOf(a.id)
    const bi = COMPONENT_ORDER.indexOf(b.id)
    const ao = ai === -1 ? COMPONENT_ORDER.length : ai
    const bo = bi === -1 ? COMPONENT_ORDER.length : bi
    if (ao !== bo) return ao - bo
    if (ai === -1 && bi === -1) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    return 0
  })

  return { overall: overall as ReadinessOverall, rows, checkedAt }
}

/** Number of optional components that are unavailable (drives degraded count). */
export function unavailableOptionalCount(rows: ReadinessComponentRow[]): number {
  return rows.filter((r) => !r.required && r.state === 'unavailable').length
}

/** Number of required components needing attention (misconfigured/unknown/unavailable). */
export function requiredActionNeededCount(rows: ReadinessComponentRow[]): number {
  return rows.filter((r) => r.required && r.state !== 'ready').length
}

export function overallHeadline(overall: ReadinessOverall): string {
  if (overall === 'ready' || overall === 'degraded') return 'Ready to audit documents'
  return 'Action needed before auditing'
}

export function overallSupporting(overall: ReadinessOverall): string {
  if (overall === 'ready') {
    return 'Required document-checking features are available.'
  }
  if (overall === 'degraded') {
    return 'Some optional features are unavailable. Deterministic document checks remain available.'
  }
  return 'A required component needs attention before auditing.'
}

export function issueCountSentence(
  overall: ReadinessOverall,
  rows: ReadinessComponentRow[],
): string {
  if (overall === 'degraded') {
    const n = unavailableOptionalCount(rows)
    if (n === 0) return ''
    return n === 1 ? '1 optional feature unavailable' : `${n} optional features unavailable`
  }
  if (overall === 'blocked') {
    const n = requiredActionNeededCount(rows)
    if (n === 0) return ''
    return n === 1 ? '1 component needs attention' : `${n} components need attention`
  }
  return ''
}
