"""Deterministic citation ↔ Reference List matching (citation reference build).

Pure functions only: no I/O, no AI, no fuzzy matching, no similarity
thresholds. Every comparison is exact tuple equality over normalized keys:

    author_key = NFC(surname) with curly apostrophes straightened, casefolded
    author_key = full NFC institutional phrase (same normalization) for
                 institutional entries — never a final-token alias
    year_key   = 4-digit year, or "n.d."
    suffix     = single lowercase a-z or ""
    base_key   = (author_key, year_key)
    full_key   = (author_key, year_key, suffix)

Contract:
  - Initials NEVER participate in matching (a key carries a surname only);
  - `&` and `and` are equivalent only as author-chain separators;
  - hyphenated names are never split; internal `-` and `'` are kept;
  - `2024a` ≠ `2024` ≠ `2024b`;
  - an entry is keyable only when it starts with a surname followed by `,`
    or `.` and carries a `(YYYY[x]|n.d.)` token in its first 200 characters;
    institutional entries key on a bounded 2–6 token author phrase with a
    generic organization noun instead (never a final-token alias);
  - unkeyable entries produce no findings in either direction;
  - DOI/URL text never becomes a matching key and never blocks entry keying;
  - ambiguity is reported as severity REVIEW (never scored), never guessed.

Findings emitted (one per key / per group, consolidated):
  CITATION_MISMATCH              MAJOR   author absent from every keyable entry
  CITATION_REFERENCE_MISMATCH    MAJOR   author present, year differs
  CITATION_YEAR_SUFFIX_MISMATCH  MINOR   year matches, suffix differs
  CITATION_REFERENCE_AMBIGUOUS   REVIEW  ≥2 entries for the author, no exact
  REFERENCE_NOT_CITED            MINOR   keyable entry with no matching citation
  REFERENCE_DUPLICATE            MINOR   ≥2 entries share a full_key

The deterministic engine owns these codes end-to-end; none of them may be
sent to an AI provider, and none may be auto-fixed.
"""
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from app.services.layout_violation import LayoutViolation


# ---------------------------------------------------------------------------
# Rule codes, severities, literals
# ---------------------------------------------------------------------------

RULE_CITATION_MISMATCH = "CITATION_MISMATCH"
RULE_CITATION_REFERENCE_MISMATCH = "CITATION_REFERENCE_MISMATCH"
RULE_CITATION_YEAR_SUFFIX_MISMATCH = "CITATION_YEAR_SUFFIX_MISMATCH"
RULE_CITATION_REFERENCE_AMBIGUOUS = "CITATION_REFERENCE_AMBIGUOUS"
RULE_REFERENCE_NOT_CITED = "REFERENCE_NOT_CITED"
RULE_REFERENCE_DUPLICATE = "REFERENCE_DUPLICATE"

# Manual-review severity: ignored by scoring (contributes no deduction and no
# major/minor count) but rendered by the UI/PDF as "Manual review".
SEVERITY_REVIEW = "REVIEW"

# Evidence previews stay bounded — full Reference List text is never carried
# into a finding (and therefore never persisted or logged).
MAX_EVIDENCE_CHARS = 120

# Maximum paragraph indexes listed on a consolidated finding.
MAX_LOCATION_INDEXES = 10

# Surname token: capitalized letter first, then letters/apostrophe/hyphen.
# Lowercase name particles (van der Berg) are deliberately OUT of scope.
_SURNAME_RE = re.compile(r"[A-Z][A-Za-zÀ-ſ'\-]+")

# A keyable entry starts with a surname followed by a comma or a period
# ("Smith, J." / "SMITH, J." / "Smith."), optionally after list numbering or
# a bullet ("1. Smith, J." / "- Smith, J.").
_ENTRY_PREFIX_RE = re.compile(r"^(?:\d+(?:\.\d+)*\.?\s+|[•\-*]\s+)")
_ENTRY_HEAD_RE = re.compile(r"^([A-Z][A-Za-zÀ-ſ'\-]+)\s*[,.]")

