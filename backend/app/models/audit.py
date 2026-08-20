import uuid
from datetime import datetime
from typing import Optional
from sqlalchemy import Column, String, Integer, DateTime, ForeignKey, Text, Float
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import relationship

from app.database import Base


class AuditRecord(Base):
    __tablename__ = "audit_records"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    filename = Column(String(255), nullable=False)
    file_size = Column(Integer, nullable=False)
    weighted_score = Column(Integer, default=0)
    deploy_mode = Column(String(10), nullable=False, default="LOCAL")
    status = Column(String(20), nullable=False, default="processing")
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    # Document statistics computed at audit time and persisted. Nullable —
    # records created before these columns existed have NULL values, and the
    # API/UI must treat NULL as "stats unavailable", never as zero counts.
    paragraph_count = Column(Integer, nullable=True)
    heading_count = Column(Integer, nullable=True)
    table_count = Column(Integer, nullable=True)
    image_count = Column(Integer, nullable=True)
    section_count = Column(Integer, nullable=True)
    word_count = Column(Integer, nullable=True)

    # AI-assisted citation review execution summary (Build 7D). Nullable —
    # historical records have NULL, meaning "status not recorded". NULL must
    # never be presented as "review ran" or "review unavailable".
    ai_review_status = Column(String(40), nullable=True)
    ai_provider = Column(String(40), nullable=True)

    # Evidence-Linked Document Preview (Build 8B): ordered paragraph-only
    # blocks as JSON. Nullable — historical records predate the column and
    # the preview must report "unavailable", never an empty document. The
    # original DOCX is never stored. Lives on the parent row so audit
    # deletion removes it automatically. Never log block text.
    document_blocks = Column(JSON, nullable=True)

    # Section boundary metadata (PoC): nullable JSON mirroring the
    # SectionMetadata API shape (section_index, start/end paragraph index,
    # break_type, page size, margins). Nullable — historical records
    # predate the column and Margin navigation must report "unavailable",
    # never a fabricated range. Populated at audit creation from the DOCX
    # (never reconstructed from PDF text after the DOCX is discarded).
    section_metadata = Column(JSON, nullable=True)

    # Immutable Document Formatting Profile snapshot (Build 3): the
    # complete resolved EffectiveProfileSnapshot captured at audit creation
    # (identity, version, source, citation style, effective formatting
    # requirements, eligibility policies, canonical fingerprint). Nullable —
    # historical records predate the column and must display "Legacy
    # formatting requirements", never an auto-resolved default. Stored data
    # is never re-resolved; GET returns exactly what was persisted. Never
    # carries document text, filenames, paths, or credentials.
    profile_snapshot = Column(JSON, nullable=True)

    # Rendered PDF preview metadata (Build 1). NULL = never attempted or
    # historical record; "AVAILABLE" = rendered PDF present in storage;
    # "UNAVAILABLE" = render attempted but failed. rendered_preview_error
    # holds only a non-sensitive error category (libreoffice_missing,
    # timeout, conversion_failed, persistence_failed, file_missing). The
    # final PDF path is derived from the audit ID — no path is stored.
    rendered_preview_status = Column(String(20), nullable=True)
    rendered_preview_sha256 = Column(String(64), nullable=True)
    rendered_preview_size = Column(Integer, nullable=True)
    rendered_preview_pages = Column(Integer, nullable=True)
    rendered_preview_converted_at = Column(DateTime, nullable=True)
    rendered_preview_error = Column(String(50), nullable=True)

    violations = relationship("Violation", back_populates="audit", cascade="all, delete-orphan")
    citation_issues = relationship("CitationIssue", back_populates="audit", cascade="all, delete-orphan")


class Violation(Base):
    __tablename__ = "violations"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    audit_id = Column(String(36), ForeignKey("audit_records.id", ondelete="CASCADE"), nullable=False)
    rule_code = Column(String(50), nullable=False)
    severity = Column(String(10), nullable=False)  # MAJOR / MINOR
    location = Column(JSON, nullable=True)
    message = Column(Text, nullable=False)
    expected_value = Column(Text, nullable=True)
    actual_value = Column(Text, nullable=True)

    audit = relationship("AuditRecord", back_populates="violations")


class CitationIssue(Base):
    __tablename__ = "citation_issues"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    audit_id = Column(String(36), ForeignKey("audit_records.id", ondelete="CASCADE"), nullable=False)
    paragraph_index = Column(Integer, nullable=False)
    text_snippet = Column(Text, nullable=False)
    issue_type = Column(String(50), nullable=False)
    message = Column(Text, nullable=False)
    suggestion = Column(Text, nullable=True)
    confidence = Column(Float, nullable=True)

    audit = relationship("AuditRecord", back_populates="citation_issues")