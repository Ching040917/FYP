"""Offline visible-only Reference DOI presentation contracts.

These are behavioral controls: no URL resolution, document mutation or
source-string wiring assertions. The selected profile controls presentation
only; unsupported DOI-like text deliberately remains ambiguous and silent.
"""
import io
import json
import re
import socket
from dataclasses import FrozenInstanceError
from unittest.mock import AsyncMock

import pytest
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt

from app.api import routes as api_routes
from app.services import ai_citation
from app.services.ai_citation_eligibility import is_local_ai_citation_eligible
from app.services.document_parser import extract_document_blocks, extract_paragraphs
from app.services.layout_engine import run_static_rules_engine
from app.services.layout_violation import LayoutViolation
from app.services.profile_preset_adapter import EffectiveProfileConfig
from app.services.profile_registry import APA_PROFILE_ID, SUC_PROFILE_ID, get_builtin_profile
from app.services.profile_schema import new_custom_profile
from app.services.profile_snapshot import resolve_snapshot
from app.services.reference_doi import VisibleDoiEvidence, classify_visible_doi
from app.services.reference_rules import run_reference_rules
from app.services.scoring import CATEGORY_META, calculate_weighted_score_detailed, rule_code_to_category

RULE = "REFERENCE_DOI_FORMAT"
REQUIRED = "https://doi.org/<doi>"
TITLE = "Reference DOI format does not match"
ACTION = (
    "Replace the visible DOI text with the configured canonical format. "
    "Verify the DOI independently because ACA checks presentation only and "
    "does not confirm registration or resolution."
)
IDENTITY = "10.1234/AbC12pt"
CANONICAL = "https://doi.org/" + IDENTITY
LEGACY = "DOI:\t " + IDENTITY
HEAD = "Smith, J. (2020). Title. "
HLINK_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
FORBIDDEN_PRESENTATION_TOKENS = ("<a", "</a>", "href=", "target=", "rel=", "title=", "class=", "&lt;", "&gt;")


def _assert_plain_text(value):
    for token in FORBIDDEN_PRESENTATION_TOKENS:
        assert token not in value


def _bytes(doc):
    stream = io.BytesIO()
    doc.save(stream)
    return stream.getvalue()


def _document(*entries, body=None):
    doc = Document()
    if body is not None:
        doc.add_paragraph(body)
    doc.add_paragraph("References")
    for entry in entries:
        doc.add_paragraph(entry)
    return doc


def _profile(enabled=True, *, base=None):
    profile = new_custom_profile("DOI presentation tests", base=base)
    profile.references.check_doi_format = enabled
    return profile


def _config(enabled=True, *, base=None):
    return EffectiveProfileConfig(resolve_snapshot(_profile(enabled, base=base)))


def _run(doc, enabled=True, *, config=None):
    return run_reference_rules(doc, extract_paragraphs(doc), config or _config(enabled))


def _doi(findings):
    return [finding for finding in findings if finding.rule_code == RULE]


def _add_link(paragraph, label, target):
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), paragraph.part.relate_to(target, HLINK_REL, is_external=True))
    # Multiple hyperlink runs exercise concatenation without invented spaces.
    midpoint = len(label) // 2
    for text in (label[:midpoint], label[midpoint:]):
        run = OxmlElement("w:r")
        value = OxmlElement("w:t")
        value.set(qn("xml:space"), "preserve")
        value.text = text
        run.append(value)
        hyperlink.append(run)
    paragraph._p.append(hyperlink)


