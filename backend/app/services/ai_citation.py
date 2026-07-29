import json
import logging
import re
from typing import List, Dict, Any, Optional
from uuid import uuid4
import httpx

from sqlalchemy.orm import Session

from app.config import settings
from app.models.audit import CitationIssue

logger = logging.getLogger(__name__)


APA_CITATION_PROMPT = """You are an APA 7th edition citation auditor.
Analyze the following text for citation FORMAT errors and citation-REFERENCE COVERAGE errors.

VALID APA 7 IN-TEXT CITATION FORMS (do NOT flag any of these as errors):
  Narrative:     Smith (2022)
                 Smith and Jones (2022)
                 Smith & Jones (2022)
                 Smith et al. (2020)
  Parenthetical: (Smith, 2022)
                 (Smith & Jones, 2022)
                 (Smith and Jones, 2022)
                 (Smith et al., 2020)
Both narrative and parenthetical forms are correct APA 7. Never flag
a citation simply for being narrative vs. parenthetical.

Return ONLY a JSON array of issues found. Each issue must have:
- "paragraph_index": integer (0-based; for references-section issues, use negative indices -1, -2, ...)
- "text_snippet": string (the problematic text segment, max 200 chars; must appear VERBATIM in the input)
- "issue_type": string — pick the MOST SPECIFIC from:
    "missing_author"            — citation has no author
    "missing_year"              — citation has no year
    "format_error"              — general APA format mistake not covered above
    "et_al_error"               — incorrect et al. usage (e.g. "et al" without period, or used for ≤2 authors)
    "ampersand_error"           — uses "and" inside parentheses instead of "&"
    "page_number_error"         — missing/incorrect page locator when required by the source
    "multiple_citations_error"  — improperly combined citations (e.g. (Smith, 2020; Jones 2018) with bad separators)
    "citation_mismatch"         — in-text author/year has no matching entry in References
    "other"                     — anything not covered above
- "message": string (one sentence, ≤200 chars, student-friendly)
- "suggestion": string (one sentence, ≤240 chars, student-friendly; explain HOW to fix)
- "confidence": float (0.0-1.0)

STRICT RULES — read carefully:
1. ANTI-HALLUCINATION: if confidence < 0.6, OMIT the issue entirely.
2. ANTI-HALLUCINATION: text_snippet MUST appear verbatim in the input.
3. ANTI-HALLUCINATION: if you cannot identify the References section, do NOT report citation_mismatch.
4. Be conservative: when in doubt, return [].
5. Do not invent issue_types. If none of the eight categories fit, use "other".
6. Do not flag narrative vs. parenthetical style (see examples above).

Text to analyze:
{text}"""


def parse_ai_json(raw_ai_text: str) -> List[Dict[str, Any]]:
    """Defensive JSON parser for AI output.
    Strips markdown code fences, handles malformed JSON, unwraps
    common {"issues":[...]} / {"findings":[...]} / {"results":[...]}
    envelopes, returns fallback on error.
    """
    try:
        clean_text = (raw_ai_text or "").strip()
        if clean_text.startswith("```json"):
            clean_text = clean_text[7:]
        if clean_text.startswith("```"):
            clean_text = clean_text[3:]
        if clean_text.endswith("```"):
            clean_text = clean_text[:-3]
        clean_text = clean_text.strip()

        # Try to extract JSON array if wrapped in other text
        array_match = re.search(r'\[.*\]', clean_text, re.DOTALL)
        if array_match:
            clean_text = array_match.group(0)

        parsed = json.loads(clean_text)
        if isinstance(parsed, list):
            return parsed
        # Unwrap common envelope dicts the model emits
        if isinstance(parsed, dict):
            for key in ("issues", "findings", "results", "data", "items"):
                inner = parsed.get(key)
                if isinstance(inner, list):
                    return inner
        return []
    except (json.JSONDecodeError, TypeError, AttributeError):
        # Fallback for non-standard AI output
        return [{
            "paragraph_index": -1,
            "text_snippet": "",
            "issue_type": "other",
            "message": "The AI response format was non-standard. Please verify this citation section manually.",
            "suggestion": None,
            "confidence": 0.0,
        }]


async def call_ollama_local(prompt: str) -> str:
    """Call local Ollama via HTTP API """
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{settings.OLLAMA_HOST}/api/generate",
                json={
                    "model": settings.OLLAMA_MODEL,  #  qwen3.5:4b
                    "prompt": prompt,
                    "stream": False,
                    "think": False
                }
            )

            response.raise_for_status()
            data = response.json()

            return data.get("response", "")

    except Exception as e:
        raise RuntimeError(f"Ollama HTTP call failed: {e}")



