# Product Requirements Document (PRD)

## 1. Project Overview
* **Project Name**: A Hybrid Architecture for Automated Academic Compliance Auditing
* **Project Type**: Local Web Application (Full-Stack)
* **Core Value & Positioning**: 
  - **Privacy-Preserving (Local-First)**: Employs a local-first deployment model to maximize data privacy and protect unpublished academic work.
  - **Highly Accurate**: Utilizes deterministic code rules to provide high-precision validation of document layout structures.
  - **Near Real-Time Performance**: Delivers rapid document checking pipelines to provide instantaneous layout health reports.

---

## 2. User Personas & Scenarios
1. **University Students (Student Persona)**:
   - **Behavioral Patterns & Pain Points**: Students often perform manual formatting checks under high stress just hours before submission deadlines. This late-stage rush causes mental fatigue, leading to skipped layout errors and preventable grade deductions.
   - **Usage Scenario**: In the final hours before a deadline, the student uploads their draft to get immediate visual feedback, highlighting exact formatting gaps for targeted, low-stress fixes.
2. **Academic Supervisors (Supervisor Persona)**:
   - **Behavioral Patterns & Pain Points**: When grading dozens of thesis reports concurrently, supervisors must spend over 30% of their time correcting basic typography issues (such as incorrect spacing or messy heading trees). This administrative overhead reduces the time available to evaluate core research arguments and system architectures.

---

## 3. Core Functional Requirements

### FR-1: Robust File Upload and Input Validation
* **System Requirement**: The system shall enforce file type validation (`.docx`) and strict file size limits (e.g., maximum 10MB) to block invalid, malformed, or malicious inputs at the system entry point.
* **Data Safety**: The file reading process shall utilize read-only memory buffers to ensure the user's original source file is never modified or corrupted.

### FR-2: Document Layout Compliance Auditing
* **System Requirement**: The system shall extract and verify document formatting attributes from uploaded files.
* **Specific Audit Scopes**:
  1. **Font Consistency**: Scans text elements to ensure font families are uniform across matching document sections.
  2. **Font Size Alignment**: Verifies that font sizes for body text and headings follow preset school specifications.
  3. **Paragraph Typography**: Evaluates line spacing values, paragraph spacing properties, and block text alignment rules.
  4. **Page Margins**: Measures the physical page boundaries (top, bottom, left, right) inside the file stream.
  5. **Heading Level Hierarchy**: Evaluates the tree structure of all headings to catch structural gaps (such as a Heading 3 appearing directly under a Heading 1 while skipping Heading 2).
  6. **Media Captions**: Confirms that every embedded data table and image object contains an associated text description tag.

### FR-3: Intelligent Citation Audit and Structured Output
* **System Requirement**: The AI module shall scan text paragraphs to identify common formatting gaps in APA in-text citations.
* **Input/Output Structuring**: The AI module shall accept extracted text strings as inputs and **must return structured outputs in JSON format** containing detected issues and human-readable explanations to ensure total design consistency with the backend server.

### FR-4: Weighted Scoring System and Visual Dashboard
* **Weighted Scoring Logic**: 
  - **System Requirement**: The overall compliance score shall be computed based on weighted error categories.
  - **Scoring Rules**: Structural violations—such as page margin shifts or out-of-order heading trees—shall be categorized as **Major Violations** and carry high deduction weights. Minor typography inconsistencies shall be labeled as **Minor Violations** with lower deduction weights. This prevents single typos from altering the score as severely as fundamental layout failures.
* **Interface Display**: The frontend shall highlight errors at their exact document positions on the left panel, display simple AI-generated fixing tooltips on the right panel, and show the weighted score alongside visual charts on a central dashboard.

### FR-5: Explicit Optional Cloud Mode
* **Privacy Alignment**: 
  - **System Requirement**: Cloud mode is optional and disabled by default. Explicit user consent is required.
  - **Execution Logic**: The alternative cloud connection pipeline remains completely locked until the user actively clicks and authorizes external network access on the UI, protecting the core local-privacy design.

---

## 4. Boundaries and Limitations
* The platform functions as a read-only formatting checker. It handles error detection, location highlighting, and repair suggestions, but **it shall never perform automated file rewriting**. This boundaries-first rule completely eliminates the risk of code errors ruining complex Word layouts.
* The system does not support file types outside of `.docx` (such as PDF or LaTeX) and does not provide advanced grammar checking or external database similarity matching for plagiarism.