# Shapes 1-16, 20-21 and 24 from the approved inventory. Hyperlink-only
# shapes 17-19 and 22-23 are tested with real serialized DOCX below.
@pytest.mark.parametrize(
    ("candidate", "state", "excerpt"),
    [
        (CANONICAL, "canonical", CANONICAL),
        ("HTTPS://DOI.ORG/" + IDENTITY, "canonical", "HTTPS://DOI.ORG/" + IDENTITY),
        ("doi:" + IDENTITY, "legacy-form", "doi:" + IDENTITY),
        (LEGACY, "legacy-form", LEGACY),
        ("http://doi.org/" + IDENTITY, "legacy-form", "http://doi.org/" + IDENTITY),
        ("http://dx.doi.org/" + IDENTITY, "legacy-form", "http://dx.doi.org/" + IDENTITY),
        ("HTTPS://DX.DOI.ORG/" + IDENTITY, "legacy-form", "HTTPS://DX.DOI.ORG/" + IDENTITY),
        (IDENTITY, "ambiguous", IDENTITY),
        (CANONICAL + ".", "canonical", CANONICAL),
        (CANONICAL + ",", "ambiguous", CANONICAL + ","),
        (CANONICAL + ")", "ambiguous", CANONICAL + ")"),
        ("doi:10.1234 /AbC", "ambiguous", "doi:10.1234 /AbC"),
        ("doi:10.1234/Ab C", "ambiguous", "doi:10.1234/Ab C"),
        ("https://doi.org/", "ambiguous", "https://doi.org/"),
        ("DOI: 10.1234/", "ambiguous", "DOI: 10.1234/"),
        ("https://example.invalid/path/doi:10.1234/abc", "absent", None),
        ("doi:10.1234/Ab\nC", "ambiguous", "doi:10.1234/Ab\nC"),
        ("No identifier is provided.", "absent", None),
    ],
)
def test_visible_classifier_inventory_and_rule_gate(candidate, state, excerpt):
    text = HEAD + candidate + "  \t"
    evidence = classify_visible_doi(text)
    assert isinstance(evidence, VisibleDoiEvidence)
    assert evidence.state == state
    assert evidence.spans == (() if excerpt is None else ((len(HEAD), len(HEAD) + len(excerpt)),))
    doc = _document(text)
    assert _doi(_run(doc, False)) == []
    findings = _doi(_run(doc, True))
    assert len(findings) == (1 if state == "legacy-form" else 0)
    if findings:
        assert findings[0].actual_value == excerpt
        assert findings[0].expected_value == REQUIRED


@pytest.mark.parametrize(
    "candidate",
    [
        "doi:10.123/abc", "doi:10.1234567890/abc", "doi:10.1234/_abc",
        "doi:10.1234/abc_", "doi:10.1234/abc-", "doi:10.1234/abc/",
        "doi:10.1234/évidence", "doi:10.1234/abc;def", "doi:10.1234/abc:def",
        "doi:10.1234/abc,def", "doi:10.1234/(abc)", "doi:10.1234/abc)",
        "doi:10.1234/abc?query=1", "doi:10.1234/abc#fragment", 'doi:10.1234/"abc"',
        "doi:10.1234/abc..", "doi:10.1234/abc...", "doi:10.1234/abc. Commentary.",
        "doi:\n10.1234/abc", "doi:10. 1234/abc", "doi:10.1234/ abc",
        "doi:10.1234/abc\tdef", "doi:10.1234/abc\u00a0def", "doi:10.1234/abc\ndef",
        "doi:garbage", "doi:", "10.",
    ],
)
def test_unsupported_doi_like_text_is_ambiguous_and_silent(candidate):
    assert classify_visible_doi(candidate).state == "ambiguous"
    assert _doi(_run(_document(HEAD + candidate))) == []


@pytest.mark.parametrize(
    "candidate",
    [
        "https://doi.org.evil.invalid/10.1234/abc", "https://notdoi.org/10.1234/abc",
        "https://dx.doi.org.evil/10.1234/abc", "https://doi.org:443/10.1234/abc",
        "https://doi.org@evil.invalid/10.1234/abc", "https://doi.org",
        "https://example.invalid/https://doi.org/10.1234/abc",
        "https://example.invalid/?doi:10.1234/abc", "xdoi:10.1234/abc",
        "xhttps://doi.org/10.1234/abc", "prefix10.1234/abc",
    ],
)
def test_host_lookalikes_embedded_urls_and_prefix_fragments_are_absent(candidate):
    assert classify_visible_doi(candidate).state == "absent"
    assert _doi(_run(_document(candidate))) == []


def test_multiple_candidates_keep_raw_spans_and_suppress_entire_entry():
    first = "doi:10.1234/AbC."
    second = "https://doi.org/10.5678/Def"
    text = HEAD + first + " \t" + second + "  "
    evidence = classify_visible_doi(text)
    assert evidence.state == "ambiguous"
    assert evidence.spans == (
        (len(HEAD), len(HEAD) + len(first)),
        (text.index(second), text.index(second) + len(second)),
    )
    assert _doi(_run(_document(text))) == []
    assert classify_visible_doi("DOI: 10.1234/AbC").state == "legacy-form"
    assert len(classify_visible_doi("DOI: 10.1234/AbC").spans) == 1
    assert classify_visible_doi("DOI: 10.1234/AbC 10.5678/def").state == "ambiguous"