async def call_gemini_cloud(prompt: str) -> str:
    """Call Google Gemini 1.5 Flash API (Layer 2)."""
    try:
        import google.generativeai as genai
        if not settings.GEMINI_API_KEY:
            raise RuntimeError("GEMINI_API_KEY not configured")
        genai.configure(api_key=settings.GEMINI_API_KEY)
        model = genai.GenerativeModel('gemini-1.5-flash')
        response = await model.generate_content_async(
            prompt,
            generation_config={"temperature": 0.1, "max_output_tokens": 2048}
        )
        return response.text or ""
    except Exception as e:
        raise RuntimeError(f"Gemini call failed: {e}")


# ---------------------------------------------------------------------------
# Server-side AI output sanitiser
# ---------------------------------------------------------------------------
# The prompt instructs the model to return a clean JSON array, but
# small models drift: they invent new issue_type strings, omit the
# confidence field, or quote snippets that do not appear in the input.
# _sanitize_issues is the defensive boundary between the LLM and the DB
# — it drops rows the model cannot justify.

# Closed enum of valid issue_type values. Mirrors the eight categories
# the prompt asks the model to choose from. Anything outside this set
# is treated as a hallucination and the row is dropped.
ALLOWED_ISSUE_TYPES: frozenset = frozenset({
    "missing_author", "missing_year", "format_error",
    "et_al_error", "ampersand_error", "page_number_error",
    "multiple_citations_error", "citation_mismatch", "other",
})
MIN_CONFIDENCE: float = 0.6
SNIPPET_MAX_CHARS: int = 500   # matches the [:500] cap in DB write
MESSAGE_MAX_CHARS: int = 200
SUGGESTION_MAX_CHARS: int = 240


def _normalize_issue_type(raw: Any) -> Optional[str]:
    """Snap raw issue_type to the closed enum, lowercased.

    Returns the canonical key if it matches; None otherwise.
    Accepts common model variants like 'Missing_Author' or
    'missing-author' by case-folding and dash→underscore.
    """
    if not isinstance(raw, str):
        return None
    candidate = raw.strip().lower().replace("-", "_").replace(" ", "_")
    return candidate if candidate in ALLOWED_ISSUE_TYPES else None


def _is_substring_of(snippet: str, source: str) -> bool:
    """Return True if snippet appears verbatim in source.

    Tries a whitespace-normalised fallback because Word frequently
    inserts double spaces after periods and the model's snippet
    collapses them.
    """
    if not snippet or not source:
        return False
    if snippet in source:
        return True
    norm_src = " ".join(source.split())
    norm_snip = " ".join(snippet.split())
    return bool(norm_snip) and norm_snip in norm_src


