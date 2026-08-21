/**
 * Custom Profile Editor logic (Build 3) — pure, deterministic, testable.
 *
 * Contains NO JSX and touches no DOM/localStorage. Creation paths,
 * collision-safe names, blank/copy payloads, client-side validation, and
 * envelope-building helpers live here so the editor component stays thin and
 * every workflow is unit-testable with the injected store adapter.
 *
 * Authoritative backend validation still gates saving: a profile becomes
 * `backend_confirmed` ONLY after POST /api/formatting-profiles/validate
 * returns a valid normalized payload.
 */
import type { FormattingProfile, ProfileValidationError } from '../../types/api'
import {
  emptyEnvelope,
  generateProfileId,
  loadStore,
  saveStore,
  upsertProfile,
  deleteProfile,
  type StoreAdapter,
  type StoreEnvelope,
  type StoredCustomProfile,
} from './store.ts'

/** The three creation paths the editor exposes (Build 3). */
export type CreationKind = 'copy-suc' | 'copy-apa' | 'blank'

/** Stable built-in profile ids the editor can copy from. */
export const SUC_BUILTIN_ID = 'suc-academic-report'
export const APA_BUILTIN_ID = 'apa7-student-paper'

/** Accessible action labels for the creation buttons. */
export const CREATION_LABELS: Record<CreationKind, string> = {
  'copy-suc': 'Copy SUC Academic Report',
  'copy-apa': 'Copy APA 7 Student Paper',
  blank: 'Start with no enabled requirements',
}

/** Default display names for each creation path. */
export const DEFAULT_PROFILE_NAMES: Record<CreationKind, string> = {
  'copy-suc': 'Copy of SUC Academic Report',
  'copy-apa': 'Copy of APA 7 Student Paper',
  blank: 'Untitled custom profile',
}

/** UI description-length bound (verified in the editor tests). */
export const MAX_DESCRIPTION_LENGTH = 500

/** The only supported citation style — visible, never selectable (Build 3). */
export const CITATION_STYLE = 'APA 7'

/**
 * Table Caption policy for newly created custom profiles. The safe schema
 * allows `administrative` (captions effectively disabled) or `scholarly`
 * (only proven scholarly tables are caption targets). "both" would enable
 * administrative/layout/rubric/unknown table captions — never allowed here.
 */
export const SAFE_TABLE_ELIGIBILITY = 'administrative'

const KNOWN_BUILTIN_NAMES: Record<string, string> = {
  [SUC_BUILTIN_ID]: 'SUC Academic Report',
  [APA_BUILTIN_ID]: 'APA 7 Student Paper',
}

// ---------------------------------------------------------------------------
// Name handling
// ---------------------------------------------------------------------------

/**
 * Friendly source label for a known built-in profile id, or null when the id
 * is not a built-in. Internal store ids (UUIDs) are NEVER exposed — callers
 * resolve custom sources by looking up the stored profile name instead.
 */
export function friendlySourceName(sourceId: string | undefined): string | null {
  if (!sourceId) return null
  return KNOWN_BUILTIN_NAMES[sourceId] ?? null
}

/**
 * Resolve a desired name into one that is unique against the given names,
 * case-insensitively, using friendly suffixes: "Name", "Name (2)", "Name (3)".
 */
export function resolveUniqueName(
  existingNames: readonly string[],
  desired: string,
): string {
  const base = (desired.trim() || 'Untitled custom profile').trim()
  const exists = (name: string) =>
    existingNames.some((n) => n.trim().toLowerCase() === name.toLowerCase())
  if (!exists(base)) return base
  let n = 2
  while (exists(`${base} (${n})`)) n += 1
  return `${base} (${n})`
}

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

/**
 * A safe blank custom profile: every deterministic requirement is null
 * (disabled), custom source, APA 7, and the safe administrative table-caption
 * policy. Never enables administrative/layout/rubric/unknown table captions.
 */
