"""Effective paragraph-formatting evidence with provenance.

Read-only. This module answers "what formatting does this paragraph
effectively have, and where did that value come from?" — it never decides
whether the value is correct and never produces a finding.

Why provenance matters
----------------------
A DOCX paragraph usually does NOT carry its own indentation: Word usually
writes it on the paragraph *style*, and the paragraph carries a bare
`<w:pPr>` or none at all. Reading only direct formatting and treating an
absent value as zero would report every correctly-formatted reference as
wrong. Every value here therefore carries a `source`, and an unresolvable
one stays `unresolved` rather than collapsing to a default.

Verified unit and sign behaviour
--------------------------------
Measured against generated `.docx` files (see `tests/
test_formatting_evidence.py`), not assumed:

* `<w:ind w:left="720" w:hanging="720"/>`  → python-docx reports
  `left_indent = 0.5in` and `first_line_indent = -0.5in`.
  **A hanging indent surfaces as a NEGATIVE first-line indent.**
  720 twips = 0.5 inch, i.e. 1440 twips per inch.
* `<w:ind w:firstLine="720"/>` → `first_line_indent = +0.5in`,
  `left_indent = None`.
* No `<w:ind>` at all → both are `None`, even when the paragraph *style*
  chain carries 0.5in / -0.5in. Inheritance must be walked explicitly.
* Style inheritance resolves nearest-first down `base_style`, which is the
  same precedence the existing font resolvers use.

Hence the effective hanging indent is:

    hanging_indent_in = -first_line_indent_in   when first_line_indent_in < 0
                     = None                    otherwise

A positive first-line indent is a first-line indent, NOT a hanging indent,
and is reported as such rather than being folded into the hanging value.
Source precedence, nearest wins:
    direct → paragraph_style → style_chain
    → numbering (when w:numPr and no stated indent)
    → document_default (w:docDefaults/w:pPrDefault, when declared)
    → effective_default (Word's built-in zero for un-numbered paragraphs)
    → unresolved (numbering unread / styles part unreadable)

`numbering` is reported only when no explicit indent resolved AND the
paragraph carries `w:numPr`; the effective indentation then comes from the
list definition, which this module does not read. Such a paragraph is
flagged `is_numbered` so a later rule can decline to judge it rather than
report a false mismatch. An un-numbered paragraph that states no
indentation anywhere is not unresolved: Word renders it flush at the left
margin (0 inches on every side), so it resolves to `effective_default`
with 0.0 values and a rule may compare it truthfully.
"""

from dataclasses import dataclass
from typing import Any, Dict, Optional

from docx.oxml.ns import qn

# Source vocabulary. Reuses the language already used by
# document_parser.resolve_effective_* (direct / paragraph_style /
# style_chain / document_default) and adds the two this feature needs.
SOURCE_DIRECT = "direct"
SOURCE_PARAGRAPH_STYLE = "paragraph_style"
SOURCE_STYLE_CHAIN = "style_chain"
SOURCE_NUMBERING = "numbering"
SOURCE_DOCUMENT_DEFAULT = "document_default"
# `effective_default` is its own source (not `document_default`): it means
# "no formatting layer stated a value and Word's default renders 0". The
# document_default source is reserved for a value actually declared in the
# document's w:docDefaults.
SOURCE_EFFECTIVE_DEFAULT = "effective_default"
SOURCE_UNRESOLVED = "unresolved"

# python-docx Length values are EMU; 914400 EMU per inch.
_EMU_PER_INCH = 914400
# OOXML w:ind attributes are twips: 1440 twips = 1 inch.
_TWIPS_PER_INCH = 1440
# A left indent at or below this magnitude is "no left indent". Word writes
# an explicitly cleared indent as ``w:left="0"`` (0 twips), which converts to
# exactly 0.0 in; the epsilon only absorbs float representation error, far
# below any tolerance ACA compares with.
_ZERO_INDENT_IN = 1e-9


def _to_inches(value: Optional[float]) -> Optional[float]:
    """Convert a python-docx Length (EMU) to a float number of inches."""
    if value is None:
        return None
    try:
        return round(float(value) / _EMU_PER_INCH, 6)
    except (TypeError, ValueError):
        return None