def _studentise_suggestion(raw: Any) -> Optional[str]:
    """Make suggestion text student-friendly and bounded.

    Strips leading "Note:", "Suggestion:", "Fix:" prefixes the
    model sometimes prepends; trims to one sentence; truncates to
    240 chars. Returns None for empty / non-string input.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    for prefix in ("Note:", "Suggestion:", "Fix:", "Recommendation:", "Tip:"):
        if text.lower().startswith(prefix.lower()):
            text = text[len(prefix):].lstrip()
    # Keep only the first sentence.
    first_sentence = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)[0].strip()
    if not first_sentence:
        return None
    if len(first_sentence) > SUGGESTION_MAX_CHARS:
        first_sentence = first_sentence[: SUGGESTION_MAX_CHARS - 1].rstrip() + "…"
    return first_sentence


def _sanitize_issues(
    issues_data: List[Dict[str, Any]],
    source_text: str,
) -> List[Dict[str, Any]]:
    """Filter and normalise the model's raw output before persistence.

    Drops:
      - non-dict entries
      - unknown issue_type values (model hallucinated a category)
      - low-confidence entries (confidence < 0.6)
      - hallucinated snippets (snippet not in the source text)

    Coerces:
      - issue_type to canonical closed-enum form
      - text_snippet to <= SNIPPET_MAX_CHARS
      - message to <= MESSAGE_MAX_CHARS, one sentence
      - suggestion via _studentise_suggestion (<= 240 chars, student voice)
      - paragraph_index to int (default -1)
      - confidence to float
    """
    clean: List[Dict[str, Any]] = []
    for raw in issues_data:
        if not isinstance(raw, dict):
            continue
        # 1. closed-enum snap
        itype = _normalize_issue_type(raw.get("issue_type"))
        if itype is None:
            continue
        # 2. confidence gate
        conf_raw = raw.get("confidence")
        try:
            conf = float(conf_raw) if conf_raw is not None else 0.0
        except (TypeError, ValueError):
            conf = 0.0
        if conf < MIN_CONFIDENCE:
            continue
        # 3. snippet must be in source (anti-hallucination)
        snippet = (raw.get("text_snippet") or "")[:SNIPPET_MAX_CHARS]
        if snippet and not _is_substring_of(snippet, source_text):
            continue
        # 4. normalise text fields
        message = (raw.get("message") or "").strip()
        if len(message) > MESSAGE_MAX_CHARS:
            message = message[: MESSAGE_MAX_CHARS - 1].rstrip() + "…"
        clean.append({
            "paragraph_index": int(raw.get("paragraph_index", -1) or -1),
            "text_snippet": snippet,
            "issue_type": itype,
            "message": message,
            "suggestion": _studentise_suggestion(raw.get("suggestion")),
            "confidence": conf,
        })
    return clean


async def async_ai_citation_task(
    text: str,
    audit_id: str,
    db: Session,
    cloud: bool = False,
    paragraph_map: Optional[Dict[int, str]] = None
) -> List[Dict[str, Any]]:
    """Background task: run AI citation check and persist results.

    Layer 1 (default): Local Ollama (qwen2.5:3b)
    Layer 2 (cloud=True): Google Gemini 1.5 Flash with defensive fallback to Layer 1
    """
    prompt = APA_CITATION_PROMPT.format(text=text)

    logger.warning("PROMPT SENT TO AI:\n%s", prompt)

    raw_response = ""

    if cloud:
        # Layer 2: Try cloud API first
        try:
            raw_response = await call_gemini_cloud(prompt)
            logger.info("Cloud AI citation audit completed for audit_id=%s", audit_id)
        except Exception as e:
            # DEFENSIVE FALLBACK: Cloud failed → log error, fall back to local Ollama
            logger.warning(
                "Cloud AI citation failed for audit_id=%s, falling back to local Ollama: %s",
                audit_id, e, exc_info=True
            )
            try:
                raw_response = await call_ollama_local(prompt)
                logger.info("Local Ollama fallback succeeded for audit_id=%s", audit_id)
            except Exception as e2:
                # Both layers failed — log full traceback, proceed with empty response
                # so parse_ai_json emits its standard non-standard fallback
                logger.error(
                    "Both cloud and local AI failed for audit_id=%s: %s",
                    audit_id, e2, exc_info=True
                )
                raw_response = ""
    else:
        # Layer 1: Local Ollama only
        try:
            raw_response = await call_ollama_local(prompt)
        except Exception as e:
            logger.error("Local Ollama call failed for audit_id=%s: %s", audit_id, e, exc_info=True)
            raw_response = ""

    issues_data = parse_ai_json(raw_response)

    # Server-side quality filter: drops unknown issue_types, low-confidence
    # rows, and hallucinated snippets not present in the source. Runs
    # BEFORE the DB write so the response is consistent with the DB.
    issues_data = _sanitize_issues(issues_data, text)

    # Temporary debug logging — helps verify AI output when tooltips come back empty
    logger.warning("RAW AI RESPONSE:\n%s", raw_response)
    logger.warning("SANITIZED AI RESPONSE:\n%s", issues_data)

    # Persist to database
    citation_issues = []
    for issue_data in issues_data:
        issue = CitationIssue(
            id=str(uuid4()),
            audit_id=audit_id,
            paragraph_index=issue_data.get("paragraph_index", -1),
            text_snippet=issue_data.get("text_snippet", "")[:500],
            issue_type=issue_data.get("issue_type", "other"),
            message=issue_data.get("message", ""),
            suggestion=issue_data.get("suggestion"),
            confidence=issue_data.get("confidence"),
        )
        db.add(issue)
        citation_issues.append(issue)

    db.commit()
    # Return only fields declared on CitationIssueResponse so the caller
    # can map dict → schema without re-querying the DB or leaking
    # SQLAlchemy's _sa_instance_state.
    return [
        {
            "id": ci.id,
            "paragraph_index": ci.paragraph_index,
            "text_snippet": ci.text_snippet,
            "issue_type": ci.issue_type,
            "message": ci.message,
            "suggestion": ci.suggestion,
            "confidence": ci.confidence,
        }
        for ci in citation_issues
    ]


def extract_citation_text(paragraphs: List[Dict]) -> str:
    """Extract paragraphs likely to contain APA in-text citations for AI analysis.

    Why the old version failed
    --------------------------
    The previous regex set only matched three narrow patterns:
      - `(Author, 2020)`      (literal space-comma-space)
      - `Author et al.`
      - `[1]`                  (numeric brackets)

    Real DOCX files fail this for several reasons:
      1. APA parentheses with ampersand / multi-author: `(Smith & Jones, 2021)`
         has no space-comma-space, so `(Author, Year)` missed it.
      2. Narrative citations: `Smith (2021)` or `Smith and Jones (2022)` —
         old regex had no pattern for these at all.
      3. et al. is often written as `et al., 2020` (et al + year in parens
         later) — `et al` standalone was the only match, missing the
         comma-year suffix.
      4. Most importantly: Word frequently splits a single citation across
         multiple runs (e.g. one run for `(Smith, ` and another for
         `2022)` because the author and year carry different formatting).
         The JOINED `para.text` collapses those runs and is the right
         surface to match on, but the old regex still required a literal
         space-comma-space which some APA style guides (and most Word
         autocorrect) produce without it.

    What this version does
    ----------------------
    - Builds a forgiving regex library covering the 5 patterns requested.
    - Matches against the joined `para.text` (post-run-join) so split runs
      are transparent.
    - Logs the first 3 paragraphs as a one-time debug breadcrumb so we
      can see the actual text the regex is being asked to classify.
    - If NOTHING matches after the full scan, falls back to returning
      every non-empty paragraph rather than the "No citation-like text
      found." sentinel — the AI can then do a full-pass over the body
      instead of seeing an empty doc. This trades a bit of latency for
      a much higher recall.
    """
    # Citation patterns — each maps to a label used in debug logs.
    patterns = {
        # (Author, Year) and (Author & Author, Year) and (Author et al., Year)
        # - Author may be one or more words, possibly hyphenated, possibly
        #   with initials. Year is 4 digits, optionally followed by letter
        #   suffix (2020a) and optional page locator.
        "parenthetical_apa": re.compile(
            r"\(\s*"                              # opening paren
            r"[A-Z][A-Za-z'\-]+"                   # author (capitalised word)
            r"(?:\s*(?:&|and)\s*[A-Z][A-Za-z'\-]+)*"  # optional & co-authors
            r"(?:\s+et\s+al\.?)?"                  # optional et al.
            r"\s*,\s*"                            # comma separator
            r"\d{4}[a-z]?"                        # year
            r"(?:\s*,\s*p+\.?\s*\d+)?"            # optional page locator
            r"\s*\)"                              # closing paren
        ),

        # Narrative: Author (Year) or Author and Author (Year) or Author et al. (Year)
        "narrative_apa": re.compile(
            r"\b[A-Z][A-Za-z'\-]+"                 # author
            r"(?:\s+(?:&|and)\s+[A-Z][A-Za-z'\-]+)*"  # co-authors
            r"(?:\s+et\s+al\.?)?"                  # et al.
            r"\s+\(\s*\d{4}[a-z]?(?:\s*,\s*p+\.?\s*\d+)?\s*\)"
        ),

        # "et al." anywhere in the paragraph (catches the rare "see Smith
        # et al. for details" prose case)
        "et_al_prose": re.compile(
            r"\b\w+\s+et\s+al\.?,?\s*\d{0,4}"      # word et al., optional year
        ),

        # Numeric / IEEE-style: [1] or [12, 34] or [1-3]
        "numeric_bracket": re.compile(r"\[\s*\d+(?:\s*[\-,\s]\s*\d+)*\s*\]"),

        # Author-year without parens, used by some disciplines:
        # "as shown by Smith 2021" — weaker, requires word boundary
        "loose_author_year": re.compile(
            r"\b[A-Z][A-Za-z'\-]+\s+\(?\d{4}[a-z]?\)?"
        ),
    }

    # Debug breadcrumb — show the first few paragraphs so we can see what
    # the regex is being asked to classify in the failing case.
    sample = [
        f"[{p.get('index')}] {repr(p.get('text', ''))[:200]}"
        for p in paragraphs[:3]
    ]
    logger.warning(
        "extract_citation_text: %d paragraphs total. First 3 samples:\n%s",
        len(paragraphs),
        "\n".join(sample) if sample else "(no paragraphs)",
    )

    citation_texts = []
    matched_counts = {k: 0 for k in patterns}

    for para in paragraphs:
        text = (para.get("text") or "").strip()
        if not text:
            continue

        matched_labels = [
            label for label, pat in patterns.items() if pat.search(text)
        ]
        if not matched_labels:
            continue

        for label in matched_labels:
            matched_counts[label] += 1

        citation_texts.append(f"[Para {para.get('index', '?')}] {text}")

    logger.warning(
        "extract_citation_text: matched %d/%d paragraphs. Pattern hits: %s",
        len(citation_texts),
        len(paragraphs),
        matched_counts,
    )

    # Fallback: if nothing matched, return every non-empty paragraph so the
    # AI still has a chance to flag narrative citations the regex missed.
    if not citation_texts:
        logger.warning(
            "extract_citation_text: zero citation matches — falling back to "
            "all non-empty paragraphs (%d total).",
            sum(1 for p in paragraphs if (p.get("text") or "").strip()),
        )
        citation_texts = [
            f"[Para {p.get('index', '?')}] {(p.get('text') or '').strip()}"
            for p in paragraphs
            if (p.get("text") or "").strip()
        ]

    return "\n\n".join(citation_texts) if citation_texts else "No citation-like text found."