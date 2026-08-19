/**
 * Session-scoped paragraph-mapping cache.
 *
 * One mapping computation per audit for the lifetime of the session
 * (matches "compute once per audit/PDF load and cache for the session").
 * In-flight requests are deduplicated; only successes are cached so a
 * transient failure is retried on the next use. Consumers are responsible
 * for ignoring stale resolutions (see use-finding-mapping).
 */
import type { BlockMapping, PageText } from './paragraph-mapping.ts'

export interface MappingBundle {
  auditId: string
  pages: PageText[]
  mapping: BlockMapping[]
  byIndex: Map<number, BlockMapping>
  /** Paragraph text evidence (formatting highlights) + caption-style hints. */
  blocks: Array<{ index: number; text: string; styleName?: string | null }>
}

export type MappingLoader = (auditId: string) => Promise<MappingBundle>

const inFlight = new Map<string, Promise<MappingBundle>>()
const done = new Map<string, MappingBundle>()

/** Resolve (or compute) the mapping bundle for an audit, deduplicated. */
export function getMapping(auditId: string, loader: MappingLoader): Promise<MappingBundle> {
  const cached = done.get(auditId)
  if (cached) return Promise.resolve(cached)
  const pending = inFlight.get(auditId)
  if (pending) return pending

  const created = loader(auditId)
    .then((bundle) => {
      done.set(auditId, bundle)
      return bundle
    })
    .finally(() => {
      inFlight.delete(auditId)
    })
  inFlight.set(auditId, created)
  return created
}

/** Drop the cached bundle (audit deleted / PDF replaced). */
export function invalidateMapping(auditId: string): void {
  done.delete(auditId)
  inFlight.delete(auditId)
}
