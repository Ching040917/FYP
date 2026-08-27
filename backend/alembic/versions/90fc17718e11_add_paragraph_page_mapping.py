"""Add paragraph_page_mapping JSON to audit_records for friendly page locations

Revision ID: 90fc17718e11
Revises: f6a8d19e2b3f2
Create Date: 2026-08-27

Stores a deterministic paragraph_index -> physical rendered-PDF page mapping
computed at audit time while both the DOCX blocks and the validated rendered
PDF bytes are available. Nullable on purpose: historical audits and audits
where preview was unavailable/invalid have NULL — the UI and PDF report
must show "Page: Unavailable" and never guess. Stores integers only
(zero-based paragraph index as string key, one-based physical page as value);
no document text, excerpts, or confidence diagnostics. One JSON blob on the
parent audit_records row, so audit deletion removes it automatically.
No change to Violation.location.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import JSON

# revision identifiers, used by Alembic.
revision: str = '90fc17718e11'
down_revision: Union[str, Sequence[str], None] = 'f6a8d19e2b3f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema: add the nullable paragraph_page_mapping JSON column."""
    op.add_column('audit_records', sa.Column('paragraph_page_mapping', JSON, nullable=True))


def downgrade() -> None:
    """Downgrade schema: remove only this column (rows untouched)."""
    op.drop_column('audit_records', 'paragraph_page_mapping')
