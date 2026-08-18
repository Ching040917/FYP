"""Add section_metadata JSON to audit_records for Section page-range navigation

Revision ID: e5f8d19e2b3f
Revises: d4e8d19e2b3f
Create Date: 2026-08-20

Nullable on purpose: historical rows predate the column, and NULL means
"Section metadata unavailable" — Margin navigation must report truthful
unavailable behavior, never a fabricated page range. Stores only section
boundary metadata (indexes, break type, page size, margins) — no document
text, no paths, no PDF bytes. The original DOCX is never stored, so
boundaries are captured at audit creation and never reconstructed from PDF
text afterwards.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'e5f8d19e2b3f'
down_revision: Union[str, Sequence[str], None] = 'd4e8d19e2b3f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema: add the nullable section metadata JSON column."""
    op.add_column('audit_records', sa.Column('section_metadata', sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema: remove the column (existing rows are untouched)."""
    op.drop_column('audit_records', 'section_metadata')
