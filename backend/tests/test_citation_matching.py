"""Deterministic citation ↔ Reference List matching engine tests.

Covers: key normalization (Unicode, apostrophes, hyphens, trailing
punctuation), year/suffix splitting, entry keyability guards, the six-rule
matrix with its severity ladder, consolidation counts (occurrences /
paragraph_indexes / entry_count), direction-2 rules, REVIEW ambiguity
precedence, and the profile toggles (disabled rules emit nothing).
"""
import pytest

from app.services.citation_matching import (
    CitationMatchingRules,
    CitationRef,
    MAX_EVIDENCE_CHARS,
    RULE_CITATION_MISMATCH,
    RULE_CITATION_REFERENCE_AMBIGUOUS,
    RULE_CITATION_REFERENCE_MISMATCH,
    RULE_CITATION_YEAR_SUFFIX_MISMATCH,
    RULE_REFERENCE_DUPLICATE,
    RULE_REFERENCE_NOT_CITED,
    SEVERITY_REVIEW,
    build_reference_index,
    make_key,
    match,
    normalise_surname,
    parse_reference_entry,
    split_year_token,
)


def _cite(author, year, index=1, snippet=None):
    return CitationRef(
        author_display=author,
        key=make_key(author, year),
        paragraph_index=index,
        snippet=snippet if snippet is not None else f"{author} ({year})",
    )


def _index(*entries):
    return build_reference_index(entries)


def _by_code(violations):
    out = {}
    for v in violations:
        out.setdefault(v.rule_code, []).append(v)
    return out


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

def test_normalise_surname_unicode_and_case():
    assert normalise_surname("Müller") == normalise_surname("MÜLLER") == "müller"
    assert normalise_surname("Smith-Jones") == "smith-jones"
    assert normalise_surname("O’Brien") == normalise_surname("O'Brien") == "o'brien"


def test_normalise_surname_strips_trailing_separators_only():
    assert normalise_surname(" Smith. ") == "smith"
    assert normalise_surname("Smith,") == "smith"
    assert normalise_surname("Smith;") == "smith"


def test_hyphenated_names_are_never_split():
    assert make_key("Smith-Jones", "2020").author_key == "smith-jones"
    assert make_key("Smith-Jones", "2020").author_key != make_key("Smith", "2020").author_key


def test_split_year_token():
    assert split_year_token("2024") == ("2024", "")
    assert split_year_token("2024a") == ("2024", "a")
    assert split_year_token("n.d.") == ("n.d.", "")
    assert split_year_token("N.D.") == ("n.d.", "")


def test_year_suffix_is_part_of_the_key():
    plain = make_key("Smith", "2024")
    a = make_key("Smith", "2024a")
    b = make_key("Smith", "2024b")
    assert plain.full_key != a.full_key != b.full_key
    assert plain.base_key == a.base_key == b.base_key
    assert a.year_display == "2024a"
    assert plain.year_display == "2024"
    assert make_key("Smith", "n.d.").year_display == "n.d."


# ---------------------------------------------------------------------------
# Entry keyability guards
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "Smith, J. (2020). On things. Press.",
    "SMITH, J. (2020). On things. Press.",
    "1. Smith, J. (2020). On things. Press.",
    "6.1 Smith, J. (2020). On things. Press.",
    "- Smith, J. (2020). On things. Press.",
    "Smith, J. (2020a). On things. Press.",
    "Smith, J. (n.d.). On things. Press.",
    "Smith-Jones, A. (2020). On things. Press.",
    "O'Brien, P. (2019). On things. Press.",
    "Smith, J. (2020). Title. https://doi.org/10.1000/xyz",
])
def test_keyable_entries(text):
    entry = parse_reference_entry(text, paragraph_index=4)
    assert entry is not None
    assert entry.paragraph_index == 4


@pytest.mark.parametrize("text", [
    "",
    "   ",
    "University of Example (2020). Annual report.",
    "Smith J (2020). Missing separator after the surname.",
    "van der Berg, J. (2020). Lowercase particle — out of scope.",
    "(Smith, 2020) — citation, not an entry.",
    "References",
    "Table 1. Smith, J. (2020). Caption text.",
])
def test_unkeyable_entries(text):
    assert parse_reference_entry(text, paragraph_index=0) is None