# Institutional author form (additive — the personal path above always runs
# first and is unchanged). A bounded multi-token author phrase before the
# year: 2–6 tokens, no personal comma/initial structure, no digits, no
# sentence punctuation, at least one generic organization noun. Never matches
# single tokens (those keep existing behavior) and never absorbs leading
# articles (title-like text stays unkeyable).
_INSTITUTION_KEYWORDS = frozenset({
    "association", "associations", "board", "bureau", "committee",
    "council", "department", "agencies", "agency", "authority",
    "foundation", "institute", "institution", "ministry", "office",
    "organisation", "organisations", "organization", "organizations",
    "society",
})
_INSTITUTION_CONNECTORS = frozenset({"and", "&", "of", "for", "the"})
_INSTITUTION_ARTICLES = frozenset({"a", "an", "the"})
_INSTITUTION_MIN_TOKENS = 2
_INSTITUTION_MAX_TOKENS = 6
_INSTITUTION_TOKEN_RE = re.compile(r"[A-Z][A-Za-zÀ-ſ'\-]*$")

# Year token: a parenthesized 4-digit year with optional suffix letter, or n.d.
_ENTRY_YEAR_RE = re.compile(r"\((\d{4}[a-z]?|n\.d\.)\)", re.IGNORECASE)
_ENTRY_YEAR_WINDOW = 200

_YEAR_RE = re.compile(r"(\d{4})([a-z])?")
_NO_DATE_TOKENS = frozenset({"n.d.", "n.d", "nd"})


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

def normalise_surname(surname: str) -> str:
    """NFC + case-fold a surname; trailing separators are stripped.

    Internal hyphens/apostrophes are preserved and hyphenated names are never
    split. Curly apostrophes are straightened so `O’Brien` == `O'Brien`.
    """
    text = unicodedata.normalize("NFC", surname or "")
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    text = text.strip().rstrip(",.;").strip()
    return text.casefold()


def split_year_token(token: str) -> Tuple[str, str]:
    """Split a year token into (year_key, suffix).

    "2024" -> ("2024", ""), "2024a" -> ("2024", "a"), "n.d." -> ("n.d.", "").
    An unrecognized token is returned case-folded with the year part empty —
    callers treat that as unkeyable.
    """
    raw = unicodedata.normalize("NFC", (token or "").strip().casefold())
    raw = raw.strip("().,;")
    if raw in _NO_DATE_TOKENS:
        return "n.d.", ""
    match = _YEAR_RE.fullmatch(raw)
    if match:
        return match.group(1), match.group(2) or ""
    return raw, ""


@dataclass(frozen=True)
class CitationKey:
    """Normalized citation/reference key. Initials never take part."""
    author_key: str
    year_key: str
    suffix: str = ""

    @property
    def base_key(self) -> Tuple[str, str]:
        return (self.author_key, self.year_key)

    @property
    def full_key(self) -> Tuple[str, str, str]:
        return (self.author_key, self.year_key, self.suffix)

    @property
    def year_display(self) -> str:
        """Year as it is shown to the user ("2024a", "2024", "n.d.")."""
        if self.year_key == "n.d.":
            return "n.d."
        return f"{self.year_key}{self.suffix}"


def make_key(author: str, year_token: str) -> CitationKey:
    """Build a normalized key from a surname (or author chain) + year token."""
    year_key, suffix = split_year_token(year_token)
    return CitationKey(
        author_key=normalise_surname(author),
        year_key=year_key,
        suffix=suffix,
    )


def normalise_institutional_author(phrase: str) -> str:
    """NFC + case-fold a full institutional author phrase.

    Whitespace is collapsed to single spaces and trailing separators are
    stripped. Internal structure (connectors, hyphens, apostrophes) is
    preserved so the phrase key can never collide with a single-token
    personal surname key.
    """
    text = unicodedata.normalize("NFC", phrase or "")
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    text = " ".join(text.strip().rstrip(",.;").split())
    return text.casefold()


def has_institution_keyword(phrase: str) -> bool:
    """True when a phrase contains a generic organization noun.

    Whole-token, case-insensitive match against the same keyword set the
    Reference classifier uses — substrings never count ("keyboard" is not
    "board"). Shared single owner for both sides of the contract.
    """
    return any(tok.casefold() in _INSTITUTION_KEYWORDS for tok in (phrase or "").split())


