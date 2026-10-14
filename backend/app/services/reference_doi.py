"""Offline presentation evidence for an ACA-supported DOI lexical subset.

Unsupported text is uncertain, not proof of an invalid DOI. Hidden hyperlink
relationships, registration and resolution are outside this module's scope.
"""
from dataclasses import dataclass
import re
from typing import Literal, Tuple


_SEED = re.compile(r"(?<!\S)(?:https?://(?:dx\.)?doi\.org/|doi:[ \t]*|10\.)", re.IGNORECASE)
_IDENTITY = re.compile(r"10\.[0-9]{4,9}/[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?")


@dataclass(frozen=True)
class VisibleDoiEvidence:
    state: Literal["canonical", "legacy-form", "ambiguous", "absent"]
    spans: Tuple[Tuple[int, int], ...]


def _trim_end(text: str, start: int, end: int) -> int:
    while end > start and text[end - 1].isspace():
        end -= 1
    return end


def classify_visible_doi(text: str) -> VisibleDoiEvidence:
    """Classify the complete visible tail; never infer or repair an identity."""
    seeds = []
    for match in _SEED.finditer(text):
        # A spaced marker and its immediately following identity are one seed.
        if seeds and match.start() == seeds[-1].end() and match.group().startswith("10."):
            continue
        seeds.append(match)
    if not seeds:
        return VisibleDoiEvidence("absent", ())
    if len(seeds) > 1:
        spans = tuple(
            (seed.start(), _trim_end(text, seed.start(), seeds[i + 1].start() if i + 1 < len(seeds) else len(text)))
            for i, seed in enumerate(seeds)
        )
        return VisibleDoiEvidence("ambiguous", spans)

    seed = seeds[0]
    end = _trim_end(text, seed.start(), len(text))
    if text.endswith(".", seed.start(), end) and not text.endswith("..", seed.start(), end):
        end -= 1
    spans = ((seed.start(), end),)
    prefix = seed.group()
    if prefix.startswith("10.") or _IDENTITY.fullmatch(text, seed.end(), end) is None:
        return VisibleDoiEvidence("ambiguous", spans)
    state = "canonical" if prefix.casefold() == "https://doi.org/" else "legacy-form"
    return VisibleDoiEvidence(state, spans)
