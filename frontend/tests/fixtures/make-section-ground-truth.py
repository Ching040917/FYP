"""Write ground-truth expected section ranges (hand-derived, independent of
the mapping code under test). Run once; the JSON is frozen."""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent

GT = {
    "sec3p": [
        {"section_index": 0, "startPage": 1, "endPage": 3, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
    ],
    "sec2next": [
        {"section_index": 0, "startPage": 1, "endPage": 1, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
        {"section_index": 1, "startPage": 2, "endPage": 2, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
    ],
    "sec2cont": [
        {"section_index": 0, "startPage": 1, "endPage": 1, "confidence": "exact", "startsMidPage": False, "endsMidPage": True},
        {"section_index": 1, "startPage": 1, "endPage": 1, "confidence": "exact", "startsMidPage": True, "endsMidPage": False},
    ],
    "secodd": [
        {"section_index": 0, "startPage": 1, "endPage": 1, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
        {"section_index": 1, "startPage": 2, "endPage": 2, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
    ],
    "secland": [
        {"section_index": 0, "startPage": 1, "endPage": 1, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
        {"section_index": 1, "startPage": 2, "endPage": 2, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
        {"section_index": 2, "startPage": 3, "endPage": 3, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
    ],
    "secsize": [
        {"section_index": 0, "startPage": 1, "endPage": 1, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
        {"section_index": 1, "startPage": 2, "endPage": 2, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
    ],
    "sectable": [
        {"section_index": 0, "startPage": 1, "endPage": 1, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
        {"section_index": 1, "startPage": None, "endPage": None, "confidence": "unavailable", "startsMidPage": False, "endsMidPage": False},
    ],
    "secfigure": [
        {"section_index": 0, "startPage": 1, "endPage": 1, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
        {"section_index": 1, "startPage": None, "endPage": None, "confidence": "unavailable", "startsMidPage": False, "endsMidPage": False},
    ],
    "secunmapped": [
        {"section_index": 0, "startPage": 1, "endPage": 1, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
        {"section_index": 1, "startPage": 2, "endPage": 2, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
    ],
    "secconflict": [
        {"section_index": 0, "startPage": 1, "endPage": 1, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
        {"section_index": 1, "startPage": 2, "endPage": 2, "confidence": "exact", "startsMidPage": False, "endsMidPage": False},
    ],
}

if __name__ == "__main__":
    for name, entries in GT.items():
        (OUT / f"{name}-expected.json").write_text(json.dumps(entries, indent=1))
        print("wrote", name, len(entries), "entries")