def test_evidence_is_frozen_and_offsets_preserve_suffix_case_and_internal_punctuation():
    candidate = "DOI: 10.123456789/A_b-C.d/E9."
    text = "\t" + candidate + "\t\n"
    evidence = classify_visible_doi(text)
    assert evidence.state == "legacy-form"
    assert evidence.spans == ((1, len(candidate)),)
    assert text[slice(*evidence.spans[0])] == candidate[:-1]
    assert isinstance(evidence.spans, tuple)
    with pytest.raises(FrozenInstanceError):
        evidence.state = "absent"


@pytest.mark.parametrize("suffix", ["A", "AbC12pt", "AbC12in", "numPr", "a_b-C.d/E9"])
def test_supported_suffixes_stay_raw_and_one_terminal_period_is_equivalent(suffix):
    candidate = "DoI:\t10.1234/" + suffix
    finding = _doi(_run(_document(HEAD + candidate + ".")))[0]
    assert finding.actual_value == candidate
    assert finding.expected_value == REQUIRED
    assert finding.severity == "MINOR"
    assert finding.location == {"paragraph_index": 1}
    assert "selected profile" in finding.message
    assert "presentation only" in finding.message
    assert "not registration or resolution" in finding.message
    assert "APA 7" not in finding.message
    _assert_plain_text(json.dumps(finding.to_dict()))


def test_each_physical_entry_gets_its_own_case_sensitive_finding_without_consolidation():
    doc = _document("doi:10.1234/AbC", "doi:10.1234/abc", "doi:10.1234/AbC")
    findings = _doi(_run(doc))
    assert [v.actual_value for v in findings] == ["doi:10.1234/AbC", "doi:10.1234/abc", "doi:10.1234/AbC"]
    assert [v.location for v in findings] == [{"paragraph_index": i} for i in (1, 2, 3)]
    assert calculate_weighted_score_detailed(findings).total == 94


@pytest.mark.parametrize("length", [159, 160, 161, 240])
def test_current_excerpt_is_bounded_without_normalizing_source(length):
    prefix = "DOI: 10.1234/"
    candidate = prefix + "A" * (length - len(prefix))
    finding = _doi(_run(_document(HEAD + candidate)))[0]
    assert finding.actual_value == (candidate if length <= 160 else candidate[:159] + "…")
    assert len(finding.actual_value) <= 160


@pytest.mark.parametrize("split", ["whole-link", "direct-link", "link-direct", "newline"])
@pytest.mark.parametrize("label_kind", ["canonical", "legacy", "human"])
def test_docx_hyperlink_shapes_use_visible_spelling_not_relationships(split, label_kind):
    labels = {"canonical": CANONICAL, "legacy": LEGACY, "human": "Read this article"}
    label = labels[label_kind]
    outputs = []
    for target in (CANONICAL, "http://dx.doi.org/10.9999/HiddenSecret"):
        doc = Document()
        doc.add_paragraph("Outside References " + LEGACY)
        doc.add_paragraph("References")
        doc.add_paragraph("")
        paragraph = doc.add_paragraph(HEAD)
        if split == "whole-link":
            _add_link(paragraph, label, target)
        elif split == "direct-link":
            paragraph.add_run(label[:8])
            _add_link(paragraph, label[8:], target)
        elif split == "link-direct":
            _add_link(paragraph, label[:8], target)
            paragraph.add_run(label[8:])
        else:
            paragraph.add_run(label[:8] + "\n")
            _add_link(paragraph, label[8:], target)
        doc.add_paragraph("Appendix")
        doc.add_paragraph(LEGACY)
        # Reload actual package bytes so neither extraction nor the rule can
        # accidentally rely on construction-time python-docx objects.
        loaded = Document(io.BytesIO(_bytes(doc)))
        paragraphs = extract_paragraphs(loaded)
        expected_text = HEAD + (label[:8] + "\n" + label[8:] if split == "newline" else label)
        assert paragraphs[3]["text"] == expected_text
        before = [p.text for p in loaded.paragraphs]
        findings = _doi(_run(loaded))
        assert [p.text for p in loaded.paragraphs] == before
        expected_count = 1 if label_kind == "legacy" and split != "newline" else 0
        assert len(findings) == expected_count
        if findings:
            assert findings[0].actual_value == label
            assert findings[0].location == {"paragraph_index": 3}
            block = extract_document_blocks(loaded)[3]
            assert block["index"] == 3 and block["text"] == expected_text
        outputs.append([finding.to_dict() for finding in findings])
    assert outputs[0] == outputs[1]


