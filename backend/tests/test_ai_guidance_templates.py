"""Focused tests for the APA 7 guidance improvement (guidance build).

Covers the fabricated-detail-safe assembly contract:
- structured suggestion hierarchy
- journal / book / webpage template structure
- webpage template only for a known webpage source
- unknown source type is never guessed
- placeholders instead of invented bibliographic details
- placeholder warning always present
- reason sanitisation
- same-paragraph findings keep distinct guidance
- end-to-end POST assembly with the real task and a mocked provider
"""
import json

import pytest

from app.services import ai_citation
from app.services.ai_citation import (
    AI_STATUS_WITH_SUGGESTIONS,
    _validate_source_type,
    _sanitise_reason,
    build_apa_suggestion,
    async_ai_citation_task,
)

WARNING = "Formatting example only. Replace all placeholders with verified source information before submission."
JOURNAL_TEMPLATE = "Author, A. A. (Year). Title of the article. Journal Name, volume(issue), page\u2013page. https://doi.org/xxxxx"
BOOK_TEMPLATE = "Author, A. A. (Year). Title of the book. Publisher."
WEBPAGE_TEMPLATE = "Author, A. A. (Year, Month Day). Title of the page. Site Name. URL"

REASON = "APA 7 requires every in-text citation to have a matching References entry. Add the missing entry using the source details you already have."


@pytest.fixture
def ai_session(test_engine):
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=test_engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


def _finding(idx, author="Smith", year="2020"):
    return {
        "finding_key": f"fk-{idx}-{author}-{year}",
        "paragraph_index": idx,
        "rule_code": "CITATION_MISMATCH",
        "severity": "MAJOR",
        "snippet": f"({author}, {year})",
        "message": f"Citation '{author} ({year})' was found in text, but no matching entry was found in the References bibliography.",
        "expected_value": f"Reference entry for {author}",
        "actual_value": f"({author}, {year})",
    }


# ---------------------------------------------------------------------------
# Source-type validation — never guessed
# ---------------------------------------------------------------------------

def test_source_type_whitelist():
    assert _validate_source_type("journal_article") == "journal_article"
    assert _validate_source_type("book") == "book"
    assert _validate_source_type("webpage") == "webpage"
    assert _validate_source_type("JOURNAL_ARTICLE") == "journal_article"
    assert _validate_source_type("  Book  ") == "book"


def test_source_type_unknown_not_guessed():
    assert _validate_source_type("conference paper") == "unknown"
    assert _validate_source_type("") == "unknown"
    assert _validate_source_type(None) == "unknown"
    assert _validate_source_type(123) == "unknown"


def test_reason_sanitisation():
    assert _sanitise_reason("  Suggestion: Fix it now.  ") == "Fix it now."
    assert _sanitise_reason("Line one\n\nLine two") == "Line one Line two"
    assert _sanitise_reason("   ") is None
    assert _sanitise_reason(None) is None
    assert _sanitise_reason(42) is None
    long = "x" * 800
    assert len(_sanitise_reason(long)) == 700


# ---------------------------------------------------------------------------
# Template structure
# ---------------------------------------------------------------------------

def test_journal_template_structurally_correct():
    sug = build_apa_suggestion(REASON, "journal_article")
    assert "Journal article:" in sug
    assert JOURNAL_TEMPLATE in sug
    assert BOOK_TEMPLATE not in sug
    assert WEBPAGE_TEMPLATE not in sug
    assert WARNING in sug


def test_book_template_structurally_correct():
    sug = build_apa_suggestion(REASON, "book")
    assert "Book:" in sug
    assert BOOK_TEMPLATE in sug
    assert JOURNAL_TEMPLATE not in sug
    assert WARNING in sug


def test_webpage_template_only_when_source_known():
    web = build_apa_suggestion(REASON, "webpage")
    assert WEBPAGE_TEMPLATE in web
    assert WARNING in web

    unknown = build_apa_suggestion(REASON, "unknown")
    assert WEBPAGE_TEMPLATE not in unknown, "webpage template must not appear for unknown source"


def test_unknown_source_type_shows_labelled_alternatives():
    sug = build_apa_suggestion(REASON, "unknown")
    assert "Identify the original source type" in sug
    assert "Journal article:" in sug
    assert JOURNAL_TEMPLATE in sug
    assert "Book:" in sug
    assert BOOK_TEMPLATE in sug
    assert WEBPAGE_TEMPLATE not in sug
    assert WARNING in sug


def test_placeholder_warning_always_present_with_templates():
    for source_type in ("journal_article", "book", "webpage", "unknown"):
        assert WARNING in build_apa_suggestion(REASON, source_type)


def test_suggestion_hierarchy_order():
    sug = build_apa_suggestion(REASON, "unknown")
    order = [sug.index(part) for part in (
        "Recommended correction", "What to verify", "APA 7 formatting example", WARNING)]
    assert order == sorted(order), "sections must appear in hierarchy order"
    for item in ("- Author name and initials", "- Publication year", "- Source title",
                 "- Journal or publisher", "- Volume, issue, and pages where applicable",
                 "- DOI or URL where applicable"):
        assert item in sug