export function blankProfilePayload(
  profileId: string,
  name: string,
): Record<string, unknown> {
  return {
    profile_id: profileId,
    profile_name: name,
    profile_version: 1,
    profile_source: 'custom',
    description: '',
    citation_style: CITATION_STYLE,
    body: {
      font_family: null,
      font_size_pt: null,
      allowed_font_combos: null,
      line_spacing: null,
      alignment: null,
      space_before_pt: null,
      space_after_pt: null,
      first_line_indent_in: null,
    },
    heading: {
      inherit_body_font: false,
      font_family: null,
      font_size_pt: null,
      allowed_font_combos: null,
      alignment: null,
      space_before_pt: null,
      space_after_pt: null,
      level_1: null,
      level_2: null,
      level_3: null,
    },
    margins: {
      margin_left_in: null,
      margin_right_in: null,
      margin_top_in: null,
      margin_bottom_in: null,
    },
    references: {
      line_spacing: null,
      hanging_indent_in: null,
    },
    captions: {
      space_before_pt: null,
      space_after_pt: null,
    },
    lists: {
      space_after_pt: null,
    },
    role_policy: {
      exempt_roles: [],
      table_eligibility: SAFE_TABLE_ELIGIBILITY,
    },
  }
}

/**
 * Turn a built-in profile's canonical payload into a custom copy: new
 * immutable id, new name, custom source. The source's requirements (and its
 * safe table-caption policy) are preserved; the registry is never mutated.
 */
export function copyProfilePayload(
  sourcePayload: Record<string, unknown>,
  profileId: string,
  name: string,
): Record<string, unknown> {
  const p = cloneRecord(sourcePayload)
  p.profile_id = profileId
  p.profile_name = name
  p.profile_source = 'custom'
  return p
}

/**
 * The exact payload sent to the backend validator on Save: the draft's stored
 * payload with the current name/description applied and the fixed citation
 * style and custom source enforced.
 */
export function buildSavePayload(
  draft: StoredCustomProfile,
): Record<string, unknown> {
  const payload = cloneRecord(draft.payload)
  payload.profile_name = draft.name.trim()
  payload.description = draft.description
  payload.profile_source = 'custom'
  payload.citation_style = CITATION_STYLE
  return payload
}

// ---------------------------------------------------------------------------
// Client-side validation (lightweight pre-flight; backend is authoritative)
// ---------------------------------------------------------------------------

/**
 * Lightweight client checks before the backend round-trip: non-empty name,
 * case-insensitive unique name, description within the UI bound, and the
 * requirement controls. Returns stable frontend field identifiers matching
 * the backend (general.name, general.description, body.*, headings.*,
 * margins.*).
 */
