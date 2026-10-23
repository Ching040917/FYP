/**
 * localStorage adapter for the custom-profile store (Build 1 PoC).
 *
 * Thin wrapper isolating `window`/`localStorage` from core business logic so
 * the store remains deterministic and testable with an injected adapter.
 * No sensitive data is ever stored (see store.ts requirements).
 */
import { ACTIVE_KEY, RECOVERY_KEY, type StorageEventPayload, type StoreAdapter } from './store.ts'

export class LocalStorageStoreAdapter implements StoreAdapter {
  readonly persistent = true
  readonly withExclusiveWrite: StoreAdapter['withExclusiveWrite']
  private readonly listeners = new Set<(key: string) => void>()
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

  constructor(
    storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    subscribe: (fn: (e: StorageEventPayload) => void) => () => void,
    locks?: Pick<LockManager, 'request'>,
  ) {
    this.storage = storage
    this.unsubscribe = subscribe(this.handleEvent)
    this.withExclusiveWrite = locks
      ? async <T>(write: () => T | Promise<T>): Promise<T> =>
          await locks.request('custom-profiles:write', { mode: 'exclusive' }, write)
      : undefined
  }

  private readonly unsubscribe: () => void

  private readonly handleEvent = (event: StorageEventPayload): void => {
    if (event.key === null || event.key === ACTIVE_KEY || event.key === RECOVERY_KEY) {
      this.listeners.forEach((fn) => fn(event.key ?? ''))
    }
  }

  get(key: string): string | null {
    return this.storage.getItem(key)
  }

  set(key: string, value: string): void {
    this.storage.setItem(key, value)
  }

  onExternalChange(cb: (key: string) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  destroy(): void {
    this.unsubscribe()
    this.listeners.clear()
  }
}

/**
 * Browser-friendly constructor: wires the adapter to the real `localStorage`
 * and the `storage` event. Returns null when storage is unavailable (e.g.
 * SSR or privacy-blocked) so callers can degrade gracefully.
 */
export function createBrowserStoreAdapter(): LocalStorageStoreAdapter | null {
  try {
    const storage = window.localStorage
    const probeKey = 'custom-profiles:probe'
    storage.setItem(probeKey, '1')
    storage.removeItem(probeKey)
    return new LocalStorageStoreAdapter(
      storage,
      (fn) => {
        const handler = (e: StorageEvent) => {
          if (e.storageArea === storage) fn({ key: e.key, newValue: e.newValue })
        }
        window.addEventListener('storage', handler)
        return () => window.removeEventListener('storage', handler)
      },
      typeof navigator !== 'undefined' ? navigator.locks : undefined,
    )
  } catch {
    return null
  }
}
