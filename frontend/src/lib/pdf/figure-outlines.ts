/**
 * Figure outline evidence store (Build 8F).
 *
 * Session-scoped: loads the pdfjs operator-list geometry ONCE per audit
 * (same bytes as the rendered preview — the viewer and the outline share
 * the exact response). The outline decision itself is recomputed from the
 * cached geometry on demand — it is cheap, so no second decision cache.
 */
import { extractPageGeometry, type PageGeometry } from './pdf-text-extract.ts'

const geometryInFlight = new Map<string, Promise<PageGeometry[]>>()
const geometryDone = new Map<string, PageGeometry[]>()

export type GeometryLoader = (auditId: string) => Promise<PageGeometry[]>

/** Resolve (or compute) the geometry for an audit, deduplicated. */
export function getPageGeometry(auditId: string, loader: GeometryLoader): Promise<PageGeometry[]> {
  const cached = geometryDone.get(auditId)
  if (cached) return Promise.resolve(cached)
  const pending = geometryInFlight.get(auditId)
  if (pending) return pending

  const created = loader(auditId)
    .then((g) => {
      geometryDone.set(auditId, g)
      return g
    })
    .finally(() => {
      geometryInFlight.delete(auditId)
    })
  geometryInFlight.set(auditId, created)
  return created
}

/** Default loader from the exact PDF bytes. */
export function geometryLoaderFromBytes(
  pdfBytes: ArrayBuffer | undefined,
): GeometryLoader | null {
  if (!pdfBytes) return null
  return () => extractPageGeometry(pdfBytes.slice(0))
}

/** Drop the cached geometry for an audit (audit changed / PDF replaced). */
export function dropPageGeometry(auditId: string): void {
  geometryDone.delete(auditId)
  geometryInFlight.delete(auditId)
}