def _twips_to_inches(value: Optional[str]) -> Optional[float]:
    """Convert a raw w:ind twips attribute value to inches, or None."""
    if value is None:
        return None
    try:
        return round(int(value) / _TWIPS_PER_INCH, 6)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class IndentationEvidence:
    """Presentation-neutral indentation evidence for one paragraph.

    All distances are inches. `None` means "not established", never zero.
    """

    left_indent_in: Optional[float]
    first_line_indent_in: Optional[float]
    hanging_indent_in: Optional[float]
    source: str
    is_numbered: bool

    @property
    def is_resolved(self) -> bool:
        return self.source != SOURCE_UNRESOLVED


@dataclass(frozen=True)
class ParagraphFormatEvidence:
    """Direct paragraph and effective run evidence for one paragraph.

    `alignment`, `line_spacing`, `space_before_pt` and `space_after_pt` are
    DIRECT values only: python-docx does not resolve style inheritance for
    them, so an absent value is recorded as `None` (unresolved) and is never
    replaced with 0 or with the Normal style's value. `*_source` states why
    a value is None.

    Font family and size are EFFECTIVE, resolved by the existing
    document_parser helpers, with the provenance those helpers return.
    """

    alignment: Any
    alignment_source: str
    line_spacing: Optional[float]
    line_spacing_source: str
    space_before_pt: Optional[float]
    space_before_source: str
    space_after_pt: Optional[float]
    space_after_source: str
    effective_font_family: Optional[str]
    font_family_source: str
    effective_font_size_pt: Optional[float]
    font_size_source: str
    has_mixed_font_family: bool
    has_mixed_font_size: bool


def _style_chain_indents(paragraph_obj: Any):
    """Yield (left, first_line) from the paragraph style then its bases.

    Nearest-first, mirroring the precedence used by the font resolvers.
    Yields at most one pair per style; `None` members mean "this style does
    not define that half". A style that states only one half (a very common
    Word shape — e.g. the built-in `List Paragraph` style declares
    ``w:left="720"`` and no first-line value) yields that half as a value and
    the other half as ``None``. Callers must therefore treat the two halves
    INDEPENDENTLY: a stated left indent does not resolve the first-line half.
    """
    try:
        style = paragraph_obj.style
    except Exception:
        return
    seen = set()
    while style is not None and id(style) not in seen:
        seen.add(id(style))
        try:
            fmt = style.paragraph_format
            yield _to_inches(fmt.left_indent), _to_inches(fmt.first_line_indent)
        except Exception:
            return
        style = getattr(style, "base_style", None)


def _has_numbering(paragraph_obj: Any) -> bool:
    """True when the paragraph's own <w:pPr> carries <w:numPr>.

    Direct-only primitive. Style-inherited numbering is detected by
    `style_chain_has_numbering`; the auto-detect path in
    `resolve_indentation` consults both so a list-styled paragraph is
    never misreported with a fabricated zero.
    """
    try:
        pPr = paragraph_obj._p.find(qn("w:pPr"))
    except Exception:
        return False
    return pPr is not None and pPr.find(qn("w:numPr")) is not None


def style_chain_has_numbering(paragraph_obj: Any) -> bool:
    """True when numbering is inherited through the paragraph style chain.

    Walks `style` → `base_style` looking for a style-level `<w:numPr>`
    (e.g. the built-in `List Number` style). Style names alone are never
    consulted — only persisted OOXML evidence counts. Cycle-safe.
    """
    seen = set()
    try:
        current = paragraph_obj.style if paragraph_obj is not None else None
    except Exception:
        return False
    while current is not None and getattr(current, "style_id", None) not in seen:
        seen.add(getattr(current, "style_id", None))
        try:
            pPr = current.element.pPr
        except Exception:
            break
        if pPr is not None and pPr.find(qn("w:numPr")) is not None:
            return True
        try:
            current = current.base_style
        except Exception:
            break
    return False


