/**
 * Lightweight `.docx` document stats — paragraphs, headings, tables, images,
 * sections, words — derived client-side via mammoth.
 *
 * Backend does not currently return document_stats. Rather than touch the
 * backend, we re-parse the same file in the browser. This is best-effort:
 * failures return zeros so the dashboard gracefully degrades to "—".
 *
 * Capped at 5 MB to avoid stalling large files; oversized files return zeros.
 */

import type { DocumentStats } from '../../types/audit'

const MAX_BYTES = 5 * 1024 * 1024

export async function extractDocumentStats(file: File): Promise<DocumentStats> {
  const zeros: DocumentStats = {
    paragraphs: 0, headings: 0, tables: 0, images: 0, sections: 0, words: 0,
  }
  if (file.size > MAX_BYTES) return zeros

  try {
    const mammoth = await import('mammoth')
    const arrayBuffer = await file.arrayBuffer()
    const result = await mammoth.extractRawText({ arrayBuffer })

    const text: string = result.value ?? ''
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)

    // Headings heuristic: numbered ("1. ", "2.2 ") or all-caps lines ≤ 80 chars
    const headings = paragraphs.filter((p) => {
      if (p.length > 80) return false
      return /^\d+(\.\d+)*\.?\s+/.test(p) || (/^[A-Z0-9 \-:&]{4,}$/.test(p) && p === p.toUpperCase())
    }).length

    const words = text.split(/\s+/).filter(Boolean).length

    // Tables: mammoth returns messages but not a table count directly.
    // Heuristic: paragraphs containing ≥ 2 tabs are likely table rows.
    const tables = paragraphs.filter((p) => (p.match(/\t/g) ?? []).length >= 2).length

    // Images: mammoth surfaces `images` warnings in messages. We sample
    // those rather than re-running with images extraction (faster, no extra deps).
    const images = Array.isArray(result.messages)
      ? result.messages.filter((m: { type?: string }) => m.type === 'warning' && /image|inline/i.test(String((m as { message?: string }).message ?? ''))).length
      : 0

    // Sections: H1-equivalent (top-level numbered) count.
    const sections = paragraphs.filter((p) => /^\d+\.?\s+/.test(p)).length

    return { paragraphs: paragraphs.length, headings, tables, images, sections, words }
  } catch {
    return zeros
  }
}