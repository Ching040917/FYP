/**
 * Shared user-facing audit date/time presentation helper.
 *
 * Formats every date the app shows to users in English UK ("en-GB") so the
 * output never depends on the browser locale (which may be Chinese) and
 * never contains CJK characters:
 *
 *   18 Aug 2026, 12:30 PM
 *
 * Options are fixed per spec: day '2-digit', month 'short', year 'numeric',
 * hour '2-digit', minute '2-digit', hour12 true. `Intl.DateTimeFormat` is
 * used with an explicit locale and options — never an unspecified
 * `toLocaleString()`/`toLocaleDateString()`.
 *
 * Timezone decision (documented — see frontend/tests/date-format.test.ts):
 * the backend stores and serialises naive UTC datetimes (`datetime.utcnow()`
 * via pydantic → `"2026-08-18T12:30:00"`, no `Z`, no offset). The
 * application's current intended behavior — which this helper preserves — is
 * to display those moments in the user's local timezone: `new Date(naive)`
 * is parsed as local wall-clock and rendered in the same local timezone, so
 * a stored `12:30` always reads `12:30 PM` regardless of where the user is.
 * ISO strings carrying `Z` or an explicit offset are converted to local
 * time first (exactly as the previous `toLocaleString()` did) and then
 * formatted — the same instant, never silently re-interpreted. Only the
 * locale and shape change; no stored timestamp, API format, timezone
 * storage, sorting, or creation logic is touched.
 */

const AUDIT_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
})

const UNAVAILABLE = 'Unavailable'

/**
 * Format an ISO timestamp (or Date) for display. Invalid, empty, or null
 * input returns "Unavailable" — never "Invalid Date" — and never throws,
 * so a malformed timestamp can't crash a page.
 */
export function formatAuditDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return UNAVAILABLE
  const date = typeof value === 'string' ? new Date(value) : value
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return UNAVAILABLE
  try {
    // en-GB emits "18 Aug 2026, 12:30 pm" — force the period uppercase so
    // the result is exactly "…12:30 PM". No locale-specific comma/spacing
    // or CJK characters can appear because locale and options are fixed.
    return AUDIT_DATE_FORMAT.format(date).replace(/\b(am|pm)\b/g, (m) => m.toUpperCase())
  } catch {
    return UNAVAILABLE
  }
}

/**
 * Accessible companion: the machine-readable ISO timestamp for a
 * `datetime`/`time` attribute, or null when the value is not a valid date.
 * Screen readers keep the formatted short text as their label while the
 * `datetime` attribute carries the original timestamp.
 */
export function auditDateTimeAttr(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  const date = typeof value === 'string' ? new Date(value) : value
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  return date.toISOString()
}