def _document_default_indents(paragraph_obj: Any):
    """Effective indentation declared in `w:docDefaults/w:pPrDefault`.

    Returns `(left, first, ok)`. A value here is a real document-wide
    default: it applies to every paragraph that does not state its own
    indentation, so it is reported as `document_default`, never collapsed
    to zero. Absent (the common case) means the document states no default
    and the caller falls through to Word's built-in effective default.
    `ok` is False only when the styles part genuinely cannot be read.
    """
    try:
        part = paragraph_obj.part
    except Exception:
        return None, None, False
    try:
        styles = None
        for rel in part.rels.values():
            if not rel.is_external and rel.reltype.endswith("/styles"):
                styles = rel.target_part.element
                break
        if styles is None:
            return None, None, True
        doc_defaults = styles.find(qn("w:docDefaults"))
        pPr_default = doc_defaults.find(qn("w:pPrDefault")) if doc_defaults is not None else None
        pPr = pPr_default.find(qn("w:pPr")) if pPr_default is not None else None
        ind = pPr.find(qn("w:ind")) if pPr is not None else None
        if ind is None:
            return None, None, True
        left = _twips_to_inches(ind.get(qn("w:left")))
        first = None
        first_attr = ind.get(qn("w:firstLine"))
        hanging_attr = ind.get(qn("w:hanging"))
        if first_attr is not None:
            first = _twips_to_inches(first_attr)
        elif hanging_attr is not None:
            # Word writes a default hanging indent as w:hanging on
            # w:pPrDefault/w:pPr just as it does on a paragraph.
            first = -_twips_to_inches(hanging_attr)
        return left, first, True
    except Exception:
        return None, None, False


