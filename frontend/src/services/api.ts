import type { AuditSubmitResponse, AuditResponse, AuditListItem, DocumentBlock } from '../types/api'

const API_BASE = '/api'

// Per-request timeout (ms). Aborts via AbortController so polling can't hang forever.
const UPLOAD_TIMEOUT_MS = 60_000
const POLL_TIMEOUT_MS = 10_000

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

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }))
    throw new Error(error.detail || `HTTP ${response.status}`)
  }
  return response.json()
}

export const api = {
  async auditDocument(
    file: File,
    options: { cloud?: boolean } = {},
  ): Promise<AuditSubmitResponse> {
    const formData = new FormData()
    formData.append('file', file)
    const url = options.cloud ? `${API_BASE}/audit?cloud=1` : `${API_BASE}/audit`
    const response = await fetchWithTimeout(
      url,
      { method: 'POST', body: formData },
      UPLOAD_TIMEOUT_MS,
    )
    return handleResponse<AuditSubmitResponse>(response)
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
    const response = await fetch(`${API_BASE}/audits?limit=${limit}&offset=${offset}`)
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
    const response = await fetch('/health')
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
}

/**
 * Extract the download filename from a Content-Disposition header.
 * Prefers RFC 5987 `filename*=UTF-8''...` (decoded) and falls back to the
 * plain `filename="..."` form. Returns null when absent.
 */
function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (star) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      // malformed percent-encoding — fall through to the plain form
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1] : null
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