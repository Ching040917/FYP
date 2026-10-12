"""TABLE_CAPTION_MISSING page resolution — strict same-page contract (A–F).

Mirrors frontend/tests/table-page-resolution.test.ts. The ONLY resolving case
is both anchors on the SAME page; a truthful `None` (unavailable) is always
preferred to a guessed page. There is NO backend legacy path — findings
without anchors are unavailable.
"""
from app.services.table_page_resolution import resolve_table_page

# A small page map: paragraphs 0,1 -> page 1; 2 -> page 2; 3 -> page 3.
_PAGES = {0: 1, 1: 1, 2: 2, 3: 3}


def _pfp(idx):
    return _PAGES.get(idx)


def _loc(prev, nxt):
    return {
        "table_index": 0,
        "previous_anchor_paragraph_index": prev,
        "next_anchor_paragraph_index": nxt,
    }


def test_case_a_both_anchors_same_page_resolves():
    assert resolve_table_page(_loc(0, 1), _pfp) == 1


def test_case_b_adjacent_page_pair_is_unavailable():
    assert resolve_table_page(_loc(0, 2), _pfp) is None


def test_case_c_single_previous_anchor_is_unavailable():
    # Table at top of page 2 after a page-1 paragraph: one anchor never proves
    # the table's page.
    assert resolve_table_page(_loc(0, None), _pfp) is None


def test_case_d_gap_between_anchors_is_unavailable():
    assert resolve_table_page(_loc(0, 3), _pfp) is None


def test_case_e_only_next_anchor_is_unavailable():
    assert resolve_table_page(_loc(None, 1), _pfp) is None


def test_case_f_only_previous_anchor_is_unavailable():
    assert resolve_table_page(_loc(1, None), _pfp) is None


def test_historical_location_without_anchors_is_unavailable():
    assert resolve_table_page({"table_index": 0}, _pfp) is None


def test_both_anchors_none_is_unavailable():
    assert resolve_table_page(_loc(None, None), _pfp) is None


def test_unmapped_anchors_are_unavailable():
    assert resolve_table_page(_loc(99, 99), _pfp) is None


def test_non_dict_location_is_unavailable():
    assert resolve_table_page(None, _pfp) is None
    assert resolve_table_page("nope", _pfp) is None


def test_bool_anchor_is_ignored():
    # Guard against bool being an int subclass.
    assert resolve_table_page(_loc(True, True), _pfp) is None


def test_rendered_pages_bound_is_respected():
    # page 3 is out of range when rendered_pages=2 → unavailable.
    assert resolve_table_page(_loc(3, 3), _pfp, rendered_pages=2) is None
    assert resolve_table_page(_loc(3, 3), _pfp, rendered_pages=3) == 3
