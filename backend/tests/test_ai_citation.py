"""Tests for the defensive AI JSON parser and citation-text extractor."""
import pytest

from app.services.ai_citation import parse_ai_json, extract_citation_text


# ---------------------------------------------------------------------------
# parse_ai_json
# ---------------------------------------------------------------------------

def test_parse_ai_json_valid_array():
    raw = '[{"paragraph_index": 0, "message": "ok", "issue_type": "x"}]'
    result = parse_ai_json(raw)
    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0]["paragraph_index"] == 0


def test_parse_ai_json_empty_array():
    assert parse_ai_json("[]") == []


def test_parse_ai_json_markdown_fenced_json():
    raw = '```json\n[]\n```'
    assert parse_ai_json(raw) == []


def test_parse_ai_json_bare_fenced():
    raw = '```\n[{"a": 1}]\n```'
    result = parse_ai_json(raw)
    assert len(result) == 1
    assert result[0]["a"] == 1


def test_parse_ai_json_wrapped_in_prose_extracts_array():
    raw = "Result follows:\n[{\"x\": 2}]\nDone."
    result = parse_ai_json(raw)
    assert len(result) == 1
    assert result[0]["x"] == 2


def test_parse_ai_json_malformed_returns_fallback():
    result = parse_ai_json("not json at all")
    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0]["paragraph_index"] == -1
    assert result[0]["issue_type"] == "other"


def test_parse_ai_json_empty_string_returns_fallback():
    result = parse_ai_json("")
    assert isinstance(result, list)
    assert result[0]["paragraph_index"] == -1


def test_parse_ai_json_none_returns_fallback():
    result = parse_ai_json(None)
    assert isinstance(result, list)
    assert result[0]["paragraph_index"] == -1


def test_parse_ai_json_object_not_array_returns_empty():
    result = parse_ai_json('{"a": 1}')
    assert result == []


# ---------------------------------------------------------------------------
# extract_citation_text
# ---------------------------------------------------------------------------

def test_extract_citation_text_finds_parenthetical_apa():
    paragraphs = [
        {"index": 0, "text": "Body line.", "runs": []},
        {"index": 1, "text": "Earlier (Smith, 2020) said…", "runs": []},
    ]
    out = extract_citation_text(paragraphs)
    assert "[Para 1]" in out
    assert "(Smith, 2020)" in out


def test_extract_citation_text_finds_et_al():
    paragraphs = [
        {"index": 0, "text": "Smith et al. reported…", "runs": []},
    ]
    out = extract_citation_text(paragraphs)
    assert "[Para 0]" in out


def test_extract_citation_text_finds_numeric_brackets():
    paragraphs = [
        {"index": 0, "text": "Some claim [1] was made.", "runs": []},
    ]
    out = extract_citation_text(paragraphs)
    assert "[Para 0]" in out


def test_extract_citation_text_no_citations_returns_sentinel():
    paragraphs = [
        {"index": 0, "text": "Just plain body text.", "runs": []},
    ]
    out = extract_citation_text(paragraphs)
    assert out == "No citation-like text found."
