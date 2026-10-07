/**
 * Local AI Citation Guidance — local-model download (pure logic + copy).
 *
 * Validates the Backend's eight-field status contract and maps it to safe
 * display values. Malformed input is rejected outright — it can never become
 * "completed", and no raw Backend or Ollama text is ever rendered.
 *
 * Scope: the optional local model provides suggestions for APA 7 in-text
 * citation formatting only. It is never required for deterministic document
 * auditing, formatting findings, rendered-page preview, Guided Fixes, PDF
 * report export, or Audit History.
 */

import type {
  LocalModelDownloadErrorCategory,
  LocalModelDownloadState,
  LocalModelDownloadStatus,
} from '../types/api'

/**
 * Contract enumerations as static string-keyed lookup tables. Values are
 * `true` so an unknown key reads as `undefined`, never an inherited member.
 */
const VALID_STATES: Record<string, true> = {
  idle: true,
  starting: true,
  waiting_for_ollama: true,
  downloading: true,
  verifying: true,
  completed: true,
  failed: true,
  disconnected: true,
}

const VALID_ERROR_CATEGORIES: Record<string, true> = {
  ollama_unavailable: true,
  ollama_error: true,
  ollama_disconnected: true,
  stalled: true,
  verification_failed: true,
  malformed_response: true,
  unsupported_host: true,
  unknown: true,
}

/** States during which the frontend must keep polling. */
const ACTIVE_STATES: Record<string, true> = {
  starting: true,
  waiting_for_ollama: true,
  downloading: true,
  verifying: true,
}

export const DOWNLOAD_POLL_INTERVAL_MS = 1000

/**
 * ACA cannot reliably stop an Ollama model download once started, so no
 * Cancel control exists. Closing this view is not a cancellation.
 */
export const NO_CANCEL_NOTICE =
  'ACA cannot reliably stop an Ollama model download after it starts. ' +
  'You may close this progress view, but Ollama may continue downloading ' +
  'in the background.'

/**
 * User-facing copy for the missing-model pathway and the confirmation step.
 * Kept here as reviewed constants so wording is asserted by tests and never
 * assembled from API data.
 */
export const LOCAL_MODEL_COPY = {
  scope:
    'The optional local model provides suggestions for APA 7 in-text citation formatting only. It is not required for deterministic document auditing.',
  accuracy:
    'AI suggestions may be incomplete or inaccurate. Review every suggestion before using it.',
  modelLabel: 'Citation Guidance Model',
  sizeLabel: 'Estimated download size',
  // The size of a model that is not installed locally cannot be verified from
  // a trusted source, so no numeric estimate is ever shown.
  sizeValue: 'Check model information',
  downloadAction: 'Download optional model',
  confirmTitle: 'Download Optional Citation Guidance Model?',
  confirmIntro:
    'This model is used only to provide suggestions for APA 7 in-text citation formatting.',
  confirmCost:
    'The download requires an internet connection, several gigabytes of storage, and may take some time.',
  confirmHardware:
    'Local AI performance depends on the computer\u2019s memory and processor. Computers with limited memory may run slowly or may be unable to load the model.',
  confirmReassurance:
    'You can skip this feature. Core deterministic audits, rendered-page previews, Guided Fixes, PDF report export, and Audit History remain available without Local AI.',
  confirmCancel: 'Not now',
  confirmStart: 'Start download',
  retryAction: 'Try again',
  hideProgress: 'Hide progress',
  showProgress: 'Show progress',
  startFailed:
    'Could not start the download. You can try again, or use the command below.',
} as const

/** Guidance for a safe error category. Never includes provider text. */
export function downloadErrorGuidance(
  category: LocalModelDownloadErrorCategory | null,
): string {
  switch (category) {
    case 'ollama_unavailable':
      return 'Ollama is not running. Start Ollama, then try again.'
    case 'ollama_error':
      return 'Ollama could not finish the download. Check your internet connection and available disk space, then try again.'
    case 'ollama_disconnected':
      return 'The connection to Ollama was lost. Make sure Ollama is running, then try again.'
    case 'stalled':
      return 'The download stopped making progress. Check your internet connection, then try again.'
    case 'verification_failed':
      return 'The model could not be confirmed after downloading. Try again, or use the command below.'
    case 'malformed_response':
      return 'Ollama returned an unexpected response. Try again, or use the command below.'
    case 'unsupported_host':
      return 'Local AI is configured to use a network address this action does not support.'
    default:
      return 'The download could not be completed. Try again, or use the command below.'
  }
}

