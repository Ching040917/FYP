/**
 * Interrupted Audit presentation helpers (Build 2).
 *
 * Maps the safe backend interruption reason to a friendly user-facing
 * sentence. Raw reason values are never exposed directly to the UI.
 */

export const INTERRUPTION_REASON_APPLICATION_RESTART = 'application_restart'

const REASON_LABELS: Record<string, string> = {
  [INTERRUPTION_REASON_APPLICATION_RESTART]:
    'The application restarted before this audit finished.',
}

const FALLBACK_INTERRUPTION_MESSAGE =
  'This audit stopped before processing was completed.'

export function interruptionMessage(reason: string | null | undefined): string {
  if (reason && REASON_LABELS[reason]) return REASON_LABELS[reason]
  return FALLBACK_INTERRUPTION_MESSAGE
}