def test_placeholders_not_invented_details():
    sug = build_apa_suggestion(REASON, "journal_article")
    for placeholder in ("A. A.", "(Year)", "xxxxx"):
        assert placeholder in sug
    # No fabricated bibliographic details may appear in the template surface
    for fabricated in ("Garcia", "2018", "vol. 12", "pp. 1-10", "https://doi.org/10.1"):
        assert fabricated not in sug


# ---------------------------------------------------------------------------
# Task-level: missing metadata, distinct same-paragraph guidance
# ---------------------------------------------------------------------------

async def test_item_without_reason_is_rejected(ai_session, monkeypatch):
    findings = [_finding(0)]

    async def _fake(prompt):
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "source_type": "book", "confidence": 0.9},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="tpl-1", db=ai_session, cloud=False, citation_findings=findings)
    assert out.suggestions == []
    assert out.status == "COMPLETED_NO_SUGGESTIONS"


async def test_missing_metadata_yields_placeholders(ai_session, monkeypatch):
    """Model supplies a reason but no source type — placeholders, no guesses."""
    findings = [_finding(0)]

    async def _fake(prompt):
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": REASON, "confidence": 0.9},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="tpl-2", db=ai_session, cloud=False, citation_findings=findings)
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    sug = out.suggestions[0]["suggestion"]
    assert "Identify the original source type" in sug
    assert BOOK_TEMPLATE in sug
    assert WARNING in sug
    assert out.suggestions[0]["confidence"] == 0.9


async def test_same_paragraph_findings_keep_distinct_guidance(ai_session, monkeypatch):
    """Two findings in one paragraph keep separate suggestions and messages."""
    findings = [_finding(5, "Smith", "2020"), _finding(5, "Jones", "2019")]

    async def _fake(prompt):
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": "Add the Smith (2020) entry.", "source_type": "unknown", "confidence": 0.9},
            {"finding_key": findings[1]["finding_key"], "reason": "Add the Jones (2019) entry.", "source_type": "unknown", "confidence": 0.8},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="tpl-3", db=ai_session, cloud=False, citation_findings=findings)
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert len(out.suggestions) == 2
    assert out.suggestions[0]["paragraph_index"] == 5
    assert out.suggestions[1]["paragraph_index"] == 5
    assert "Smith" in out.suggestions[0]["suggestion"]
    assert "Jones" in out.suggestions[1]["suggestion"]
    assert out.suggestions[0]["message"] != out.suggestions[1]["message"]


async def test_confidence_not_forced_to_one(ai_session, monkeypatch):
    """Model confidence is preserved; absence of confidence stays None."""
    findings = [_finding(0)]

    async def _fake(prompt):
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": REASON, "source_type": "book"},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)

    out = await async_ai_citation_task(
        audit_id="tpl-4", db=ai_session, cloud=False, citation_findings=findings)
    ai_session.commit()

    assert out.status == AI_STATUS_WITH_SUGGESTIONS
    assert out.suggestions[0]["confidence"] is None, "missing confidence must not become 1.0"


# ---------------------------------------------------------------------------
# End-to-end POST assembly with the real task and a mocked provider
# ---------------------------------------------------------------------------

def test_post_assembles_structured_guidance(client, docx_factory, monkeypatch):
    import app.api.routes as api_routes

    async def _fake(prompt):
        # The prompt embeds the example array before the real findings — take
        # the LAST array (the real findings) so the echoed finding_key matches.
        start = prompt.rindex("[")
        end = prompt.rindex("]") + 1
        findings = json.loads(prompt[start:end])
        return json.dumps([
            {"finding_key": findings[0]["finding_key"], "reason": REASON,
             "source_type": "book", "confidence": 0.9},
        ])

    monkeypatch.setattr(ai_citation, "call_ollama_local", _fake)
    # conftest's client fixture no-ops the route task — route the real task
    # through so the assembled suggestion is exercised end-to-end.
    real_task = ai_citation.async_ai_citation_task

    async def _real(*args, **kwargs):
        return await real_task(*args, **kwargs)

    monkeypatch.setattr(api_routes, "async_ai_citation_task", _real)

    file_bytes = docx_factory(paragraphs=["Orphan (Garcia, 2018) text."], references=None)
    post = client.post(
        "/api/audit",
        files={"file": ("t.docx", file_bytes, "application/octet-stream")},
    )
    assert post.status_code == 200
    data = post.json()
    assert data["ai_review_status"] == AI_STATUS_WITH_SUGGESTIONS
    assert len(data["ai_citation_tooltips"]) == 1
    tooltip = data["ai_citation_tooltips"][0]
    assert tooltip["confidence"] == 0.9
    sug = tooltip["suggestion"]
    assert "Recommended correction" in sug
    assert "What to verify" in sug
    assert "APA 7 formatting example" in sug
    assert BOOK_TEMPLATE in sug
    assert WARNING in sug
    assert "Garcia" not in sug, "model reason must not fabricate source details into templates"