def test_entry_year_must_appear_in_the_first_200_characters():
    late = "Smith, J. " + ("x" * 250) + " (2020). Press."
    assert parse_reference_entry(late) is None
    early = "Smith, J. (2020). " + ("x" * 250)
    assert parse_reference_entry(early) is not None


def test_entry_key_ignores_initials_and_titles():
    entry = parse_reference_entry("Smith, John Jacob (2020). Title. Press.", 2)
    assert entry.key.author_key == "smith"
    assert entry.key.year_key == "2020"
    assert entry.author_display == "Smith"
    assert entry.label == "Smith (2020)"


def test_index_skips_unkeyable_entries_and_groups_keys():
    index = _index(
        (1, "Smith, J. (2020). A."),
        (2, "University of Example (2020). B."),
        (3, "Smith, J. (2020). C."),
        (4, "Jones, A. (2019). D."),
    )
    assert [e.paragraph_index for e in index.entries] == [1, 3, 4]
    assert len(index.author_entries("smith")) == 2
    assert index.has_full_key(("smith", "2020", ""))
    assert index.distinct_years("smith") == {"2020"}
    assert not index.has_full_key(("university", "2020", ""))


# ---------------------------------------------------------------------------
# Rule matrix — direction 1 (citations → entries)
# ---------------------------------------------------------------------------

def test_exact_match_emits_nothing():
    viols = match(
        [_cite("Smith", "2020", 5)],
        _index((9, "Smith, J. (2020). Title. Press.")),
    )
    assert viols == []


def test_missing_author_is_major_citation_mismatch():
    viols = match(
        [_cite("Smith", "2020", 5, snippet="(Smith, 2020)")],
        _index((9, "Jones, A. (2019). Other. Press.")),
    )
    assert len(viols) == 1
    v = viols[0]
    assert v.rule_code == RULE_CITATION_MISMATCH
    assert v.severity == "MAJOR"
    assert v.expected_value == "Reference entry for Smith"
    assert v.actual_value == "(Smith, 2020)"
    assert v.message == (
        "Citation 'Smith (2020)' was found in text, but no matching entry was "
        "found in the References bibliography."
    )
    assert v.location["paragraph_index"] == 5


def test_year_mismatch_is_major_reference_mismatch():
    viols = match(
        [_cite("Smith", "2020", 5, snippet="(Smith, 2020)")],
        _index((9, "Smith, J. (2019). Title. Press.")),
    )
    assert len(viols) == 1
    v = viols[0]
    assert v.rule_code == RULE_CITATION_REFERENCE_MISMATCH
    assert v.severity == "MAJOR"
    assert v.expected_value == "Consistent year for Smith (2019)"
    assert v.actual_value == "(Smith, 2020)"
    assert "2019" in v.message and "2020" in v.message


def test_year_suffix_mismatch_is_minor():
    viols = match(
        [_cite("Smith", "2020", 5, snippet="(Smith, 2020)")],
        _index((9, "Smith, J. (2020a). Title. Press.")),
    )
    assert len(viols) == 1
    v = viols[0]
    assert v.rule_code == RULE_CITATION_YEAR_SUFFIX_MISMATCH
    assert v.severity == "MINOR"
    assert v.expected_value == "Smith (2020a)"
    assert v.actual_value == "(Smith, 2020)"


def test_suffix_mismatch_also_fires_when_citation_has_the_wrong_letter():
    viols = match(
        [_cite("Smith", "2020b", 7)],
        _index((9, "Smith, J. (2020a). Title. Press.")),
    )
    assert [v.rule_code for v in viols] == [RULE_CITATION_YEAR_SUFFIX_MISMATCH]
    assert viols[0].expected_value == "Smith (2020a)"


