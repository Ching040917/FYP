import asyncio
import json
import logging
import re
from typing import List, Dict, Any, Optional
from uuid import uuid4

from sqlalchemy.orm import Session

from app.config import settings
from app.models.audit import CitationIssue

logger = logging.getLogger(__name__)


APA_CITATION_PROMPT = """You are an APA 7th edition citation format validator.
Analyze the following text for APA in-text citation issues.
Return ONLY a JSON array of issues found. Each issue must have:
- "paragraph_index": integer (0-based index of paragraph)
- "text_snippet": string (the problematic text segment, max 200 chars)
- "issue_type": string (one of: "missing_author", "missing_year", "format_error", "et_al_error", "ampersand_error", "page_number_error", "multiple_citations_error", "other")
- "message": string (human-readable explanation)
- "suggestion": string (optional, how to fix)
- "confidence": float (0.0-1.0, your confidence in this detection)

If no issues found, return empty array [].

Text to analyze:
{text}"""


def parse_ai_json(raw_ai_text: str) -> List[Dict[str, Any]]:
    """Defensive JSON parser for AI output.
    Strips markdown code fences, handles malformed JSON, returns fallback on error.
    """
    try:
        # Strip markdown code fences
        clean_text = raw_ai_text.strip()
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
    """Call local Ollama model (Layer 1)."""
    try:
        import ollama
        client = ollama.AsyncClient(host=settings.OLLAMA_HOST)
        response = await client.generate(
            model=settings.OLLAMA_MODEL,
            prompt=prompt,
            options={"temperature": 0.1, "num_predict": 2048}
        )
        return response.get("response", "")
    except Exception as e:
        raise RuntimeError(f"Ollama call failed: {e}")


async def call_gemini_cloud(prompt: str) -> str:
    """Call Google Gemini 1.5 Flash API (Layer 2) with 30s hard timeout."""
    try:
        import google.generativeai as genai
        if not settings.GEMINI_API_KEY:
            raise RuntimeError("GEMINI_API_KEY not configured")
        genai.configure(api_key=settings.GEMINI_API_KEY)
        model = genai.GenerativeModel('gemini-1.5-flash')
        response = await asyncio.wait_for(
            model.generate_content_async(
                prompt,
                generation_config={"temperature": 0.1, "max_output_tokens": 2048}
            ),
            timeout=30.0
        )
        return response.text or ""
    except asyncio.TimeoutError:
        raise RuntimeError("Gemini call timed out after 30s")
    except Exception as e:
        raise RuntimeError(f"Gemini call failed: {e}")


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
    return [{"id": ci.id, **ci.__dict__} for ci in citation_issues]


def extract_citation_text(paragraphs: List[Dict]) -> str:
    """Extract text segments likely to contain citations for AI analysis."""
    citation_texts = []
    for para in paragraphs:
        text = para.get("text", "").strip()
        if text and (re.search(r'\(\w+, \d{4}\)', text) or  # (Author, Year)
                     re.search(r'\w+ et al\.?', text) or     # Author et al.
                     re.search(r'\[\d+\]', text)):           # [1]
            citation_texts.append(f"[Para {para['index']}] {text}")
    return "\n\n".join(citation_texts) if citation_texts else "No citation-like text found."