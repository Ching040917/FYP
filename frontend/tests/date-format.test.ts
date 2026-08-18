/**
 * Date-time presentation tests for the shared formatAuditDateTime helper.
 *
 * Covers the required cases: morning/noon/midnight/afternoon, single-digit
 * day, December, timestamps with `Z`, timestamps with explicit offset,
 * invalid and null timestamps, a browser locale simulated as Chinese (the
 * original defect: History showed "2026年8月18日 12:30"), no CJK characters,
 * and the en-GB ordering day-month-year with 12-hour uppercase AM/PM.
 *
 * Timezone contract (documented here, not guessed): the backend persists and
 * serialises naive UTC datetimes (`datetime.utcnow()` → pydantic →
 * "2026-08-18T12:30:00", no `Z`, no offset). The app's intended behavior —
 * preserved by this helper — is to display those moments in the user's
 * local timezone:
 *   - naive "2026-08-18T12:30:00" is parsed as LOCAL wall-clock and
 *     rendered in the SAME local timezone, so it always reads
 *     "18 Aug 2026, 12:30 PM" no matter where the user is (this is exactly
 *     what the previous `toLocaleString(undefined, …)` produced — same
 *     moment, only the locale/shape changed);
 *   - "…T12:30:00Z" and "…T12:30:00+02:00" convert to the user's local
 *     timezone first (identical to the old behavior) and are never
 *     re-interpreted as UTC wall-clock.
 *
 * The TZ-shift test uses `process.env.TZ` at runtime, which Node's V8
 * honours for both `Date` parsing and `Intl` output (verified on Node 24).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAuditDateTime, auditDateTimeAttr } from '../src/lib/format-date.ts'

const CJK = /[年日月]/

test('morning formats as "08:05 AM" with en-GB day-month-year order', () => {
  assert.equal(formatAuditDateTime('2026-08-18T08:05:00'), '18 Aug 2026, 08:05 AM')
})

test('noon formats as "12:30 PM"', () => {
  assert.equal(formatAuditDateTime('2026-08-18T12:30:00'), '18 Aug 2026, 12:30 PM')
})

test('midnight formats as "12:00 AM"', () => {
  assert.equal(formatAuditDateTime('2026-08-18T00:00:00'), '18 Aug 2026, 12:00 AM')
})

test('afternoon formats as "07:41 PM"', () => {
  assert.equal(formatAuditDateTime('2026-08-18T19:41:00'), '18 Aug 2026, 07:41 PM')
})

test('single-digit day keeps a leading zero', () => {
  assert.equal(formatAuditDateTime('2026-08-05T12:30:00'), '05 Aug 2026, 12:30 PM')
})

test('December uses the short English month', () => {
  assert.equal(formatAuditDateTime('2026-12-05T08:05:00'), '05 Dec 2026, 08:05 AM')
})

test('timestamp with Z suffix formats as local moment', () => {
  // Z is interpreted in the current timezone; the instant is converted
  // exactly as the previous toLocaleString() did — never as UTC wall-clock.
  const local = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date('2026-08-18T12:30:00Z')).replace(/\b(am|pm)\b/g, (m) => m.toUpperCase())
  assert.equal(formatAuditDateTime('2026-08-18T12:30:00Z'), local)
})

test('timestamp with explicit offset is converted to local time first', () => {
  const local = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date('2026-08-18T12:30:00+02:00')).replace(/\b(am|pm)\b/g, (m) => m.toUpperCase())
  assert.equal(formatAuditDateTime('2026-08-18T12:30:00+02:00'), local)
})

test('invalid and null timestamps display "Unavailable"', () => {
  assert.equal(formatAuditDateTime('not-a-date'), 'Unavailable')
  assert.equal(formatAuditDateTime(''), 'Unavailable')
  assert.equal(formatAuditDateTime(null), 'Unavailable')
  assert.equal(formatAuditDateTime(undefined), 'Unavailable')
  assert.equal(formatAuditDateTime(new Date('garbage')), 'Unavailable')
})

test('browser locale simulated as Chinese produces the English format', () => {
  // The original defect: toLocaleString(undefined, …) rendered
  // "2026年8月18日 12:30" on a Chinese-locale browser. The helper fixes the
  // locale to en-GB, so this must hold regardless of any ambient locale.
  const fallback = Intl.DateTimeFormat
  // @ts-expect-error — force every DateTimeFormat (incl. our module's) to the Chinese locale
  Intl.DateTimeFormat = function (this: any, locale?: any, options?: any) {
    return new fallback(locale === undefined ? 'zh-CN' : locale, options)
  } as typeof Intl.DateTimeFormat
  try {
    const formatted = formatAuditDateTime('2026-08-18T12:30:00')
    assert.equal(formatted, '18 Aug 2026, 12:30 PM')
    assert.ok(!CJK.test(formatted), `CJK character in output: ${formatted}`)
  } finally {
    Intl.DateTimeFormat = fallback
  }
})

test('output never contains Chinese date characters', () => {
  for (const iso of [
    '2026-08-18T08:05:00',
    '2026-08-18T12:30:00',
    '2026-08-18T00:00:00',
    '2026-08-18T19:41:00',
    '2026-12-05T08:05:00',
  ]) {
    const formatted = formatAuditDateTime(iso)
    assert.ok(!CJK.test(formatted), `CJK character in ${formatted}`)
    assert.ok(!/invalid date/i.test(formatted))
  }
})

test('naive timestamps read the same wall-clock in any timezone (local preserved)', () => {
  // Intentionally TZ-agnostic: a naive "2026-08-18T12:30:00" is parsed as
  // local wall-clock and rendered in the same local timezone, so it always
  // reads "18 Aug 2026, 12:30 PM" no matter where the user is. The
  // formatter has no timeZone option, so the browser's local timezone (and
  // node's TZ) is what both parsing and display use — the same moment the
  // old toLocaleString() showed, just en-GB-shaped.
  assert.equal(formatAuditDateTime('2026-08-18T12:30:00'), '18 Aug 2026, 12:30 PM')
})

test('Z/offset instants render as the same local moment as Date would', () => {
  const originalTz = process.env.TZ
  try {
    process.env.TZ = 'Asia/Shanghai'
    // Compute the reference under the same TZ so both sides agree on the
    // local conversion of the instant (+02:00 → 18:30 Shanghai).
    const expected = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }).format(new Date('2026-08-18T12:30:00+02:00')).replace(/\b(am|pm)\b/g, (m) => m.toUpperCase())
    assert.equal(formatAuditDateTime('2026-08-18T12:30:00+02:00'), expected)
  } finally {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  }
})

test('auditDateTimeAttr returns an ISO timestamp for datetime attributes', () => {
  // The attribute carries the original instant (converted to ISO UTC) for
  // machine readers; the visible text stays the short en-GB format.
  const dt = auditDateTimeAttr('2026-08-18T12:30:00')
  assert.ok(dt !== null && !Number.isNaN(new Date(dt).getTime()))
  assert.equal(auditDateTimeAttr('garbage'), null)
  assert.equal(auditDateTimeAttr(null), null)
})
