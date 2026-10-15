"""Focused tests for the SPACE_BEFORE/SPACE_AFTER scoring fix.

Covers:
- explicit paragraph_typography mapping for the two generic spacing codes
  (current contract) vs the exact pre-fix uncategorised mapping (legacy
  contract);
- the dual-contract selector: consistent / legacy_spacing / inconsistent
  (including the invariant-degradation path);
- GET / History / PDF historical reconciliation against immutable stored
  scores;
- new-audit parity (POST == GET) and non-completed audits.

No production code, weights, caps, snapshots, or migrations are modified
here — this file only pins the contract.
"""
import io
import re
import uuid

from sqlalchemy.orm import sessionmaker

from app.models.audit import AuditRecord, Violation
from app.services.layout_violation import LayoutViolation
from app.services.scoring import (
    LEGACY_SPACING_CATEGORY,
    LEGACY_SPACING_LABEL,
    ScoreBreakdownItem,
    ScoreResult,
    calculate_weighted_score_detailed,
    rule_code_to_category,
    select_scoring_contract,
)
from app.api import routes as api_routes
from app.config import settings

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _violations(counts):
    """Build a LayoutViolation list from {(rule_code, severity): n}."""
    out = []
    for (code, severity), n in counts.items():
        out.extend(LayoutViolation(code, severity, {}, f"{code} message") for _ in range(n))
    return out


def _selection(stored, violations):
    cur = calculate_weighted_score_detailed(violations)
    leg = calculate_weighted_score_detailed(violations, legacy_spacing=True)
    return select_scoring_contract(stored, cur, leg), cur, leg


def _deductions(result):
    return {b.category: b.deduction for b in result.breakdown if b.deduction}


def _pdf_text(pdf_bytes):
    from pypdf import PdfReader
    raw = "\n".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(pdf_bytes)).pages)
    return re.sub(r"\s+", " ", raw)


def _seed_audit(test_engine, status="completed", weighted_score=97, violations=(), **fields):
    Session = sessionmaker(bind=test_engine)
    s = Session()
    audit_id = fields.pop("id", str(uuid.uuid4()))
    rec = AuditRecord(
        id=audit_id,
        filename=fields.pop("filename", "seeded.docx"),
        file_size=100,
        weighted_score=weighted_score,
        deploy_mode=fields.pop("deploy_mode", "LOCAL"),
        status=status,
    )
    s.add(rec)
    for v in violations:
        s.add(Violation(id=str(uuid.uuid4()), audit_id=audit_id, **v))
    s.commit()
    s.close()
    return audit_id


def _space_violation(rule_code, severity="MINOR", paragraph_index=3,
                     expected="0pt", actual="12pt"):
    return {
        "rule_code": rule_code,
        "severity": severity,
        "location": {"paragraph_index": paragraph_index},
        "message": f"{rule_code} {actual} != {expected}",
        "expected_value": expected,
        "actual_value": actual,
    }


def _spacing_docx_bytes(space_after):
    """A minimal docx with one body paragraph at the given space_after (pt)."""
    from docx import Document
    from docx.shared import Pt
    doc = Document()
    p = doc.add_paragraph("Body text.")
    p.paragraph_format.space_after = Pt(space_after)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 1. Mapping regression control
# ---------------------------------------------------------------------------

def test_space_codes_map_to_paragraph_typography_under_current_contract():
    assert rule_code_to_category("SPACE_BEFORE") == "paragraph_typography"
    assert rule_code_to_category("SPACE_AFTER") == "paragraph_typography"
    # case-insensitive: codes arrive uppercase from the engine, but pin both
    assert rule_code_to_category("space_before") == "paragraph_typography"
    assert rule_code_to_category("SPACE_AFTER", legacy_spacing=False) == "paragraph_typography"


def test_space_codes_fall_to_uncategorised_under_legacy_contract():
    assert rule_code_to_category("SPACE_BEFORE", legacy_spacing=True) == "uncategorised"
    assert rule_code_to_category("SPACE_AFTER", legacy_spacing=True) == "uncategorised"


