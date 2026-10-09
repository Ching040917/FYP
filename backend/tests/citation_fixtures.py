"""Synthetic citation/reference document fixtures.

Every fixture is built in memory through the repo's `make_docx_bytes`
factory (tests/conftest.py) — nothing is written to disk. Each spec states
what the deterministic sensor must report, so the fixture table doubles as
the support-matrix contract from the build plan.
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.services.citation_sensor import run_citation_sensor
from app.services.document_parser import extract_paragraphs, parse_document


@dataclass(frozen=True)
class CitationDoc:
    """One synthetic document: body paragraphs + optional bibliography."""
    name: str
    body: List[Any]
    references: Optional[List[str]] = None
    header: Optional[str] = None          # custom heading text
    include_header: bool = True           # False → no bibliography at all
    tables: Optional[List[List[List[str]]]] = None
    appendix: Optional[List[str]] = None  # paragraphs placed after the entries

    def build(self, make_docx_bytes) -> bytes:
        paragraphs = list(self.body)
        if not self.include_header:
            return make_docx_bytes(paragraphs=paragraphs, tables=self.tables)
        if self.header is not None:
            paragraphs = paragraphs + [self.header] + list(self.references or [])
            paragraphs = paragraphs + list(self.appendix or [])
            return make_docx_bytes(paragraphs=paragraphs, tables=self.tables)
        return make_docx_bytes(
            paragraphs=paragraphs,
            references=list(self.references or []),
            tables=self.tables,
        )


def scan(fixture: CitationDoc, make_docx_bytes, config: Any = None, roles=None):
    """Build the fixture and run the deterministic citation sensor."""
    doc = parse_document(fixture.build(make_docx_bytes))
    return run_citation_sensor(doc, extract_paragraphs(doc), config=config, roles=roles)


# ---------------------------------------------------------------------------
# Support matrix fixtures
# ---------------------------------------------------------------------------

FIXTURES: Dict[str, CitationDoc] = {
    # 1 — matched citation: clean
    "matched_citation": CitationDoc(
        "matched_citation",
        ["Smith (2020) reported the finding."],
        ["Smith, J. (2020). On things. Press."],
    ),
    # 2 — citation with no matching entry
    "missing_reference": CitationDoc(
        "missing_reference",
        ["Smith (2020) reported the finding."],
        ["Jones, A. (2019). Other things. Press."],
    ),
    # 3 — entry with no citation (REFERENCE_NOT_CITED is opt-in)
    "uncited_reference": CitationDoc(
        "uncited_reference",
        ["Smith (2020) reported the finding."],
        ["Smith, J. (2020). On things. Press.", "Jones, A. (2019). Other. Press."],
    ),
    # 4 — narrative form
    "narrative": CitationDoc(
        "narrative",
        ["Taylor & Green (2018) explored it."],
        ["Taylor, A. B. (2018). Title. Press."],
    ),
    # 5 — two authors, primary surname resolves
    "two_authors": CitationDoc(
        "two_authors",
        ["Confirmed by (Smith & Jones, 2020)."],
        ["Smith, J. (2020). Title. Press."],
    ),
    # 6 — narrative "et al."
    "et_al": CitationDoc(
        "et_al",
        ["Smith et al. (2020) found it."],
        ["Smith, J. (2020). Title. Press."],
    ),
    # 7 — organisation author: outside the deterministic support matrix
    "organisation_author": CitationDoc(
        "organisation_author",
        ["The policy changed (University of Example, 2024)."],
        ["University of Example. (2024). Policy. Press."],
    ),
    # 8 — n.d. on both sides
    "no_date": CitationDoc(
        "no_date",
        ["An undated source (Smith, n.d.) says so."],
        ["Smith, J. (n.d.). Undated. Press."],
    ),
    # 9 — 2024a / 2024b suffixes
    "year_suffixes": CitationDoc(
        "year_suffixes",
        ["Reported earlier (Smith, 2024b)."],
        ["Smith, J. (2024a). First. Press.", "Smith, J. (2024b). Second. Press."],
    ),
    # 10 — ';'-grouped parenthetical, both missing
    "grouped_missing": CitationDoc(
        "grouped_missing",
        ["Mixed evidence (Smith, 2024; Lee, 2023)."],
        ["Other, X. (2019). Unrelated. Press."],
    ),
    # 11 — repeated missing citation
    "repeated_missing": CitationDoc(
        "repeated_missing",
        [
            "Smith (2020) reported the first finding.",
            "Smith (2020) repeated it later.",
            "Smith (2020) repeated it again.",
        ],
        ["Jones, A. (2019). Other. Press."],
    ),
    # 12 — duplicate entry
    "duplicate_reference": CitationDoc(
        "duplicate_reference",
        ["Body line (Smith, 2020)."],
        ["Smith, J. (2020). On things. Press.", "Smith, J. (2020). On things. Press."],
    ),
    # 13 — no References heading at all
    "no_references_heading": CitationDoc(
        "no_references_heading",
        ["Smith (2020) wrote about it.", "And (Jones, 2019) confirmed it."],
        include_header=False,
    ),
    # 14 — custom bibliography heading
    "custom_heading": CitationDoc(
        "custom_heading",
        ["Smith (2020) said so."],
        ["Smith, J. (2020). Title. Press."],
        header="Works Cited",
    ),
    # 17 — Unicode surname
    "unicode_surname": CitationDoc(
        "unicode_surname",
        ["MÜLLER (2020) reported it."],
        ["Müller, J. (2020). Title. Press."],
    ),
    # 18 — entry carrying a DOI/URL stays keyable (URL never becomes a key)
    "entry_with_doi": CitationDoc(
        "entry_with_doi",
        ["Smith (2020) reported it."],
        ["Smith, J. (2020). Title. https://doi.org/10.1000/xyz"],
    ),
    # 19 — personal communication (allowed by default)
    "personal_communication": CitationDoc(
        "personal_communication",
        ["Per (J. Smith, personal communication, October 5, 2024) it holds."],
        ["Smith, J. (2019). Earlier paper. Press."],
    ),
    # 20 — "as cited in" secondary citation
    "as_cited_in": CitationDoc(
        "as_cited_in",
        ["Reported by (Smith, 2020, as cited in Jones, 2019)."],
        ["Jones, A. (2019). Secondary source. Press."],
    ),
    # 21 — title-based citation
    "title_based_citation": CitationDoc(
        "title_based_citation",
        ["The report says so (Annual Report, 2024)."],
        ["Annual Report. (2024). Title. Press."],
    ),
    # 22 — same surname, different initials
    "same_surname_different_initials": CitationDoc(
        "same_surname_different_initials",
        ["Confirmed earlier (Smith, 2024)."],
        ["Smith, A. (2020). First. Press.", "Smith, B. (2019). Second. Press."],
    ),
    # 23 — citation inside a table (never extracted)
    "table_only_citation": CitationDoc(
        "table_only_citation",
        ["Body text without a citation."],
        [["See (Garcia, 2018) for the numbers."]],
    ),
    # 24 — citation inside a caption (captions are scanned)
    "caption_citation": CitationDoc(
        "caption_citation",
        [("Body line.", None), ("Figure 1: Data from Smith (2020).", "Caption")],
        ["Smith, J. (2020). On things. Press."],
    ),
    # 27 — numeric citation style (out of scope)
    "numeric_citation": CitationDoc(
        "numeric_citation",
        ["As shown in [12] the effect holds."],
        ["Smith, J. (2020). On things. Press."],
    ),
    # 28 — malformed citation form
    "malformed_citation": CitationDoc(
        "malformed_citation",
        ["See Smith 2024 for details."],
        ["Smith, J. (2024). On things. Press."],
    ),
    # 29 — Reference List placed after an Appendix heading
    "references_in_appendix": CitationDoc(
        "references_in_appendix",
        ["Smith (2020) wrote about it."],
        ["Jones, A. (2019). Other. Press."],
        header="References",
        appendix=[
            "Appendix A: Material",
            "Smith, J. (2020). Title. Press.",
        ],
    ),
    # 30 — "Bibliography" alias where "References" is expected
    "bibliography_alias": CitationDoc(
        "bibliography_alias",
        ["Smith (2020) said so."],
        ["Smith, J. (2020). Title. Press."],
        header="Bibliography",
    ),
}


# Fixtures whose observed result is "no findings at all" under the default
# profile (citation-side checks on, REFERENCE_NOT_CITED off).
CLEAN_FIXTURES = (
    "matched_citation",
    "narrative",
    "two_authors",
    "et_al",
    "organisation_author",
    "no_date",
    "year_suffixes",
    "custom_heading",
    "unicode_surname",
    "entry_with_doi",
    "personal_communication",
    "as_cited_in",
    "title_based_citation",
    "table_only_citation",
    "caption_citation",
    "numeric_citation",
    "malformed_citation",
    "bibliography_alias",
)

# Silent even with every rule armed. `numeric_citation` and
# `malformed_citation` are excluded: their (unmatched) citations are out of
# scope, but their Reference List entry is genuinely uncited, so the opt-in
# REFERENCE_NOT_CITED rule reports it.
#
# `personal_communication` and `as_cited_in` are excluded for the opposite
# reason: the in-text citation is an UNSUPPORTED occurrence (excluded per
# occurrence, never author-wide), so the entry it names is still genuinely
# uncited and must be reported when that rule is on.
UNSUPPORTED_OCCURRENCE_FIXTURES = ("personal_communication", "as_cited_in")

# `year_suffixes` cites (Smith, 2024b) while the list holds 2024a and 2024b:
# cited state is work-level, so the uncited 2024a entry is correctly reported.
UNCITED_ENTRY_UNDER_ALL_RULES = ("year_suffixes",)

CLEAN_UNDER_ALL_RULES = tuple(
    name for name in CLEAN_FIXTURES
    if name not in ("numeric_citation", "malformed_citation")
    + UNSUPPORTED_OCCURRENCE_FIXTURES
    + UNCITED_ENTRY_UNDER_ALL_RULES
)


# ---------------------------------------------------------------------------
# Committed browser-E2E fixture (frontend/e2e/fixtures/)
# ---------------------------------------------------------------------------

# The browser E2E run cannot import python-docx, so the ambiguous-citation
# document used by e2e/audit-workspace.spec.ts is generated here and committed.
# Regenerate with:  python -m tests.citation_fixtures
E2E_REVIEW_FIXTURE_NAME = "citation-review-synthetic.docx"
E2E_REVIEW_BODY = ["The policy changed earlier (Smith, 2024) and is still in effect."]
E2E_REVIEW_REFERENCES = [
    "Smith, A. (2020). First work on the policy. Example Press.",
    "Smith, B. (2019). Second work on the policy. Example Press.",
]


def build_review_document_bytes() -> bytes:
    """A clean SUC-formatted document whose only finding is a REVIEW one.

    Two entries share the surname Smith; the in-text citation `(Smith, 2024)`
    matches neither entry's year, so the deterministic engine reports
    CITATION_REFERENCE_AMBIGUOUS with severity REVIEW (manual review, never
    scored). Formatting mirrors the SUC profile so no other finding fires.
    """
    import io

    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    doc = Document()
    for text in E2E_REVIEW_BODY:
        para = doc.add_paragraph(text)
        for run in para.runs:
            run.font.name = "Times New Roman"
            run.font.size = Pt(12)
        para.paragraph_format.line_spacing = 1.5
        para.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        para.paragraph_format.space_before = Pt(0)
        para.paragraph_format.space_after = Pt(6)

    header = doc.add_paragraph("References")
    for run in header.runs:
        run.font.name = "Times New Roman"
        run.font.size = Pt(16)

    for text in E2E_REVIEW_REFERENCES:
        para = doc.add_paragraph(text)
        for run in para.runs:
            run.font.name = "Times New Roman"
            run.font.size = Pt(12)
        # SUC wants 2.0 line spacing for the reference list.
        para.paragraph_format.line_spacing = 2.0
        para.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        para.paragraph_format.space_before = Pt(0)
        para.paragraph_format.space_after = Pt(6)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


if __name__ == "__main__":  # pragma: no cover - regeneration helper
    import pathlib

    target = (
        pathlib.Path(__file__).resolve().parents[2]
        / "frontend" / "e2e" / "fixtures" / E2E_REVIEW_FIXTURE_NAME
    )
    target.write_bytes(build_review_document_bytes())
    print(f"wrote {target}")
