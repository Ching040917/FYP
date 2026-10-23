import assert from 'node:assert/strict'
import { loadStore, type StoreAdapter, type StoreEnvelope } from '../src/lib/custom-profile-store/store.ts'

/** Simulates durable bytes and one shared exclusive storage lock, not browser availability. */
export function createDurableTestAdapter(): StoreAdapter {
  const bytes = new Map<string, string>()
  let pending: Promise<unknown> = Promise.resolve()
  return {
    persistent: true,
    get: (key) => bytes.get(key) ?? null,
    set: (key, value) => { bytes.set(key, value) },
    onExternalChange: () => () => undefined,
    withExclusiveWrite<T>(write: () => T | Promise<T>): Promise<T> {
      const next = pending.then(write)
      pending = next.catch(() => undefined)
      return next
    },
  }
}

export function readStoredEnvelope(adapter: StoreAdapter): StoreEnvelope {
  const loaded = loadStore(adapter)
  assert.ok(loaded.ok, 'Expected a readable test store')
  assert.equal(loaded.readonly, false)
  return loaded.envelope
}
