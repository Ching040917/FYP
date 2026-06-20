"""Tests for the static layout engine and scoring math."""
import pytest
from docx import Document
from docx.shared import Pt, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH

from app.services.layout_engine import run_static_rules_engine
from app.services.scoring import calculate_weighted_score
from app.services.layout_violation import LayoutViolation
from app.config import settings


# ---------------------------------------------------------------------------
# Scoring math
# ---------------------------------------------------------------------------

def test_calculate_weighted_score_clean_returns_100():
    assert calculate_weighted_score([]) == 100


def test_calculate_weighted_score_one_major_returns_85():
    v = LayoutViolation("X", "MAJOR", {}, "msg")
    assert calculate_weighted_score([v]) == 85


def test_calculate_weighted_score_one_minor_returns_97():
    v = LayoutViolation("X", "MINOR", {}, "msg")
    assert calculate_weighted_score([v]) == 97


def test_calculate_weighted_score_mixed_math():
    viols = [
        LayoutViolation("X", "MAJOR", {}, "m"),
        LayoutViolation("X", "MAJOR", {}, "m"),
        LayoutViolation("X", "MINOR", {}, "m"),
    ]
    # 100 - 15 - 15 - 3 = 67
    assert calculate_weighted_score(viols) == 67


def test_calculate_weighted_score_floors_at_zero():
    viols = [LayoutViolation("X", "MAJOR", {}, "m") for _ in range(8)]
    # 100 - 8*15 = -20, floor 0
    assert calculate_weighted_score(viols) == 0


def test_calculate_weighted_score_unknown_severity_ignored():
    v = LayoutViolation("X", "WEIRD", {}, "m")
    assert calculate_weighted_score([v]) == 100


# ---------------------------------------------------------------------------
# Layout engine — citation sensor wiring
# ---------------------------------------------------------------------------

def test_citation_mismatch_included_in_engine_output(docx_factory):
    body = [
        "Intro paragraph.",
        "Orphan (Garcia, 2018) text.",
    ]
    # no references header at all -> orphan flagged
    file_bytes = docx_factory(paragraphs=body, references=None)
    viols = run_static_rules_engine(file_bytes)
    codes = [v.rule_code for v in viols]
    assert "CITATION_MISMATCH" in codes
    cm = next(v for v in viols if v.rule_code == "CITATION_MISMATCH")
    assert cm.severity == "MAJOR"
    assert "Garcia" in cm.message


def test_present_citation_not_flagged(docx_factory):
    body = ["Smith (2020) wrote…"]
    refs = ["Smith, J. (2020). Title. Press."]
    file_bytes = docx_factory(paragraphs=body, references=refs)
    viols = run_static_rules_engine(file_bytes)
    codes = [v.rule_code for v in viols]
    assert "CITATION_MISMATCH" not in codes


# ---------------------------------------------------------------------------
# Layout engine — preset conformance
# ---------------------------------------------------------------------------

def test_wrong_margin_triggers_major(docx_factory):
    # SUC left = 1.5in; we set 1.0in
    body = ["Body text."]
    refs = []  # avoid citation noise
    file_bytes = docx_factory(
        paragraphs=body, references=refs, margins={"left": 1.0, "right": 1.0, "top": 1.0, "bottom": 1.0}
    )
    viols = run_static_rules_engine(file_bytes)
    codes = [v.rule_code for v in viols]
    assert "MARGIN_LEFT" in codes
    mv = next(v for v in viols if v.rule_code == "MARGIN_LEFT")
    assert mv.severity == "MAJOR"


def test_wrong_body_font_triggers_minor(docx_factory):
    body = ["Body text using Arial."]
    refs = []
    file_bytes = docx_factory(
        paragraphs=body, references=refs,
        margins={"left": 1.5, "right": 1.0, "top": 1.0, "bottom": 1.0},
        font_name="Arial",
    )
    viols = run_static_rules_engine(file_bytes)
    codes = [v.rule_code for v in viols]
    assert "FONT_CONSISTENCY" in codes
    fc = next(v for v in viols if v.rule_code == "FONT_CONSISTENCY")
    assert fc.severity == "MINOR"


def test_uncaptioned_table_triggers_minor(docx_factory):
    body = ["Body text."]
    refs = []
    file_bytes = docx_factory(
        paragraphs=body, references=refs,
        margins={"left": 1.5, "right": 1.0, "top": 1.0, "bottom": 1.0},
        tables=[[["A", "B"], ["1", "2"]]],
        with_caption=False,
    )
    viols = run_static_rules_engine(file_bytes)
    codes = [v.rule_code for v in viols]
    assert "TABLE_CAPTION_MISSING" in codes
    tc = next(v for v in viols if v.rule_code == "TABLE_CAPTION_MISSING")
    assert tc.severity == "MINOR"