@pytest.mark.parametrize("boundary", ["Appendix", "Rubric", "Methods"])
def test_reference_section_boundaries_and_unkeyable_entries(boundary):
    doc = Document()
    doc.add_paragraph(LEGACY)
    doc.add_paragraph("References")
    doc.add_paragraph("")
    doc.add_paragraph("Unkeyable reference text " + LEGACY)
    doc.add_paragraph(boundary, style=None if boundary == "Appendix" else "Heading 1")
    doc.add_paragraph(LEGACY)
    assert [v.location for v in _doi(_run(doc))] == [{"paragraph_index": 3}]
    no_heading = Document()
    no_heading.add_paragraph(LEGACY)
    assert _run(no_heading) == []


def test_legacy_missing_toggle_and_explicit_off_preserve_complete_pipeline_findings():
    base = get_builtin_profile(SUC_PROFILE_ID)
    profile = _profile(False, base=base)
    profile.references.check_reference_order = True
    profile.references.check_font_size = True
    profile.references.font_size_pt = 12.0
    profile.references.check_hanging_indent = True
    profile.references.hanging_indent_in = 0.5
    profile.references.check_line_spacing = True
    profile.references.line_spacing = 2.0
    profile.citation_matching.check_references_are_cited = True
    doc = _document(
        HEAD + LEGACY,
        "Institutional Standards Board. (2021). Policy. doi:10.1234/Board",
        "Adams, A. (2019). Other. doi:10.1234/Other",
        body="Prior work (Smith, 2022); policy (Institutional Standards Board, 2021).",
    )
    for paragraph in doc.paragraphs:
        paragraph.paragraph_format.line_spacing = 1.0
        for run in paragraph.runs:
            run.font.size = Pt(11)
    data = _bytes(doc)
    off = EffectiveProfileConfig(resolve_snapshot(profile))
    legacy = EffectiveProfileConfig(resolve_snapshot(profile))
    del legacy.REFERENCES_CHECK_DOI_FORMAT
    profile.references.check_doi_format = True
    enabled = EffectiveProfileConfig(resolve_snapshot(profile))
    original = [v.to_dict() for v in run_static_rules_engine(data, config=legacy)]
    disabled = [v.to_dict() for v in run_static_rules_engine(data, config=off)]
    on = run_static_rules_engine(data, config=enabled)
    assert disabled == original
    assert [v.to_dict() for v in on if v.rule_code != RULE] == original
    assert len(_doi(on)) == 3
    assert any(v["rule_code"] == "REFERENCE_ORDER" for v in original)
    assert any(v["rule_code"] == "REFERENCE_FONT_SIZE" for v in original)
    assert any(v["rule_code"] == "REFERENCE_HANGING_INDENT" for v in original)
    assert any(v["rule_code"] == "LINE_SPACING" for v in original)
    assert any(v["rule_code"] == "CITATION_REFERENCE_MISMATCH" for v in original)


def test_doi_category_weight_cap_and_manual_only_eligibility():
    finding = _doi(_run(_document(LEGACY)))[0]
    assert rule_code_to_category(RULE) == "citation_apa"
    assert rule_code_to_category(RULE, legacy_spacing=True) == "citation_apa"
    meta = CATEGORY_META["citation_apa"]
    assert (meta.major_weight, meta.minor_weight, meta.cap) == (5, 2, 25)
    assert calculate_weighted_score_detailed([finding]).total == 98
    assert calculate_weighted_score_detailed([finding] * 20).total == 75
    assert calculate_weighted_score_detailed(_doi(_run(_document(LEGACY), False))).total == 100
    assert is_local_ai_citation_eligible(finding) is False
    for severity in ("REVIEW", "UNKNOWN"):
        unscored = LayoutViolation(RULE, severity, {"paragraph_index": 1}, "m", REQUIRED, LEGACY)
        assert calculate_weighted_score_detailed([unscored]).total == 100


