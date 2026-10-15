"""Page-level evidence for a section, never exact Header/Footer geometry."""


def _index(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def section_first_rendered_page(location, section_metadata, mapping, document_blocks, rendered_pages):
    """Map the section's first paragraph, never a later convenient anchor.

    A blank first paragraph may carry a page break: text-only evidence cannot
    prove it occupies no earlier page. Such starts remain unavailable.
    """
    if (not isinstance(location, dict) or location.get("structural_story") is not True
            or not _index(location.get("section_index"))
            or not isinstance(section_metadata, list) or not isinstance(document_blocks, list)
            or not isinstance(mapping, dict) or not _index(rendered_pages) or rendered_pages < 1):
        return None
    sections = [s for s in section_metadata if isinstance(s, dict)
                and s.get("section_index") == location["section_index"]
                and _index(s.get("section_index"))]
    if len(sections) != 1:
        return None
    section = sections[0]
    start, end = section.get("start_paragraph_index"), section.get("end_paragraph_index")
    if not _index(start) or (end is not None and (not _index(end) or end < start)):
        return None
    blocks = [b for b in document_blocks if isinstance(b, dict)
              and _index(b.get("index")) and b["index"] == start]
    if len(blocks) != 1 or not isinstance(blocks[0].get("text"), str) or not blocks[0]["text"].strip():
        return None
    page = mapping.get(str(start), mapping.get(start))
    return page if _index(page) and 1 <= page <= rendered_pages else None
