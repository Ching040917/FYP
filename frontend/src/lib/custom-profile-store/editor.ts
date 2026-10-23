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
import type { FormattingProfile, ProfileSnapshot, ProfileValidationError } from '../../types/api'
import {
  generateProfileId,
  saveStore,
  upsertProfile,
  deleteProfile,
  type StoreAdapter,
  type StoreEnvelope,
  type StoredCustomProfile,
  type WriteResult,
} from './store.ts'
import type { DraftUiState } from './draft-recovery.ts'
import {
  PAGE_ELEMENTS_HELP_TEXT,
  pageElementCheckParts,
  pageElementDisclosureLines,
  referencesDisclosure,
  type PageElementProfileGroups,
} from '../audit/enabled-checks-wording.ts'
import type { ProfileSnapshotReferences } from '../../types/api'

/** The three creation paths the editor exposes (Build 3). */
export type CreationKind = 'copy-suc' | 'copy-apa' | 'blank'

/** Stable built-in profile ids the editor can copy from. */
export const SUC_BUILTIN_ID = 'suc-academic-report'
export const APA_BUILTIN_ID = 'apa7-student-paper'

/** Accessible action labels for the creation buttons. */
export const CREATION_LABELS: Record<CreationKind, string> = {
  'copy-suc': 'Copy SUC Academic Report',
  'copy-apa': 'Copy APA 7 Student Paper',
  blank: 'Start with blank formatting and APA citation defaults',
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
 * Citation ↔ Reference List matching toggles (deterministic rules only).
 * Names mirror the authoritative backend schema (`CitationMatchingSettings`).
 */
export const CITATION_MATCHING_FIELDS = [
  'check_citations_have_references',
  'check_references_are_cited',
  'check_author_year_consistency',
  'check_year_suffixes',
  'check_duplicate_references',
  'flag_ambiguous_matches',
  'allow_personal_communication',
] as const

export type CitationMatchingField = (typeof CITATION_MATCHING_FIELDS)[number]

export type CitationMatchingUiModel = Record<CitationMatchingField, boolean>

/** Defaults mirror the backend dataclass exactly. */
export const DEFAULT_CITATION_MATCHING: CitationMatchingUiModel = {
  check_citations_have_references: true,
  check_references_are_cited: false,
  check_author_year_consistency: true,
  check_year_suffixes: true,
  check_duplicate_references: true,
  flag_ambiguous_matches: true,
  allow_personal_communication: true,
}

/**
 * Toggles that only run while `check_citations_have_references` is on. The
 * backend resolver normalizes them off behind a disabled parent; the editor
 * disables the controls so the UI never claims an inactive check.
 */
export const CITATION_MATCHING_DEPENDENT_FIELDS: readonly CitationMatchingField[] = [
  'check_author_year_consistency',
  'check_year_suffixes',
]

/** Read the payload group into the UI model (missing/unknown → default). */
export function citationMatchingToUiModel(group: unknown): CitationMatchingUiModel {
  const record =
    group && typeof group === 'object' && !Array.isArray(group)
      ? (group as Record<string, unknown>)
      : {}
  const model = { ...DEFAULT_CITATION_MATCHING }
  for (const field of CITATION_MATCHING_FIELDS) {
    if (typeof record[field] === 'boolean') {
      model[field] = record[field] as boolean
    }
  }
  return model
}

/** Write the UI model back as the payload group (booleans only). */
export function citationMatchingFromUiModel(
  ui: CitationMatchingUiModel,
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const field of CITATION_MATCHING_FIELDS) {
    out[field] = ui[field] === true
  }
  return out
}

export interface PageElementsUiModel {
  headerEnabled: boolean
  footerEnabled: boolean
  pageNumberEnabled: boolean
  placement: 'header' | 'footer' | 'either'
}

const PAGE_ELEMENT_FIELDS = [
  ['headers', 'check_header_requirements', 'headerEnabled'],
  ['footers', 'check_footer_requirements', 'footerEnabled'],
  ['page_numbers', 'check_page_number_requirements', 'pageNumberEnabled'],
] as const

