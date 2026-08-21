/**
 * Audit completion persistence (Dashboard) — presentation-safe, tab-scoped.
 *
 * The completion shortcut ("View audit") must survive Dashboard → Manage
 * Profiles → Return and a same-tab refresh without ever inferring the audit
 * from History ordering, filename, or timestamps. Dashboard React state alone
 * is lost on unmount, so a dedicated versioned sessionStorage record carries
 * only the minimum needed to render the navigation panel.
 *
 * Persisted shape (presentation-safe, no document/Profile data):
 *   schema_version, audit_id, score, major_count, minor_count, completed_at
 *
 * Never persisted: document text, filename, DOCX bytes, findings, profile
 * payload/snapshot, API keys, credentials, filesystem paths.
 */

export const AUDIT_COMPLETION_STORAGE_KEY = 'audit-completion:v1'
export const AUDIT_COMPLETION_SCHEMA_VERSION = 1

export interface AuditCompletionSnapshot {
  schema_version: number
  audit_id: string
  score: number
  major_count: number
  minor_count: number
  completed_at: string
}

export interface CompletionStorageAdapter {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

const ALLOWED_KEYS = new Set<string>([
  'schema_version',
  'audit_id',
  'score',
  'major_count',
  'minor_count',
  'completed_at',
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidSnapshot(v: unknown): v is AuditCompletionSnapshot {
  if (!isRecord(v)) return false
  // Strict: reject unknown fields
  for (const k of Object.keys(v)) {
    if (!ALLOWED_KEYS.has(k)) return false
  }
  if (typeof v.schema_version !== 'number' || v.schema_version !== AUDIT_COMPLETION_SCHEMA_VERSION) return false
  if (typeof v.audit_id !== 'string' || v.audit_id.trim().length === 0) return false
  if (typeof v.completed_at !== 'string' || v.completed_at.trim().length === 0) return false
  // Validate completed_at is at least parseable
  if (Number.isNaN(Date.parse(v.completed_at))) return false
  if (typeof v.score !== 'number' || !Number.isFinite(v.score)) return false
  if (v.score < 0 || v.score > 100) return false
  if (typeof v.major_count !== 'number' || !Number.isFinite(v.major_count) || !Number.isInteger(v.major_count) || v.major_count < 0) return false
  if (typeof v.minor_count !== 'number' || !Number.isFinite(v.minor_count) || !Number.isInteger(v.minor_count) || v.minor_count < 0) return false
  return true
}

export function serializeCompletionSnapshot(snapshot: AuditCompletionSnapshot): string {
  return JSON.stringify(snapshot)
}

export function parseCompletionSnapshot(raw: string | null): AuditCompletionSnapshot | null {
  if (raw === null || raw.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isValidSnapshot(parsed)) return parsed
    return null
  } catch {
    return null
  }
}

export function saveCompletionSnapshot(
  adapter: CompletionStorageAdapter | null,
  snapshot: AuditCompletionSnapshot,
): boolean {
  if (!adapter) return false
  if (!isValidSnapshot(snapshot)) return false
  try {
    adapter.set(AUDIT_COMPLETION_STORAGE_KEY, serializeCompletionSnapshot(snapshot))
    return true
  } catch {
    return false
  }
}

export function loadCompletionSnapshot(
  adapter: CompletionStorageAdapter | null,
): AuditCompletionSnapshot | null {
  if (!adapter) return null
  try {
    const raw = adapter.get(AUDIT_COMPLETION_STORAGE_KEY)
    if (raw === null) return null
    const parsed = parseCompletionSnapshot(raw)
    if (!parsed) {
      // Malformed or unsupported version — remove so it does not linger.
      try { adapter.remove(AUDIT_COMPLETION_STORAGE_KEY) } catch { /* ignore */ }
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function clearCompletionSnapshot(
  adapter: CompletionStorageAdapter | null,
): void {
  if (!adapter) return
  try { adapter.remove(AUDIT_COMPLETION_STORAGE_KEY) } catch { /* ignore */ }
}

export function createSessionStorageAdapter(): CompletionStorageAdapter | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null
    const probe = '__audit_completion_probe__'
    window.sessionStorage.setItem(probe, '1')
    window.sessionStorage.removeItem(probe)
    return {
      get: (k) => window.sessionStorage.getItem(k),
      set: (k, v) => window.sessionStorage.setItem(k, v),
      remove: (k) => window.sessionStorage.removeItem(k),
    }
  } catch {
    return null
  }
}

export function createMemoryCompletionAdapter(): CompletionStorageAdapter {
  const map = new Map<string, string>()
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => { map.set(k, v) },
    remove: (k) => { map.delete(k) },
  }
}

/**
 * Build a completion snapshot from the exact POST response's AuditResult.
 * Returns null when audit_id is missing (failed/incomplete audit — no panel).
 */
export function toCompletionSnapshot(args: {
  audit_id: string | undefined
  score: number
  major_count: number
  minor_count: number
  completed_at: string
}): AuditCompletionSnapshot | null {
  const { audit_id, score, major_count, minor_count, completed_at } = args
  if (typeof audit_id !== 'string' || audit_id.trim().length === 0) return null
  const snapshot: AuditCompletionSnapshot = {
    schema_version: AUDIT_COMPLETION_SCHEMA_VERSION,
    audit_id: audit_id.trim(),
    score,
    major_count,
    minor_count,
    completed_at,
  }
  if (!isValidSnapshot(snapshot)) return null
  return snapshot
}