def resolve_indentation(
    paragraph_obj: Any,
    is_numbered: Optional[bool] = None,
) -> IndentationEvidence:
    """Resolve effective indentation evidence for one python-docx paragraph.

    How Word represents a hanging indent
    ------------------------------------
    OOXML stores paragraph indentation on ``<w:ind>`` with independent
    attributes: ``w:left`` (paragraph left indent), ``w:firstLine`` and
    ``w:hanging`` (mutually exclusive). A hanging indent of N means "first
    line N further left than the following lines", which python-docx
    surfaces as ``left_indent = N`` and ``first_line_indent = -N``. A
    positive first line is a first-line indent, never a hanging indent.

    Source precedence (nearest wins):
        direct → paragraph_style → style_chain
        → document_default (w:docDefaults/w:pPrDefault, when declared)
        → effective_default (Word's built-in zero)
    Numbering: when a paragraph carries ``w:numPr`` — directly on its own
    ``<w:pPr>`` or inherited through its style chain — and states no
    indentation of its own, its effective indent comes from the list
    definition, which this module does not read. It is reported as
    ``numbering`` with no asserted value so a later rule declines to
    judge it rather than claim a false mismatch.

    When absent values safely resolve to zero
    -------------------------------------------
    Verified against generated OOXML: a paragraph that states no
    ``<w:ind>`` at any level (direct, style chain, document defaults)
    renders flush at the left margin in Word — the un-numbered paragraph
    default for every indentation half is 0 twips. That is a rendering
    fact, not a formatting declaration, so it is reported as
    ``effective_default`` with 0.0 values: the rule may compare against a
    required indent and report a truthful "0 in" current value, but the
    source is never labelled ``direct``.

    The same rendering fact resolves the first-line half ALONE: a
    non-numbered paragraph with no first-line/hanging declaration anywhere
    and no effective left indent (either unstated, or explicitly cleared as
    ``w:left="0"``) has its first line flush with the following lines, so
    its effective hanging indent is 0.0 in — again reported as
    ``effective_default``. A paragraph that does state a NON-ZERO left
    indent without any first-line declaration is left unstated instead: the
    document describes a plain indented block, and claiming a hanging indent
    for it would overstate what the evidence supports.

    When values remain unresolved
    ------------------------------
    Only numbered paragraphs with no stated indentation stay valueless
    (``numbering``), and a document whose styles part cannot be read
    stays ``unresolved`` — an unsupported source is never guessed at.
    """
    numbered = (
        _has_numbering(paragraph_obj) or style_chain_has_numbering(paragraph_obj)
        if is_numbered is None
        else bool(is_numbered)
    )

    # 1. Direct paragraph formatting.
    direct_left = direct_first = None
    try:
        fmt = paragraph_obj.paragraph_format
        direct_left = _to_inches(fmt.left_indent)
        direct_first = _to_inches(fmt.first_line_indent)
    except Exception:
        direct_left = direct_first = None
    # Direct values win over numbering: a paragraph that states both
    # indentation halves directly is judged on those values even when a
    # list definition also applies. Otherwise numbering may own an
    # unstated half and the evidence stays numbering-flagged.
    direct_complete = direct_left is not None and direct_first is not None

    left, first = direct_left, direct_first
    source = SOURCE_DIRECT
    style_source: Optional[str] = None

    # 2. + 3. Paragraph style, then its base-style chain. Each half is
    # resolved independently: a level that states only the left half (e.g.
    # the built-in `List Paragraph` style, which declares w:left="720" and
    # no first-line value) must not terminate the search for the first-line
    # half, or a hanging indent stated further up the chain is missed.
    if left is None or first is None:
        for depth, (style_left, style_first) in enumerate(
            _style_chain_indents(paragraph_obj)
        ):
            if left is None and style_left is not None:
                left = style_left
            if first is None and style_first is not None:
                first = style_first
            if left is not None or first is not None:
                if style_source is None:
                    # depth 0 is the paragraph's own style; anything deeper
                    # was inherited through a base style.
                    style_source = (
                        SOURCE_PARAGRAPH_STYLE if depth == 0 else SOURCE_STYLE_CHAIN
                    )
            if left is not None and first is not None:
                break
        if style_source is not None:
            source = style_source

    # 4. Numbering (conservative): no stated indent + w:numPr → the list
    # definition owns the value; this module does not read it.
    if left is None and first is None:
        if numbered:
            return IndentationEvidence(
                left_indent_in=None,
                first_line_indent_in=None,
                hanging_indent_in=None,
                source=SOURCE_NUMBERING,
                is_numbered=True,
            )

    # 5. Document-wide defaults declared in w:docDefaults, when present.
    # Consulted for whichever half is still unstated, so a document-default
    # hanging indent is honoured even when a style supplied only the left half.
    if left is None or first is None:
        doc_left, doc_first, ok = _document_default_indents(paragraph_obj)
        if not ok:
            # The styles part was unreadable: unsupported source, so the
            # unstated half stays valueless rather than guessed at.
            return IndentationEvidence(
                left_indent_in=None if left is None else left,
                first_line_indent_in=None if first is None else first,
                hanging_indent_in=None,
                source=SOURCE_UNRESOLVED,
                is_numbered=numbered and not direct_complete,
            )
        doc_applied = False
        if left is None and doc_left is not None:
            left = doc_left
            doc_applied = True
        if first is None and doc_first is not None:
            first = doc_first
            doc_applied = True
        if doc_applied:
            source = SOURCE_DOCUMENT_DEFAULT
        # 6. Word-compatible effective default: an un-numbered paragraph that
        # states no indentation ANYWHERE renders flush at the left margin, so
        # both halves are 0.0. This applies to the PAIR, not per-half: a left
        # indent stated without a first-line value is a plain left indent, NOT
        # a zero hanging indent, so it must not be overstated as one.
        if left is None and first is None:
            left, first = 0.0, 0.0
            source = SOURCE_EFFECTIVE_DEFAULT

    # 7. The first-line half is unstated at EVERY level and the paragraph
    # states no effective left indent. Word renders such a paragraph with
    # its first line flush against the following lines, so the effective
    # hanging indent is a truthful 0.0 in. Nothing in the document declares
    # that value — it is Word's own paragraph default — so the provenance
    # becomes the effective default (never "direct").
    #
    # A NON-ZERO left indent is deliberately left unstated: the paragraph is
    # a plain indented block whose hanging behaviour the document does not
    # describe, and asserting 0.0 there would overstate the evidence. The
    # same applies to numbered paragraphs, whose indentation is owned by the
    # list definition this module does not read.
    if first is None and not numbered and (
        left is None or abs(left) <= _ZERO_INDENT_IN
    ):
        first = 0.0
        source = SOURCE_EFFECTIVE_DEFAULT

    # Effective hanging indent, computed from the resolved first-line half:
    #   * first < 0  → a genuine hanging indent (w:hanging / w:firstLine="-N"),
    #     magnitude -first.
    #   * first > 0  → a positive FIRST-LINE indent. It is NOT a hanging
    #     indent, so hanging stays None — never report the positive value as
    #     a hanging (case G).
    #   * first == 0 → "no hanging". This is either an explicitly stated 0.0
    #     or a Word effective default (the fully bare paragraph, or a
    #     zero-left-only paragraph resolved in step 7), so it resolves to 0.0
    #     and a rule may compare it truthfully.
    # A left indent without a first-line value leaves first = None, so
    # hanging stays None too — the value is simply not stated, and we do not
    # overstate it (case H).
    hanging = None
    if first is not None:
        if first < 0:
            hanging = round(-first, 6)
        elif first > 0:
            hanging = None
        else:
            hanging = 0.0

    return IndentationEvidence(
        left_indent_in=left,
        first_line_indent_in=first,
        hanging_indent_in=hanging,
        source=source,
        is_numbered=numbered and not direct_complete,
    )

