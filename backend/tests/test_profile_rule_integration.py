"""Profile → deterministic-rule integration — Build 4 tests.

Compares the SAME controlled DOCX under SUC, APA 7, and a custom profile:
  - 1 in left margin fails SUC but passes APA;
  - References 2.0 passes both SUC and APA;
  - APA heading does not receive a 16 pt requirement (inherits body pair);
  - custom nullable requirement creates no finding;
  - same document → reproducible but profile-dependent results;
  - each Audit stores the snapshot used;
  - modifying the source custom profile does not alter stored results;
  - allowed font pairs validate TOGETHER (valid family + wrong size → fail);
  - no global-default fallback.
"""
import base64
import io

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Inches

from app.services.layout_engine import run_static_rules_engine
from app.services.profile_preset_adapter import EffectiveProfileConfig
from app.services.profile_registry import (
    APA_PROFILE_ID,
    SUC_PROFILE_ID,
    get_builtin_profile,
)
from app.services.profile_schema import new_custom_profile
from app.services.profile_snapshot import resolve_snapshot

AM = WD_ALIGN_PARAGRAPH
_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAA"
    "BJRU5ErkJggg=="
)


def _config(profile):
    return EffectiveProfileConfig(resolve_snapshot(profile))


def _doc(
    left_margin=1.0,
    body_ls=2.0,
    heading_size=12,
    heading_font="Calibri",
    heading_ls=1.0,
    refs_ls=2.0,
    body_font="Calibri",
    body_size=11,
):
    """Controlled DOCX: 1 in margins, body 2.0 spacing, 12pt headings,
    References at 2.0."""
    doc = Document()
    for name in ("Normal", "Heading 1", "Heading 2", "Heading 3", "Caption"):
        try:
            s = doc.styles[name]
            s.font.name = "Times New Roman"
            s.font.size = Pt(12)
        except KeyError:
            pass
    sec = doc.sections[0]
    sec.left_margin = Inches(left_margin)
    sec.right_margin = Inches(1.0)
    sec.top_margin = Inches(1.0)
    sec.bottom_margin = Inches(1.0)

    p = doc.add_paragraph("Body text that is long enough to be prose here.")
    p.paragraph_format.line_spacing = body_ls
    p.alignment = AM.JUSTIFY
    for r in p.runs:
        r.font.name = body_font
        r.font.size = Pt(body_size)

    h = doc.add_paragraph("1. Introduction", style="Heading 1")
    h.paragraph_format.line_spacing = heading_ls
    h.alignment = AM.LEFT
    for r in h.runs:
        r.font.name = heading_font
        r.font.size = Pt(heading_size)

    p2 = doc.add_paragraph("More body prose after the heading here.")
    p2.paragraph_format.line_spacing = body_ls
    for r in p2.runs:
        r.font.name = body_font
        r.font.size = Pt(body_size)

    doc.add_paragraph("References", style="Heading 1")
    for ref in ["Smith, J. (2020). Title. Press.", "Garcia, A. (2018). Book. Publisher."]:
        p = doc.add_paragraph(ref)
        p.paragraph_format.line_spacing = refs_ls
        for r in p.runs:
            r.font.name = body_font
            r.font.size = Pt(body_size)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _codes(viols):
    return {v.rule_code for v in viols}


# ---------------------------------------------------------------------------
# SUC vs APA comparison
# ---------------------------------------------------------------------------

def test_one_inch_left_margin_fails_suc_passes_apa():
    """Same DOCX (1 in left margin): SUC requires 1.5 → MARGIN_LEFT; APA
    requires 1.0 → no MARGIN_LEFT."""
    file_bytes = _doc(left_margin=1.0)
    suc = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(SUC_PROFILE_ID)))
    apa = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(APA_PROFILE_ID)))
    assert "MARGIN_LEFT" in _codes(suc)
    assert "MARGIN_LEFT" not in _codes(apa)


def test_references_2_0_passes_suc_and_apa():
    """References at 2.0 line spacing passes both approved profiles."""
    file_bytes = _doc(refs_ls=2.0)
    suc = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(SUC_PROFILE_ID)))
    apa = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(APA_PROFILE_ID)))
    ref_ls_suc = [v for v in suc if v.rule_code == "LINE_SPACING" and v.location.get("paragraph_index", -1) >= 4]
    ref_ls_apa = [v for v in apa if v.rule_code == "LINE_SPACING" and v.location.get("paragraph_index", -1) >= 4]
    assert ref_ls_suc == []
    assert ref_ls_apa == []


def test_apa_heading_does_not_get_16pt_requirement():
    """APA headings inherit the body pair — a 12 pt heading under APA is
    valid if (family, size) is an allowed pair; it never gets a 16 pt
    requirement."""
    file_bytes = _doc(heading_size=12, heading_font="Calibri", body_font="Calibri", body_size=11)
    apa = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(APA_PROFILE_ID)))
    font_size = [v for v in apa if v.rule_code == "FONT_SIZE"]
    # Calibri 12 is NOT an allowed APA pair (Calibri is 11) → flagged, but
    # the message/expected must never claim 16 pt.
    for v in font_size:
        assert "16" not in (v.expected_value or "")