def test_every_other_rule_code_maps_identically_in_both_contracts():
    """The two contracts MUST differ only for the generic spacing codes —
    this is what makes the dual-contract selector well-defined and the
    legacy deduction monotonic (legacy >= current for every reachable row
    mix). Any other code that differs would silently misclassify audits."""
    codes = [
        "MARGIN_LEFT", "MARGIN_RIGHT", "MARGIN_TOP", "MARGIN_BOTTOM",
        "FONT_CONSISTENCY", "FONT_SIZE", "LINE_SPACING", "SPACE_BEFORE",
        "SPACE_AFTER", "ALIGNMENT", "HEADING_HIERARCHY",
        "TABLE_CAPTION_MISSING", "IMAGE_CAPTION_MISSING", "MANUAL_CAPTION",
        "IMAGE_ALT_TEXT_MISSING",
        "CITATION_MISMATCH", "CITATION_REFERENCE_MISMATCH",
        "CITATION_YEAR_SUFFIX_MISMATCH", "CITATION_REFERENCE_AMBIGUOUS",
        "REFERENCE_NOT_CITED", "REFERENCE_DUPLICATE",
        "REFERENCE_HEADING_TEXT", "REFERENCE_HEADING_BOLD",
        "REFERENCE_HEADING_ALIGNMENT", "REFERENCE_SECTION_NEW_PAGE",
        "REFERENCE_HANGING_INDENT", "REFERENCE_SPACE_BEFORE",
        "REFERENCE_SPACE_AFTER", "REFERENCE_FONT_FAMILY",
        "REFERENCE_FONT_SIZE", "REFERENCE_ALIGNMENT",
    ]
    for code in codes:
        if code in ("SPACE_BEFORE", "SPACE_AFTER"):
            continue
        assert rule_code_to_category(code) == rule_code_to_category(code, legacy_spacing=True), code
    # Unknown codes fall through identically too.
    assert rule_code_to_category("SOME_FUTURE_CODE") == rule_code_to_category("SOME_FUTURE_CODE", legacy_spacing=True)


# ---------------------------------------------------------------------------
# 2. Confirmed legacy / current / both-equal cases (unit, no DB)
# ---------------------------------------------------------------------------

def test_confirmed_legacy_space_before_audit():
    """The required legacy fixture: 1x SPACE_BEFORE Minor, stored score 97.
    Legacy contract: uncategorised minor weight 3 -> 97. Current: paragraph
    minor weight 1 -> 99. The selector must confirm legacy and derive the
    adjustment as current_total - legacy_total = 2 (NOT a residual)."""
    viols = _violations({("SPACE_BEFORE", "MINOR"): 1})
    selection, cur, leg = _selection(97, viols)
    assert cur.total == 99
    assert leg.total == 97
    assert selection.status == "legacy_spacing"
    assert selection.adjustment == 2
    assert selection.adjustment == cur.total - leg.total
    row = selection.legacy_row
    assert row is not None
    assert row.category == LEGACY_SPACING_CATEGORY
    assert row.label == LEGACY_SPACING_LABEL
    assert row.deduction == 2
    assert row.major == 0 and row.minor == 0
    # Reconciliation invariant the selector verified: visible + adjustment
    # explains the full deduction against the stored score.
    visible = sum(_deductions(cur).values())
    assert visible + selection.adjustment == 100 - 97


def test_confirmed_legacy_space_after_audit():
    viols = _violations({("SPACE_AFTER", "MINOR"): 1})
    selection, cur, leg = _selection(97, viols)
    assert cur.total == 99 and leg.total == 97
    assert selection.status == "legacy_spacing"
    assert selection.adjustment == 2


def test_confirmed_current_audit_has_no_adjustment_row():
    viols = _violations({("SPACE_BEFORE", "MINOR"): 1})
    selection, cur, _ = _selection(99, viols)
    assert cur.total == 99
    assert selection.status == "consistent"
    assert selection.adjustment == 0
    assert selection.legacy_row is None
    assert selection.note is None


def test_both_contracts_producing_same_total_selects_consistent():
    """No spacing findings: both contracts total identically. The stored
    score matching both must classify as consistent — never legacy."""
    viols = _violations({("MARGIN_LEFT", "MAJOR"): 1, ("LINE_SPACING", "MINOR"): 2})
    cur = calculate_weighted_score_detailed(viols)
    leg = calculate_weighted_score_detailed(viols, legacy_spacing=True)
    selection, _, _ = _selection(cur.total, viols)
    assert cur.total == leg.total
    assert selection.status == "consistent"
    assert selection.legacy_row is None


