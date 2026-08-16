/**
 * useRenderedPdf — single owner of the rendered PDF bytes for an audit.
 *
 * Fetches the secure endpoint once per audit (session-cached) and shares
 * the exact response bytes with BOTH the viewer and the finding-to-page
 * mapper — no duplicate fetches, no byte divergence, no lifecycle races.
 * Failures map to truthful states the viewer renders as fallback panels.
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../services/api'

export type RenderedPdfStatus =
  | 'idle'
  | 'loading'
  | 'available'
  | 'historical'
  | 'unavailable'
  | 'corrupt'
  | 'missing'
  | 'error'

export interface RenderedPdfState {
  status: RenderedPdfStatus
  detail?: string
  bytes?: ArrayBuffer
}

function mapFailure(status: number, detail: string): RenderedPdfStatus {
  if (status === 404) return detail.includes('older audit') ? 'historical' : 'error'
  if (status === 409) return detail.includes('could not be created') ? 'unavailable' : 'corrupt'
  if (status === 410) return 'missing'
  return 'error'
}

const cache = new Map<string, RenderedPdfState>()

export function useRenderedPdf(auditId: string | null): RenderedPdfState {
  const [state, setState] = useState<RenderedPdfState>({ status: 'idle' })
  const generation = useRef(0)

  useEffect(() => {
    if (!auditId) {
      setState({ status: 'idle' })
      return
    }
    const cached = cache.get(auditId)
    if (cached) {
      setState(cached)
      return
    }
    const gen = ++generation.current
    let cancelled = false
    setState({ status: 'loading' })

    api
      .getRenderedPreview(auditId)
      .then(async (result) => {
        if (cancelled || gen !== generation.current) return
        if (!result.ok) {
          const next: RenderedPdfState = { status: mapFailure(result.status, result.detail), detail: result.detail }
          cache.set(auditId, next)
          setState(next)
          return
        }
        const bytes = await result.blob.arrayBuffer()
        if (cancelled || gen !== generation.current) return
        const next: RenderedPdfState = { status: 'available', bytes }
        cache.set(auditId, next)
        setState(next)
      })
      .catch(() => {
        if (cancelled || gen !== generation.current) return
        const next: RenderedPdfState = { status: 'error' }
        setState(next)
      })

    return () => {
      cancelled = true
    }
  }, [auditId])

  return state
}

/** Drop the cached bytes (audit deleted). */
export function dropRenderedPdfCache(auditId: string): void {
  cache.delete(auditId)
}