def parse_institutional_author(head: str) -> Optional[str]:
    """Return the full institutional author phrase, or None.

    `head` is entry text with numbering/bullet prefix already stripped.
    Conservative by construction: personal comma/initial structure is
    rejected (the personal path owns it), single tokens are rejected
    (existing behavior owns them), leading articles are rejected
    (title-like text stays unkeyable), and at least one generic
    organization noun is required. Returns the phrase as written.
    """
    # Candidate head: up to the first period or open paren (the author
    # phase of the entry, before the year).
    m = re.match(r"^([^().;!?]+?)\s*(\.|[(])", head)
    if not m:
        return None
    phrase = m.group(1).strip()
    if "," in phrase:
        return None
    if re.search(r"\d", phrase):
        return None
    tokens = phrase.split()
    if not (_INSTITUTION_MIN_TOKENS <= len(tokens) <= _INSTITUTION_MAX_TOKENS):
        return None
    if tokens[0].casefold() in _INSTITUTION_ARTICLES:
        return None
    if not _INSTITUTION_TOKEN_RE.match(tokens[0]):
        return None
    if not _INSTITUTION_TOKEN_RE.match(tokens[-1]):
        return None
    lowered = [t.casefold() for t in tokens]
    for i, tok in enumerate(tokens):
        if _INSTITUTION_TOKEN_RE.match(tok):
            continue
        # Lowercase interior tokens are allowed only as flanked connectors.
        if tok not in _INSTITUTION_CONNECTORS:
            return None
        if i == 0 or i == len(tokens) - 1:
            return None
        if not _INSTITUTION_TOKEN_RE.match(tokens[i - 1]):
            return None
        if not _INSTITUTION_TOKEN_RE.match(tokens[i + 1]):
            return None
    if not any(t in _INSTITUTION_KEYWORDS for t in lowered):
        return None
    return phrase


# ---------------------------------------------------------------------------
# In-text citation records (produced by the scanner)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CitationRef:
    """One detected in-text citation item.

    `author_display` is what the user sees: the full chain for narrative
    citations ("Taylor & Green"), the primary surname for parenthetical ones.
    `snippet` is the exact source span — never rewritten.
    `context` is the bounded paragraph slice immediately before the detected
    author chain (no sentence-boundary crossing); `institutional_phrase` is
    the candidate institutional interpretation, empty when none applies.
    Both default empty so previously constructed citations behave identically.
    """
    author_display: str
    key: CitationKey
    paragraph_index: Optional[int]
    snippet: str
    context: str = ""
    institutional_phrase: str = ""


# ---------------------------------------------------------------------------
# Reference entries + index
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ReferenceEntry:
    """One keyable Reference List entry."""
    key: CitationKey
    author_display: str
    year_display: str
    paragraph_index: Optional[int]
    text: str

    @property
    def label(self) -> str:
        return f"{self.author_display} ({self.year_display})"


@dataclass
class ReferenceIndex:
    """Reference entries grouped for deterministic lookups."""
    entries: List[ReferenceEntry] = field(default_factory=list)
    by_author: Dict[str, List[ReferenceEntry]] = field(default_factory=dict)
    by_full_key: Dict[Tuple[str, str, str], List[ReferenceEntry]] = field(default_factory=dict)

    def author_entries(self, author_key: str) -> List[ReferenceEntry]:
        return self.by_author.get(author_key, [])

    def has_full_key(self, full_key: Tuple[str, str, str]) -> bool:
        return full_key in self.by_full_key

    def distinct_years(self, author_key: str) -> Set[str]:
        return {e.key.year_key for e in self.by_author.get(author_key, [])}


