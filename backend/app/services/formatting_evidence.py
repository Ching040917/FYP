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
    direct → paragraph_style → style_chain → numbering → unresolved

`numbering` is reported only when no explicit indent resolved AND the
paragraph carries `w:numPr`; the effective indentation then comes from the
list definition, which this module does not read. Such a paragraph is
flagged `is_numbered` so a later rule can decline to judge it rather than
report a false mismatch.
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
SOURCE_UNRESOLVED = "unresolved"

# python-docx Length values are EMU; 914400 EMU per inch.
_EMU_PER_INCH = 914400


def _to_inches(value: Optional[float]) -> Optional[float]:
    """Convert a python-docx Length (EMU) to a float number of inches."""
    if value is None:
        return None
    try:
        return round(float(value) / _EMU_PER_INCH, 6)
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
    not define that half".
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

    Note: this is the same direct check the existing `is_list_item` flag in
    document_parser performs. Numbering applied purely through a style is
    NOT detected by either — a known, pre-existing limitation that is
    preserved rather than silently changed here.
    """
    try:
        pPr = paragraph_obj._p.find(qn("w:pPr"))
    except Exception:
        return False
    return pPr is not None and pPr.find(qn("w:numPr")) is not None


def resolve_indentation(
    paragraph_obj: Any,
    is_numbered: Optional[bool] = None,
) -> IndentationEvidence:
    """Resolve effective indentation evidence for one python-docx paragraph.

    Precedence: direct → the paragraph's own style → the style chain.
    A paragraph with no explicit indent anywhere resolves to `unresolved`
    unless it is numbered, in which case the indentation comes from the
    list definition and is reported as `numbering` (never as a value this
    module can vouch for).
    """
    numbered = _has_numbering(paragraph_obj) if is_numbered is None else bool(is_numbered)

    direct_left = direct_first = None
    try:
        fmt = paragraph_obj.paragraph_format
        direct_left = _to_inches(fmt.left_indent)
        direct_first = _to_inches(fmt.first_line_indent)
    except Exception:
        direct_left = direct_first = None

    left, first, source = direct_left, direct_first, SOURCE_DIRECT
    if left is None and first is None:
        for depth, (style_left, style_first) in enumerate(
            _style_chain_indents(paragraph_obj)
        ):
            if style_left is None and style_first is None:
                continue
            left, first = style_left, style_first
            # depth 0 is the paragraph's own style; anything deeper was
            # inherited through a base style.
            source = SOURCE_PARAGRAPH_STYLE if depth == 0 else SOURCE_STYLE_CHAIN
            break

    # No explicit indent anywhere. A numbered paragraph takes its
    # indentation from the list definition, which this module does not read,
    # so it is reported as `numbering` with no asserted value rather than as
    # a mismatch a later rule could act on.
    if left is None and first is None:
        if numbered:
            return IndentationEvidence(
                left_indent_in=None,
                first_line_indent_in=None,
                hanging_indent_in=None,
                source=SOURCE_NUMBERING,
                is_numbered=True,
            )
        return IndentationEvidence(
            left_indent_in=None,
            first_line_indent_in=None,
            hanging_indent_in=None,
            source=SOURCE_UNRESOLVED,
            is_numbered=numbered,
        )

    # Verified against generated XML: w:hanging surfaces as a NEGATIVE
    # first_line_indent. A positive value is a first-line indent, not a
    # hanging indent, so it is never folded into the hanging value.
    hanging = None
    if first is not None and first < 0:
        hanging = round(-first, 6)

    return IndentationEvidence(
        left_indent_in=left,
        first_line_indent_in=first,
        hanging_indent_in=hanging,
        source=source,
        is_numbered=numbered,
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