def test_apa_heading_inherits_body_pair_valid():
    """Calibri 11 heading under APA (inherited body pair) → no font finding."""
    file_bytes = _doc(heading_size=11, heading_font="Calibri", body_font="Calibri", body_size=11)
    apa = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(APA_PROFILE_ID)))
    assert "FONT_SIZE" not in _codes(apa)
    assert "FONT_CONSISTENCY" not in _codes(apa)


# ---------------------------------------------------------------------------
# Allowed font-pair validation (TOGETHER)
# ---------------------------------------------------------------------------

def test_allowed_font_pair_valid_family_wrong_size_rejected():
    """APA: 'Calibri 12' is invalid — Calibri is only allowed at 11 pt.
    A valid family with a size from another family must be rejected."""
    file_bytes = _doc(body_font="Calibri", body_size=12)
    apa = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(APA_PROFILE_ID)))
    fc = [v for v in apa if v.rule_code == "FONT_CONSISTENCY" and v.location.get("paragraph_index") == 0]
    assert len(fc) >= 1
    assert "Calibri" in fc[0].actual_value


def test_allowed_font_pair_valid_combo_passes():
    file_bytes = _doc(body_font="Calibri", body_size=11, heading_font="Calibri", heading_size=11)
    apa = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(APA_PROFILE_ID)))
    assert "FONT_CONSISTENCY" not in _codes(apa)
    assert "FONT_SIZE" not in _codes(apa)


# ---------------------------------------------------------------------------
# Custom profile
# ---------------------------------------------------------------------------

def test_custom_nullable_requirement_creates_no_finding():
    """A custom profile with nullable body line spacing → no LINE_SPACING
    finding for a wrong body spacing."""
    custom = new_custom_profile("NullSpacing", base=get_builtin_profile(SUC_PROFILE_ID))
    custom.body.line_spacing = None  # nullable → skip check
    custom.margins.margin_left_in = 1.0
    file_bytes = _doc(left_margin=1.0, body_ls=1.0)
    viols = run_static_rules_engine(file_bytes, config=_config(custom))
    assert "MARGIN_LEFT" not in _codes(viols)   # custom requires 1.0
    assert "LINE_SPACING" not in _codes(viols)  # nullable → skipped


def test_custom_modified_margins_and_heading_size():
    """Custom: 1.25 in margins, heading 14 pt, body 1.5 spacing."""
    custom = new_custom_profile("Custom", base=get_builtin_profile(SUC_PROFILE_ID))
    custom.margins.margin_left_in = 1.25
    custom.heading.font_size_pt = 14.0
    custom.body.line_spacing = 1.5
    custom.body.font_family = "Calibri"
    custom.body.font_size_pt = 11.0
    custom.heading.font_family = "Calibri"
    custom.heading.font_size_pt = 14.0
    file_bytes = _doc(left_margin=1.0, body_ls=1.5, heading_size=14,
                      body_font="Calibri", body_size=11, heading_font="Calibri")
    viols = run_static_rules_engine(file_bytes, config=_config(custom))
    assert "MARGIN_LEFT" in _codes(viols)       # 1.0 vs required 1.25
    assert "LINE_SPACING" not in _codes(viols)  # 1.5 matches
    assert "FONT_SIZE" not in _codes(viols)     # 14 pt heading matches
    assert "FONT_CONSISTENCY" not in _codes(viols)


# ---------------------------------------------------------------------------
# Reproducibility / snapshot binding
# ---------------------------------------------------------------------------

def test_same_document_reproducible_but_profile_dependent():
    file_bytes = _doc(left_margin=1.0, body_ls=2.0, heading_size=11,
                      heading_font="Calibri", body_font="Calibri", body_size=11)
    a1 = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(APA_PROFILE_ID)))
    a2 = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(APA_PROFILE_ID)))
    suc = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(SUC_PROFILE_ID)))
    # Same profile → identical findings.
    assert [(v.rule_code, v.severity, v.location) for v in a1] == [(v.rule_code, v.severity, v.location) for v in a2]
    # Different profile → different margin finding.
    assert ("MARGIN_LEFT", "MAJOR", {"section_index": 0}) in [
        (v.rule_code, v.severity, v.location) for v in suc
    ]
    assert ("MARGIN_LEFT", "MAJOR", {"section_index": 0}) not in [
        (v.rule_code, v.severity, v.location) for v in a1
    ]