def parse_reference_entry(
    text: str,
    paragraph_index: Optional[int] = None,
) -> Optional[ReferenceEntry]:
    """Parse one Reference List paragraph into a keyable entry, or None.

    Keyable requires BOTH:
      - the first token (after optional numbering/bullet) is a capitalized
        surname immediately followed by `,` or `.`;
      - a `(YYYY[x]|n.d.)` token appears within the first 200 characters.

    Everything after the leading surname is ignored for matching: initials,
    editors, year position, publisher, DOI/URL text.
    """
    raw = (text or "").strip()
    if not raw:
        return None

    head = _ENTRY_PREFIX_RE.sub("", raw, count=1)
    head_match = _ENTRY_HEAD_RE.match(head)
    if head_match:
        author_display = head_match.group(1)
        window = raw[:_ENTRY_YEAR_WINDOW]
        year_match = _ENTRY_YEAR_RE.search(window)
        if not year_match:
            return None
        year_token = year_match.group(1)
        year_key, suffix = split_year_token(year_token)

        return ReferenceEntry(
            key=CitationKey(normalise_surname(author_display), year_key, suffix),
            author_display=author_display,
            year_display=year_key if year_key == "n.d." else f"{year_key}{suffix}",
            paragraph_index=paragraph_index,
            text=raw,
        )

    # Institutional author form (additive): a bounded multi-token phrase
    # such as "Institutional Standards Board". The complete normalized
    # phrase becomes the author key — never a final-token alias — so it
    # cannot collide with a personal surname key.
    institution = parse_institutional_author(head)
    if institution is None:
        return None
    window = raw[:_ENTRY_YEAR_WINDOW]
    year_match = _ENTRY_YEAR_RE.search(window)
    if not year_match:
        return None
    year_token = year_match.group(1)
    year_key, suffix = split_year_token(year_token)

    return ReferenceEntry(
        key=CitationKey(normalise_institutional_author(institution), year_key, suffix),
        author_display=institution,
        year_display=year_key if year_key == "n.d." else f"{year_key}{suffix}",
        paragraph_index=paragraph_index,
        text=raw,
    )


def build_reference_index(
    entries: Iterable[Tuple[Optional[int], str]],
) -> ReferenceIndex:
    """Build the index from (paragraph_index, text) pairs in document order.

    Unkeyable paragraphs are skipped entirely — they can neither resolve a
    citation nor be reported as uncited/duplicate.
    """
    index = ReferenceIndex()
    for paragraph_index, text in entries:
        entry = parse_reference_entry(text, paragraph_index)
        if entry is None:
            continue
        index.entries.append(entry)
        index.by_author.setdefault(entry.key.author_key, []).append(entry)
        index.by_full_key.setdefault(entry.key.full_key, []).append(entry)
    return index


# ---------------------------------------------------------------------------
# Profile controls
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CitationMatchingRules:
    """Profile-side toggles for the deterministic matching rules.

    Severity is fixed per rule and never configurable. The dependent toggles
    are already normalized off by the snapshot resolver when the parent check
    is disabled; `from_config` mirrors that normalization for callers passing
    a config directly.
    """
    check_citations_have_references: bool = True
    check_references_are_cited: bool = False
    check_author_year_consistency: bool = True
    check_year_suffixes: bool = True
    check_duplicate_references: bool = True
    flag_ambiguous_matches: bool = True
    allow_personal_communication: bool = True

    @classmethod
    def from_config(cls, config: Any) -> "CitationMatchingRules":
        """Read the toggles off a rule config; absent attributes = defaults.

        Accepts EffectiveProfileConfig (CITATION_* attributes) and tolerates
        legacy configs that predate the group.
        """
        if config is None:
            return cls()
        get = lambda name, default: bool(getattr(config, name, default))  # noqa: E731
        parent = get("CITATION_CHECK_CITATIONS_HAVE_REFERENCES", True)
        return cls(
            check_citations_have_references=parent,
            check_references_are_cited=get("CITATION_CHECK_REFERENCES_ARE_CITED", False),
            check_author_year_consistency=(
                get("CITATION_CHECK_AUTHOR_YEAR_CONSISTENCY", True) and parent
            ),
            check_year_suffixes=get("CITATION_CHECK_YEAR_SUFFIXES", True) and parent,
            check_duplicate_references=get("CITATION_CHECK_DUPLICATE_REFERENCES", True),
            flag_ambiguous_matches=get("CITATION_FLAG_AMBIGUOUS_MATCHES", True),
            allow_personal_communication=get(
                "CITATION_ALLOW_PERSONAL_COMMUNICATION", True
            ),
        )


# ---------------------------------------------------------------------------
# Finding builders
# ---------------------------------------------------------------------------

def _location(first: CitationRef, group: Sequence[CitationRef]) -> Dict[str, Any]:
    indexes = sorted({c.paragraph_index for c in group if c.paragraph_index is not None})
    return {
        "paragraph_index": first.paragraph_index,
        "occurrences": len(group),
        "paragraph_indexes": indexes[:MAX_LOCATION_INDEXES],
    }