@pytest.fixture
def offline_api(client, monkeypatch, tmp_path):
    from reportlab.pdfgen import canvas

    preview = io.BytesIO()
    page = canvas.Canvas(preview)
    page.drawString(72, 720, "Offline DOI preview")
    page.save()
    monkeypatch.setattr(api_routes, "convert_docx_to_pdf", lambda data: preview.getvalue())
    monkeypatch.setattr(api_routes.settings, "PREVIEW_STORAGE_DIR", str(tmp_path / "previews"))
    monkeypatch.setattr(api_routes, "compute_paragraph_page_mapping", lambda *args, **kwargs: {"0": 1, "1": 1})
    # Exercise the real eligibility gate and empty-input task, while proving
    # neither local provider nor any outbound socket can be used.
    provider = AsyncMock(side_effect=AssertionError("DOI must never call AI"))
    monkeypatch.setattr(ai_citation, "call_ollama_local", provider)
    monkeypatch.setattr(api_routes, "async_ai_citation_task", ai_citation.async_ai_citation_task)
    network_calls = []

    def no_network(*args, **kwargs):
        network_calls.append((args, kwargs))
        raise AssertionError("DOI checks must stay offline")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    monkeypatch.setattr(socket.socket, "connect_ex", no_network)
    monkeypatch.setattr(socket, "create_connection", no_network)
    monkeypatch.setattr(socket, "getaddrinfo", no_network)
    yield client
    provider.assert_not_called()
    assert network_calls == []


@pytest.mark.parametrize(
    ("candidate", "enabled", "count", "score"),
    [(LEGACY, True, 1, 98), (CANONICAL, True, 0, 100), ("No DOI.", True, 0, 100),
     (LEGACY, False, 0, 100), ("doi:10.1234/Ab C", True, 0, 100)],
)
def test_offline_api_persistence_history_evidence_pdf_and_scores(offline_api, monkeypatch, candidate, enabled, count, score):
    client = offline_api
    data = _bytes(_document(HEAD + candidate))
    response = client.post(
        "/api/audit",
        files={"file": ("doi.docx", data, "application/octet-stream")},
        data={"custom_profile": json.dumps(_profile(enabled).to_dict())},
    )
    assert response.status_code == 200, response.text
    submitted = response.json()
    findings = submitted["physical_layout_errors"]
    assert len(findings) == count
    assert submitted["weighted_compliance_score"] == score
    assert submitted["ai_citation_tooltips"] == []
    assert submitted["profile_snapshot"]["schema_version"] == 6
    assert submitted["profile_snapshot"]["references"]["check_doi_format"] is enabled
    assert submitted["minor_count"] == count
    category = next(row for row in submitted["score_breakdown"] if row["category"] == "citation_apa")
    assert (category["minor"], category["deduction"]) == (count, count * 2)
    if count:
        assert findings[0]["rule_code"] == RULE
        assert findings[0]["actual_value"] == candidate
        assert findings[0]["expected_value"] == REQUIRED
        assert findings[0]["location"] == {"paragraph_index": 1}
        assert findings[0]["severity"] == "MINOR"
    audit_id = submitted["audit_id"]

    def no_redetection(*args, **kwargs):
        raise AssertionError("Reload/export must use immutable persisted findings")

    monkeypatch.setattr(api_routes, "run_static_rules_engine", no_redetection)
    detail = client.get(f"/api/audit/{audit_id}")
    assert detail.status_code == 200
    reopened = detail.json()
    assert reopened["violations"] == findings
    assert reopened["weighted_score"] == score
    assert reopened["score_breakdown"] == submitted["score_breakdown"]
    assert reopened["profile_snapshot"] == submitted["profile_snapshot"]
    history = client.get("/api/audits")
    assert history.status_code == 200
    assert next(row for row in history.json() if row["id"] == audit_id)["weighted_score"] == score
    envelope = client.get(f"/api/audit/{audit_id}/document-blocks").json()
    assert envelope["blocks"][1]["text"] == HEAD + candidate
    assert envelope["blocks"][1]["index"] == 1
    pdf = client.get(f"/api/audit/{audit_id}/export-pdf")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    from pypdf import PdfReader

    text = re.sub(r"\s+", " ", " ".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf.content)).pages))
    if count:
        assert REQUIRED in text
        assert re.sub(r"\s+", " ", candidate) in text
        assert TITLE in text
        assert ACTION in text
        assert text.count(ACTION) == 1
        assert f"Action {ACTION}" in text
        assert "selected profile" in text
    _assert_plain_text(json.dumps(findings) + text)
    if count:
        review = client.post(
            f"/api/audit/{audit_id}/guided-fixes/review",
            files={"file": ("doi.docx", data, "application/octet-stream")},
            data={"selection": json.dumps({"violation_ids": [findings[0]["id"]]})},
        )
        assert review.status_code == 422
        assert review.json()["detail"] == "Fix cannot be applied safely. Manual correction required."
        assert client.get(f"/api/audit/{audit_id}").json()["violations"] == findings