def resolve_paragraph_format(paragraph_obj: Any) -> ParagraphFormatEvidence:
    """Collect direct paragraph evidence plus effective font evidence.

    Font family and size are resolved through the existing
    `document_parser.resolve_effective_family` / `resolve_effective_size`
    helpers so this module never duplicates that precedence logic.
    """
    from app.services.document_parser import (
        resolve_effective_family,
        resolve_effective_size,
    )
    try:
        doc_part = paragraph_obj.part
        styles_element = doc_part.document.styles.element
    except Exception:
        styles_element = getattr(paragraph_obj, "_styles_element", None)

    try:
        fmt = paragraph_obj.paragraph_format
        alignment = paragraph_obj.alignment
        line_spacing = fmt.line_spacing
        space_before = fmt.space_before
        space_after = fmt.space_after
    except Exception:
        alignment = line_spacing = space_before = space_after = None

    # Direct-only properties: python-docx resolves no style inheritance here,
    # so a missing value stays None and says why.
    alignment_source = SOURCE_DIRECT if alignment is not None else SOURCE_UNRESOLVED
    line_spacing_source = (
        SOURCE_DIRECT if line_spacing is not None else SOURCE_UNRESOLVED
    )
    space_before_source = (
        SOURCE_DIRECT if space_before is not None else SOURCE_UNRESOLVED
    )
    space_after_source = (
        SOURCE_DIRECT if space_after is not None else SOURCE_UNRESOLVED
    )

    families: Dict[str, int] = {}
    sizes: Dict[str, int] = {}
    if styles_element is not None:
        for run in getattr(paragraph_obj, "runs", ()):
            try:
                size, size_source = resolve_effective_size(run, paragraph_obj, styles_element)
                family, family_source = resolve_effective_family(
                    run, paragraph_obj, styles_element
                )
            except Exception:
                continue
            if family is not None:
                families[family] = families.get(family, 0) + 1
            if size is not None:
                sizes[size] = sizes.get(size, 0) + 1

    effective_family = next(iter(families), None)
    effective_size = next(iter(sizes), None)

    return ParagraphFormatEvidence(
        alignment=alignment,
        alignment_source=alignment_source,
        line_spacing=line_spacing,
        line_spacing_source=line_spacing_source,
        space_before_pt=space_before.pt if space_before is not None else None,
        space_before_source=space_before_source,
        space_after_pt=space_after.pt if space_after is not None else None,
        space_after_source=space_after_source,
        effective_font_family=effective_family,
        font_family_source=(
            SOURCE_UNRESOLVED if effective_family is None else "resolved"
        ),
        effective_font_size_pt=effective_size,
        font_size_source=(
            SOURCE_UNRESOLVED if effective_size is None else "resolved"
        ),
        has_mixed_font_family=len(families) > 1,
        has_mixed_font_size=len(sizes) > 1,
    )


# Alignment vocabulary shared with the profile schema. Any other OOXML
# alignment token (THAI_DISTRIBUTE, JUSTIFY_HI, ...) is left unresolved
# rather than guessed at — an unresolved value emits no finding.
_ALIASMENT_TOKENS = {
    "LEFT": "left",
    "CENTER": "center",
    "RIGHT": "right",
    "JUSTIFY": "justify",
    "DISTRIBUTE": "justify",
    "THAI_JUSTIFY": "justify",
    "JUSTIFY_MED": "justify",
    "JUSTIFY_HI": "justify",
    "JUSTIFY_LOW": "justify",
}


def _alignment_token(value: Any) -> Optional[str]:
    """Normalize a python-docx alignment enum (or string) to our vocabulary."""
    if value is None:
        return None
    name = getattr(value, "name", None) or str(value)
    name = str(name).strip().upper()
    if name.startswith("WD_ALIGN_PARAGRAPH."):
        name = name.split(".", 1)[1]
    return _ALIASMENT_TOKENS.get(name)


