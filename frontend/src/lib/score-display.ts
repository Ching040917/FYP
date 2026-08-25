/**
 * Shared helper for legacy nullable weighted_score presentation.
 * null or undefined -> Unavailable (ordinary-user wording)
 * numeric 0 -> "0" (must not be treated as missing)
 * normal score -> String(score)
 */
export function isScoreAvailable(score: number | null | undefined): score is number {
  return typeof score === 'number'
}

export function formatScore(score: number | null | undefined): string {
  return isScoreAvailable(score) ? String(score) : 'Unavailable'
}