def _citation_finding(
    rule_code: str,
    severity: str,
    message: str,
    expected_value: str,
    actual_value: str,
    location: Dict[str, Any],
) -> LayoutViolation:
    return LayoutViolation(
        rule_code=rule_code,
        severity=severity,
        location=location,
        message=message,
        expected_value=expected_value,
        actual_value=actual_value,
    )

@dataclass
class CitedWorkKeys:
    """Work-level cited state derived from SUPPORTED citations only.

    `exact_full_keys` — works a suffix-bearing citation pointed at.
    `uniquely_resolved_base_keys` — author+year pairs where exactly one
    compatible Reference List entry exists, so an unsuffixed citation
    identifies that work.
    `undecided_candidates` — works an ambiguous unsuffixed citation could
    have referred to. They are neither cited nor definitely uncited.
    """

    exact_full_keys: Set[Tuple[str, str, str]] = field(default_factory=set)
    uniquely_resolved_base_keys: Set[Tuple[str, str]] = field(default_factory=set)
    undecided_candidates: Set[Tuple[str, str, str]] = field(default_factory=set)


def resolve_cited_work_keys(
    citations: Sequence[CitationRef],
    index: ReferenceIndex,
) -> CitedWorkKeys:
    """Resolve which individual Reference List WORKS are cited.

    Deliberately work-level: one cited work never marks the author's other
    works as cited. Rules, in order per supported citation:

      A. A citation with a year suffix identifies only the exact work
         (`Smith 2024 a`); every other work by that author stays uncited.
      B. An unsuffixed citation with exactly one compatible entry (same
         author + year) identifies that work.
      C. An unsuffixed citation with several compatible entries cannot
         identify one: the candidates become UNDECIDED, never "cited".
      D-F. Year and `n.d.` are part of the work key, so a dated citation
         never covers an `n.d.` entry and vice versa.

    Unsupported occurrences (personal communication, secondary citations,
    out-of-grammar forms) are absent from `citations` and therefore add no
    work key here. No fuzzy comparison is involved: keys are exact tuples.
    """
    keys = CitedWorkKeys()
    for cite in citations:
        key = cite.key
        if key.suffix:
            if index.has_full_key(key.full_key):
                keys.exact_full_keys.add(key.full_key)
            continue
        compatible = [
            entry for entry in index.author_entries(key.author_key)
            if entry.key.year_key == key.year_key
        ]
        if len(compatible) == 1:
            keys.uniquely_resolved_base_keys.add(key.base_key)
        elif len(compatible) > 1:
            for entry in compatible:
                keys.undecided_candidates.add(entry.key.full_key)
    return keys

# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def match(
    citations: Sequence[CitationRef],
    index: ReferenceIndex,
    rules: Optional[CitationMatchingRules] = None,
) -> List[LayoutViolation]:
    """Compare citations against the Reference List in both directions.

    `citations` are SUPPORTED occurrences only: the scanner has already
    excluded unsupported ones (personal communication, secondary "as cited in"
    citations) per occurrence. There is no author-wide or document-wide
    exemption set anywhere in this pipeline, so an unrelated entry by an
    author named in unsupported material is still reported as uncited.

    Direction 1 precedence per citation key: exact match → nothing; ≥2 entries
    for the author and no exact match → REVIEW (ambiguous); a single entry with
    a different year → MAJOR year mismatch; a matching year with a different
    suffix → MINOR suffix mismatch; no entry for the author → MAJOR mismatch.
    A disabled rule emits nothing and never falls through to another code.

    Direction 2 decides each entry's cited state at WORK level (author + year
    + suffix), never at author level: see `resolve_cited_work_keys`.
    """
    rules = rules or CitationMatchingRules()
    violations: List[LayoutViolation] = []

    # Work-level cited state. No author-wide "cited" set exists here: one
    # cited work never marks the author's other works as cited.
    cited_works = resolve_cited_work_keys(citations, index)

    # ---- Direction 1: in-text citations → Reference List entries ----------
    groups: Dict[Tuple[str, str, str], List[CitationRef]] = {}
    for cite in citations:
        groups.setdefault(cite.key.full_key, []).append(cite)

    for group in groups.values():
        first = group[0]
        author = first.author_display
        year = first.key.year_display
        entry_matches = index.author_entries(first.key.author_key)
        location = _location(first, group)

        # Exact key match: nothing to report.
        if any(e.key.full_key == first.key.full_key for e in entry_matches):
            continue
        # Parent check disabled: the citation side never reports.
        if not rules.check_citations_have_references:
            continue

        if not entry_matches:
            violations.append(_citation_finding(
                RULE_CITATION_MISMATCH,
                "MAJOR",
                (
                    f"Citation '{author} ({year})' was found in text, "
                    f"but no matching entry was found in the References bibliography."
                ),
                f"Reference entry for {author}",
                first.snippet[:MAX_EVIDENCE_CHARS],
                location,
            ))
            continue

        if len(entry_matches) >= 2:
            if rules.flag_ambiguous_matches:
                violations.append(_citation_finding(
                    RULE_CITATION_REFERENCE_AMBIGUOUS,
                    SEVERITY_REVIEW,
                    (
                        f"Citation '{author} ({year})' could match {len(entry_matches)} "
                        f"Reference List entries for {author}; the citation carries no "
                        f"initials, so the intended source must be confirmed manually."
                    ),
                    "One unambiguous matching entry",
                    first.snippet[:MAX_EVIDENCE_CHARS],
                    location,
                ))
            continue

        entry = entry_matches[0]
        if entry.key.year_key != first.key.year_key:
            if rules.check_author_year_consistency:
                violations.append(_citation_finding(
                    RULE_CITATION_REFERENCE_MISMATCH,
                    "MAJOR",
                    (
                        f"Citation '{author} ({year})' and the Reference List entry for "
                        f"{author} ({entry.year_display}) state different years."
                    ),
                    f"Consistent year for {author} ({entry.year_display})",
                    first.snippet[:MAX_EVIDENCE_CHARS],
                    location,
                ))
            continue

        # Same author and year, different (or missing) suffix letter.
        if rules.check_year_suffixes:
            violations.append(_citation_finding(
                RULE_CITATION_YEAR_SUFFIX_MISMATCH,
                "MINOR",
                (
                    f"Citation '{author} ({year})' is missing the year suffix used by "
                    f"the Reference List entry '{entry.label}'."
                ),
                f"{author} ({entry.year_display})",
                first.snippet[:MAX_EVIDENCE_CHARS],
                location,
            ))

    # ---- Direction 2: Reference List entries → citations ------------------
    #
    # Precedence against ambiguity (one consistent contract): when a supported
    # unsuffixed citation has several compatible candidates, direction 1 has
    # already emitted CITATION_REFERENCE_AMBIGUOUS (REVIEW) and the UI asks the
    # user to confirm the intended source. Those candidates are therefore
    # neither counted as cited nor claimed to be definitely uncited — emitting
    # both would contradict each other. The suppression is per candidate WORK,
    # never author-wide: an unrelated work by the same author is still
    # reported as uncited.
    if rules.check_references_are_cited:
        for group in index.by_full_key.values():
            entry = group[0]
            full_key = entry.key.full_key
            if full_key in cited_works.exact_full_keys:
                continue
            if entry.key.base_key in cited_works.uniquely_resolved_base_keys:
                continue
            if full_key in cited_works.undecided_candidates:
                continue
            violations.append(_citation_finding(
                RULE_REFERENCE_NOT_CITED,
                "MINOR",
                (
                    f"Reference List entry '{entry.label}' was not cited in the body "
                    f"text. Only in-text citations in the supported author–year forms "
                    f"are compared."
                ),
                "At least one in-text citation",
                entry.text[:MAX_EVIDENCE_CHARS],
                {"paragraph_index": entry.paragraph_index},
            ))

    # ---- Duplicate Reference List entries ---------------------------------
    if rules.check_duplicate_references:
        for group in index.by_full_key.values():
            if len(group) < 2:
                continue
            later = group[-1]
            violations.append(_citation_finding(
                RULE_REFERENCE_DUPLICATE,
                "MINOR",
                (
                    f"Reference List entry '{later.label}' appears {len(group)} times; "
                    f"a source must have exactly one entry."
                ),
                "One entry per source",
                later.text[:MAX_EVIDENCE_CHARS],
                {
                    "paragraph_index": later.paragraph_index,
                    "entry_count": len(group),
                    "paragraph_indexes": [
                        e.paragraph_index for e in group[:MAX_LOCATION_INDEXES]
                    ],
                },
            ))

    return violations
