/**
 * Disclosure group coordination for CompactDisclosure instances.
 *
 * Only one context disclosure (Profile Summary, Selected Evidence, …) stays
 * open at a time: an opening instance announces its panel id on `window`
 * and every mounted instance closes when it hears a foreign announcement.
 * Closing never announces, so there is no loop. Pure helpers live here so
 * they stay unit-testable without a DOM.
 */

/** Group event name: an opening disclosure announces its panel id. */
export const DISCLOSURE_GROUP_EVENT = 'aca:compact-disclosure-open'

/** True when a group event was announced by a different disclosure. Pure. */
export function isForeignDisclosureEvent(event: Event, ownId: string): boolean {
  const detail = (event as CustomEvent<string>).detail
  return typeof detail === 'string' && detail !== ownId
}

/** Announce an opening disclosure to the group (no-op without `window`). */
export function announceDisclosureOpen(panelId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(DISCLOSURE_GROUP_EVENT, { detail: panelId }))
}
