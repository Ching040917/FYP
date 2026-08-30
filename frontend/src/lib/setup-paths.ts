/**
 * Optional-component setup pathways (Build N).
 *
 * Pure constants + helpers for the readiness card's optional-component
 * guidance. Official download URLs are reviewed frontend constants — never
 * taken from API data, never user-supplied. No download, installer, or
 * command execution happens in ACA: the user clicks a link or copies a
 * command and runs it themselves.
 */

/** Approved official URLs (Phase 8: reviewed frontend constants). */
export const OFFICIAL_URLS = {
  libreoffice: 'https://www.libreoffice.org/download/',
  ollama: 'https://ollama.com/download/windows',
} as const

/** Wording shown when a component is confirmed unavailable. */
export const SETUP_COPY = {
  optionalNote: 'Optional feature',
  libreoffice: {
    title: 'Rendered-page support',
    body:
      'Rendered-page support is optional. Install LibreOffice to enable page previews and original-document page locations. You can continue using deterministic audit checks without it.',
    linkLabel: 'Download LibreOffice',
  },
  ollama: {
    title: 'Local AI review',
    body:
      'Local AI review is optional. Install Ollama to enable local citation suggestions. Deterministic audit checks remain available without it.',
    linkLabel: 'Download Ollama',
  },
  model: {
    title: 'Local AI model',
    body:
      'The local AI model is optional. Install the model to enable local citation suggestions. The download requires internet access, may take time, and may require substantial disk storage. ACA does not start the download automatically.',
    copyLabel: 'Copy installation command',
    copiedLabel: 'Command copied',
    copyFailedLabel: 'Copying failed. Select the command and copy it manually.',
  },
  thirdPartyNote: 'This links to third-party software. Third-party websites have their own terms and privacy policies.',
} as const

/** Component ids that carry a setup pathway when `unavailable`. */
export const SETUP_COMPONENTS = new Set(['libreoffice', 'ollama', 'local_model'])

export interface SetupPathwayInfo {
  kind: 'libreoffice' | 'ollama' | 'model'
  url?: string
  linkLabel?: string
  body: string
}

/** The exact command shown for a missing local model. */
export function modelInstallCommand(modelName: string): string {
  return `ollama pull ${modelName}`
}

/**
 * Extract the authoritative model name from the backend readiness detail.
 * Backend contract: detail = "Configured model: <name>". Returns null when
 * the detail does not carry a parseable name — the command is then not
 * shown (never guessed, never hardcoded).
 */
export function modelNameFromDetail(detail: string | null | undefined): string | null {
  if (!detail) return null
  const m = /Configured model:\s*(.+)$/.exec(detail)
  const name = m?.[1]?.trim()
  return name ? name : null
}

/** True when the row should show the LibreOffice download pathway. */
export function isLibreOfficeMissing(row: { id: string; state: string }): boolean {
  return row.id === 'libreoffice' && row.state === 'unavailable'
}

/** True when the row should show the Ollama download pathway. */
export function isOllamaMissing(row: { id: string; state: string }): boolean {
  return row.id === 'ollama' && row.state === 'unavailable'
}

/**
 * True when the row should show the model-install pathway: Ollama is running
 * (ready) but the required model is absent. Ollama-unreachable keeps the
 * model state `unknown` — never presented as confirmed-missing.
 */
export function isModelMissing(
  row: { id: string; state: string; detail: string | null },
  rows: { id: string; state: string }[],
): boolean {
  if (row.id !== 'local_model' || row.state !== 'unavailable') return false
  const ollama = rows.find((r) => r.id === 'ollama')
  return ollama?.state === 'ready'
}

/** Safe external link attributes (never rely on caller to remember). */
export const EXTERNAL_LINK_ATTRS = {
  target: '_blank',
  rel: 'noopener noreferrer',
} as const
