/**
 * First-run setup guidance persistence (Dashboard).
 *
 * Versioned localStorage record holding only dismissal state:
 *   { schema_version, dismissed, updated_at }
 *
 * Never stores document data, filenames, Profile payloads, Audit results,
 * credentials, or API keys. Corrupted records are removed safely so guidance
 * reappears; future schema versions are handled conservatively (treated as
 * already-dismissed so returning users are never interrupted).
 *
 * localStorage unavailable → in-memory fallback keeps the panel usable for
 * the current session without persistence.
 */

export const GUIDANCE_STORAGE_KEY = 'aca:guidance:v1'
export const GUIDANCE_SCHEMA_VERSION = 1

export interface GuidanceRecord {
  schema_version: number
  dismissed: boolean
  updated_at: string
}

export interface GuidanceStorageAdapter {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Interpret a parsed guidance record.
 * Returns `dismissed: true` for future schema versions (conservative:
 * returning users are not interrupted by unknown formats) and `false` for
 * version 1 records that are explicitly not dismissed. Null = unusable.
 */
export function parseGuidanceState(raw: string | null): { dismissed: boolean } | null {
  if (raw === null || raw.trim().length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null // corrupted — caller removes and re-shows
  }
  if (!isRecord(parsed)) return null
  const keys = Object.keys(parsed)
  if (!keys.includes('schema_version') || !keys.includes('dismissed')) return null

  if (parsed.schema_version !== GUIDANCE_SCHEMA_VERSION) {
    // Future version: conservative — assume the user has already seen it.
    return parsed.dismissed === false ? { dismissed: false } : { dismissed: true }
  }
  if (
    typeof parsed.dismissed !== 'boolean' ||
    typeof parsed.updated_at !== 'string' ||
    Number.isNaN(Date.parse(parsed.updated_at))
  ) {
    return null
  }
  return { dismissed: parsed.dismissed }
}

export function serializeGuidanceState(dismissed: boolean, updatedAt: string): string {
  return JSON.stringify({
    schema_version: GUIDANCE_SCHEMA_VERSION,
    dismissed,
    updated_at: updatedAt,
  })
}

export function saveGuidanceDismissed(
  adapter: GuidanceStorageAdapter | null,
  dismissed: boolean,
): boolean {
  if (!adapter) return false
  try {
    adapter.set(
      GUIDANCE_STORAGE_KEY,
      serializeGuidanceState(dismissed, new Date().toISOString()),
    )
    return true
  } catch {
    return false
  }
}

/**
 * Load dismissal state. Corrupted or future-version records that cannot be
 * interpreted are removed safely; null means "no usable record" (first visit
 * or recovered corruption) — guidance should appear.
 */
export function loadGuidanceDismissed(
  adapter: GuidanceStorageAdapter | null,
): boolean {
  if (!adapter) return false
  try {
    const raw = adapter.get(GUIDANCE_STORAGE_KEY)
    if (raw === null) return false
    const state = parseGuidanceState(raw)
    if (state === null) {
      try {
        adapter.remove(GUIDANCE_STORAGE_KEY)
      } catch {
        /* ignore */
      }
      return false
    }
    return state.dismissed
  } catch {
    return false
  }
}

export function clearGuidance(adapter: GuidanceStorageAdapter | null): void {
  if (!adapter) return
  try {
    adapter.remove(GUIDANCE_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/** Browser adapter with probe; memory fallback when storage is blocked. */
export function createBrowserGuidanceAdapter(): GuidanceStorageAdapter | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const probe = '__aca_guidance_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return {
      get: (k) => window.localStorage.getItem(k),
      set: (k, v) => window.localStorage.setItem(k, v),
      remove: (k) => window.localStorage.removeItem(k),
    }
  } catch {
    return null
  }
}

export function createMemoryGuidanceAdapter(): GuidanceStorageAdapter {
  const map = new Map<string, string>()
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v)
    },
    remove: (k) => {
      map.delete(k)
    },
  }
}
