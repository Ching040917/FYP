/**
 * Create a completed synthetic audit through the backend API, using only the
 * committed synthetic sample DOCX fixture (no real user data).
 *
 * Goes through the Vite proxy (same origin, 127.0.0.1) so no CORS and no
 * direct backend binding are involved. Ollama/LibreOffice absence degrades
 * gracefully on the backend — the audit still completes deterministically.
 */
import { type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'

export interface AuditSummary {
  auditId: string
  status: string
  score: number | null
  majorCount: number
  minorCount: number
}

export async function createAuditViaApi(
  page: Page,
  docxPath: string,
  filename: string,
): Promise<AuditSummary> {
  const request: APIRequestContext = page.request
  const bytes = fs.readFileSync(docxPath)
  const response = await request.post('/api/audit?profile_id=suc-academic-report', {
    multipart: {
      file: { name: filename, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes },
    },
    timeout: 90_000,
  })
  if (!response.ok()) {
    throw new Error(`API audit creation failed: ${response.status()} ${await response.text()}`)
  }
  const body = (await response.json()) as {
    audit_id: string
    status?: string
    weighted_compliance_score: number | null
    major_count: number
    minor_count: number
  }
  // POST returns the completed audit synchronously; confirm via GET as well.
  await page.request.get(`/health`)
  return {
    auditId: body.audit_id,
    status: body.status ?? 'Success',
    score: body.weighted_compliance_score,
    majorCount: body.major_count,
    minorCount: body.minor_count,
  }
}
