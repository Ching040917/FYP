/**
 * Profile-selection helpers (Build 5) — pure logic, testable without a
 * renderer. The UploadCard consumes these so default selection, stale
 * resets, and error guards are deterministic and unit-tested.
 */
import type { FormattingProfile } from '../types/api'

/**
 * Resolve the effective selected profile id.
 *
 * - No profiles / loading error → null (submission must be blocked).
 * - No previous selection → the recommended profile (authoritative default).
 * - Previous selection still available → keep it (session retention).
 * - Previous selection stale → reset to recommended, report a reset via the
 *   returned `reset` flag so the UI can notify the user.
 */
export function resolveProfileSelection(
  profiles: FormattingProfile[],
  previousId: string | null,
): { selectedId: string | null; reset: boolean } {
  if (profiles.length === 0) return { selectedId: null, reset: false }
  const recommended = profiles.find((p) => p.recommended) ?? profiles[0]
  if (!previousId) return { selectedId: recommended.profile_id, reset: false }
  if (profiles.some((p) => p.profile_id === previousId)) {
    return { selectedId: previousId, reset: false }
  }
  // Stale selection — reset to the authoritative recommended profile.
  return { selectedId: recommended.profile_id, reset: true }
}

/** True when submission must be blocked (no known profile). */
export function profileBlockingSubmission(profiles: FormattingProfile[]): boolean {
  return profiles.length === 0
}