function optionalNonNegativeInt(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
  return Math.floor(v)
}

/**
 * Validate a raw download status payload.
 * Returns null when the payload cannot be trusted; a malformed payload never
 * becomes `completed`, and an unknown state is never guessed.
 */
export function adaptDownloadStatus(raw: unknown): LocalModelDownloadStatus | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const payload = raw as Record<string, unknown>

  const state = payload.state
  if (typeof state !== 'string' || VALID_STATES[state] !== true) return null

  const message = payload.message
  if (typeof message !== 'string' || message.length === 0) return null

  const modelName = payload.model_name
  if (typeof modelName !== 'string' || modelName.length === 0) return null

  const bytesCompleted = optionalNonNegativeInt(payload.bytes_completed)
  if (bytesCompleted === undefined) return null
  const bytesTotal = optionalNonNegativeInt(payload.bytes_total)
  if (bytesTotal === undefined) return null

  let percentage: number | null = null
  const rawPercentage = payload.percentage
  if (rawPercentage !== null && rawPercentage !== undefined) {
    if (
      typeof rawPercentage !== 'number' ||
      !Number.isFinite(rawPercentage) ||
      rawPercentage < 0 ||
      rawPercentage > 100
    ) {
      return null
    }
    percentage = Math.floor(rawPercentage)
  }

  const retryable = payload.retryable === true

  let errorCategory: LocalModelDownloadErrorCategory | null = null
  const rawCategory = payload.error_category
  if (rawCategory !== null && rawCategory !== undefined) {
    if (
      typeof rawCategory !== 'string' ||
      VALID_ERROR_CATEGORIES[rawCategory] !== true
    ) {
      return null
    }
    errorCategory = rawCategory as LocalModelDownloadErrorCategory
  }

  return {
    state: state as LocalModelDownloadState,
    message,
    model_name: modelName,
    bytes_completed: bytesCompleted,
    bytes_total: bytesTotal,
    percentage,
    retryable,
    error_category: errorCategory,
  }
}

/**
 * True while a job is running and the frontend should keep polling. Every
 * other state (including a superseded or unknown one) stops polling.
 */
export function isDownloadActive(
  status: LocalModelDownloadStatus | null,
): boolean {
  return status !== null && ACTIVE_STATES[status.state] === true
}

/**
 * True when a determinate progress value may be shown. A percentage is only
 * ever rendered when the Backend supplied one — never fabricated here.
 */
export function isDeterminate(status: LocalModelDownloadStatus | null): boolean {
  return status !== null && status.percentage !== null
}

/** Human-readable byte count. Returns '' for unknown values. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1000) return `${bytes} bytes`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  const rounded = value < 10 ? value.toFixed(1) : String(Math.round(value))
  return `${rounded} ${units[unit]}`
}

/**
 * Secondary progress line. Byte values are the primary honest signal; the
 * percentage is only appended when the Backend supplied one.
 */
export function downloadProgressText(status: LocalModelDownloadStatus): string {
  const completed = formatBytes(status.bytes_completed)
  const total = formatBytes(status.bytes_total)

  if (completed && total) {
    const base = `${completed} of ${total} downloaded`
    return status.percentage === null ? base : `${base} (${status.percentage}%)`
  }
  if (completed) return `${completed} downloaded`
  return ''
}

/** Friendly accessible progress text for the progressbar element. */
export function progressAriaText(status: LocalModelDownloadStatus): string {
  if (status.state === 'completed') return 'Download complete'
  if (status.state === 'failed' || status.state === 'disconnected') {
    return 'Download not completed'
  }
  if (status.percentage !== null) {
    return `Downloading the Citation Guidance Model, ${status.percentage}% complete`
  }
  if (status.state === 'verifying') return 'Checking the downloaded model'
  return 'Downloading the Citation Guidance Model, progress unknown'
}