def test_ambiguous_author_without_exact_match_is_review():
    viols = match(
        [_cite("Smith", "2024", 5, snippet="(Smith, 2024)")],
        _index(
            (9, "Smith, A. (2020). First. Press."),
            (10, "Smith, B. (2019). Second. Press."),
        ),
    )
    assert len(viols) == 1
    v = viols[0]
    assert v.rule_code == RULE_CITATION_REFERENCE_AMBIGUOUS
    assert v.severity == "REVIEW"
    assert v.expected_value == "One unambiguous matching entry"
    assert v.location == {"paragraph_index": 5, "occurrences": 1, "paragraph_indexes": [5]}


def test_same_surname_same_year_entries_keep_exact_match_precedence():
    """Two entries differing only in initials share one key: the citation
    matches that key exactly, so the precedence rule (exact → nothing) wins
    and initials are never invented into the comparison. The two entries do
    share a key, so the duplicate-entry rule is what reports them."""
    viols = match(
        [_cite("Smith", "2024", 5)],
        _index(
            (9, "Smith, A. (2024). First. Press."),
            (10, "Smith, B. (2024). Second. Press."),
        ),
    )
    assert [v.rule_code for v in viols] == [RULE_REFERENCE_DUPLICATE]
    assert viols[0].severity == "MINOR"


def test_two_entries_with_different_suffixes_are_ambiguous_not_suffix():
    viols = match(
        [_cite("Smith", "2024", 5)],
        _index(
            (9, "Smith, A. (2024a). First. Press."),
            (10, "Smith, B. (2024b). Second. Press."),
        ),
    )
    assert [v.rule_code for v in viols] == [RULE_CITATION_REFERENCE_AMBIGUOUS]
    assert viols[0].severity == "REVIEW"


def test_ambiguous_flag_off_emits_nothing():
    rules = CitationMatchingRules(flag_ambiguous_matches=False)
    viols = match(
        [_cite("Smith", "2024", 5)],
        _index(
            (9, "Smith, A. (2020). First. Press."),
            (10, "Smith, B. (2019). Second. Press."),
        ),
        rules,
    )
    assert viols == []


def test_namedate_entry_versus_dated_citation_is_a_year_mismatch():
    viols = match(
        [_cite("Smith", "2020", 5)],
        _index((9, "Smith, J. (n.d.). Title. Press.")),
    )
    assert [v.rule_code for v in viols] == [RULE_CITATION_REFERENCE_MISMATCH]
    assert viols[0].expected_value == "Consistent year for Smith (n.d.)"


def test_namedate_citation_matching_namedate_entry_is_clean():
    viols = match(
        [_cite("Smith", "n.d.", 5)],
        _index((9, "Smith, J. (n.d.). Title. Press.")),
    )
    assert viols == []


# ---------------------------------------------------------------------------
# Consolidation
# ---------------------------------------------------------------------------

def test_repeated_missing_citation_consolidates_with_occurrences():
    viols = match(
        [
            _cite("Smith", "2020", 3, snippet="Smith (2020)"),
            _cite("Smith", "2020", 8, snippet="(Smith, 2020)"),
            _cite("Smith", "2020", 3, snippet="Smith (2020)"),
        ],
        _index((20, "Jones, A. (2019). Other. Press.")),
    )
    assert len(viols) == 1
    v = viols[0]
    assert v.location == {
        "paragraph_index": 3,
        "occurrences": 3,
        "paragraph_indexes": [3, 8],
    }
    # The first occurrence's exact span is the evidence.
    assert v.actual_value == "Smith (2020)"


def test_paragraph_indexes_are_capped_at_ten():
    cites = [_cite("Smith", "2020", idx) for idx in range(25)]
    viols = match(cites, _index((99, "Jones, A. (2019). Other. Press.")))
    assert len(viols[0].location["paragraph_indexes"]) == 10
    assert viols[0].location["occurrences"] == 25


def test_one_finding_per_unique_citation_key():
    viols = match(
        [_cite("Smith", "2020", 3), _cite("Smith", "2020a", 4)],
        _index((20, "Jones, A. (2019). Other. Press.")),
    )
    assert sorted(v.rule_code for v in viols) == [RULE_CITATION_MISMATCH] * 2
    assert {v.expected_value for v in viols} == {
        "Reference entry for Smith",
    }
    assert {v.location["paragraph_index"] for v in viols} == {3, 4}


