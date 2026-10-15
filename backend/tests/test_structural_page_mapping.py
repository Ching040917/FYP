"""Section-start evidence cannot be inferred from later or malformed mappings."""
from copy import deepcopy
import pytest
from app.services.structural_page_mapping import section_first_rendered_page

LOCATION = dict(structural_story=True, section_index=2, story_type="header", story_variant="default")
SECTIONS = [dict(section_index=2, start_paragraph_index=18, end_paragraph_index=None)]
BLOCKS = [dict(index=18, text="Section 3"), dict(index=19, text="Body")]


def test_first_section_paragraph_proves_page_not_story_geometry():
    before = deepcopy((LOCATION, SECTIONS, BLOCKS))
    for kind in ("header", "footer", "either"):
        assert section_first_rendered_page({**LOCATION, "story_type": kind}, SECTIONS,
                                           {"18": 3, "19": 3}, BLOCKS, 3) == 3
    assert (LOCATION, SECTIONS, BLOCKS) == before


@pytest.mark.parametrize("mapping", [{}, {"19": 3}, {"18": None}, {"18": True},
    {"18": "3"}, {"18": 3.0}, {"18": 0}, {"18": 4}, {"18": -1}])
def test_later_or_invalid_pages_never_prove_section_start(mapping):
    assert section_first_rendered_page(LOCATION, SECTIONS, mapping, BLOCKS, 3) is None


@pytest.mark.parametrize("blocks", [None, [], [dict(index=19, text="Later text")],
    [dict(index=18, text=""), dict(index=19, text="Later text")],
    [dict(index=18, text="Field-only"), dict(index=18, text="Duplicate identity")]])
def test_missing_blank_or_duplicate_start_identity_is_unavailable(blocks):
    assert section_first_rendered_page(LOCATION, SECTIONS, {"18": 3, "19": 3}, blocks, 3) is None


@pytest.mark.parametrize("sections", [None, [], SECTIONS * 2,
    [dict(section_index=2, start_paragraph_index=True, end_paragraph_index=None)],
    [dict(section_index=2, start_paragraph_index=18, end_paragraph_index=17)]])
def test_missing_or_malformed_boundaries_are_unavailable(sections):
    assert section_first_rendered_page(LOCATION, sections, {"18": 3}, BLOCKS, 3) is None


def test_section_index_is_never_a_page_number():
    assert section_first_rendered_page({**LOCATION, "section_index": 1}, SECTIONS, {"18": 3}, BLOCKS, 3) is None
    assert section_first_rendered_page(LOCATION, SECTIONS, {18: 2}, BLOCKS, 3) == 2
    assert section_first_rendered_page(LOCATION, SECTIONS, {18: 2}, BLOCKS, None) is None