function pageElementGroup(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Presentation defaults never replace raw values used by validation or Save. */
export function pageElementsToUiModel(payload: Record<string, unknown>): PageElementsUiModel {
  const pageNumbers = pageElementGroup(payload.page_numbers)
  return {
    headerEnabled: pageElementGroup(payload.headers).check_header_requirements === true,
    footerEnabled: pageElementGroup(payload.footers).check_footer_requirements === true,
    pageNumberEnabled: pageNumbers.check_page_number_requirements === true,
    placement: pageNumbers.placement === 'header' || pageNumbers.placement === 'footer'
      ? pageNumbers.placement : 'either',
  }
}

export function pageElementsFromUiModel(ui: PageElementsUiModel): Record<string, unknown> {
  return {
    headers: { check_header_requirements: ui.headerEnabled },
    footers: { check_footer_requirements: ui.footerEnabled },
    page_numbers: {
      check_page_number_requirements: ui.pageNumberEnabled,
      placement: ui.placement,
    },
  }
}

/** Change only explicitly edited controls; untouched raw settings still validate. */
export function applyPageElementsUiPatch(
  payload: Record<string, unknown>,
  patch: Partial<PageElementsUiModel>,
): Record<string, unknown> {
  const next = { ...payload }
  for (const [groupKey, field, uiField] of PAGE_ELEMENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, uiField)) {
      next[groupKey] = { ...pageElementGroup(next[groupKey]), [field]: patch[uiField] }
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'placement')) {
    next.page_numbers = { ...pageElementGroup(next.page_numbers), placement: patch.placement }
  }
  return next
}

/** Fill only absent settings; malformed supplied evidence must reach validation. */
function defaultMissingPageElements(payload: Record<string, unknown>): void {
  for (const [groupKey, field] of PAGE_ELEMENT_FIELDS) {
    if (!(groupKey in payload)) payload[groupKey] = {}
    const raw = payload[groupKey]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const group = raw as Record<string, unknown>
    if (!(field in group)) group[field] = false
    if (groupKey === 'page_numbers' && !('placement' in group)) group.placement = 'either'
  }
}

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
      // Every Reference List check is opt-in: the booleans are the switches,
      // the nulls the values behind them.
      check_heading_text: false,
      heading_text: null,
      allow_heading_aliases: false,
      check_heading_bold: false,
      heading_bold: true,
      check_heading_alignment: false,
      heading_alignment: null,
      check_start_on_new_page: false,
      check_hanging_indent: false,
      hanging_indent_in: null,
      check_line_spacing: false,
      line_spacing: null,
      check_space_before: false,
      space_before_pt: null,
      check_space_after: false,
      space_after_pt: null,
      check_font_family: false,
      font_family: null,
      check_font_size: false,
      font_size_pt: null,
      check_alignment: false,
      alignment: null,
      check_reference_order: false,
      check_doi_format: false,
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
    // Citation ↔ Reference List matching controls. Booleans only — the
    // editor exposes switches, never regex/JSON input.
    citation_matching: { ...DEFAULT_CITATION_MATCHING },
    ...pageElementsFromUiModel({
      headerEnabled: false,
      footerEnabled: false,
      pageNumberEnabled: false,
      placement: 'either',
    }),
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
  // A source payload that predates the citation controls gets the documented
  // defaults — never an absent group that would silently drop the toggles.
  if (!Object.prototype.hasOwnProperty.call(p, 'citation_matching')) {
    p.citation_matching = { ...DEFAULT_CITATION_MATCHING }
  }
  defaultMissingPageElements(p)
  return p
}

/**
 * The exact payload sent to the backend validator on Save: the draft's stored
 * payload with the current name/description applied and the fixed citation
 * style and custom source enforced.
 */
