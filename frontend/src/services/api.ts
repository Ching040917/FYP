import type { AuditSubmitResponse, AuditResponse, AuditListItem, DocumentBlock, FormattingProfile, ProfileValidationResult } from '../types/api'
import { isProfileObject } from '../lib/custom-profile-store/store.ts'

const API_BASE = '/api'

// Per-request timeout (ms). Aborts via AbortController so polling can't hang forever.
const UPLOAD_TIMEOUT_MS = 60_000
const POLL_TIMEOUT_MS = 10_000
const GUIDED_VERIFY_TIMEOUT_MS = 180_000

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Request timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new TimeoutError(timeoutMs)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export class ApiRequestError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }))
    throw new ApiRequestError(typeof error.detail === 'string' ? error.detail : `HTTP ${response.status}`, response.status)
  }
  return response.json()
}

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try { return decodeURIComponent(encoded) } catch { /* use the plain name */ }
  }
  return header.match(/filename="([^"]+)"/i)?.[1] ?? null
}

export const api = {
  async auditDocument(
    file: File,
    options: { profileId?: string; customProfile?: Record<string, unknown> } = {},
  ): Promise<AuditSubmitResponse> {
    if (options.profileId && options.customProfile) {
      throw new Error('provide either profileId or customProfile, not both')
    }
    const formData = new FormData()
    formData.append('file', file)
    if (options.customProfile) {
      formData.append('custom_profile', JSON.stringify(options.customProfile))
    }
    const params = new URLSearchParams()
    if (options.profileId) params.set('profile_id', options.profileId)
    const qs = params.toString()
    const url = qs ? `${API_BASE}/audit?${qs}` : `${API_BASE}/audit`
    const response = await fetchWithTimeout(
      url,
      { method: 'POST', body: formData },
      UPLOAD_TIMEOUT_MS,
    )
    return handleResponse<AuditSubmitResponse>(response)
  },

  /** Read-only list of available built-in formatting profiles (Build 5). */
  async getFormattingProfiles(): Promise<FormattingProfile[]> {
    const response = await fetchWithTimeout(
      `${API_BASE}/formatting-profiles`,
      {},
      POLL_TIMEOUT_MS,
    )
    const body = await handleResponse<{ profiles: FormattingProfile[] }>(response)
    return body.profiles
  },

  /**
   * Read-only setup readiness (Build B1). `refresh=true` bypasses the
   * Backend 30s cache (`?refresh=1`). Returns the raw payload; callers
   * validate through adaptReadiness — never expose raw errors to the UI.
   */
  async getReadiness(refresh = false): Promise<unknown> {
    const url = refresh ? `${API_BASE}/readiness?refresh=1` : `${API_BASE}/readiness`
    const response = await fetchWithTimeout(url, {}, POLL_TIMEOUT_MS)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  },

  /**
   * Local AI Citation Guidance — current local-model download snapshot
   * (GET /api/setup/local-model/download/status). Read-only: never starts a
   * pull. Returns the raw payload; callers validate through
   * `adaptDownloadStatus`, so malformed data can never render as completed.
   */
  async getLocalModelDownloadStatus(): Promise<unknown> {
    const response = await fetchWithTimeout(
      `${API_BASE}/setup/local-model/download/status`,
      {},
      POLL_TIMEOUT_MS,
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  },

  /**
   * Local AI Citation Guidance — start downloading the optional local model
   * (POST /api/setup/local-model/download).
   *
   * Sends NO parameters and NO body: the browser cannot influence the model
   * name, the Ollama origin, or insecure mode. A 409 means a download is
   * already active, which callers treat as "keep polling" rather than an
   * error. The manual `ollama pull` command remains available as a fallback.
   */
  async startLocalModelDownload(): Promise<void> {
    const response = await fetchWithTimeout(
      `${API_BASE}/setup/local-model/download`,
      { method: 'POST' },
      POLL_TIMEOUT_MS,
    )
    if (response.status === 409) return
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  },

  /**
   * Read-only canonical payload of ONE built-in formatting profile (Build 3).
   * Used to authoritatively copy a built-in profile into a custom one.
   */
  async getBuiltinProfilePayload(profileId: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(
      `${API_BASE}/formatting-profiles/${encodeURIComponent(profileId)}/payload`,
      {},
      POLL_TIMEOUT_MS,
    )
    const body = await handleResponse<unknown>(response)
    if (!isProfileObject(body) || !isProfileObject(body.profile) ||
        body.profile.profile_id !== profileId || body.profile.profile_source !== 'built_in' ||
        typeof body.profile.profile_name !== 'string') {
      throw new Error('The source profile could not be read. Please retry copying it.')
    }
    return body.profile
  },

  /**
   * Presentation-safe backend validation of ONE custom formatting profile
   * (Build 3). Returns a discriminated result so the editor can distinguish
   * a network failure from a definite validation failure.
   */
  async validateCustomProfile(payload: Record<string, unknown>): Promise<ProfileValidationResult> {
    try {
      const response = await fetchWithTimeout(
        `${API_BASE}/formatting-profiles/validate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
        UPLOAD_TIMEOUT_MS,
      )
      const body: unknown = await response.json().catch(() => null)
      if (!isProfileObject(body)) return { valid: false, unreachable: true }
      if (body.valid === false && (response.ok || response.status === 422) &&
          Array.isArray(body.errors) && body.errors.length > 0 &&
          body.errors.every((error) => isProfileObject(error) && typeof error.field === 'string' && typeof error.message === 'string')) {
        return { valid: false, errors: body.errors as { field: string; message: string }[] }
      }
      if (!response.ok || body.valid !== true || !isProfileObject(body.profile)) return { valid: false, unreachable: true }
      const profile = body.profile
      const groups = ['body', 'heading', 'margins', 'references', 'captions', 'lists', 'role_policy', 'citation_matching', 'headers', 'footers', 'page_numbers']
      if (typeof profile.profile_id !== 'string' || !profile.profile_id.trim() || profile.profile_id !== payload.profile_id || profile.profile_source !== 'custom' ||
          typeof profile.profile_name !== 'string' || !profile.profile_name.trim() ||
          typeof profile.description !== 'string' || profile.citation_style !== 'APA 7' ||
          typeof profile.profile_version !== 'number' || !Number.isInteger(profile.profile_version) || profile.profile_version < 1 ||
          groups.some((key) => !isProfileObject(profile[key]))) {
        return { valid: false, unreachable: true }
      }
      for (const key of groups) {
        const group = profile[key] as Record<string, unknown>
        for (const [field, value] of Object.entries(group)) {
          if ((field.startsWith('check_') || field === 'inherit_body_font' || field === 'allow_heading_aliases' ||
              field === 'heading_bold' || field === 'flag_ambiguous_matches' || field === 'allow_personal_communication') &&
              typeof value !== 'boolean' && !(key === 'references' && field === 'check_line_spacing' && value === null)) {
            return { valid: false, unreachable: true }
          }
          if ((field.endsWith('_pt') || field.endsWith('_in') || field === 'line_spacing') && value !== null &&
              (typeof value !== 'number' || !Number.isFinite(value))) return { valid: false, unreachable: true }
          if (field === 'allowed_font_combos' && value !== null &&
              (!Array.isArray(value) || !value.every((pair) => Array.isArray(pair) && pair.length === 2 &&
                typeof pair[0] === 'string' && typeof pair[1] === 'number' && Number.isFinite(pair[1])))) {
            return { valid: false, unreachable: true }
          }
          if ((field === 'font_family' || field === 'heading_text' || field === 'alignment' || field === 'heading_alignment') &&
              value !== null && typeof value !== 'string') return { valid: false, unreachable: true }
        }
      }
      const rolePolicy = profile.role_policy as Record<string, unknown>
      if (!Array.isArray(rolePolicy.exempt_roles) || !rolePolicy.exempt_roles.every((role) => typeof role === 'string') ||
          !['administrative', 'scholarly', 'both'].includes(rolePolicy.table_eligibility as string)) return { valid: false, unreachable: true }
      return { valid: true, profile }
    } catch {
      return { valid: false, unreachable: true }
    }
  },

  async getAudit(auditId: string): Promise<AuditResponse> {
    const response = await fetchWithTimeout(
      `${API_BASE}/audit/${auditId}`,
      {},
      POLL_TIMEOUT_MS,
    )
    return handleResponse<AuditResponse>(response)
  },

  async listAudits(limit = 20, offset = 0): Promise<AuditListItem[]> {
    const response = await fetchWithTimeout(`${API_BASE}/audits?limit=${limit}&offset=${offset}`, {}, POLL_TIMEOUT_MS)
    return handleResponse<AuditListItem[]>(response)
  },

  async deleteAudit(auditId: string): Promise<{ status: string; audit_id: string; filename: string }> {
    const response = await fetchWithTimeout(
      `${API_BASE}/audit/${auditId}`,
      { method: 'DELETE' },
      UPLOAD_TIMEOUT_MS,
    )
    return handleResponse(response)
  },

  async healthCheck(): Promise<{ status: string }> {
    const response = await fetchWithTimeout('/health', {}, POLL_TIMEOUT_MS)
    return handleResponse<{ status: string }>(response)
  },

  async getDocumentBlocks(auditId: string): Promise<{ audit_id: string; blocks: DocumentBlock[] | null }> {
    const response = await fetchWithTimeout(
      `${API_BASE}/audit/${auditId}/document-blocks`,
      {},
      POLL_TIMEOUT_MS,
    )
    return handleResponse<{ audit_id: string; blocks: DocumentBlock[] | null }>(response)
  },

  /**
   * Download the audit report as a PDF Blob. The response is a binary
   * document, not JSON — errors are still parsed for their backend `detail`
   * message (simple language, no server internals).
   */
  async exportAuditPdf(auditId: string): Promise<{ blob: Blob; filename: string | null }> {
    const response = await fetchWithTimeout(
      `${API_BASE}/audit/${auditId}/export-pdf`,
      {},
      UPLOAD_TIMEOUT_MS,
    )
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Unknown error' }))
      throw new Error(error.detail || `HTTP ${response.status}`)
    }
    const blob = await response.blob()
    return { blob, filename: parseContentDispositionFilename(response.headers.get('content-disposition')) }
  },

  /**
   * Fetch a persisted rendered PDF preview. Never throws for HTTP errors —
   * returns a discriminated result so the viewer can map 404/409/410 to
   * truthful fallback states. status === 0 means network/timeout failure.
   */
  async getRenderedPreview(
    auditId: string,
  ): Promise<{ ok: true; blob: Blob } | { ok: false; status: number; detail: string }> {
    try {
      const response = await fetchWithTimeout(
        `${API_BASE}/audit/${auditId}/rendered-preview`,
        {},
        UPLOAD_TIMEOUT_MS,
      )
      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: '' }))
        return { ok: false, status: response.status, detail: typeof error.detail === 'string' ? error.detail : '' }
      }
      return { ok: true, blob: await response.blob() }
    } catch (err: any) {
      return { ok: false, status: 0, detail: err?.message ?? 'Network error' }
    }
  },

  /** Review only; no DOCX is changed and no output is issued. */
  async reviewGuidedFixes(auditId: string, file: File, violationIds: string[]): Promise<GuidedFixReview> {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('selection', JSON.stringify({ violation_ids: violationIds }))
    return handleResponse<GuidedFixReview>(await fetchWithTimeout(
      `${API_BASE}/audit/${auditId}/guided-fixes/review`,
      { method: 'POST', body: formData },
      UPLOAD_TIMEOUT_MS,
    ))
  },

  /** Revoking a review is idempotent; expiry also invalidates abandoned reviews. */
  async cancelGuidedFixReview(auditId: string, reviewId: string): Promise<void> {
    const response = await fetchWithTimeout(
      `${API_BASE}/audit/${auditId}/guided-fixes/review/${encodeURIComponent(reviewId)}`,
      { method: 'DELETE' },
      POLL_TIMEOUT_MS,
    )
    if (!response.ok) await handleResponse(response)
  },

  /** Re-upload the exact source; a passed response is the sole download permission. */
  async applyGuidedFixes(
    auditId: string, file: File, violationIds: string[], reviewId: string,
  ): Promise<GuidedFixVerification> {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('selection', JSON.stringify({ violation_ids: violationIds }))
    formData.append('review_id', reviewId)
    const result = await handleResponse<GuidedFixVerification>(await fetchWithTimeout(
      `${API_BASE}/audit/${auditId}/guided-fixes`,
      { method: 'POST', body: formData },
      GUIDED_VERIFY_TIMEOUT_MS,
    ))
    if (result.status !== 'passed' || !result.download_token) {
      throw new Error('Verification did not pass')
    }
    return result
  },

  /** A download token is one-use; do not retrieve bytes until the user requests them. */
  async downloadGuidedFix(auditId: string, token: string): Promise<Blob> {
    const response = await fetchWithTimeout(
      `${API_BASE}/audit/${auditId}/guided-fixes/download/${encodeURIComponent(token)}`,
      { cache: 'no-store' },
      UPLOAD_TIMEOUT_MS,
    )
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Download unavailable' }))
      throw new ApiRequestError(typeof error.detail === 'string' ? error.detail : 'Download unavailable', response.status)
    }
    return response.blob()
  },
}

export interface GuidedFixReviewItem {
  violation_id: string
  before: string
  after: string
  locations: string[]
  affected_count: number
  property: string
}

export interface GuidedFixReview {
  review_id: string
  items: GuidedFixReviewItem[]
  output_filename: string
  limitations: string[]
  expires_at: string
}

export interface GuidedFixFindingSummary {
  rule_code: string
  count: number
  locations: string[]
}

export interface GuidedFixVerification {
  status: 'passed'
  resolved: string[]
  before_score: number
  after_score: number
  before_findings: GuidedFixFindingSummary[]
  after_findings: GuidedFixFindingSummary[]
  new_findings: GuidedFixFindingSummary[]
  download_token: string
  output_filename: string
  expires_at: string
}


/**
 * Trigger a browser download from a Blob and always release the temporary
 * object URL afterwards.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export { TimeoutError }