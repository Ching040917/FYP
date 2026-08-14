import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from uuid import uuid4
import httpx

from sqlalchemy.orm import Session

from app.config import settings
from app.models.audit import CitationIssue

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# AI review execution status — the frontend needs to distinguish a completed
# (possibly empty) provider run from an unavailable one, and to know which
# provider path actually executed. Only this summary is exposed; raw prompts,
# raw model responses, and exceptions are never persisted or returned.
# ---------------------------------------------------------------------------

AI_STATUS_WITH_SUGGESTIONS = "COMPLETED_WITH_SUGGESTIONS"
AI_STATUS_NO_SUGGESTIONS = "COMPLETED_NO_SUGGESTIONS"
AI_STATUS_UNAVAILABLE = "UNAVAILABLE"

AI_PROVIDER_LOCAL = "LOCAL_OLLAMA"
AI_PROVIDER_CLOUD = "CLOUD_GEMINI"
AI_PROVIDER_CLOUD_FALLBACK_LOCAL = "CLOUD_FALLBACK_LOCAL"


@dataclass
class AiCitationResult:
    """Narrow, frontend-safe summary of one AI-assisted citation run.

    status is one of the AI_STATUS_* constants; provider is one of the
    AI_PROVIDER_* constants or None when no provider completed.
    suggestions are the sanitized, persisted CitationIssue-shaped dicts.
    """
    status: str
    provider: Optional[str]
    suggestions: List[Dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Prompt — deterministic finding explanation only (Build 7F / guidance build)
#
# The deterministic citation sensor has already identified and scored all
# CITATION_MISMATCH violations. The provider's sole responsibility is to
# explain how each confirmed finding can be corrected. It must not
# rediscover, add, remove, or reclassify any finding, and it must never
# invent bibliographic details — placeholders are substituted by the
# application using safe templates, never by the model.
# ---------------------------------------------------------------------------

CITATION_GUIDANCE_PROMPT = """You are an APA 7th edition citation guide.
Your job is NOT to find issues — they have already been found by a
deterministic scanner. Your job is to explain the correction clearly.

Below are confirmed citation findings. Each finding has a unique
finding_key (a UUID). You must return the SAME finding_key for each
guidance item so the system can match your response to the correct
finding — especially when multiple findings appear in the same
paragraph.

For each finding, provide:
- "reason": two or three concise, student-friendly sentences explaining
  (1) why the confirmed mismatch matters for APA 7 and (2) the exact
  corrective action the student must take. At most 700 characters.
- "source_type": exactly one of "journal_article", "book", "webpage",
  or "unknown". Choose "webpage" only when the citation is clearly a
  webpage. When the source type cannot be identified from the finding,
  use "unknown" — never guess.
- "confidence": float between 0.0 and 1.0 indicating how certain the
  guidance is; use 0.9-1.0 when the fix is straightforward, lower only
  when the correction is ambiguous.

WORDING RULES — the mismatch is a formatting defect, never a moral
judgement. Use neutral, corrective wording only:
- Say "no matching References entry was found" or "the citation has no
  matching entry in the References section".
- Say "add a matching reference entry" or "add the missing reference
  entry" — never "create the missing citation" or "create a citation".
- Say "verify the source details" and "correct or remove the in-text
  citation if it refers to the wrong source".
NEVER use subjective or accusatory wording such as "academic integrity
violation", "misconduct", "losing credibility", or "credibility".

Do NOT invent bibliographic details such as author initials, titles,
journal names, publishers, volumes, issues, page ranges, DOIs, URLs, or
publication dates. Do NOT write reference entries yourself. Do NOT
propose additional issues. Do NOT remove or reclassify findings.

Return ONLY a JSON array. The array must have exactly one object per
finding, in the same order as the findings list below. Each object must
have: "finding_key", "reason", "source_type", "confidence".

Example output (2 findings):
[{"finding_key": "abc-123", "reason": "APA 7 requires every in-text citation to have a matching entry in the References section. Add the missing reference entry for Garcia (2018) using the source details you already have.", "source_type": "unknown", "confidence": 0.9},
 {"finding_key": "def-456", "reason": "APA 7 requires a page number when quoting directly. Add the page range from the source in the format (Author, Year, p. page).", "source_type": "journal_article", "confidence": 0.85}]

Findings:
__FINDINGS__"""


# ---------------------------------------------------------------------------
# APA 7 guidance assembly — deterministic, fabricated-detail-safe (guidance build)
#
# The model supplies a reason and a source_type. Every template, checklist
# item, and warning below is application-owned text: the model never writes
# reference entries, so it can never fabricate bibliographic details.
# Unknown source types are never guessed — journal and book templates are
# shown as labelled alternatives and the student is told to identify the
# real source type.
# ---------------------------------------------------------------------------

_APA_REFERENCE_TEMPLATES = {
    "journal_article": (
        "Journal article:\n"
        "Author, A. A. (Year). Title of the article. Journal Name, volume(issue), "
        "page\u2013page. https://doi.org/xxxxx"
    ),
    "book": (
        "Book:\n"
        "Author, A. A. (Year). Title of the book. Publisher."
    ),
    "webpage": (
        "Webpage:\n"
        "Author, A. A. (Year, Month Day). Title of the page. Site Name. URL"
    ),
}

_APA_VERIFICATION_CHECKLIST = (
    "- Author name and initials",
    "- Publication year",
    "- Source title",
    "- Journal or publisher",
    "- Volume, issue, and pages where applicable",
    "- DOI or URL where applicable",
)

_APA_PLACEHOLDER_WARNING = (
    "Formatting example only. Replace all placeholders with verified source "
    "information before submission."
)

# Subjective / accusatory phrasing that must never reach the student.
# Guidance that contains any of these is rejected outright — a formatting
# mismatch is corrected with neutral wording, never a moral judgement.
# Matched case-insensitively against the sanitized reason.
_SUBJECTIVE_PHRASES = (
    "academic integrity",
    "misconduct",
    "credibility",
    "create the missing citation",
    "create a missing citation",
    "create a citation",
    "create citations",
)


def _reject_subjective_reason(reason: Optional[str]) -> Optional[str]:
    """Return the reason unchanged when neutral, or None when subjective.

    The AI is instructed to use neutral wording, but instructions can be
    ignored — this is the hard boundary. Any reason containing a
    subjective/accusatory phrase (academic integrity, misconduct,
    credibility, "create the missing citation") is dropped so no guidance
    is persisted for that finding.
    """
    if not reason:
        return reason
    lowered = reason.lower()
    if any(phrase in lowered for phrase in _SUBJECTIVE_PHRASES):
        return None
    return reason


# Author/year embedded in the deterministic violation message, e.g.
# "Citation 'Garcia (2018)' was found in text, ..." — matches the exact
# format emitted by citation_sensor._make_violation.
_FINDING_AUTHOR_YEAR = re.compile(r"^Citation '(.+?) \((\d{4}[a-z]?)\)'")


def _extract_author_year(message: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Return (author, year) parsed from the deterministic violation message.

    Falls back to (None, None) when the message is missing or malformed —
    the caller then uses a generic correction without naming a source.
    """
    if not message:
        return None, None
    match = _FINDING_AUTHOR_YEAR.match(message.strip())
    if not match:
        return None, None
    return match.group(1), match.group(2)


def _build_personalised_correction(author: Optional[str], year: Optional[str]) -> str:
    """Deterministically assemble the personalised correction sentence.

    Application-owned wording, identical for every provider (Ollama,
    Gemini, local fallback). Never names a source type, never invents
    bibliographic details, and always includes the remove/correct
    alternative. The AI reason is validated but never persisted into this
    sentence — absolute phrasing ("No matching reference exists") cannot
    reach the student.
    """
    if author and year:
        target = f"{author} ({year})"
    else:
        target = "this citation"
    return (
        f"No matching References entry was found for {target} in this "
        "document. Verify the original source details and add the "
        "corresponding APA 7 reference entry. If the in-text citation "
        "refers to the wrong source or is no longer required, correct or "
        "remove it instead."
    )


def _validate_source_type(raw: Any) -> str:
    """Return one of the allowed source types, or "unknown" for anything else.

    The model may return anything — anything outside the whitelist is treated
    as unknown so the application never guesses a source type.
    """
    if isinstance(raw, str) and raw.strip().lower() in _APA_REFERENCE_TEMPLATES:
        return raw.strip().lower()
    return "unknown"


def _sanitise_reason(raw: Any) -> Optional[str]:
    """Sanitize the model's reason into a single bounded paragraph.

    Strips leading prefixes, collapses newlines, and truncates to 700 chars.
    Returns None for empty / non-string input.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    for prefix in ("Note:", "Suggestion:", "Fix:", "Recommendation:", "Tip:"):
        if text.lower().startswith(prefix.lower()):
            text = text[len(prefix):].lstrip()
    text = re.sub(r"\s*\n\s*", " ", text).strip()
    if not text:
        return None
    if len(text) > 700:
        text = text[:699].rstrip() + "\u2026"
    return text


def build_apa_suggestion(reason: str, source_type: str) -> str:
    """Assemble the structured guidance string stored in CitationIssue.suggestion.

    Section hierarchy: Recommended correction / What to verify /
    APA 7 formatting example / placeholder warning. The webpage template is
    only included for a known webpage source; an unknown source type shows
    the journal and book templates as labelled alternatives with a prompt to
    identify the original source type.
    """
    if source_type == "webpage":
        template_block = _APA_REFERENCE_TEMPLATES["webpage"]
    elif source_type in _APA_REFERENCE_TEMPLATES:
        template_block = _APA_REFERENCE_TEMPLATES[source_type]
    else:
        template_block = (
            "The source type could not be identified from the finding. "
            "Identify the original source type before submission — possible alternatives:\n"
            "Journal article:\n"
            "Author, A. A. (Year). Title of the article. Journal Name, volume(issue), "
            "page\u2013page. https://doi.org/xxxxx\n\n"
            "Book:\n"
            "Author, A. A. (Year). Title of the book. Publisher."
        )

    return (
        "Recommended correction\n"
        f"{reason}\n\n"
        "What to verify\n"
        f"{chr(10).join(_APA_VERIFICATION_CHECKLIST)}\n\n"
        "APA 7 formatting example\n"
        f"{template_block}\n\n"
        f"{_APA_PLACEHOLDER_WARNING}"
    )


# ---------------------------------------------------------------------------
# Provider call helpers
# ---------------------------------------------------------------------------

async def call_ollama_local(prompt: str) -> str:
    """Call local Ollama via HTTP API."""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{settings.OLLAMA_HOST}/api/generate",
                json={
                    "model": settings.OLLAMA_MODEL,
                    "prompt": prompt,
                    "stream": False,
                    "think": False,
                },
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
            generation_config={"temperature": 0.1, "max_output_tokens": 2048},
        )
        return response.text or ""
    except Exception as e:
        raise RuntimeError(f"Gemini call failed: {e}")


# ---------------------------------------------------------------------------
# Server-side response parser and confidence validator
# ---------------------------------------------------------------------------

# Sentinel returned when the provider response cannot be parsed as valid JSON.
# Distinguishes "provider returned empty" ([]) from "provider returned garbage"
# so the caller can treat them as COMPLETED_NO_SUGGESTIONS vs UNAVAILABLE.
_GUIDANCE_PARSE_ERROR = object()


def _parse_guidance_response(raw: str):
    """Parse the provider's guidance response.

    Returns a list of guidance items on success, or ``_GUIDANCE_PARSE_ERROR``
    when the response is not valid JSON or cannot be extracted. Callers use
    this sentinel to distinguish a legitimately empty array from malformed
    output and report the appropriate AI status.
    """
    try:
        clean_text = (raw or "").strip()
        if clean_text.startswith("```json"):
            clean_text = clean_text[7:]
        if clean_text.startswith("```"):
            clean_text = clean_text[3:]
        if clean_text.endswith("```"):
            clean_text = clean_text[:-3]
        clean_text = clean_text.strip()

        array_match = re.search(r'\[.*\]', clean_text, re.DOTALL)
        if array_match:
            clean_text = array_match.group(0)

        parsed = json.loads(clean_text)
        if isinstance(parsed, list):
            return parsed
        if isinstance(parsed, dict):
            for key in ("issues", "findings", "results", "data", "items"):
                inner = parsed.get(key)
                if isinstance(inner, list):
                    return inner
        return []
    except (json.JSONDecodeError, TypeError, AttributeError):
        return _GUIDANCE_PARSE_ERROR


def _validate_guidance_confidence(raw: Any) -> Optional[float]:
    """Return validated confidence float in [0,1] or None.

    Preserves model-provided confidence when truthful; never forces 1.0.
    Explicitly rejects booleans since bool is a subclass of int in Python.
    """
    if raw is None or isinstance(raw, bool):
        return None
    try:
        conf = float(raw)
    except (TypeError, ValueError):
        return None
    if 0.0 <= conf <= 1.0:
        return conf
    return None


# ---------------------------------------------------------------------------
# Core AI citation task — deterministic findings, AI guidance only (Build 7F)
# ---------------------------------------------------------------------------

async def async_ai_citation_task(
    text: str = "",
    audit_id: str = "",
    db: Session = None,
    cloud: bool = False,
    paragraph_map: Optional[Dict[int, str]] = None,
    citation_findings: Optional[List[Dict[str, Any]]] = None,
) -> AiCitationResult:
    """Run the AI citation guidance task against deterministic findings.

    When citation_findings is empty or None, skips the provider call
    and returns COMPLETED_NO_SUGGESTIONS immediately.

    When citation_findings is non-empty, the provider is called once to
    generate correction guidance. The provider must not discover new
    findings — it only explains how to fix the ones already confirmed.

    Returns an AiCitationResult summarising the actual execution: the
    provider that completed (or None), and whether accepted suggestions
    were produced. Provider failure is reported as UNAVAILABLE — never
    as a completed run.
    """
    if citation_findings is None:
        citation_findings = []

    if not citation_findings:
        logger.info(
            "AI citation suggestion audit_id=%s findings=0 skipped",
            audit_id,
        )
        return AiCitationResult(
            status=AI_STATUS_NO_SUGGESTIONS,
            provider=None,
            suggestions=[],
        )

    findings_json = json.dumps(citation_findings, indent=2)
    prompt = CITATION_GUIDANCE_PROMPT.replace("__FINDINGS__", findings_json)

    raw_response = ""
    provider: Optional[str] = None
    start = time.monotonic()

    if cloud:
        try:
            raw_response = await call_gemini_cloud(prompt)
            provider = AI_PROVIDER_CLOUD
        except Exception:
            try:
                raw_response = await call_ollama_local(prompt)
                provider = AI_PROVIDER_CLOUD_FALLBACK_LOCAL
            except Exception:
                provider = None
    else:
        try:
            raw_response = await call_ollama_local(prompt)
            provider = AI_PROVIDER_LOCAL
        except Exception:
            provider = None

    duration_ms = int((time.monotonic() - start) * 1000)

    if provider is None:
        logger.warning(
            "AI citation suggestion unavailable audit_id=%s findings=%d provider=null duration_ms=%d",
            audit_id,
            len(citation_findings),
            duration_ms,
        )
        return AiCitationResult(status=AI_STATUS_UNAVAILABLE, provider=None, suggestions=[])

    guidance = _parse_guidance_response(raw_response)

    # Distinguish valid empty array from parse failure.
    # [] = provider ran successfully but returned nothing → COMPLETED_NO_SUGGESTIONS.
    # _GUIDANCE_PARSE_ERROR = provider returned garbage → UNAVAILABLE.
    response_was_valid_list = isinstance(guidance, list)
    if guidance is _GUIDANCE_PARSE_ERROR:
        logger.warning(
            "AI citation suggestion unusable audit_id=%s provider=%s findings=%d reason=malformed_response duration_ms=%d",
            audit_id,
            provider,
            len(citation_findings),
            duration_ms,
        )
        return AiCitationResult(status=AI_STATUS_UNAVAILABLE, provider=None, suggestions=[])

    # Build a lookup from finding_key → guidance item.
    # finding_key is the request-local unique identifier injected by the
    # route layer. Using it (instead of paragraph_index) prevents mapping
    # collisions when multiple findings share the same paragraph.
    # First match wins for duplicate keys — later duplicates are silently
    # dropped to avoid persisting the same guidance twice.
    guidance_by_key: Dict[str, Dict[str, Any]] = {}
    for item in guidance:
        if not isinstance(item, dict):
            continue
        key = item.get("finding_key")
        if not key or not isinstance(key, str):
            continue
        if key not in guidance_by_key:
            guidance_by_key[key] = item

    accepted: List[Dict[str, Any]] = []
    for finding in citation_findings:
        finding_key = finding.get("finding_key")
        if not finding_key:
            continue
        item = guidance_by_key.pop(finding_key, None)
        if item is None:
            continue
        suggestion = None
        reason = _sanitise_reason(item.get("reason"))
        reason = _reject_subjective_reason(reason)
        if reason is not None:
            # Deterministic personalised correction — the model reason is
            # validated but never persisted verbatim. Application-owned
            # wording guarantees neutral, complete guidance on every
            # provider path (Ollama / Gemini / local fallback).
            author, year = _extract_author_year(finding.get("message", ""))
            correction = _build_personalised_correction(author, year)
            source_type = _validate_source_type(item.get("source_type"))
            suggestion = build_apa_suggestion(correction, source_type)
        if suggestion is None:
            continue
        confidence = _validate_guidance_confidence(item.get("confidence"))
        rule_code = finding.get("rule_code", "citation_mismatch")
        accepted.append({
            "paragraph_index": finding.get("paragraph_index"),
            "text_snippet": finding.get("snippet", ""),
            "issue_type": rule_code.lower(),
            "message": finding.get("message", ""),
            "suggestion": suggestion,
            "confidence": confidence,
        })

    # Valid JSON [] with findings → provider ran but produced no guidance
    if citation_findings and not accepted and response_was_valid_list:
        logger.info(
            "AI citation suggestion completed audit_id=%s provider=%s findings=%d accepted=0 duration_ms=%d",
            audit_id,
            provider,
            len(citation_findings),
            duration_ms,
        )
        return AiCitationResult(status=AI_STATUS_NO_SUGGESTIONS, provider=provider, suggestions=[])

    # Findings exist but response was malformed, empty, or all items
    # rejected by mapping — provider run is unusable.
    if citation_findings and not accepted:
        logger.warning(
            "AI citation suggestion unusable audit_id=%s provider=%s findings=%d accepted=0 duration_ms=%d",
            audit_id,
            provider,
            len(citation_findings),
            duration_ms,
        )
        return AiCitationResult(status=AI_STATUS_UNAVAILABLE, provider=None, suggestions=[])

    # Findings exist but response was malformed, empty, or all items rejected
    # by mapping — provider run is unusable.
    if citation_findings and not accepted:
        logger.info(
            "AI citation suggestion completed audit_id=%s provider=%s findings=%d accepted=0 duration_ms=%d",
            audit_id,
            provider,
            len(citation_findings),
            duration_ms,
        )
        return AiCitationResult(status=AI_STATUS_NO_SUGGESTIONS, provider=provider, suggestions=[])

    # Findings exist but response was malformed, non-list, or all items
    # rejected by mapping — provider run is unusable.
    if citation_findings and not accepted:
        logger.warning(
            "AI citation suggestion unusable audit_id=%s provider=%s findings=%d accepted=0 duration_ms=%d",
            audit_id,
            provider,
            len(citation_findings),
            duration_ms,
        )
        return AiCitationResult(status=AI_STATUS_UNAVAILABLE, provider=None, suggestions=[])

    # Persist accepted guidance rows
    suggestion_ids: List[str] = []
    for entry in accepted:
        issue = CitationIssue(
            id=str(uuid4()),
            audit_id=audit_id,
            paragraph_index=entry["paragraph_index"],
            text_snippet=entry["text_snippet"][:500],
            issue_type=entry["issue_type"],
            message=entry["message"],
            suggestion=entry["suggestion"],
            confidence=entry["confidence"],
        )
        db.add(issue)
        suggestion_ids.append(issue.id)
    db.commit()

    suggestions = [
        {
            "id": sid,
            "paragraph_index": entry["paragraph_index"],
            "text_snippet": entry["text_snippet"],
            "issue_type": entry["issue_type"],
            "message": entry["message"],
            "suggestion": entry["suggestion"],
            "confidence": entry["confidence"],
        }
        for sid, entry in zip(suggestion_ids, accepted)
    ]

    status = AI_STATUS_WITH_SUGGESTIONS if suggestions else AI_STATUS_NO_SUGGESTIONS
    logger.info(
        "AI citation suggestion completed audit_id=%s provider=%s findings=%d accepted=%d duration_ms=%d",
        audit_id,
        provider,
        len(citation_findings),
        len(suggestions),
        duration_ms,
    )
    return AiCitationResult(status=status, provider=provider, suggestions=suggestions)


# ---------------------------------------------------------------------------
# Backward-compat: extract_citation_text kept for callers that still need it
# ---------------------------------------------------------------------------

def extract_citation_text(paragraphs: List[Dict]) -> str:
    """Extract paragraphs likely to contain APA in-text citations for AI analysis."""
    patterns = {
        "parenthetical_apa": re.compile(
            r"\(\s*"
            r"[A-Z][A-Za-z'\-]+"
            r"(?:\s*(?:&|and)\s*[A-Z][A-Za-z'\-]+)*"
            r"(?:\s+et\s+al\.?)?"
            r"\s*,\s*"
            r"\d{4}[a-z]?"
            r"(?:\s*,\s*p+\.?\s*\d+)?"
            r"\s*\)"
        ),
        "narrative_apa": re.compile(
            r"\b[A-Z][A-Za-z'\-]+"
            r"(?:\s+(?:&|and)\s+[A-Z][A-Za-z'\-]+)*"
            r"(?:\s+et\s+al\.?)?"
            r"\s+\(\s*\d{4}[a-z]?(?:\s*,\s*p+\.?\s*\d+)?\s*\)"
        ),
        "et_al_prose": re.compile(r"\b\w+\s+et\s+al\.?,?\s*\d{0,4}"),
        "numeric_bracket": re.compile(r"\[\s*\d+(?:\s*[\-,\s]\s*\d+)*\s*\]"),
        "loose_author_year": re.compile(r"\b[A-Z][A-Za-z'\-]+\s+\(?\d{4}[a-z]?\)?"),
    }

    citation_texts = []
    for para in paragraphs:
        text = (para.get("text") or "").strip()
        if not text:
            continue
        if any(pat.search(text) for pat in patterns.values()):
            citation_texts.append(f"[Para {para.get('index', '?')}] {text}")

    if not citation_texts:
        citation_texts = [
            f"[Para {p.get('index', '?')}] {(p.get('text') or '').strip()}"
            for p in paragraphs
            if (p.get("text") or "").strip()
        ]

    return "\n\n".join(citation_texts) if citation_texts else "No citation-like text found."