def test_cap_case_current_contract_is_consistent():
    """25 SPACE_AFTER rows: current caps paragraph_typography at 20 -> 80;
    legacy uncategorised cap 100 -> raw 75 -> 25. A 25-row NEW audit stores
    80 and must classify consistent with no legacy row."""
    viols = _violations({("SPACE_AFTER", "MINOR"): 25})
    selection, cur, leg = _selection(80, viols)
    assert cur.total == 80
    assert leg.total == 25
    assert selection.status == "consistent"
    assert selection.legacy_row is None
    assert _deductions(cur)["paragraph_typography"] == 20  # cap applied


def test_category_cap_legacy_case():
    """Same 25 rows, stored under the legacy contract: 25. The adjustment is
    the total difference (80 - 25 = 55), derived from the two totals, not
    from counting SPACE findings: visible capped 20 + 55 == 75 == 100 - 25."""
    viols = _violations({("SPACE_AFTER", "MINOR"): 25})
    selection, cur, leg = _selection(25, viols)
    assert selection.status == "legacy_spacing"
    assert selection.adjustment == 55
    visible = _deductions(cur)["paragraph_typography"]
    assert visible == 20
    assert visible + selection.adjustment == 100 - 25
    # The adjustment does NOT equal the naive per-finding count product
    # (25 x 1 = 25) — it is the exact total difference.
    assert selection.adjustment != 25


def test_no_spacing_historical_audit_selects_consistent():
    """A historical audit with only LINE_SPACING findings scored identically
    under both contracts -> consistent, no legacy row, no note."""
    viols = _violations({("LINE_SPACING", "MINOR"): 3, ("MARGIN_RIGHT", "MAJOR"): 1})
    cur = calculate_weighted_score_detailed(viols)
    selection, _, _ = _selection(cur.total, viols)
    assert selection.status == "consistent"
    assert selection.legacy_row is None


def test_review_and_unknown_findings_are_never_scored_or_selected():
    """REVIEW (manual review) and unknown severities carry no deduction in
    either contract; stored 100 selects consistent."""
    viols = _violations({("CITATION_REFERENCE_AMBIGUOUS", "REVIEW"): 1,
                         ("SPACE_BEFORE", "WEIRD"): 1,
                         ("SPACE_AFTER", "MINOR"): 1})
    cur = calculate_weighted_score_detailed(viols)
    leg = calculate_weighted_score_detailed(viols, legacy_spacing=True)
    selection = select_scoring_contract(leg.total, cur, leg)
    assert selection.status == "legacy_spacing"  # stored is the legacy total
    # REVIEW added nothing: 100 - (leg: 3 for SPACE_AFTER uncategorised)
    assert leg.total == 97
    # An all-unscored audit is simply consistent.
    unscored = _violations({("CITATION_REFERENCE_AMBIGUOUS", "REVIEW"): 2,
                            ("SPACE_BEFORE", "WEIRD"): 1})
    c2 = calculate_weighted_score_detailed(unscored)
    l2 = calculate_weighted_score_detailed(unscored, legacy_spacing=True)
    assert c2.total == 100 and l2.total == 100
    assert select_scoring_contract(100, c2, l2).status == "consistent"


# ---------------------------------------------------------------------------
# 3. Inconsistent stored score (matches neither contract)
# ---------------------------------------------------------------------------

def test_stored_score_matching_neither_contract_is_inconsistent():
    viols = _violations({("SPACE_BEFORE", "MINOR"): 1})
    selection, cur, leg = _selection(91, viols)
    assert cur.total == 99 and leg.total == 97
    assert selection.status == "inconsistent"
    assert selection.adjustment == 0
    assert selection.legacy_row is None
    assert selection.note is not None
    # Reader-safe wording: no internal terms leak into the note.
    assert "uncategorised" not in selection.note.lower()
    assert "legacy_spacing" not in selection.note
    assert "SPACE_BEFORE" not in selection.note


def test_unrelated_future_or_mapping_difference_is_not_labelled_legacy():
    """A stored score that matches neither contract — e.g. produced by some
    unrelated future scoring change — must never get the legacy-spacing
    label, because `stored == legacy` is false. The selector only confirms
    legacy on an exact legacy-total match."""
    viols = _violations({("SOME_FUTURE_RULE", "MINOR"): 1, ("SPACE_AFTER", "MINOR"): 1})
    cur = calculate_weighted_score_detailed(viols)
    leg = calculate_weighted_score_detailed(viols, legacy_spacing=True)
    # Future-code rows land in the hidden uncategorised bucket in BOTH
    # contracts (identically); the stored score of 84 matches neither total.
    assert cur.total != leg.total
    sel = select_scoring_contract(84, cur, leg)
    assert sel.status == "inconsistent"
    assert sel.legacy_row is None