@pytest.mark.parametrize("profile_id", [SUC_PROFILE_ID, APA_PROFILE_ID])
def test_builtin_api_profiles_keep_doi_check_off(offline_api, profile_id):
    response = offline_api.post(
        "/api/audit",
        params={"profile_id": profile_id},
        files={"file": ("builtin.docx", _bytes(_document(LEGACY)), "application/octet-stream")},
    )
    assert response.status_code == 200, response.text
    assert response.json()["profile_snapshot"]["references"]["check_doi_format"] is False
    assert all(v["rule_code"] != RULE for v in response.json()["physical_layout_errors"])


def test_hidden_only_doi_api_label_is_silent_and_source_faithful(offline_api):
    doc = _document()
    paragraph = doc.add_paragraph(HEAD)
    _add_link(paragraph, "Read this article", "http://dx.doi.org/10.1234/HiddenSecret")
    response = offline_api.post(
        "/api/audit",
        files={"file": ("hidden.docx", _bytes(doc), "application/octet-stream")},
        data={"custom_profile": json.dumps(_profile().to_dict())},
    )
    assert response.status_code == 200, response.text
    submitted = response.json()
    assert submitted["physical_layout_errors"] == []
    assert submitted["weighted_compliance_score"] == 100
    blocks = offline_api.get(f"/api/audit/{submitted['audit_id']}/document-blocks").json()["blocks"]
    assert blocks[1]["text"] == HEAD + "Read this article"
    assert "HiddenSecret" not in json.dumps(blocks)


def test_text_only_reference_entries_do_not_require_live_objects_or_author_keys():
    paragraphs = [
        {"index": 0, "text": "References", "style_name": "Normal"},
        {"index": 1, "text": "", "style_name": "Normal"},
        {"index": 2, "text": "Unkeyable entry " + LEGACY, "style_name": "Normal"},
    ]
    findings = _doi(run_reference_rules(object(), paragraphs, _config()))
    assert len(findings) == 1
    assert findings[0].location == {"paragraph_index": 2}
    assert findings[0].actual_value == LEGACY


def test_numbered_entries_do_not_change_doi_gate_or_other_findings():
    doc = _document()
    for text, style in (("1. " + HEAD + LEGACY, None), (HEAD + LEGACY, "List Number")):
        doc.add_paragraph(text, style=style)
    off = _run(doc, False)
    on = _run(doc, True)
    assert [v.to_dict() for v in on if v.rule_code != RULE] == [v.to_dict() for v in off]
    assert [v.location for v in _doi(on)] == [{"paragraph_index": 1}, {"paragraph_index": 2}]


def test_wrapped_continuation_paragraphs_are_never_reassembled_or_repaired():
    doc = _document(HEAD + "doi:10.1234/", "ContinuationSuffix")
    assert _doi(_run(doc)) == []


@pytest.mark.parametrize("value", [None, "true", "false", 0, 1])
def test_api_validation_rejects_non_boolean_doi_toggle(offline_api, value):
    payload = _profile().to_dict()
    payload["references"]["check_doi_format"] = value
    response = offline_api.post("/api/formatting-profiles/validate", json=payload)
    assert response.status_code == 422, response.text
    result = response.json()
    assert result["valid"] is False
    assert any(error["field"] == "references.check_doi_format" for error in result["errors"])


def test_api_validation_accepts_doi_true_false_and_missing(offline_api):
    for enabled in (False, True, None):
        payload = _profile(enabled is True).to_dict()
        if enabled is None:
            del payload["references"]["check_doi_format"]
        response = offline_api.post("/api/formatting-profiles/validate", json=payload)
        assert response.status_code == 200, response.text
        assert response.json()["valid"] is True


def test_profile_disclosure_is_off_by_default_and_attributes_requirement_to_selected_profile():
    from app.services.profile_registry import _key_requirements_summary

    disabled = _profile(False)
    enabled = _profile(True)
    assert not any("DOI" in line for line in _key_requirements_summary(disabled))
    disclosure = [
        line for line in _key_requirements_summary(enabled) if "DOI" in line
    ]
    assert len(disclosure) == 1
    assert "The selected profile requires the visible DOI format " + REQUIRED in disclosure[0]
    assert "presentation only, not registration or resolution." in disclosure[0]
    _assert_plain_text(disclosure[0])