def test_evidence_is_bounded():
    long_snippet = "Smith (2020) " + ("x" * 400)
    viols = match([_cite("Smith", "2020", 3, snippet=long_snippet)], _index())
    assert len(viols[0].actual_value) == MAX_EVIDENCE_CHARS


# ---------------------------------------------------------------------------
# Rule matrix — direction 2 (entries → citations)
# ---------------------------------------------------------------------------

def _cited_rules(**overrides):
    base = dict(check_references_are_cited=True)
    base.update(overrides)
    return CitationMatchingRules(**base)


def test_uncited_entry_is_minor():
    viols = match(
        [_cite("Smith", "2020", 3)],
        _index((9, "Smith, J. (2020). A."), (12, "Jones, A. (2019). B.")),
        _cited_rules(),
    )
    assert [v.rule_code for v in viols] == [RULE_REFERENCE_NOT_CITED]
    v = viols[0]
    assert v.severity == "MINOR"
    assert v.location["paragraph_index"] == 12
    assert v.expected_value == "At least one in-text citation"
    assert v.actual_value == "Jones, A. (2019). B."


def test_uncited_duplicated_entry_reports_one_finding():
    viols = match(
        [_cite("Smith", "2020", 3)],
        _index(
            (9, "Smith, J. (2020). A."),
            (12, "Jones, A. (2019). B."),
            (14, "Jones, A. (2019). B duplicate."),
        ),
        _cited_rules(check_duplicate_references=False),
    )
    assert [v.rule_code for v in viols] == [RULE_REFERENCE_NOT_CITED]
    assert viols[0].location["paragraph_index"] == 12


def test_uncited_rule_off_by_default():
    viols = match(
        [_cite("Smith", "2020", 3)],
        _index((9, "Smith, J. (2020). A."), (12, "Jones, A. (2019). B.")),
    )
    assert viols == []


def test_match_accepts_no_author_exemption_input():
    """There is no author-wide exemption channel: an entry whose author only
    appears in excluded (unsupported) material is still reported uncited."""
    import inspect

    parameters = inspect.signature(match).parameters
    assert "exempt_author_keys" not in parameters
    assert list(parameters) == ["citations", "index", "rules"]
    viols = match(
        [_cite("Smith", "2020", 3)],
        _index((9, "Smith, J. (2020). A."), (12, "Jones, A. (2019). B.")),
        _cited_rules(),
    )
    assert [v.rule_code for v in viols] == [RULE_REFERENCE_NOT_CITED]
    assert viols[0].actual_value == "Jones, A. (2019). B."


def test_duplicate_entries_report_the_later_entry():
    viols = match(
        [_cite("Smith", "2020", 3)],
        _index(
            (9, "Smith, J. (2020). A."),
            (12, "Smith, J. (2020). A duplicate."),
        ),
    )
    assert [v.rule_code for v in viols] == [RULE_REFERENCE_DUPLICATE]
    v = viols[0]
    assert v.severity == "MINOR"
    assert v.expected_value == "One entry per source"
    assert v.actual_value == "Smith, J. (2020). A duplicate."
    assert v.location == {
        "paragraph_index": 12,
        "entry_count": 2,
        "paragraph_indexes": [9, 12],
    }


def test_same_author_different_years_is_not_a_duplicate():
    viols = match(
        [_cite("Smith", "2020", 3), _cite("Smith", "2019", 4)],
        _index((9, "Smith, J. (2020). A."), (12, "Smith, J. (2019). B.")),
    )
    assert viols == []


def test_duplicate_rule_can_be_disabled():
    viols = match(
        [_cite("Smith", "2020", 3)],
        _index((9, "Smith, J. (2020). A."), (12, "Smith, J. (2020). B.")),
        CitationMatchingRules(check_duplicate_references=False),
    )
    assert viols == []


# ---------------------------------------------------------------------------
# Profile toggles
# ---------------------------------------------------------------------------