def test_corrupted_or_incomplete_persisted_findings_select_inconsistent():
    """Malformed severity tokens are ignored by both contracts. A stored
    score that no longer matches either total (rows lost, rows corrupted)
    is inconsistent — never misclassified as legacy spacing."""
    viols = _violations({("SPACE_BEFORE", "MINOR"): 1, ("SPACE_AFTER", "WEIRD"): 2})
    cur = calculate_weighted_score_detailed(viols)
    leg = calculate_weighted_score_detailed(viols, legacy_spacing=True)
    # 97 IS the legacy total here (only the one valid MINOR row scores).
    sel = select_scoring_contract(leg.total, cur, leg)
    assert sel.status == "legacy_spacing"
    # But a corrupted stored score that matches neither:
    sel2 = select_scoring_contract(55, cur, leg)
    assert sel2.status == "inconsistent"
    assert sel2.legacy_row is None
    assert sel2.note is not None


def test_invariant_break_degrades_legacy_match_to_inconsistent():
    """Even when stored == legacy total, a broken presentation invariant
    (visible deductions + adjustment != 100 - stored) must NOT emit the
    adjustment row. Simulated with a hand-built contradictory result: the
    current total claims 98 while its visible deduction is only 1, so
    stored=97 leaves an unexplained residual of 1."""
    viols = _violations({("SPACE_BEFORE", "MINOR"): 1})
    leg = calculate_weighted_score_detailed(viols, legacy_spacing=True)
    fake_current = ScoreResult(
        total=98,
        major_count=0,
        minor_count=1,
        breakdown=[
            ScoreBreakdownItem("page_margins", "Page Margins", 0, 0, 0, 100),
            ScoreBreakdownItem("paragraph_typography", "Paragraph Typography", 0, 1, 1, 99),
        ],
    )
    sel = select_scoring_contract(97, fake_current, leg)
    assert sel.status == "inconsistent"
    assert sel.legacy_row is None
    # Sanity: the real (non-fake) current result DOES verify.
    real_cur = calculate_weighted_score_detailed(viols)
    assert select_scoring_contract(97, real_cur, leg).status == "legacy_spacing"


def test_legacy_adjustment_is_never_negative():
    """For spacing rows, the legacy contract ALWAYS deducts at least as
    much as the current one (legacy uncategorised minor weight 3, cap 100,
    vs current paragraph minor weight 1, cap 20). Therefore
    legacy_total <= current_total, and a confirmed legacy match
    (stored == legacy total) yields a non-negative adjustment
    (current - legacy). Pin that across a range of spacing row counts."""
    for n in range(0, 40):
        viols = _violations({("SPACE_AFTER", "MINOR"): n, ("SPACE_BEFORE", "MINOR"): n})
        cur = calculate_weighted_score_detailed(viols)
        leg = calculate_weighted_score_detailed(viols, legacy_spacing=True)
        assert leg.total <= cur.total
        sel = select_scoring_contract(leg.total, cur, leg)
        if n == 0:
            assert sel.status == "consistent"
            assert sel.adjustment == 0
        else:
            assert sel.status == "legacy_spacing"
            assert sel.adjustment > 0


# ---------------------------------------------------------------------------
# 4. GET / History / PDF historical reconciliation (API level)
# ---------------------------------------------------------------------------

def test_get_confirmed_legacy_space_before_reconciles_stored_score(client, test_engine):
    aid = _seed_audit(test_engine, weighted_score=97,
                      violations=[_space_violation("SPACE_BEFORE")])
    resp = client.get(f"/api/audit/{aid}")
    assert resp.status_code == 200
    body = resp.json()
    # The immutable stored score is preserved verbatim.
    assert body["weighted_score"] == 97
    assert body["score_consistency"] == {
        "status": "legacy_spacing",
        "note": "This completed audit used an earlier spacing-scoring contract. "
                 "Its original score is preserved, and the Legacy spacing adjustment "
                 "explains the difference in the category breakdown.",
    }
    breakdown = {b["category"]: b for b in body["score_breakdown"]}
    pt = breakdown["paragraph_typography"]
    assert pt["deduction"] == 1
    assert breakdown[LEGACY_SPACING_CATEGORY]["deduction"] == 2
    # Full deduction explanation: 1 + 2 == 100 - 97.
    assert sum(b["deduction"] for b in body["score_breakdown"]) == 3


