from docx import Document
from docx.shared import Pt, Inches, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from typing import List, Dict, Any, Optional
import io


def parse_document(file_bytes: bytes) -> Document:
    """Load .docx from bytes into python-docx Document."""
    return Document(io.BytesIO(file_bytes))


def extract_paragraphs(doc: Document) -> List[Dict[str, Any]]:
    """Extract paragraph-level formatting info."""
    paragraphs = []
    for idx, para in enumerate(doc.paragraphs):
        runs_info = []
        for run_idx, run in enumerate(para.runs):
            runs_info.append({
                "index": run_idx,
                "text": run.text,
                "font_name": run.font.name,
                "font_size": run.font.size.pt if run.font.size else None,
                "bold": run.font.bold,
                "italic": run.font.italic,
                "underline": run.font.underline,
            })

        pf = para.paragraph_format
        paragraphs.append({
            "index": idx,
            "text": para.text,
            "style_name": para.style.name if para.style else None,
            "alignment": para.alignment,
            "line_spacing": pf.line_spacing,
            "space_before": pf.space_before.pt if pf.space_before else None,
            "space_after": pf.space_after.pt if pf.space_after else None,
            "runs": runs_info,
        })
    return paragraphs


def extract_sections(doc: Document) -> List[Dict[str, Any]]:
    """Extract page margin info from sections."""
    sections = []
    for section in doc.sections:
        sections.append({
            "page_width": section.page_width.inches if section.page_width else None,
            "page_height": section.page_height.inches if section.page_height else None,
            "margin_left": section.left_margin.inches if section.left_margin else None,
            "margin_right": section.right_margin.inches if section.right_margin else None,
            "margin_top": section.top_margin.inches if section.top_margin else None,
            "margin_bottom": section.bottom_margin.inches if section.bottom_margin else None,
        })
    return sections


def extract_tables(doc: Document) -> List[Dict[str, Any]]:
    """Extract table info with surrounding context for caption detection."""
    tables = []
    for idx, table in enumerate(doc.tables):
        # Get preceding/following paragraphs for caption detection
        prev_para = None
        next_para = None
        # python-docx doesn't directly give table position, use element traversal
        tbl_element = table._tbl
        prev_elem = tbl_element.getprevious()
        next_elem = tbl_element.getnext()

        if prev_elem is not None and prev_elem.tag.endswith('}p'):
            from docx.oxml.ns import qn
            if prev_elem.find(qn('w:pPr')) is not None:
                pass  # Could extract text here

        tables.append({
            "index": idx,
            "rows": len(table.rows),
            "cols": len(table.columns),
            "alignment": table.alignment,
        })
    return tables


def extract_inline_shapes(doc: Document) -> List[Dict[str, Any]]:
    """Extract inline shapes (images) info."""
    shapes = []
    for rel in doc.part.rels.values():
        if "image" in rel.target_ref:
            shapes.append({
                "type": "image",
                "content_type": rel.target_ref,
            })
    return shapes


def get_heading_level(style_name: Optional[str]) -> Optional[int]:
    """Determine heading level from style name."""
    if not style_name:
        return None
    style_lower = style_name.lower()
    if style_lower.startswith("heading"):
        try:
            return int(style_lower.replace("heading", "").strip())
        except ValueError:
            pass
    return None


def iter_paragraphs_with_context(doc: Document):
    """Yield (paragraph, prev_para, next_para) for caption detection."""
    paragraphs = doc.paragraphs
    for i, para in enumerate(paragraphs):
        prev = paragraphs[i - 1] if i > 0 else None
        nxt = paragraphs[i + 1] if i < len(paragraphs) - 1 else None
        yield para, prev, nxt