"""Tests for deterministic paragraph→rendered-page mapping."""
import io

from app.services.page_mapping import (
    compute_paragraph_page_mapping,
    sanitize_stored_mapping,
    excerpt_for_paragraph,
    is_whole_paragraph_affected,
)


def _make_pdf_bytes(pages_text):
    """Create a minimal PDF with one page per text block via reportlab."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import letter
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    for text in pages_text:
        # Simple: one page per text block, draw text
        c.drawString(100, 500, text)
        c.showPage()
    c.save()
    return buf.getvalue()


def test_single_page_mapping():
    pdf = _make_pdf_bytes(["Hello World Paragraph One"])
    paras = [{"index": 0, "text": "Hello World Paragraph One"}]
    mapping = compute_paragraph_page_mapping(paras, pdf, rendered_preview_pages=1)
    assert mapping == {"0": 1}


def test_multi_page_mapping():
    pdf = _make_pdf_bytes(["First paragraph", "Second paragraph"])
    paras = [
        {"index": 0, "text": "First paragraph"},
        {"index": 1, "text": "Second paragraph"},
    ]
    mapping = compute_paragraph_page_mapping(paras, pdf, rendered_preview_pages=2)
    assert mapping == {"0": 1, "1": 2}


def test_split_line_text():
    # PDF text may be split across lines but still contains paragraph text
    pdf = _make_pdf_bytes(["This is a long paragraph that will be split"])
    paras = [{"index": 0, "text": "This is a long paragraph that will be split"}]
    mapping = compute_paragraph_page_mapping(paras, pdf, rendered_preview_pages=1)
    assert mapping == {"0": 1}


def test_empty_paragraphs_unmapped():
    pdf = _make_pdf_bytes(["Some content"])
    paras = [{"index": 0, "text": ""}, {"index": 1, "text": "   "}]
    mapping = compute_paragraph_page_mapping(paras, pdf, rendered_preview_pages=1)
    assert mapping is None or mapping == {}


def test_ambiguous_duplicated_text_unmapped():
    # Same text on two pages → ambiguous → unmapped
    pdf = _make_pdf_bytes(["Duplicate text", "Duplicate text"])
    paras = [{"index": 0, "text": "Duplicate text"}]
    mapping = compute_paragraph_page_mapping(paras, pdf, rendered_preview_pages=2)
    # Ambiguous should be left unmapped (conservative)
    assert mapping is None or "0" not in mapping


def test_unicode():
    pdf = _make_pdf_bytes(["Café résumé — “quotes”"])
    paras = [{"index": 0, "text": "Café résumé — “quotes”"}]
    mapping = compute_paragraph_page_mapping(paras, pdf, rendered_preview_pages=1)
    assert mapping == {"0": 1}


def test_invalid_pdf_returns_none():
    mapping = compute_paragraph_page_mapping(
        [{"index": 0, "text": "Hello"}],
        b"not a pdf",
        rendered_preview_pages=1,
    )
    assert mapping is None


def test_mapping_failure_does_not_expose_text(caplog):
    pdf = b"%PDF invalid but header"
    paras = [{"index": 0, "text": "Secret FYP text that should not appear in logs"}]
    mapping = compute_paragraph_page_mapping(paras, pdf)
    assert mapping is None
    # Ensure no log contains the secret text
    for record in caplog.records:
        assert "Secret FYP" not in record.getMessage()


def test_invalid_mapping_values_ignored():
    raw = {"0": 1, "1": 999, "bad": "x", "-1": 1, "2": 0}
    cleaned = sanitize_stored_mapping(raw, rendered_preview_pages=2)
    assert cleaned == {"0": 1}


def test_mapping_bounded_by_rendered_preview_pages():
    pdf = _make_pdf_bytes(["A", "B"])
    paras = [{"index": 0, "text": "A"}, {"index": 1, "text": "B"}]
    # Provide mapping that would be page 2, but bound to 1 → should be ignored on read
    raw = {"0": 1, "1": 2}
    cleaned = sanitize_stored_mapping(raw, rendered_preview_pages=1)
    assert cleaned == {"0": 1}
    # Also test that compute respects bound
    mapping = compute_paragraph_page_mapping(paras, pdf, rendered_preview_pages=1)
    # Second paragraph on page 2 should be ignored when bound is 1
    # Our compute does not currently filter on read but on compute, it checks bound
    # So second mapping should be absent
    assert mapping is None or mapping.get("1") is None


def test_excerpt_normalization():
    assert excerpt_for_paragraph("  Hello   World  ") == "Hello World"
    assert excerpt_for_paragraph("a" * 100) is not None
    long = "a" * 90
    excerpt = excerpt_for_paragraph(long)
    assert excerpt.endswith("…")
    assert len(excerpt) <= 81


def test_is_whole_paragraph_affected():
    assert is_whole_paragraph_affected("ALIGNMENT", {"paragraph_index": 0}) is True
    assert is_whole_paragraph_affected("FONT_SIZE", {"paragraph_index": 0, "run_index": 0}) is False
    assert is_whole_paragraph_affected("FONT_SIZE", {"paragraph_index": 0}) is True