def test_get_confirmed_current_audit_has_no_legacy_row(client, test_engine):
    aid = _seed_audit(test_engine, weighted_score=99,
                      violations=[_space_violation("SPACE_BEFORE")])
    body = client.get(f"/api/audit/{aid}").json()
    assert body["weighted_score"] == 99
    assert body["score_consistency"]["status"] == "consistent"
    assert LEGACY_SPACING_CATEGORY not in {b["category"] for b in body["score_breakdown"]}
    assert sum(b["deduction"] for b in body["score_breakdown"]) == 1


def test_get_inconsistent_preserves_stored_score_and_warns(client, test_engine, caplog):
    import logging
    aid = _seed_audit(test_engine, weighted_score=91,
                      violations=[_space_violation("SPACE_BEFORE")])
    with caplog.at_level(logging.WARNING, logger="app.api.routes"):
        body = client.get(f"/api/audit/{aid}").json()
    assert body["weighted_score"] == 91  # stored score preserved
    assert body["score_consistency"]["status"] == "inconsistent"
    assert body["score_consistency"]["note"] == (
        "This completed audit's stored score cannot be fully reconstructed "
        "from its saved findings. The original score is preserved."
    )
    # No adjustment row, no residual re-attribution:
    assert LEGACY_SPACING_CATEGORY not in {b["category"] for b in body["score_breakdown"]}
    assert "mismatch" in caplog.text


def test_history_list_shows_stored_score(client, test_engine):
    """GET /api/audits (History) carries the immutable stored score — the
    GET detail and History can therefore never disagree on the number."""
    aid = _seed_audit(test_engine, weighted_score=97,
                      violations=[_space_violation("SPACE_BEFORE")])
    body = client.get("/api/audits").json()
    row = next(a for a in body if a["id"] == aid)
    assert row["weighted_score"] == 97
    # And the GET detail agrees:
    assert client.get(f"/api/audit/{aid}").json()["weighted_score"] == 97


def test_pdf_confirmed_legacy_explains_stored_score(client, test_engine):
    from app.services.pdf_report import generate_audit_pdf
    aid = _seed_audit(test_engine, weighted_score=97,
                      violations=[_space_violation("SPACE_BEFORE")])
    audit = _get_model(test_engine, aid)
    pdf = generate_audit_pdf(audit, list(audit.violations), list(audit.citation_issues),
                             profile_snapshot=audit.profile_snapshot)
    text = _pdf_text(pdf)
    # The stored score is displayed, not a recomputation.
    assert re.search(r"\b97\s*/\s*100\b", text)
    # The presentation-only row reconciles: 1 (paragraph typography) +
    # 2 (legacy adjustment) == 3 == 100 - 97.
    assert "Legacy spacing adjustment" in text
    assert "This completed audit used an earlier spacing-scoring contract." in text


def test_pdf_inconsistent_audit_gets_safe_notice_not_legacy_row(client, test_engine):
    from app.services.pdf_report import generate_audit_pdf
    aid = _seed_audit(test_engine, weighted_score=91,
                      violations=[_space_violation("SPACE_BEFORE")])
    audit = _get_model(test_engine, aid)
    text = _pdf_text(generate_audit_pdf(
        audit, list(audit.violations), list(audit.citation_issues),
        profile_snapshot=audit.profile_snapshot))
    assert re.search(r"\b91\s*/\s*100\b", text)
    assert "cannot be fully reconstructed" in text
    # Never mislabelled:
    assert "Legacy spacing adjustment" not in text


def test_pdf_new_style_audit_has_no_legacy_row(client, test_engine):
    from app.services.pdf_report import generate_audit_pdf
    aid = _seed_audit(test_engine, weighted_score=99,
                      violations=[_space_violation("SPACE_BEFORE")])
    audit = _get_model(test_engine, aid)
    text = _pdf_text(generate_audit_pdf(
        audit, list(audit.violations), list(audit.citation_issues),
        profile_snapshot=audit.profile_snapshot))
    assert re.search(r"\b99\s*/\s*100\b", text)
    assert "Legacy spacing adjustment" not in text
    assert "cannot be fully reconstructed" not in text


def _get_model(test_engine, audit_id):
    Session = sessionmaker(bind=test_engine)
    s = Session()
    try:
        audit = s.query(AuditRecord).filter(AuditRecord.id == audit_id).first()
        s.refresh(audit, ["violations", "citation_issues"])
        return audit
    finally:
        s.close()


