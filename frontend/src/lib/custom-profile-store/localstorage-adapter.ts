/**
 * localStorage adapter for the custom-profile store (Build 1 PoC).
 *
 * Thin wrapper isolating `window`/`localStorage` from core business logic so
 * the store remains deterministic and testable with an injected adapter.
 * No sensitive data is ever stored (see store.ts requirements).
 */
import { ACTIVE_KEY, RECOVERY_KEY, type StorageEventPayload, type StoreAdapter } from './store.ts'

export class LocalStorageStoreAdapter implements StoreAdapter {
  private readonly listeners = new Set<(key: string) => void>()

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly subscribe: (fn: (e: StorageEventPayload) => void) => () => void,
  ) {
    this.unsubscribe = this.subscribe(this.handleEvent)
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
    const probeKey = 'custom-profiles:probe'
    window.localStorage.setItem(probeKey, '1')
    window.localStorage.removeItem(probeKey)
  } catch {
    return null
  }
  return new LocalStorageStoreAdapter(
    window.localStorage,
    (fn) => {
      window.addEventListener('storage', (e) => fn({ key: e.key, newValue: e.newValue }))
      return () => {
        window.removeEventListener('storage', () => {})
      }
    },
  )
}
