/**
 * useFindingMapping — session-cached paragraph→page mapping for an audit.
 *
 * Computes the mapping once per audit from the EXACT shared PDF bytes
 * (useRenderedPdf) and the persisted document blocks. Mapping only STARTS
 * once both inputs are ready — while blocks or PDF bytes are loading the
 * status stays 'idle' so a paragraph finding is never mislabelled
 * unavailable. Stale work is cancelled/ignored via a generation counter;
 * transient loader failures are not cached (retried on next use).
 */
import { useEffect, useRef, useState } from 'react'
import { extractPageText } from '../lib/pdf/pdf-text-extract.ts'
import { mapBlocksToPages } from '../lib/pdf/paragraph-mapping.ts'
import { getMapping, invalidateMapping, type MappingBundle } from '../lib/pdf/mapping-cache.ts'
import type { DocumentBlock } from '../types/api'

export type MappingStatus = 'idle' | 'loading' | 'ready' | 'error'

export function useFindingMapping(
  auditId: string | null,
  blocks: DocumentBlock[] | null,
  blocksError: boolean,
  pdfBytes: ArrayBuffer | undefined,
): { bundle: MappingBundle | null; status: MappingStatus } {
  const [bundle, setBundle] = useState<MappingBundle | null>(null)
  const [status, setStatus] = useState<MappingStatus>('idle')
  const generation = useRef(0)
  // PDF bytes identity: a replaced PDF for the SAME audit must not be served
  // a stale mapping computed from the previous bytes.
  const lastBytesRef = useRef<ArrayBuffer | undefined>(undefined)

  useEffect(() => {
    if (!auditId) {
      setBundle(null)
      setStatus('idle')
      return
    }
    // Never start with partial inputs: blocks loading, PDF loading, or an
    // unrecoverable blocks failure each have a distinct, stable state.
    if (blocks === null && !blocksError) {
      setBundle(null)
      setStatus('idle')
      return
    }
    if (blocksError) {
      setBundle(null)
      setStatus('error')
      return
    }
    if (pdfBytes === undefined) {
      setBundle(null)
      setStatus('idle')
      return
    }
    const blockList = blocks
    if (blockList === null) {
      setBundle(null)
      setStatus('idle')
      return
    }

    const gen = ++generation.current
    let cancelled = false
    setStatus('loading')

    // A PDF replaced for the SAME audit id invalidates the cached mapping
    // (the cache is keyed by audit id only) — never serve stale pages.
    const bytesChanged = lastBytesRef.current !== pdfBytes
    lastBytesRef.current = pdfBytes
    if (bytesChanged) invalidateMapping(auditId)

    const loader = async (id: string): Promise<MappingBundle> => {
      const pages = await extractPageText(pdfBytes)
      const blockLike = blockList.map((b) => ({ index: b.index, text: b.text, styleName: b.style_name ?? null }))
      const mapping = mapBlocksToPages(blockLike, pages)
      return {
        auditId: id,
        pages,
        mapping,
        byIndex: new Map(mapping.map((m) => [m.index, m])),
        blocks: blockLike,
      }
    }

    getMapping(auditId, loader)
      .then((b) => {
        if (cancelled || gen !== generation.current) return
        setBundle(b)
        setStatus('ready')
      })
      .catch(() => {
        if (cancelled || gen !== generation.current) return
        setBundle(null)
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [auditId, blocks, blocksError, pdfBytes])

  return { bundle, status }
}

/** Drop the session cache for an audit (e.g. audit deleted). */
export function dropMappingCache(auditId: string): void {
  invalidateMapping(auditId)
}