export function clientValidate(
  draft: StoredCustomProfile,
  envelope: StoreEnvelope,
): ProfileValidationError[] {
  const errors: ProfileValidationError[] = []
  const name = draft.name.trim()
  if (!name) {
    errors.push({ field: 'general.name', message: 'Enter a profile name.' })
  } else {
    const clash = envelope.profiles.some(
      (p) =>
        p.id !== draft.id &&
        p.name.trim().toLowerCase() === name.toLowerCase(),
    )
    if (clash) {
      errors.push({
        field: 'general.name',
        message: 'A custom profile with this name already exists.',
      })
    }
  }
  if (draft.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push({
      field: 'general.description',
      message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`,
    })
  }
  errors.push(...validateRequirements(draft.payload))
  return errors
}

// ---------------------------------------------------------------------------
// Requirement ranges (Build 4) — mirror the authoritative backend schema.
// The editor never enforces these on save (backend is authoritative); they
// drive lightweight client-side validation while editing and the controls.
// ---------------------------------------------------------------------------

export const FONT_SIZE_MIN = 6
export const FONT_SIZE_MAX = 72
export const LINE_SPACING_MIN = 1.0
export const LINE_SPACING_MAX = 4.0
export const SPACING_PT_MIN = 0
export const SPACING_PT_MAX = 240
export const MARGIN_MIN_IN = 0.25
export const MARGIN_MAX_IN = 4.0

export const ALIGNMENT_OPTIONS = ['left', 'center', 'right', 'justify'] as const
export type AlignmentValue = (typeof ALIGNMENT_OPTIONS)[number]

export interface FontPair {
  /** Font family — kept as typed text; validated as a pair with size. */
  family: string
  /** Font size in pt — raw input string; parsed on save/validate. */
  size: string
}

export type MarginSide = 'left' | 'right' | 'top' | 'bottom'
export type MarginPreset = 'all-one' | 'left-one-five' | 'none'

export const MARGIN_PRESET_LABELS: Record<MarginPreset, string> = {
  'all-one': '1 in on all sides',
  'left-one-five': '1.5 in left, 1 in elsewhere',
  none: 'Do not check margins',
}

export const MARGIN_SIDE_LABELS: Record<MarginSide, string> = {
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom',
}

// ---------------------------------------------------------------------------
// UI models (Build 4) — a plain, editable view of the schema-backed groups.
// Converters map payload ↔ UI model; `null` always means "disabled".
// ---------------------------------------------------------------------------

export interface BodyUiModel {
  fontEnabled: boolean
  /** True when the source stored a single exact (family, size) pair. */
  fontExactMode: boolean
  pairs: FontPair[]
  alignmentEnabled: boolean
  alignment: AlignmentValue | ''
  lineSpacingEnabled: boolean
  lineSpacing: string
  spaceBeforeEnabled: boolean
  spaceBefore: string
  spaceAfterEnabled: boolean
  spaceAfter: string
}

export type HeadingFontBehavior = 'inherit' | 'explicit' | 'disabled'

export interface HeadingLevelModel {
  /** Per-level alignment (APA-style metadata, stored per level). */
  alignmentEnabled: boolean
  alignment: AlignmentValue | ''
  bold: boolean
  italic: boolean
}

export interface HeadingUiModel {
  fontBehavior: HeadingFontBehavior
  fontExactMode: boolean
  pairs: FontPair[]
  /** Shared heading alignment — the engine-consumed value (audited). */
  alignmentEnabled: boolean
  alignment: AlignmentValue | ''
  spaceBeforeEnabled: boolean
  spaceBefore: string
  spaceAfterEnabled: boolean
  spaceAfter: string
  level1: HeadingLevelModel
  level2: HeadingLevelModel
  level3: HeadingLevelModel
}

export type MarginsUiModel = Record<MarginSide, { enabled: boolean; value: string }>

type BodyGroup = Record<string, unknown>
type HeadingGroup = Record<string, unknown>
type MarginGroup = Record<string, unknown>

const numStr = (n: unknown): string => {
  if (typeof n === 'number' && Number.isFinite(n)) return String(n)
  if (typeof n === 'string' && n.trim() !== '') return n
  return ''
}

const parseNum = (s: string): number | null => {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

const asNumList = (v: unknown): [string, number][] => {
  if (!Array.isArray(v)) return []
  const out: [string, number][] = []
  for (const item of v) {
    if (Array.isArray(item) && item.length === 2) {
      const size = parseNum(String(item[1]))
      if (item[0] != null && size != null) out.push([String(item[0]), size])
    }
  }
  return out
}

const asLevel = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return {}
}

/** Read the schema-backed Body group into the editable UI model. */
export function bodyToUiModel(body: BodyGroup): BodyUiModel {
  const combos = asNumList(body.allowed_font_combos)
  const exactFamily = typeof body.font_family === 'string' ? body.font_family : null
  const exactSize = parseNum(numStr(body.font_size_pt))
  const exact = exactFamily !== null && exactSize !== null
  const fontEnabled = combos.length > 0 || exact
  const pairs: FontPair[] = combos.length > 0
    ? combos.map(([family, size]) => ({ family, size: numStr(size) }))
    : exact
      ? [{ family: exactFamily as string, size: numStr(exactSize) }]
      : []
  return {
    fontEnabled,
    fontExactMode: exact && combos.length === 0,
    pairs,
    alignmentEnabled: body.alignment != null,
    alignment: (body.alignment as AlignmentValue) ?? '',
    lineSpacingEnabled: body.line_spacing != null,
    lineSpacing: numStr(body.line_spacing),
    spaceBeforeEnabled: body.space_before_pt != null,
    spaceBefore: numStr(body.space_before_pt),
    spaceAfterEnabled: body.space_after_pt != null,
    spaceAfter: numStr(body.space_after_pt),
  }
}

/** Build the schema-backed Body group from the editable UI model. */
export function bodyFromUiModel(ui: BodyUiModel): BodyGroup {
  const body: BodyGroup = {
    font_family: null,
    font_size_pt: null,
    allowed_font_combos: null,
    line_spacing: ui.lineSpacingEnabled ? parseNum(ui.lineSpacing) : null,
    alignment: ui.alignmentEnabled && ui.alignment ? ui.alignment : null,
    space_before_pt: ui.spaceBeforeEnabled ? parseNum(ui.spaceBefore) : null,
    space_after_pt: ui.spaceAfterEnabled ? parseNum(ui.spaceAfter) : null,
    // First-line indentation is not consumed by the deterministic adapter in
    // this release — never save a misleading value (Build 4 rule).
    first_line_indent_in: null,
  }
  if (ui.fontEnabled) {
    const pairs = ui.pairs
      .map((p) => [p.family.trim(), parseNum(p.size)] as [string, number | null])
      .filter((p): p is [string, number] => p[0] !== '' && p[1] !== null)
    if (ui.fontExactMode && pairs.length === 1) {
      body.font_family = pairs[0][0]
      body.font_size_pt = pairs[0][1]
    } else if (pairs.length >= 1) {
      body.allowed_font_combos = pairs
    }
  }
  return body
}

const levelToUiModel = (level: unknown): HeadingLevelModel => {
  const l = asLevel(level)
  return {
    alignmentEnabled: l.alignment != null,
    alignment: (l.alignment as AlignmentValue) ?? '',
    bold: l.bold === true,
    italic: l.italic === true,
  }
}

const uiModelToLevel = (ui: HeadingLevelModel): Record<string, unknown> => {
  return {
    bold: ui.bold,
    italic: ui.italic,
    // Preserve any stored alignment verbatim (never edited by the UI).
    ...(ui.alignmentEnabled && ui.alignment ? { alignment: ui.alignment } : {}),
  }
}

/** Read the schema-backed Heading group into the editable UI model. */
export function headingToUiModel(heading: HeadingGroup): HeadingUiModel {
  const combos = asNumList(heading.allowed_font_combos)
  const exactFamily = typeof heading.font_family === 'string' ? heading.font_family : null
  const exactSize = parseNum(numStr(heading.font_size_pt))
  const exact = exactFamily !== null && exactSize !== null
  const explicit = combos.length > 0 || exact
  const fontBehavior: HeadingFontBehavior = heading.inherit_body_font === true
    ? 'inherit'
    : explicit
      ? 'explicit'
      : 'disabled'
  const pairs: FontPair[] = explicit
    ? combos.length > 0
      ? combos.map(([family, size]) => ({ family, size: numStr(size) }))
      : [{ family: exactFamily as string, size: numStr(exactSize) }]
    : []
  return {
    fontBehavior,
    fontExactMode: exact && combos.length === 0,
    pairs,
    alignmentEnabled: heading.alignment != null,
    alignment: (heading.alignment as AlignmentValue) ?? '',
    spaceBeforeEnabled: heading.space_before_pt != null,
    spaceBefore: numStr(heading.space_before_pt),
    spaceAfterEnabled: heading.space_after_pt != null,
    spaceAfter: numStr(heading.space_after_pt),
    level1: levelToUiModel(heading.level_1),
    level2: levelToUiModel(heading.level_2),
    level3: levelToUiModel(heading.level_3),
  }
}

/**
 * Build the schema-backed Heading group from the editable UI model.
 * The shared `heading.alignment` (engine-consumed) is preserved verbatim;
 * per-level alignment is preserved from the level model. Only bold/italic
 * and the spacing/font fields the editor exposes are written.
 */
export function headingFromUiModel(
  ui: HeadingUiModel,
  preserveAlignment: string | null,
): HeadingGroup {
  const heading: HeadingGroup = {
    inherit_body_font: ui.fontBehavior === 'inherit',
    font_family: null,
    font_size_pt: null,
    allowed_font_combos: null,
    alignment: preserveAlignment,
    space_before_pt: ui.spaceBeforeEnabled ? parseNum(ui.spaceBefore) : null,
    space_after_pt: ui.spaceAfterEnabled ? parseNum(ui.spaceAfter) : null,
    level_1: uiModelToLevel(ui.level1),
    level_2: uiModelToLevel(ui.level2),
    level_3: uiModelToLevel(ui.level3),
  }
  if (ui.fontBehavior === 'explicit') {
    const pairs = ui.pairs
      .map((p) => [p.family.trim(), parseNum(p.size)] as [string, number | null])
      .filter((p): p is [string, number] => p[0] !== '' && p[1] !== null)
    if (ui.fontExactMode && pairs.length === 1) {
      heading.font_family = pairs[0][0]
      heading.font_size_pt = pairs[0][1]
    } else if (pairs.length >= 1) {
      heading.allowed_font_combos = pairs
    }
  }
  return heading
}

/** Read the schema-backed Margins group into the editable UI model. */
export function marginsToUiModel(margins: MarginGroup): MarginsUiModel {
  return {
    left: {
      enabled: margins.margin_left_in != null,
      value: numStr(margins.margin_left_in),
    },
    right: {
      enabled: margins.margin_right_in != null,
      value: numStr(margins.margin_right_in),
    },
    top: {
      enabled: margins.margin_top_in != null,
      value: numStr(margins.margin_top_in),
    },
    bottom: {
      enabled: margins.margin_bottom_in != null,
      value: numStr(margins.margin_bottom_in),
    },
  }
}

/** Build the schema-backed Margins group from the editable UI model. */
export function marginsFromUiModel(ui: MarginsUiModel): MarginGroup {
  return {
    margin_left_in: ui.left.enabled ? parseNum(ui.left.value) : null,
    margin_right_in: ui.right.enabled ? parseNum(ui.right.value) : null,
    margin_top_in: ui.top.enabled ? parseNum(ui.top.value) : null,
    margin_bottom_in: ui.bottom.enabled ? parseNum(ui.bottom.value) : null,
  }
}

/**
 * Apply a convenience margin preset. Presets are NOT universal standards —
 * they only pre-fill the four controls, which remain editable and must pass
 * backend validation before save.
 */
export function applyMarginPreset(preset: MarginPreset): MarginsUiModel {
  if (preset === 'none') {
    return {
      left: { enabled: false, value: '' },
      right: { enabled: false, value: '' },
      top: { enabled: false, value: '' },
      bottom: { enabled: false, value: '' },
    }
  }
  const value = preset === 'all-one' ? '1' : '1.5'
  return {
    left: { enabled: true, value },
    right: { enabled: true, value: '1' },
    top: { enabled: true, value: '1' },
    bottom: { enabled: true, value: '1' },
  }
}

/** Deep-clone a payload then replace one top-level group. */
export function setPayloadGroup(
  payload: Record<string, unknown>,
  groupKey: string,
  group: Record<string, unknown>,
): Record<string, unknown> {
  const next = cloneRecord(payload)
  next[groupKey] = group
  return next
}

// ---------------------------------------------------------------------------
// Lightweight client-side validation for requirements (Build 4)
// ---------------------------------------------------------------------------

/**
 * Validate the editable requirement controls. Mirrors the authoritative
 * backend ranges so the user gets early feedback; the backend remains the
 * gate before save. Errors carry stable frontend field identifiers.
 */
export function validateRequirements(
  payload: Record<string, unknown>,
): ProfileValidationError[] {
  const errors: ProfileValidationError[] = []
  const body = bodyToUiModel((payload.body ?? {}) as BodyGroup)
  const heading = headingToUiModel((payload.heading ?? {}) as HeadingGroup)
  const margins = marginsToUiModel((payload.margins ?? {}) as MarginGroup)

  // Body font pairs
  if (body.fontEnabled) {
    if (body.pairs.length === 0) {
      errors.push({
        field: 'body.font_pairs',
        message: 'Select at least one accepted font and size.',
      })
    } else {
      const seen = new Set<string>()
      for (const p of body.pairs) {
        if (!p.family.trim()) {
          errors.push({ field: 'body.font_pairs', message: 'Enter a font name for every pair.' })
          break
        }
        const size = parseNum(p.size)
        if (size === null) {
          errors.push({ field: 'body.font_pairs', message: 'Enter a numeric font size in points.' })
          break
        }
        if (size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) {
          errors.push({
            field: 'body.font_pairs',
            message: `Enter a font size between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX} pt.`,
          })
          break
        }
        const key = `${p.family.trim().toLowerCase()}@${size}`
        if (seen.has(key)) {
          errors.push({
            field: 'body.font_pairs',
            message: 'Each font and size may be listed only once.',
          })
          break
        }
        seen.add(key)
      }
    }
  }

  // Body line spacing
  const ls = body.lineSpacingEnabled ? parseNum(body.lineSpacing) : null
  if (body.lineSpacingEnabled && (ls === null || ls < LINE_SPACING_MIN || ls > LINE_SPACING_MAX)) {
    errors.push({
      field: 'body.line_spacing',
      message: `Enter line spacing between ${LINE_SPACING_MIN} and ${LINE_SPACING_MAX}.`,
    })
  }

  // Body space before / after
  for (const [field, label] of [
    ['body.space_before', body.spaceBefore],
    ['body.space_after', body.spaceAfter],
  ] as const) {
    const enabled = field === 'body.space_before' ? body.spaceBeforeEnabled : body.spaceAfterEnabled
    const value = enabled ? parseNum(label) : null
    if (enabled && (value === null || value < SPACING_PT_MIN || value > SPACING_PT_MAX)) {
      errors.push({
        field,
        message: `Enter paragraph spacing between ${SPACING_PT_MIN} and ${SPACING_PT_MAX} pt.`,
      })
    }
  }

  // Heading inheritance requires body font enabled.
  if (heading.fontBehavior === 'inherit' && !body.fontEnabled) {
    errors.push({
      field: 'headings.level_1.font',
      message: 'Heading 1 cannot inherit the body font when no body font is enabled.',
    })
  }

  // Heading explicit pairs
  if (heading.fontBehavior === 'explicit') {
    if (heading.pairs.length === 0) {
      errors.push({
        field: 'headings.level_1.font',
        message: 'Select at least one accepted font and size.',
      })
    } else {
      const seen = new Set<string>()
      for (const p of heading.pairs) {
        if (!p.family.trim()) {
          errors.push({
            field: 'headings.level_1.font',
            message: 'Enter a font name for every pair.',
          })
          break
        }
        const size = parseNum(p.size)
        if (size === null) {
          errors.push({
            field: 'headings.level_1.font',
            message: 'Enter a numeric font size in points.',
          })
          break
        }
        if (size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) {
          errors.push({
            field: 'headings.level_1.font',
            message: `Enter a font size between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX} pt.`,
          })
          break
        }
        const key = `${p.family.trim().toLowerCase()}@${size}`
        if (seen.has(key)) {
          errors.push({
            field: 'headings.level_1.font',
            message: 'Each font and size may be listed only once.',
          })
          break
        }
        seen.add(key)
      }
    }
  }

  // Heading space before / after
  for (const [field, label] of [
    ['headings.level_1.space_before', heading.spaceBefore],
    ['headings.level_1.space_after', heading.spaceAfter],
  ] as const) {
    const enabled = field.endsWith('space_before')
      ? heading.spaceBeforeEnabled
      : heading.spaceAfterEnabled
    const value = enabled ? parseNum(label) : null
    if (enabled && (value === null || value < SPACING_PT_MIN || value > SPACING_PT_MAX)) {
      errors.push({
        field,
        message: `Enter heading spacing between ${SPACING_PT_MIN} and ${SPACING_PT_MAX} pt.`,
      })
    }
  }

  // Margins — product range 0.25–4.0; zero is never an enabled value.
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const m = margins[side]
    if (!m.enabled) continue
    const value = parseNum(m.value)
    if (value === null || value < MARGIN_MIN_IN || value > MARGIN_MAX_IN) {
      errors.push({
        field: `margins.${side}`,
        message: `Enter a margin between ${MARGIN_MIN_IN} and ${MARGIN_MAX_IN} in.`,
      })
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// Plain-English summary (Build 4)
// ---------------------------------------------------------------------------

export interface ProfileSummary {
  lines: string[]
  disabledCount: number
}

const formatPairs = (pairs: { family: string; size: string }[]): string =>
  pairs.map((p) => `${p.family.trim()}, ${p.size} pt`).join('; ') ||
  'No font selected'

/**
 * Build the plain-English summary shown for the unsaved draft and saved
 * profiles. Uses only human terms — never internal field names, schema
 * terms, or enum values.
 */
export function summarizeProfile(payload: Record<string, unknown>): ProfileSummary {
  const lines: string[] = []
  const body = bodyToUiModel((payload.body ?? {}) as BodyGroup)
  const heading = headingToUiModel((payload.heading ?? {}) as HeadingGroup)
  const margins = marginsToUiModel((payload.margins ?? {}) as MarginGroup)

  // Body
  let bodyLine = 'Body: Not checked'
  if (body.fontEnabled) {
    bodyLine = `Body: ${formatPairs(body.pairs)}`
    if (body.lineSpacingEnabled && body.lineSpacing) {
      bodyLine += ` · ${body.lineSpacing} spacing`
    }
  } else if (body.lineSpacingEnabled && body.lineSpacing) {
    bodyLine = `Body: ${body.lineSpacing} line spacing`
  }
  lines.push(bodyLine)

  if (body.alignmentEnabled && body.alignment) {
    lines.push(`Body alignment: ${capitalize(body.alignment)}`)
  }

  // Headings
  if (heading.fontBehavior === 'inherit') {
    lines.push('Headings: Use body font')
  } else if (heading.fontBehavior === 'explicit') {
    lines.push(`Headings: ${formatPairs(heading.pairs)}`)
  } else {
    lines.push('Headings: Not checked')
  }
  const headingStyles: string[] = []
  for (const [label, level] of [
    ['H1', heading.level1],
    ['H2', heading.level2],
    ['H3', heading.level3],
  ] as const) {
    if (level.bold || level.italic) {
      headingStyles.push(`${label}: ${level.bold ? 'bold' : ''}${level.bold && level.italic ? ' + ' : ''}${level.italic ? 'italic' : ''}`)
    }
  }
  if (headingStyles.length > 0) {
    lines.push(`Heading styles: ${headingStyles.join('; ')}`)
  }

  // Margins
  const enabled = (['left', 'right', 'top', 'bottom'] as const).filter(
    (side) => margins[side].enabled,
  )
  if (enabled.length === 0) {
    lines.push('Margins: Not checked')
  } else if (enabled.length === 4) {
    const values = enabled.map((s) => margins[s].value)
    if (new Set(values).size === 1) {
      lines.push(`Margins: ${values[0]} in on all sides`)
    } else {
      lines.push(
        `Margins: ${MARGIN_SIDE_LABELS.left} ${margins.left.value} in, ` +
          `${MARGIN_SIDE_LABELS.right} ${margins.right.value} in, ` +
          `${MARGIN_SIDE_LABELS.top} ${margins.top.value} in, ` +
          `${MARGIN_SIDE_LABELS.bottom} ${margins.bottom.value} in`,
      )
    }
  } else {
    const parts = enabled.map(
      (s) => `${MARGIN_SIDE_LABELS[s]} ${margins[s].value} in`,
    )
    lines.push(`Margins: ${parts.join(', ')}`)
  }

  // Disabled check count
  let disabledCount = 0
  const nullable: unknown[] = [
    payload.body, payload.heading, payload.margins,
    payload.references, payload.captions, payload.lists,
  ]
  for (const group of nullable) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue
    const g = group as Record<string, unknown>
    for (const key of Object.keys(g)) {
      if (key === 'exempt_roles' || key === 'table_eligibility' || key === 'inherit_body_font') continue
      if (g[key] === null) disabledCount += 1
    }
  }

  return { lines, disabledCount }
}

const capitalize = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

// ---------------------------------------------------------------------------
// Operation status (Build 5 polish) — ONE active status at a time
// ---------------------------------------------------------------------------

export type OpStatusKind =
  | 'idle'
  | 'validating'
  | 'deleting'
  | 'saved'
  | 'deleted'
  | 'already-gone'
  | 'error'
  | 'backend-error'

export interface OpStatus {
  kind: OpStatusKind
  message?: string
  errors?: string[]
}

/** Success statuses auto-dismiss after this long (within the 3–5 s window). */
export const OP_STATUS_SUCCESS_MS = 4000

export function isSuccessOpStatus(kind: OpStatusKind): boolean {
  return kind === 'saved' || kind === 'deleted' || kind === 'already-gone'
}

export function isErrorOpStatus(kind: OpStatusKind): boolean {
  return kind === 'error' || kind === 'backend-error'
}

function opStatusSame(a: OpStatus, b: OpStatus): boolean {
  if (a.kind !== b.kind) return false
  if ((a.message ?? '') !== (b.message ?? '')) return false
  const ae = a.errors ?? []
  const be = b.errors ?? []
  return ae.length === be.length && ae.every((m, i) => m === be[i])
}

/**
 * Merge the next operation status into the current one. Returns the PREVIOUS
 * object reference when the status is identical so React never re-renders
 * (and aria-live never re-announces) the same message twice.
 */
export function mergeOpStatus(prev: OpStatus, next: OpStatus): OpStatus {
  return opStatusSame(prev, next) ? prev : next
}

// ---------------------------------------------------------------------------
// Envelope building + persistence (revision-gated)
// ---------------------------------------------------------------------------

/**
 * Insert/update a stored profile, bump the envelope revision, and stamp the
 * new updated_at. Never touches storage — returns the next envelope for the
 * caller to persist via `persistEnvelope` (which enforces the expected
 * revision for multi-tab safety).
 */
export function upsertAndBump(
  envelope: StoreEnvelope,
  profile: StoredCustomProfile,
  nowIso: string,
): StoreEnvelope {
  const next = upsertProfile(envelope, profile)
  if (!next.ok) return envelope
  return {
    ...next.envelope,
    revision: next.envelope.revision + 1,
    updated_at: nowIso,
  }
}

/**
 * Remove ONE stored custom profile, bump the revision, and reset the store
 * selection to the recommended built-in when the deleted profile was
 * selected. Refuses to remove a profile that does not exist. Never touches
 * built-in definitions, Audit data, or anything outside the local envelope.
 */
export function deleteAndBump(
  envelope: StoreEnvelope,
  id: string,
  nowIso: string,
): { ok: true; envelope: StoreEnvelope } | { ok: false; reason: 'not-found' } {
  const result = deleteProfile(envelope, id)
  if (!result.ok) return result
  return {
    ok: true,
    envelope: {
      ...result.envelope,
      revision: result.envelope.revision + 1,
      updated_at: nowIso,
    },
  }
}

/**
 * True when the draft has never been persisted to the store (a freshly
 * created blank/copy draft). Such drafts use "Discard draft", never
 * "Delete profile".
 */
export function isUnsavedDraft(
  draft: StoredCustomProfile | null,
  envelope: StoreEnvelope | null,
): boolean {
  if (!draft || !envelope) return false
  return !envelope.profiles.some((p) => p.id === draft.id)
}

/**
 * Persist a new envelope only when the caller's expected revision still
 * matches storage. Returns the store WriteResult so the UI can distinguish a
 * successful write from a stale-revision refusal (another tab).
 */
export function persistEnvelope(
  adapter: StoreAdapter,
  envelope: StoreEnvelope,
  expectedRevision: number,
) {
  return saveStore(adapter, envelope, expectedRevision)
}

/**
 * True when the editable draft differs from its stored version — used to gate
 * the unsaved-changes warning. A freshly created (unsaved) draft is always
 * dirty; after a successful save the confirmed profile replaces the draft.
 */
export function isDirty(
  draft: StoredCustomProfile | null,
  stored: StoredCustomProfile | null,
): boolean {
  if (!draft) return false
  if (!stored) return true
  return (
    draft.name !== stored.name || draft.description !== stored.description
  )
}

// ---------------------------------------------------------------------------
// Store adapter helpers
// ---------------------------------------------------------------------------

/** Deterministic in-memory StoreAdapter (used for tests and fallback). */
export function createMemoryStoreAdapter(): StoreAdapter {
  const store = new Map<string, string>()
  return {
    get(key) {
      return store.get(key) ?? null
    },
    set(key, value) {
      store.set(key, value)
    },
    onExternalChange() {
      return () => undefined
    },
  }
}

/** Deterministic helper used by tests and the editor. */
export function loadEnvelope(adapter: StoreAdapter): StoreEnvelope {
  const result = loadStore(adapter)
  if (!result.ok) return emptyEnvelope()
  return result.envelope
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Deep-clone a plain JSON value without `structuredClone` assumptions. */
export function cloneRecord<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as T
}

export { generateProfileId }
export type { FormattingProfile, StoreAdapter, StoreEnvelope, StoredCustomProfile }