def test_all_rules_off_emit_nothing():
    rules = CitationMatchingRules(
        check_citations_have_references=False,
        check_references_are_cited=True,
        check_author_year_consistency=True,
        check_year_suffixes=True,
        check_duplicate_references=True,
        flag_ambiguous_matches=True,
        allow_personal_communication=True,
    )
    citations = [_cite("Smith", "2020", 3), _cite("Other", "2021", 4)]
    index = _index(
        (9, "Smith, J. (2019). Wrong year."),
        (12, "Smith, J. (2019). Wrong year duplicate."),
        (15, "Jones, A. (2018). Uncited."),
    )
    # The parent toggle is off → the citation side reports nothing.
    viols = match(citations, index, rules)
    assert [v.rule_code for v in viols] == [RULE_REFERENCE_NOT_CITED, RULE_REFERENCE_DUPLICATE]


def test_disabled_year_rule_does_not_fall_through_to_suffix_rule():
    rules = CitationMatchingRules(check_author_year_consistency=False)
    viols = match(
        [_cite("Smith", "2020", 3)],
        _index((9, "Smith, J. (2019). Title. Press.")),
        rules,
    )
    assert viols == []


def test_disabled_suffix_rule_emits_nothing():
    rules = CitationMatchingRules(check_year_suffixes=False)
    viols = match(
        [_cite("Smith", "2020", 3)],
        _index((9, "Smith, J. (2020a). Title. Press.")),
        rules,
    )
    assert viols == []


class _StubConfig:
    """Minimal EffectiveProfileConfig look-alike."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def test_rules_from_config_defaults_when_attributes_absent():
    assert CitationMatchingRules.from_config(None) == CitationMatchingRules()
    assert CitationMatchingRules.from_config(_StubConfig()) == CitationMatchingRules()


def test_rules_from_config_reads_attributes_and_normalizes_parent():
    cfg = _StubConfig(
        CITATION_CHECK_CITATIONS_HAVE_REFERENCES=False,
        CITATION_CHECK_REFERENCES_ARE_CITED=True,
        CITATION_CHECK_AUTHOR_YEAR_CONSISTENCY=True,
        CITATION_CHECK_YEAR_SUFFIXES=True,
        CITATION_CHECK_DUPLICATE_REFERENCES=False,
        CITATION_FLAG_AMBIGUOUS_MATCHES=False,
        CITATION_ALLOW_PERSONAL_COMMUNICATION=False,
    )
    rules = CitationMatchingRules.from_config(cfg)
    assert rules.check_citations_have_references is False
    assert rules.check_author_year_consistency is False
    assert rules.check_year_suffixes is False
    assert rules.check_references_are_cited is True
    assert rules.check_duplicate_references is False
    assert rules.flag_ambiguous_matches is False
    assert rules.allow_personal_communication is False


# ---------------------------------------------------------------------------
# Scoring/category wiring — every citation/reference code is one category
# ---------------------------------------------------------------------------

def test_all_citation_and_reference_codes_map_to_citation_category():
    from app.services.scoring import rule_code_to_category

    for code in (
        RULE_CITATION_MISMATCH,
        RULE_CITATION_REFERENCE_MISMATCH,
        RULE_CITATION_YEAR_SUFFIX_MISMATCH,
        RULE_CITATION_REFERENCE_AMBIGUOUS,
        RULE_REFERENCE_NOT_CITED,
        RULE_REFERENCE_DUPLICATE,
    ):
        assert rule_code_to_category(code) == "citation_apa", code


def test_review_severity_adds_no_deduction_or_count():
    from app.services.scoring import calculate_weighted_score_detailed
    from app.services.layout_violation import LayoutViolation

    review = LayoutViolation(
        rule_code=RULE_CITATION_REFERENCE_AMBIGUOUS,
        severity=SEVERITY_REVIEW,
        location={"paragraph_index": 0},
        message="m",
        expected_value="One unambiguous matching entry",
        actual_value="(Smith, 2024)",
    )
    result = calculate_weighted_score_detailed([review])
    assert result.total == 100
    assert result.major_count == 0
    assert result.minor_count == 0
    apa = next(b for b in result.breakdown if b.category == "citation_apa")
    assert (apa.major, apa.minor, apa.deduction) == (0, 0, 0)
