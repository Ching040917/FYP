"""Custom-only, unscored reviews of stored Normal-pages story definitions.

Silence establishes only a supported structural witness, never rendered
visibility, field freshness, physical-page coverage or numbering correctness.
"""
from app.services.layout_violation import LayoutViolation


PAGE_ELEMENT_RULES = frozenset({
    "HEADER_CONTENT_REQUIRED", "FOOTER_CONTENT_REQUIRED", "PAGE_NUMBER_FIELD_REQUIRED",
})
_SUPPORTED_CONTENT_FIELDS = frozenset({"PAGE", "NUMPAGES", "SECTION", "SECTIONPAGES"})
_STORY_LABELS = {"header": "Header", "footer": "Footer", "either": "Header or Footer"}


def structural_story_label(location: dict) -> str:
    return (f"Section {location['section_index'] + 1} · "
            f"{_STORY_LABELS[location['story_type']]} · Normal pages")


def structural_required_action(rule_code: str, location: dict) -> str:
    target = structural_story_label(location)
    if location["evidence_state"] == "unresolved":
        return (f"In Word, inspect {target} against your Custom Profile; "
                "ACA cannot determine this requirement from supported structure.")
    change = ("insert a PAGE field if needed" if rule_code == "PAGE_NUMBER_FIELD_REQUIRED"
              else "add the required content if needed")
    return (f"In Word, review {target} against your Custom Profile and {change}. "
            "Verify the rendered document manually.")


def _part_observations(part: dict) -> tuple[str, str]:
    """Content and PAGE outcomes, cached once per unique effective part."""
    paragraphs = part["paragraphs"]
    fields = [field for paragraph in paragraphs for field in paragraph["fields"]]
    resolved = {field["kind"] for field in fields if field["status"] == "resolved"}
    literal = any(paragraph["literal_text"].strip() for paragraph in paragraphs)
    complete = part["completeness"] == "complete"
    content = ("positive" if literal or resolved & _SUPPORTED_CONTENT_FIELDS else
               "empty" if complete and not fields else "unresolved")
    page = ("positive" if "PAGE" in resolved else
            "missing" if complete and not any(field["kind"] == "PAGE" for field in fields)
            else "unresolved")
    return content, page


def _story_observations(section: dict, kind: str, parts: dict, cache: dict) -> tuple[str, str]:
    if section["status"] != "resolved":
        return "unresolved", "unresolved"
    story = next((story for story in section["stories"]
                  if story["kind"] == kind and story["variant"] == "default"), None)
    if story is None or story["activation"] != "enabled":
        return "unresolved", "unresolved"
    if story["status"] == "absent":
        return "missing", "missing"
    if story["status"] != "resolved" or story["part_key"] not in parts:
        return "unresolved", "unresolved"
    key = story["part_key"]
    if key not in cache:
        cache[key] = _part_observations(parts[key])
    return cache[key]


def _finding(section_index: int, kind: str, outcome: str, page: bool = False) -> LayoutViolation:
    label = _STORY_LABELS[kind]
    code = "PAGE_NUMBER_FIELD_REQUIRED" if page else f"{kind.upper()}_CONTENT_REQUIRED"
    location = dict(structural_story=True, section_index=section_index, story_type=kind,
                    story_variant="default", evidence_state=outcome)
    if outcome == "unresolved":
        current = "Supported structural evidence is insufficient to determine this requirement."
    elif page:
        current = "No supported PAGE field found in the selected Normal-pages definition(s)"
    elif outcome == "missing":
        current = f"No effective Normal-pages {label} definition"
    else:
        current = f"The effective Normal-pages {label} contains no text or supported field"
    required = (f"A PAGE field in each section's Normal-pages {label} definition" if page else
                f"Text or a supported field in each section's Normal-pages {label} definition")
    return LayoutViolation(code, "REVIEW", location, structural_required_action(code, location),
                           expected_value=required, actual_value=current)


def check_page_element_requirements(elements: dict, config) -> list[LayoutViolation]:
    """Inspect every section's effective default stories; never consolidate consumers."""
    if getattr(config, "profile_source", None) != "custom":
        return []
    header_on = getattr(config, "HEADER_CHECK_REQUIREMENTS", False) is True
    footer_on = getattr(config, "FOOTER_CHECK_REQUIREMENTS", False) is True
    page_on = getattr(config, "PAGE_NUMBER_CHECK_REQUIREMENTS", False) is True
    if not (header_on or footer_on or page_on):
        return []
    placement = getattr(config, "PAGE_NUMBER_PLACEMENT", "either")
    parts = {part["part_key"]: part for part in elements["parts"]}
    cache = {}
    findings = []
    for section in elements["sections"]:
        header = _story_observations(section, "header", parts, cache)
        footer = _story_observations(section, "footer", parts, cache)
        index = section["section_index"]
        for enabled, kind, observation in ((header_on, "header", header), (footer_on, "footer", footer)):
            if enabled and observation[0] != "positive":
                findings.append(_finding(index, kind, observation[0]))
        if page_on:
            if placement == "either":
                outcomes = (header[1], footer[1])
                outcome = ("positive" if "positive" in outcomes else
                           "missing" if outcomes == ("missing", "missing") else "unresolved")
            else:
                outcome = (header if placement == "header" else footer)[1]
            if outcome != "positive":
                findings.append(_finding(index, placement, outcome, page=True))
    return findings