def test_no_global_default_fallback():
    """A blank custom profile (all nulls) produces NO margin/font/spacing
    findings regardless of the document — no PresetConfig leaks in."""
    blank = new_custom_profile("Blank")
    file_bytes = _doc(left_margin=1.0, body_ls=1.0, heading_size=20)
    viols = run_static_rules_engine(file_bytes, config=_config(blank))
    assert "MARGIN_LEFT" not in _codes(viols)
    assert "FONT_SIZE" not in _codes(viols)
    assert "LINE_SPACING" not in _codes(viols)


def test_profile_aware_messages_reference_profile():
    """Findings reference the selected profile by name."""
    file_bytes = _doc(left_margin=1.0)
    suc = run_static_rules_engine(file_bytes, config=_config(get_builtin_profile(SUC_PROFILE_ID)))
    ml = next(v for v in suc if v.rule_code == "MARGIN_LEFT")
    assert '"SUC Academic Report"' in ml.message
    assert "requires 1.50 in" in ml.message


# ---------------------------------------------------------------------------
# Audit-level snapshot binding (POST uses the snapshot config)
# ---------------------------------------------------------------------------

def test_audit_uses_snapshot_config_and_stores_it(client):
    """The audit's findings are produced from the stored snapshot config —
    the same document audited under different profiles gives different
    results, and each audit stores its snapshot."""
    from tests.test_profile_persistence import _docx_bytes  # reuse builder

    def _post(profile_id):
        return client.post(
            "/api/audit",
            files={"file": ("t.docx", _docx_bytes(), "application/octet-stream")},
            params={"profile_id": profile_id},
        )

    # This builder produces a default-margin doc — SUC (1.5) flags left margin.
    from app.config import settings
    # Build a doc with 1.0 left margin explicitly.
    doc = Document()
    doc.sections[0].left_margin = Inches(1.0)
    doc.sections[0].right_margin = Inches(1.0)
    doc.sections[0].top_margin = Inches(1.0)
    doc.sections[0].bottom_margin = Inches(1.0)
    p = doc.add_paragraph("Body text that is long enough to be prose here.")
    p.paragraph_format.line_spacing = 1.5
    p.alignment = AM.JUSTIFY
    for r in p.runs:
        r.font.name = "Times New Roman"
        r.font.size = Pt(12)
    doc.add_paragraph("References", style="Heading 1")
    for ref in ["Smith, J. (2020). Title. Press."]:
        p = doc.add_paragraph(ref)
        p.paragraph_format.line_spacing = 2.0
        for r in p.runs:
            r.font.name = "Times New Roman"
            r.font.size = Pt(12)
    buf = io.BytesIO()
    doc.save(buf)
    doc_bytes = buf.getvalue()

    def _post_bytes(profile_id):
        return client.post(
            "/api/audit",
            files={"file": ("t.docx", doc_bytes, "application/octet-stream")},
            params={"profile_id": profile_id},
        )

    suc_post = _post_bytes(SUC_PROFILE_ID)
    apa_post = _post_bytes(APA_PROFILE_ID)
    assert suc_post.status_code == 200
    assert apa_post.status_code == 200
    suc_codes = {v["rule_code"] for v in suc_post.json()["physical_layout_errors"]}
    apa_codes = {v["rule_code"] for v in apa_post.json()["physical_layout_errors"]}
    assert "MARGIN_LEFT" in suc_codes
    assert "MARGIN_LEFT" not in apa_codes
    # Each audit stores the snapshot it used.
    assert suc_post.json()["profile_snapshot"]["profile_id"] == SUC_PROFILE_ID
    assert apa_post.json()["profile_snapshot"]["profile_id"] == APA_PROFILE_ID
    # GET returns the stored snapshot.
    get = client.get(f"/api/audit/{apa_post.json()['audit_id']}")
    assert get.json()["profile_snapshot"]["profile_id"] == APA_PROFILE_ID


def test_modifying_custom_source_does_not_alter_stored_results(client):
    """Editing the source custom profile after the audit never changes the
    stored findings/snapshot."""
    custom = new_custom_profile("SourceMut", base=get_builtin_profile(APA_PROFILE_ID))
    from app.services.profile_resolver import resolve_request_profile
    snapshot = resolve_request_profile(custom_profile=custom.to_dict())
    stored_fp = snapshot.fingerprint

    # Audit with this custom profile.
    doc = Document()
    doc.add_paragraph("Body text that is long enough to be prose here.")
    buf = io.BytesIO()
    doc.save(buf)
    resp = client.post(
        "/api/audit",
        files={"file": ("t.docx", buf.getvalue(), "application/octet-stream")},
        data={"custom_profile": __import__("json").dumps(custom.to_dict())},
    )
    assert resp.status_code == 200
    audit_id = resp.json()["audit_id"]
    findings = resp.json()["physical_layout_errors"]

    # Mutate the source profile.
    custom.margins.margin_left_in = 3.0
    custom.body.font_family = "Comic Sans"

    get = client.get(f"/api/audit/{audit_id}").json()
    assert get["profile_snapshot"]["fingerprint"] == stored_fp
    assert get["violations"] == findings