# ---------------------------------------------------------------------------
# 5. New-audit pipeline parity (POST == GET == History == PDF)
# ---------------------------------------------------------------------------

def test_new_audit_pipeline_spacing_score_parity(client, test_engine, monkeypatch):
    """A freshly POSTed audit with one SPACE_AFTER finding (space_after=12pt
    vs the 6pt body preset) scores under the CURRENT contract and the same
    total must survive POST -> GET -> History -> PDF."""
    monkeypatch.setattr(
        api_routes, "convert_docx_to_pdf",
        lambda _bytes: _fake_rendered_pdf(2),
    )
    post = client.post(
        "/api/audit",
        files={"file": ("spacing.docx", _spacing_docx_bytes(12.0), "application/octet-stream")},
    )
    assert post.status_code == 200, post.text
    post_body = post.json()
    assert post_body["score_consistency"] == {"status": "consistent", "note": None}
    new_score = post_body["weighted_compliance_score"]
    # The default SUC profile checks body font (1x FONT_SIZE MINOR) and body
    # spacing (12pt vs 6pt preset -> 1x SPACE_AFTER MINOR); margins are not
    # enabled, so the expected total is 100 - 1 - 1 = 98, and the spacing
    # deduction must be VISIBLE under paragraph_typography (1 point), not
    # hidden in an uncategorised bucket (3 points legacy).
    assert new_score == 98
    categories = [b["category"] for b in post_body["score_breakdown"]]
    assert LEGACY_SPACING_CATEGORY not in categories
    assert "paragraph_typography" in categories
    pt = next(b for b in post_body["score_breakdown"] if b["category"] == "paragraph_typography")
    assert pt["deduction"] == 1
    assert pt["minor"] == 1

    audit_id = post_body["audit_id"]
    get_body = client.get(f"/api/audit/{audit_id}").json()
    assert get_body["weighted_score"] == new_score
    assert get_body["score_consistency"]["status"] == "consistent"
    assert LEGACY_SPACING_CATEGORY not in [b["category"] for b in get_body["score_breakdown"]]
    # Full deduction explanation from the breakdown alone:
    assert sum(b["deduction"] for b in get_body["score_breakdown"]) == 100 - new_score

    # History parity:
    history = next(a for a in client.get("/api/audits").json() if a["id"] == audit_id)
    assert history["weighted_score"] == new_score

    # PDF parity: the exported report shows the same stored score and no
    # legacy row.
    from app.services.pdf_report import generate_audit_pdf
    audit = _get_model(test_engine, audit_id)
    text = _pdf_text(generate_audit_pdf(
        audit, list(audit.violations), list(audit.citation_issues),
        profile_snapshot=audit.profile_snapshot))
    assert re.search(rf"\b{new_score}\s*/\s*100\b", text)
    assert "Legacy spacing adjustment" not in text


def test_non_completed_audit_uses_current_contract_only(client, test_engine):
    """In-flight audits keep the live current-contract computation: no
    historical consistency classification and no legacy row are produced,
    even when the running total happens to match the legacy total."""
    # Seeded with a concrete pre-completion placeholder score; the contract
    # under test is that a NON-completed audit is never classified against
    # either scoring contract, and never gets the legacy adjustment row —
    # only the live current-contract breakdown.
    aid = _seed_audit(test_engine, status="processing", weighted_score=0,
                      violations=[_space_violation("SPACE_BEFORE")])
    body = client.get(f"/api/audit/{aid}").json()
    assert body["score_consistency"] is None
    assert LEGACY_SPACING_CATEGORY not in [b["category"] for b in body["score_breakdown"]]
    # The current-contract breakdown is still live: the SPACE_BEFORE
    # finding is visible under paragraph_typography (1 point), so the
    # visible total is 99 — not the legacy 97 that would only appear if a
    # legacy row had been attached.
    visible = sum(b["deduction"] for b in body["score_breakdown"])
    assert visible == 1

def _fake_rendered_pdf(page_count: int = 2) -> bytes:
    """Minimal valid multi-page PDF bytes so the POST pipeline's best-effort
    rendered-preview step succeeds without LibreOffice."""
    import io as _io
    from reportlab.pdfgen import canvas as _pdfcanvas
    buf = _io.BytesIO()
    c = _pdfcanvas.Canvas(buf)
    for _ in range(page_count):
        c.showPage()
    c.save()
    return buf.getvalue()