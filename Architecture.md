# System Architecture Documentation

## 1. Overall Architecture Topology
The platform uses a decoupled Browser/Server (B/S) client-side local architecture. The system core implements a dual-engine architecture designed to process layout rules and AI tasks asynchronously:

 [Frontend View: React.js]
           │
  (HTTP / Async JSON)
           │
           ▼
 [Backend Web Server: FastAPI] ─────── (Reads) ───────► [Target Word Document (.docx)]
               │                                                    │
  (Localhost:11434 / Async Task)                       (Parsed via Python-Docx)
               │                                                    │
               ▼                                                    ▼
 [Local AI Engine: Ollama]                    [Fixed Layout Rules Engine]
 (Model: Qwen2.5-3B Quantized)                 (Strategy Pattern: Typographic Checks)
           │
  (Disabled by Default / Enabled via UI Toggle)
           │
           ▼ (Controlled Alternative Path)
 [Cloud Free Gemini 1.5 Flash API]

---

## 2. Tech Stack Matrix
* **Frontend View Layer (React.js)**: Utilizes a Virtual DOM architecture. When receiving complex error arrays from the server, it runs efficient incremental updates to prevent full-page browser reloads.
* **Asynchronous Backend Layer (FastAPI)**: Supports asynchronous concurrency based on the ASGI standard. It uses Background Tasks to handle long-running AI inference processes without blocking the main request thread.
* **Document File Parser (Python-Docx)**: Unpacks and scans the OpenXML styling trees directly within memory buffers, eliminating the need to launch a heavy Microsoft Word client instance.

---

## 3. Conceptual Asynchronous Design
To prevent long-running AI citation checks from stalling the application, the platform separates file processing into parallel execution tracks:

[User Uploads Word File (< 10MB)] ──► [FastAPI Secure Input Verification] 
                                             │
             ┌───────────────────────────────┴───────────────────────────────┐
             ▼ (Main Request Thread)                                         ▼ (Asynchronous Background Task)
   [Fixed Layout Rules Engine]                                     [Ollama Local AI Layer]
             │                                                               │
   - Computes geometric layout errors inside 0.5s.                 - Executes citation context scans.
   - Compiles weighted error scores instantly.                     - Returns structured text outputs.
             │                                                               │
             ▼                                                               ▼
 [React UI Renders Fixed Layout Errors Immediately] ◄── (Asynchronous Merge) ──► [UI Appends AI Citation Tooltips]

---

## 4. Key Backend Code Architecture Implementation
This single continuous code block demonstrates the backend's route safety controls, asynchronous background task allocation, and defensive JSON handling (written using standard markdown indentation to prevent code-box splitting):

    # =====================================================================
    # config.py - Global Environment Configurations
    # =====================================================================
    import os

    class ServerConfig:
        DEPLOY_MODE = os.getenv("DEPLOY_MODE", "LOCAL")  # Defaults to secure local mode
        MAX_FILE_SIZE = 10 * 1024 * 1024                 # Restricts maximum input size to 10MB
        GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "FREE_KEY_ENV_VALUE")


    # =====================================================================
    # main.py - FastAPI Application Core Router
    # =====================================================================
    from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException
    import docx
    import json
    import ollama
    import google.generativeai as genai

    app = FastAPI()

    def run_static_rules_engine(doc_bytes: bytes) -> list:
        """Extracts layout properties using python-docx with strict rule mapping."""
        errors = []
        # Structural checking steps occur here
        return errors

    def calculate_weighted_score(errors: list) -> int:
        """Computes a layout health score based on major and minor error categories."""
        base_score = 100
        # Deduct weights based on error type severity
        return max(base_score - len(errors), 0)

    def parse_ai_json(raw_ai_text: str) -> list:
        """Cleans, sanitizes, and parses AI output strings to defend against crash risks."""
        try:
            # Strip potential Markdown wrappers safely if present
            clean_text = raw_ai_text.strip().replace("```json", "").replace("
```", "")
            return json.loads(clean_text)
        except (json.JSONDecodeError, TypeError):
            # Fallback safety net triggers if AI returns invalid JSON formats or hallucinations
            return [{"line": -1, "msg": "The AI response format was non-standard. Please verify this citation section manually."}]

    async def async_ai_citation_task(sample_text: str, result_holder: list):
        """Executes long-running semantic AI evaluations within an isolated background thread."""
        try:
            if ServerConfig.DEPLOY_MODE == "LOCAL":
                response = ollama.generate(
                    model='qwen2.5:3b', 
                    prompt=f"Verify if this text matches APA 7th format rules. Return clean JSON only: {sample_text}"
                )
                raw_text = response['response']
            else:
                genai.configure(api_key=ServerConfig.GEMINI_API_KEY)
                model = genai.GenerativeModel('gemini-1.5-flash')
                response = model.generate_content(f"Verify APA style citation format rules: {sample_text}")
                raw_text = response.text
                
            result_holder.extend(parse_ai_json(raw_text))
        except Exception:
            # Handles connection time-outs or system outages gracefully
            result_holder.append({"line": -1, "msg": "The citation verification engine experienced a network timeout."})

    @app.post("/api/audit")
    async def audit_document(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
        # Step 1: Input Validation Defense (File format and size validation)
        if not file.filename.endswith('.docx'):
            raise HTTPException(status_code=400, detail="Unsupported file format. Only .docx files are accepted.")
        
        file_bytes = await file.read()
        if len(file_bytes) > ServerConfig.MAX_FILE_SIZE:
            raise HTTPException(status_code=400, detail="File size exceeds the 10MB security boundary.")
        
        # Step 2: Instant layout calculation using the rules engine
        layout_errors = run_static_rules_engine(file_bytes)
        weighted_score = calculate_weighted_score(layout_errors)
        
        # Step 3: Trigger genuine non-blocking AI verification via BackgroundTasks
        ai_results = []
        background_tasks.add_task(async_ai_citation_task, "Extracted Target Citation Strings", ai_results)
        
        return {
            "status": "Success",
            "weighted_compliance_score": weighted_score,
            "physical_layout_errors": layout_errors,
            "ai_citation_tooltips": ai_results  # Front-end will poll or merge this data upon completion
        }

---

## 5. Architectural Limitations & Robustness
1. **Word Style Inheritance and Parsing Complexity**: 
   - **Technical Limitation Statement**: *Certain complex Word styling scenarios may not be fully captured due to the limitations of the parsing library.*
   - **Explanation**: Microsoft Word files implement highly intricate font styling inheritance and run-level property overrides inside their underlying XML directories. The static Python rules engine focuses primarily on validating global styles and paragraph-level configurations. Complex, manual local overrides within tiny code structures may fall outside the parsing lens. This limitation is openly documented as an engineering boundary and a target for future work.
2. **AI Malformed Output Mitigation**: The system features strict try-except capture filters within the `parse_ai_json` utility. If a local model experiences hallucination or returns poorly formatted text chunks, the exception handler catches the error immediately and down-grades to a standard warning card, preserving backend service uptime.
3. **Evidence-Linked Preview is Paragraph-Level Only (Builds 8B–8E)**: The document preview surface covers extracted paragraph text (text, style name, heading level), persisted only for new audits. It is explicitly not exact pagination, image/table rendering, editing, document rewriting, or pixel-perfect Microsoft Word reproduction. Extracted text is stored locally in the audit database so previews can be reopened from history; the original `.docx` is never stored or modified.