@dataclass(frozen=True)
class AlignmentEvidence:
    """Effective paragraph alignment with provenance.

    `alignment` is one of left/center/right/justify, or None when nothing
    resolves — never a default. An absent value is NOT "left".
    """

    alignment: Optional[str]
    source: str

    @property
    def is_resolved(self) -> bool:
        return self.alignment is not None


def resolve_alignment(paragraph_obj: Any) -> AlignmentEvidence:
    """Effective alignment: direct → paragraph style → style chain.

    Nearest-first, the same precedence the indentation resolver walks. When
    no level defines an alignment the result stays unresolved, because an
    absent value must never be reported as a mismatch against a profile
    requirement.
    """
    try:
        token = _alignment_token(paragraph_obj.paragraph_format.alignment)
    except Exception:
        token = None
    if token is not None:
        return AlignmentEvidence(alignment=token, source=SOURCE_DIRECT)

    try:
        style = paragraph_obj.style
    except Exception:
        return AlignmentEvidence(alignment=None, source=SOURCE_UNRESOLVED)
    seen = set()
    depth = 0
    while style is not None and id(style) not in seen:
        seen.add(id(style))
        try:
            token = _alignment_token(style.paragraph_format.alignment)
        except Exception:
            return AlignmentEvidence(alignment=None, source=SOURCE_UNRESOLVED)
        if token is not None:
            return AlignmentEvidence(
                alignment=token,
                source=SOURCE_PARAGRAPH_STYLE if depth == 0 else SOURCE_STYLE_CHAIN,
            )
        style = getattr(style, "base_style", None)
        depth += 1
    return AlignmentEvidence(alignment=None, source=SOURCE_UNRESOLVED)


@dataclass(frozen=True)
class BoldEvidence:
    """Effective bold state of a paragraph's visible text.

    `effective_bold` is a definite True/False only when EVERY visible run
    agrees and each one resolved. `has_mixed` marks genuine disagreement;
    `None` with `has_mixed=False` means unresolved. A paragraph whose runs
    simply carry no bold value is never reported as "not bold" when an
    inherited value may still apply.
    """

    effective_bold: Optional[bool]
    source: str
    has_mixed: bool

    @property
    def is_resolved(self) -> bool:
        return self.effective_bold is not None


def _run_bold(run: Any) -> Optional[bool]:
    """Effective bold for one run: direct → character style → run style."""
    try:
        value = run.font.bold
    except Exception:
        value = None
    if value is not None:
        return bool(value)
    try:
        style = run.style
    except Exception:
        return None
    seen = set()
    while style is not None and id(style) not in seen:
        seen.add(id(style))
        try:
            value = style.font.bold
        except Exception:
            return None
        if value is not None:
            return bool(value)
        style = getattr(style, "base_style", None)
    return None


def _paragraph_style_bold(paragraph_obj: Any) -> Optional[bool]:
    """Bold declared by the paragraph's own style chain."""
    try:
        style = paragraph_obj.style
    except Exception:
        return None
    seen = set()
    while style is not None and id(style) not in seen:
        seen.add(id(style))
        try:
            value = style.font.bold
        except Exception:
            return None
        if value is not None:
            return bool(value)
        style = getattr(style, "base_style", None)
    return None


def resolve_bold(paragraph_obj: Any) -> BoldEvidence:
    """Effective bold evidence for a paragraph's visible runs.

    Each visible run resolves independently (direct → character style);
    a run that resolves nothing inherits the paragraph style chain. Only a
    unanimous, fully resolved result is definite.
    """
    inherited = _paragraph_style_bold(paragraph_obj)
    values: Dict[bool, int] = {}
    for run in getattr(paragraph_obj, "runs", ()):
        try:
            if not (run.text or "").strip():
                continue
        except Exception:
            continue
        value = _run_bold(run)
        if value is None:
            value = inherited
        if value is None:
            continue
        values[value] = values.get(value, 0) + 1
    if not values:
        return BoldEvidence(effective_bold=None, source=SOURCE_UNRESOLVED, has_mixed=False)
    if len(values) > 1:
        return BoldEvidence(effective_bold=None, source=SOURCE_UNRESOLVED, has_mixed=True)
    only = next(iter(values))
    return BoldEvidence(
        effective_bold=only,
        source=SOURCE_DIRECT if inherited != only else SOURCE_STYLE_CHAIN,
        has_mixed=False,
    )
