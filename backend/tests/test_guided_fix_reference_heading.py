"""Only an unambiguous, verified Reference heading may receive an alignment fix."""
import hashlib
import io
import json
from types import SimpleNamespace

import pytest
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from app.services.profile_schema import new_custom_profile
from app.services.guided_fix import GuidedFixFailed, review_targets
from app.services.profile_snapshot import resolve_snapshot
from tests.test_guided_fixes import _fix_post


RULE = "REFERENCE_HEADING_ALIGNMENT"


def _source(*, duplicate=False, table=False, field=False, inherited=False):
    doc = Document()
    doc.add_paragraph("A body paragraph.")
    heading = doc.add_paragraph("References")
    if inherited:
        heading.style = "Heading 1"
        doc.styles["Heading 1"].paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
    else:
        heading.alignment = WD_ALIGN_PARAGRAPH.LEFT
    if field:
        run = heading.add_run()
        run._r.append(OxmlElement("w:fldChar"))
        run._r[-1].set(qn("w:fldCharType"), "begin")
    doc.add_paragraph("Smith, A. (2024). An entry. Press.")
    if duplicate:
        doc.add_paragraph("References")
    if table:
        doc.add_table(rows=1, cols=1).cell(0, 0).text = "References"
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _audit(client, source, *, enabled=True, required="center"):
    profile = new_custom_profile("Reference heading alignment")
    profile.references.check_heading_alignment = enabled
    profile.references.heading_alignment = required
    result = client.post("/api/audit", data={"custom_profile": json.dumps(profile.to_dict())},
                         files={"file": ("source.docx", source)})
    assert result.status_code == 200, result.text
    findings = [v for v in result.json()["physical_layout_errors"] if v["rule_code"] == RULE]
    return result.json(), findings


@pytest.mark.parametrize("inherited", [False, True])
def test_unique_heading_review_apply_download_and_reaudit(client, tmp_path, monkeypatch, inherited):
    from app.services import guided_fix_storage
    monkeypatch.setattr(guided_fix_storage.settings, "GUIDED_FIX_STORAGE_DIR", str(tmp_path))
    source = _source(inherited=inherited)
    original_digest = hashlib.sha256(source).digest()
    audit, findings = _audit(client, source)
    assert len(findings) == 1
    finding = findings[0]
    assert finding["location"] == {"paragraph_index": 1}
    assert finding["actual_value"] == "Left"
    assert finding["expected_value"] == "Center"
    base = f'/api/audit/{audit["audit_id"]}/guided-fixes'
    selection = {"selection": json.dumps({"violation_ids": [finding["id"]]})}
    review = client.post(base + "/review", data=selection, files={"file": ("source.docx", source)})
    assert review.status_code == 200, review.text
    assert review.json()["items"][0]["locations"] == ["Paragraph 2"]
    assert review.json()["items"][0]["before"] == "Left"
    assert review.json()["items"][0]["after"] == "Center"
    applied = client.post(base, data={**selection, "review_id": review.json()["review_id"]},
                          files={"file": ("source.docx", source)})
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "passed"
    assert applied.json()["resolved"] == [finding["id"]]
    assert applied.json()["new_findings"] == []
    output = client.get(base + "/download/" + applied.json()["download_token"])
    assert output.status_code == 200
    doc = Document(io.BytesIO(output.content))
    assert doc.paragraphs[1].alignment == WD_ALIGN_PARAGRAPH.CENTER
    assert doc.paragraphs[1].text == "References"
    assert doc.paragraphs[0].text == "A body paragraph."
    assert hashlib.sha256(source).digest() == original_digest
    assert hashlib.sha256(output.content).digest() != original_digest
    assert RULE not in [v["rule_code"] for v in _audit(client, output.content)[1]]


@pytest.mark.parametrize("variant", ["duplicate", "table", "field"])
def test_ambiguous_or_unsafe_heading_has_no_download(client, variant):
    source = _source(**{variant: True})
    audit, findings = _audit(client, source)
    assert findings
    response = _fix_post(client, audit["audit_id"], source, [findings[0]["id"]])
    assert response.status_code == 422


def test_disabled_profile_has_no_heading_candidate(client):
    _, findings = _audit(client, _source(), enabled=False)
    assert findings == []


def test_already_matching_heading_has_no_candidate(client):
    _, findings = _audit(client, _source(), required="left")
    assert findings == []


@pytest.mark.parametrize("change", ["wrong_location", "extra_location", "wrong_required", "stale_actual", "disabled"])
def test_persisted_target_must_match_heading_source_and_saved_profile(change):
    source = _source()
    profile = new_custom_profile("Persisted Reference rule")
    profile.references.check_heading_alignment = change != "disabled"
    profile.references.heading_alignment = "center"
    audit = SimpleNamespace(profile_snapshot=resolve_snapshot(profile).to_dict())
    finding = SimpleNamespace(
        id="heading-1", rule_code=RULE, location={"paragraph_index": 1},
        actual_value="Left", expected_value="Center",
    )
    if change == "wrong_location":
        finding.location = {"paragraph_index": 0}
    elif change == "extra_location":
        finding.location["paragraph_indexes"] = [1]
    elif change == "wrong_required":
        finding.expected_value = "Right"
    elif change == "stale_actual":
        finding.actual_value = "Right"
    with pytest.raises(GuidedFixFailed):
        review_targets(audit, source, [finding])