export function buildSavePayload(
  draft: StoredCustomProfile,
  ui?: DraftUiState,
): Record<string, unknown> {
  let payload = cloneRecord(draft.payload)
  if (ui?.body) payload = applyBodyUiPatch(payload, ui.body)
  if (ui?.heading) payload = applyHeadingUiPatch(payload, ui.heading)
  if (ui?.margins) payload = applyMarginsUiPatch(payload, ui.margins)
  if (ui?.references) payload = applyReferencesUiPatch(payload, ui.references)
  if (ui?.captions) payload = applyCaptionsUiPatch(payload, ui.captions)
  if (ui?.lists) payload = applyListsUiPatch(payload, ui.lists)
  if (ui?.citation) payload = applyCitationUiPatch(payload, ui.citation)
  payload.profile_id = draft.id
  payload.profile_name = draft.name.trim()
  payload.description = draft.description
  payload.profile_source = 'custom'
  payload.citation_style = CITATION_STYLE
  if (!Object.prototype.hasOwnProperty.call(payload, 'citation_matching')) payload.citation_matching = { ...DEFAULT_CITATION_MATCHING }
  defaultMissingPageElements(payload)
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
/** Reference line spacing is a multiplier like body line spacing. */
export const REFERENCES_LINE_SPACING_MIN = 1.0
export const REFERENCES_LINE_SPACING_MAX = 4.0

/** Reference hanging indent range in inches (mirrors the backend schema). */
export const REFERENCES_INDENT_MIN_IN = 0
export const REFERENCES_INDENT_MAX_IN = 4.0

/**
 * The heading words a profile may require — a fixed vocabulary, never free
 * text. Mirrors `REFERENCE_HEADING_TEXT_CHOICES` in the backend schema; the
 * stored value is always lowercase.
 */
export const REFERENCE_HEADING_TEXT_OPTIONS = [
  'references',
  'bibliography',
  'works cited',
  'reference list',
] as const

export type ReferenceHeadingText = (typeof REFERENCE_HEADING_TEXT_OPTIONS)[number]

/** Reader-facing wording for each heading word in the select. */
export const REFERENCE_HEADING_TEXT_LABELS: Record<ReferenceHeadingText, string> = {
  references: 'References',
  bibliography: 'Bibliography',
  'works cited': 'Works Cited',
  'reference list': 'Reference List',
}

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

/**
 * Reference List section UI. Every deterministic check is an opt-in toggle
 * with a dependent value: when the toggle is off the value is never compared,
 * so an historical profile can never gain a rule it never opted into.
 * `lineSpacingEnabled` is the rendered state of the tri-state
 * `check_line_spacing` field (absent = derived from the stored value).
 */
export interface ReferencesUiModel {
  headingTextEnabled: boolean
  headingText: ReferenceHeadingText | ''
  allowHeadingAliases: boolean
  /** True when the heading's bold or regular state is required. */
  headingBoldEnabled: boolean
  /** The required value — bold when the heading-bold check is on. */
  headingBold: boolean
  headingAlignmentEnabled: boolean
  headingAlignment: AlignmentValue | ''
  startOnNewPageEnabled: boolean
  hangingIndentEnabled: boolean
  hangingIndent: string
  lineSpacingEnabled: boolean
  lineSpacing: string
  spaceBeforeEnabled: boolean
  spaceBefore: string
  spaceAfterEnabled: boolean
  spaceAfter: string
  fontFamilyEnabled: boolean
  fontFamily: string
  fontSizeEnabled: boolean
  fontSize: string
  alignmentEnabled: boolean
  alignment: AlignmentValue | ''
  /** Alphabetical-order review: adjacent author identities only. */
  referenceOrderEnabled: boolean
  /** Visible DOI presentation only; no registration or resolution check. */
  doiFormatEnabled: boolean
}

/** Captions section UI (Build 5). Space before/after are independent. */
export interface CaptionUiModel {
  spaceBeforeEnabled: boolean
  spaceBefore: string
  spaceAfterEnabled: boolean
  spaceAfter: string
}

/** Lists section UI (Build 5). Space before is never checked for lists. */
export interface ListUiModel {
  spaceAfterEnabled: boolean
  spaceAfter: string
}

type BodyGroup = Record<string, unknown>
type HeadingGroup = Record<string, unknown>
type MarginGroup = Record<string, unknown>
type ReferencesGroup = Record<string, unknown>
type CaptionGroup = Record<string, unknown>
type ListGroup = Record<string, unknown>

const numStr = (n: unknown): string => {
  if (typeof n === 'number' && Number.isFinite(n)) return String(n)
  if (typeof n === 'string' && n.trim() !== '') return n
  return ''
}

// Invalid typed text is retained for validation, never converted to no requirement.
const parseNum = (s: string): number | string | null => {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : s
}

const asNumList = (v: unknown): [string, number][] => {
  if (!Array.isArray(v)) return []
  const out: [string, number][] = []
  for (const item of v) {
    if (Array.isArray(item) && item.length === 2) {
      const size = parseNum(String(item[1]))
      if (typeof item[0] === 'string' && typeof size === 'number') out.push([item[0], size])
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
    alignment: asAlignment(body.alignment),
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
  }
  if (ui.fontEnabled) {
    const pairs = ui.pairs.map((p) => [p.family.trim(), parseNum(p.size)])
    if (ui.fontExactMode && pairs.length === 1) {
      body.font_family = pairs[0][0]
      body.font_size_pt = pairs[0][1]
    } else {
      body.allowed_font_combos = pairs
    }
  }
  return body
}

const levelToUiModel = (level: unknown): HeadingLevelModel => {
  const l = asLevel(level)
  return {
    alignmentEnabled: l.alignment != null,
    alignment: asAlignment(l.alignment),
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
    alignment: asAlignment(heading.alignment),
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
    const pairs = ui.pairs.map((p) => [p.family.trim(), parseNum(p.size)])
    if (ui.fontExactMode && pairs.length === 1) {
      heading.font_family = pairs[0][0]
      heading.font_size_pt = pairs[0][1]
    } else {
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

/** Coerce a stored heading word to the fixed vocabulary (lowercase). */
const asHeadingText = (v: unknown): ReferenceHeadingText | '' => {
  const normalized = typeof v === 'string' ? v.trim().toLowerCase() : ''
  const match = REFERENCE_HEADING_TEXT_OPTIONS.find((o) => o === normalized)
  return match ?? ''
}

/** Coerce a stored alignment to the shared vocabulary ('' = not set). */
const asAlignment = (v: unknown): AlignmentValue | '' =>
  ALIGNMENT_OPTIONS.find((o) => o === v) ?? ''

/**
 * Read the schema-backed References group into the editable UI model.
 *
 * `check_line_spacing` is the one tri-state field: an absent/None toggle means
 * this profile predates it, so the check is active exactly when a line-spacing
 * value is stored. An explicit true/false always wins.
 */
export function referencesToUiModel(references: ReferencesGroup): ReferencesUiModel {
  const lineSpacingEnabled =
    references.check_line_spacing == null
      ? references.line_spacing != null
      : references.check_line_spacing === true
  return {
    headingTextEnabled: references.check_heading_text === true,
    headingText: asHeadingText(references.heading_text),
    allowHeadingAliases: references.allow_heading_aliases === true,
    headingBoldEnabled: references.check_heading_bold === true,
    headingBold: references.heading_bold !== false,
    headingAlignmentEnabled: references.check_heading_alignment === true,
    headingAlignment: asAlignment(references.heading_alignment),
    startOnNewPageEnabled: references.check_start_on_new_page === true,
    hangingIndentEnabled: references.check_hanging_indent === true,
    hangingIndent: numStr(references.hanging_indent_in),
    lineSpacingEnabled,
    lineSpacing: numStr(references.line_spacing),
    spaceBeforeEnabled: references.check_space_before === true,
    spaceBefore: numStr(references.space_before_pt),
    spaceAfterEnabled: references.check_space_after === true,
    spaceAfter: numStr(references.space_after_pt),
    fontFamilyEnabled: references.check_font_family === true,
    fontFamily: typeof references.font_family === 'string' ? references.font_family : '',
    fontSizeEnabled: references.check_font_size === true,
    fontSize: numStr(references.font_size_pt),
    alignmentEnabled: references.check_alignment === true,
    alignment: asAlignment(references.alignment),
    referenceOrderEnabled: references.check_reference_order === true,
    doiFormatEnabled: references.check_doi_format === true,
  }
}

/**
 * Build the schema-backed References group from the editable UI model.
 *
 * The standalone converter expresses the current controls. The canonical
 * candidate applies only deliberate field deltas, retaining a missing/null
 * legacy line switch and inactive configured values until explicitly edited.
 */
export function referencesFromUiModel(ui: ReferencesUiModel): ReferencesGroup {
  return {
    line_spacing: parseNum(ui.lineSpacing),
    check_line_spacing: ui.lineSpacingEnabled,
    hanging_indent_in: parseNum(ui.hangingIndent),
    check_hanging_indent: ui.hangingIndentEnabled,
    check_heading_text: ui.headingTextEnabled,
    heading_text: ui.headingText || null,
    allow_heading_aliases: ui.allowHeadingAliases,
    check_heading_bold: ui.headingBoldEnabled,
    heading_bold: ui.headingBold,
    check_heading_alignment: ui.headingAlignmentEnabled,
    heading_alignment: ui.headingAlignment || null,
    check_start_on_new_page: ui.startOnNewPageEnabled,
    check_space_before: ui.spaceBeforeEnabled,
    space_before_pt: parseNum(ui.spaceBefore),
    check_space_after: ui.spaceAfterEnabled,
    space_after_pt: parseNum(ui.spaceAfter),
    check_font_family: ui.fontFamilyEnabled,
    font_family: ui.fontFamily.trim() || null,
    check_font_size: ui.fontSizeEnabled,
    font_size_pt: parseNum(ui.fontSize),
    check_alignment: ui.alignmentEnabled,
    alignment: ui.alignment || null,
    check_reference_order: ui.referenceOrderEnabled,
    check_doi_format: ui.doiFormatEnabled,
  }
}

/** Read the schema-backed Captions group into the editable UI model. */
export function captionsToUiModel(captions: CaptionGroup): CaptionUiModel {
  return {
    spaceBeforeEnabled: captions.space_before_pt != null,
    spaceBefore: numStr(captions.space_before_pt),
    spaceAfterEnabled: captions.space_after_pt != null,
    spaceAfter: numStr(captions.space_after_pt),
  }
}

/** Build the schema-backed Captions group from the editable UI model. */
export function captionsFromUiModel(ui: CaptionUiModel): CaptionGroup {
  return {
    space_before_pt: ui.spaceBeforeEnabled ? parseNum(ui.spaceBefore) : null,
    space_after_pt: ui.spaceAfterEnabled ? parseNum(ui.spaceAfter) : null,
  }
}

/** Read the schema-backed Lists group into the editable UI model. */
export function listsToUiModel(lists: ListGroup): ListUiModel {
  return {
    spaceAfterEnabled: lists.space_after_pt != null,
    spaceAfter: numStr(lists.space_after_pt),
  }
}

/** Build the schema-backed Lists group from the editable UI model. */
export function listsFromUiModel(ui: ListUiModel): ListGroup {
  return {
    space_after_pt: ui.spaceAfterEnabled ? parseNum(ui.spaceAfter) : null,
  }
}

/** Overlay only deliberate UI changes; projections are never a storage schema. */
function patchGroup<T extends object>(
  payload: Record<string, unknown>,
  key: string,
  ui: T,
  project: (group: Record<string, unknown>) => T,
  convert: (ui: T) => Record<string, unknown>,
  fields: Partial<Record<keyof T, readonly string[]>>,
): Record<string, unknown> {
  const raw = asLevel(payload[key])
  const before = project(raw)
  let converted: Record<string, unknown> | undefined
  const patch: Record<string, unknown> = {}
  for (const field of Object.keys(fields) as (keyof T)[]) {
    if (JSON.stringify(before[field]) === JSON.stringify(ui[field])) continue
    converted ??= convert(ui)
    for (const target of fields[field] ?? []) patch[target] = converted[target]
  }
  if (Object.keys(patch).length === 0) return payload
  return { ...payload, [key]: { ...cloneRecord(raw), ...patch } }
}

const fontKeys = ['font_family', 'font_size_pt', 'allowed_font_combos'] as const

export function applyBodyUiPatch(payload: Record<string, unknown>, ui: BodyUiModel): Record<string, unknown> {
  return patchGroup(payload, 'body', ui, bodyToUiModel, bodyFromUiModel, {
    fontEnabled: fontKeys, fontExactMode: fontKeys, pairs: fontKeys,
    alignmentEnabled: ['alignment'], alignment: ['alignment'],
    lineSpacingEnabled: ['line_spacing'], lineSpacing: ['line_spacing'],
    spaceBeforeEnabled: ['space_before_pt'], spaceBefore: ['space_before_pt'],
    spaceAfterEnabled: ['space_after_pt'], spaceAfter: ['space_after_pt'],
  })
}

export function applyHeadingUiPatch(payload: Record<string, unknown>, ui: HeadingUiModel): Record<string, unknown> {
  let result = patchGroup(payload, 'heading', ui, headingToUiModel,
    (value) => headingFromUiModel(value, value.alignmentEnabled ? value.alignment || null : null), {
      fontBehavior: ['inherit_body_font', ...fontKeys], fontExactMode: fontKeys, pairs: fontKeys,
      alignmentEnabled: ['alignment'], alignment: ['alignment'],
      spaceBeforeEnabled: ['space_before_pt'], spaceBefore: ['space_before_pt'],
      spaceAfterEnabled: ['space_after_pt'], spaceAfter: ['space_after_pt'],
    })
  const before = headingToUiModel(asLevel(payload.heading))
  for (const [field, key] of [['level1', 'level_1'], ['level2', 'level_2'], ['level3', 'level_3']] as const) {
    const patch: Record<string, unknown> = {}
    for (const member of ['bold', 'italic'] as const) {
      if (before[field][member] !== ui[field][member]) patch[member] = ui[field][member]
    }
    if (Object.keys(patch).length) {
      const group = asLevel(result.heading)
      result = { ...result, heading: { ...group, [key]: { ...cloneRecord(asLevel(group[key])), ...patch } } }
    }
  }
  return result
}

export function applyMarginsUiPatch(payload: Record<string, unknown>, ui: MarginsUiModel): Record<string, unknown> {
  return patchGroup(payload, 'margins', ui, marginsToUiModel, marginsFromUiModel, {
    left: ['margin_left_in'], right: ['margin_right_in'], top: ['margin_top_in'], bottom: ['margin_bottom_in'],
  })
}

export function applyReferencesUiPatch(payload: Record<string, unknown>, ui: ReferencesUiModel): Record<string, unknown> {
  return patchGroup(payload, 'references', ui, referencesToUiModel, referencesFromUiModel, {
    headingTextEnabled: ['check_heading_text'], headingText: ['heading_text'],
    allowHeadingAliases: ['allow_heading_aliases'], headingBoldEnabled: ['check_heading_bold'], headingBold: ['heading_bold'],
    headingAlignmentEnabled: ['check_heading_alignment'], headingAlignment: ['heading_alignment'],
    startOnNewPageEnabled: ['check_start_on_new_page'],
    hangingIndentEnabled: ['check_hanging_indent'], hangingIndent: ['hanging_indent_in'],
    lineSpacingEnabled: ['check_line_spacing'], lineSpacing: ['line_spacing'],
    spaceBeforeEnabled: ['check_space_before'], spaceBefore: ['space_before_pt'],
    spaceAfterEnabled: ['check_space_after'], spaceAfter: ['space_after_pt'],
    fontFamilyEnabled: ['check_font_family'], fontFamily: ['font_family'],
    fontSizeEnabled: ['check_font_size'], fontSize: ['font_size_pt'],
    alignmentEnabled: ['check_alignment'], alignment: ['alignment'],
    referenceOrderEnabled: ['check_reference_order'], doiFormatEnabled: ['check_doi_format'],
  })
}

export function applyCaptionsUiPatch(payload: Record<string, unknown>, ui: CaptionUiModel): Record<string, unknown> {
  return patchGroup(payload, 'captions', ui, captionsToUiModel, captionsFromUiModel, {
    spaceBeforeEnabled: ['space_before_pt'], spaceBefore: ['space_before_pt'],
    spaceAfterEnabled: ['space_after_pt'], spaceAfter: ['space_after_pt'],
  })
}

export function applyListsUiPatch(payload: Record<string, unknown>, ui: ListUiModel): Record<string, unknown> {
  return patchGroup(payload, 'lists', ui, listsToUiModel, listsFromUiModel, {
    spaceAfterEnabled: ['space_after_pt'], spaceAfter: ['space_after_pt'],
  })
}

export function applyCitationUiPatch(payload: Record<string, unknown>, ui: CitationMatchingUiModel): Record<string, unknown> {
  const fields = Object.fromEntries(CITATION_MATCHING_FIELDS.map((field) => [field, [field]]))
  return patchGroup(payload, 'citation_matching', ui, citationMatchingToUiModel, citationMatchingFromUiModel, fields)
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
        if (typeof size !== 'number') { errors.push({ field: 'body.font_pairs', message: 'Enter a numeric font size in points.' })
        break }
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
  if (body.lineSpacingEnabled && (typeof ls !== 'number' || ls < LINE_SPACING_MIN || ls > LINE_SPACING_MAX)) {
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
    if (enabled && (typeof value !== 'number' || value < SPACING_PT_MIN || value > SPACING_PT_MAX)) {
      errors.push({
        field,
        message: `Enter paragraph spacing between ${SPACING_PT_MIN} and ${SPACING_PT_MAX} pt.`,
      })
    }
  }

  const rawBody = asLevel(payload.body)
  if (heading.fontBehavior === 'inherit' && rawBody.font_family == null &&
      rawBody.font_size_pt == null && !body.fontEnabled) {
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
        if (typeof size !== 'number') { errors.push({
          field: 'headings.level_1.font',
          message: 'Enter a numeric font size in points.',
        })
        break }
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
    if (enabled && (typeof value !== 'number' || value < SPACING_PT_MIN || value > SPACING_PT_MAX)) {
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
    if (typeof value !== 'number' || value < MARGIN_MIN_IN || value > MARGIN_MAX_IN) {
      errors.push({
        field: `margins.${side}`,
        message: `Enter a margin between ${MARGIN_MIN_IN} and ${MARGIN_MAX_IN} in.`,
      })
    }
  }

  // Reference List — heading, section start and entry layout. A value is
  // validated only while its check is switched on.
  const references = referencesToUiModel((payload.references ?? {}) as ReferencesGroup)
  const refLs = references.lineSpacingEnabled ? parseNum(references.lineSpacing) : null
  if (references.lineSpacingEnabled && references.lineSpacing !== '' && (typeof refLs !== 'number' || refLs < REFERENCES_LINE_SPACING_MIN || refLs > REFERENCES_LINE_SPACING_MAX)) {
    errors.push({
      field: 'references.line_spacing',
      message: `Enter reference line spacing between ${REFERENCES_LINE_SPACING_MIN} and ${REFERENCES_LINE_SPACING_MAX}.`,
    })
  }
  const refIndent = references.hangingIndentEnabled ? parseNum(references.hangingIndent) : null
  if (references.hangingIndentEnabled && references.hangingIndent !== '' && (typeof refIndent !== 'number' || refIndent < REFERENCES_INDENT_MIN_IN || refIndent > REFERENCES_INDENT_MAX_IN)) {
    errors.push({
      field: 'references.hanging_indent_in',
      message: `Enter a hanging indent between ${REFERENCES_INDENT_MIN_IN} and ${REFERENCES_INDENT_MAX_IN} in.`,
    })
  }
  for (const [field, value] of [
    ['references.space_before_pt', references.spaceBefore],
    ['references.space_after_pt', references.spaceAfter],
  ] as const) {
    const enabled = field === 'references.space_before_pt'
      ? references.spaceBeforeEnabled
      : references.spaceAfterEnabled
    const parsed = enabled ? parseNum(value) : null
    if (enabled && value !== '' && (typeof parsed !== 'number' || parsed < SPACING_PT_MIN || parsed > SPACING_PT_MAX)) {
      errors.push({
        field,
        message: `Enter spacing between ${SPACING_PT_MIN} and ${SPACING_PT_MAX} pt.`,
      })
    }
  }
  const refSize = references.fontSizeEnabled ? parseNum(references.fontSize) : null
  if (references.fontSizeEnabled && references.fontSize !== '' && (typeof refSize !== 'number' || refSize < FONT_SIZE_MIN || refSize > FONT_SIZE_MAX)) {
    errors.push({
      field: 'references.font_size_pt',
      message: `Enter a font size between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX} pt.`,
    })
  }
  const rawReferences = asLevel(payload.references)
  if (rawReferences.font_family != null &&
      (typeof rawReferences.font_family !== 'string' || !rawReferences.font_family.trim())) {
    errors.push({ field: 'references.font_family', message: 'Enter a font name.' })
  }
  for (const field of ['heading_alignment', 'alignment'] as const) {
    if (rawReferences[field] != null &&
        !(ALIGNMENT_OPTIONS as readonly unknown[]).includes(rawReferences[field])) {
      errors.push({ field: `references.${field}`, message: 'Choose an alignment.' })
    }
  }

  // Captions — space before / after, independent (Build 5).
  const captions = captionsToUiModel((payload.captions ?? {}) as CaptionGroup)
  for (const [field, label] of [
    ['captions.space_before', captions.spaceBefore],
    ['captions.space_after', captions.spaceAfter],
  ] as const) {
    const enabled = field === 'captions.space_before' ? captions.spaceBeforeEnabled : captions.spaceAfterEnabled
    const value = enabled ? parseNum(label) : null
    if (enabled && (typeof value !== 'number' || value < SPACING_PT_MIN || value > SPACING_PT_MAX)) {
      errors.push({
        field,
        message: `Enter caption spacing between ${SPACING_PT_MIN} and ${SPACING_PT_MAX} pt.`,
      })
    }
  }

  // Citation ↔ Reference List matching toggles — booleans only.
  const citationGroup = payload.citation_matching
  if (citationGroup != null) {
    if (typeof citationGroup !== 'object' || Array.isArray(citationGroup)) {
      errors.push({ field: 'citation_matching', message: 'This section is not well formed.' })
    } else {
      const group = citationGroup as Record<string, unknown>
      for (const field of CITATION_MATCHING_FIELDS) {
        if (field in group && typeof group[field] !== 'boolean') {
          errors.push({
            field: `citation_matching.${field}`,
            message: 'Choose true or false for this check.',
          })
        }
      }
      for (const key of Object.keys(group)) {
        if (!(CITATION_MATCHING_FIELDS as readonly string[]).includes(key)) {
          errors.push({ field: `citation_matching.${key}`, message: 'This field is not recognized.' })
        }
      }
    }
  }

  // Validate raw structural settings, including disabled groups and unknown keys.
  for (const [groupKey, field] of PAGE_ELEMENT_FIELDS) {
    if (!(groupKey in payload)) continue
    const raw = payload[groupKey]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ field: groupKey, message: 'This section is not well formed.' })
      continue
    }
    const group = raw as Record<string, unknown>
    if (field in group && typeof group[field] !== 'boolean') {
      errors.push({ field: `${groupKey}.${field}`, message: 'Choose true or false for this check.' })
    }
    if (group[field] === true && payload.profile_source !== 'custom') {
      errors.push({ field: `${groupKey}.${field}`, message: 'Available only in Custom Profiles' })
    }
    for (const key of Object.keys(group)) {
      if (key !== field && !(groupKey === 'page_numbers' && key === 'placement')) {
        errors.push({ field: `${groupKey}.${key}`, message: 'This field is not recognized.' })
      }
    }
    if (groupKey === 'page_numbers' && 'placement' in group &&
        group.placement !== 'header' && group.placement !== 'footer' && group.placement !== 'either') {
      errors.push({ field: 'page_numbers.placement', message: 'Choose Header, Footer or Either.' })
    }
  }

  // Lists — space after only (Build 5).
  const lists = listsToUiModel((payload.lists ?? {}) as ListGroup)
  const listAfter = lists.spaceAfterEnabled ? parseNum(lists.spaceAfter) : null
  if (lists.spaceAfterEnabled && (typeof listAfter !== 'number' || listAfter < SPACING_PT_MIN || listAfter > SPACING_PT_MAX)) {
    errors.push({
      field: 'lists.space_after',
      message: `Enter list spacing between ${SPACING_PT_MIN} and ${SPACING_PT_MAX} pt.`,
    })
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
 * Read-only presentation projection of canonical profile settings. Resolves
 * heading inheritance and citation dependencies without changing the payload.
 * Historical report consumers use their stored snapshot directly, never this.
 */
export function profilePayloadSnapshot(payload: Record<string, unknown>): ProfileSnapshot {
  const body = (payload.body ?? {}) as Record<string, unknown>
  const heading = (payload.heading ?? {}) as Record<string, unknown>
  const margins = (payload.margins ?? {}) as Record<string, number | null>
  const matching = citationMatchingToUiModel(payload.citation_matching)
  const policy = (payload.role_policy ?? {}) as Record<string, unknown>
  return {
    ...payload,
    profile_id: String(payload.profile_id ?? ''),
    description: String(payload.description ?? ''),
    citation_style: String(payload.citation_style || CITATION_STYLE),
    institution_specific: payload.profile_source === 'built_in' && String(payload.profile_id ?? '').startsWith('suc-'),
    profile_name: String(payload.profile_name || 'Selected profile'),
    profile_source: String(payload.profile_source || 'custom'),
    profile_version: Number(payload.profile_version ?? 1),
    heading: heading.inherit_body_font === true
      ? { ...heading, font_family: body.font_family, font_size_pt: body.font_size_pt, allowed_font_combos: body.font_family != null && body.font_size_pt != null ? [] : body.allowed_font_combos }
      : heading,
    margins: {
      left_in: margins.margin_left_in ?? null,
      right_in: margins.margin_right_in ?? null,
      top_in: margins.margin_top_in ?? null,
      bottom_in: margins.margin_bottom_in ?? null,
    },
    citation_matching: {
      ...matching,
      check_author_year_consistency: matching.check_citations_have_references === true && matching.check_author_year_consistency === true,
      check_year_suffixes: matching.check_citations_have_references === true && matching.check_year_suffixes === true,
    },
    role_exemptions: policy.exempt_roles,
    table_eligibility: policy.table_eligibility,
  } as ProfileSnapshot
}

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

  // Reference List — the editor draft and the audit report must describe the
  // same requirements in the same words, so both use this one helper.
  lines.push(referencesDisclosure((payload.references ?? null) as ProfileSnapshotReferences | null))
  // Enabled order and DOI requirements already appear in referencesDisclosure.
  // Add only their unchecked states; never repeat an enabled requirement.
  const refsRaw = (payload.references ?? {}) as Record<string, unknown>
  if (refsRaw.check_reference_order !== true) lines.push('Reference List alphabetical order: Not checked')
  if (refsRaw.check_doi_format !== true) lines.push('Reference DOI format: Not checked')

  const pageElements = payload as PageElementProfileGroups
  lines.push(...pageElementDisclosureLines(pageElements))
  if (pageElementCheckParts(pageElements).length > 0) lines.push(PAGE_ELEMENTS_HELP_TEXT)

  // Captions (Build 5)
  const captions = captionsToUiModel((payload.captions ?? {}) as CaptionGroup)
  const captionParts: string[] = []
  if (captions.spaceBeforeEnabled && captions.spaceBefore) {
    captionParts.push(`${captions.spaceBefore} pt before`)
  }
  if (captions.spaceAfterEnabled && captions.spaceAfter) {
    captionParts.push(`${captions.spaceAfter} pt after`)
  }
  lines.push(
    captionParts.length > 0
      ? `Captions: ${captionParts.join(', ')}`
      : 'Captions: Not checked',
  )

  // Lists (Build 5)
  const lists = listsToUiModel((payload.lists ?? {}) as ListGroup)
  if (lists.spaceAfterEnabled && lists.spaceAfter) {
    lines.push(`Lists: ${lists.spaceAfter} pt after`)
  } else {
    lines.push('Lists: Not checked')
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
  disabledCount += 3 - pageElementCheckParts(pageElements).length

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
export async function persistEnvelope(
  adapter: StoreAdapter,
  envelope: StoreEnvelope,
  expectedRevision: number,
): Promise<WriteResult> {
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
    persistent: false,
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
