"""Add document_sha256 to audit_records for Guided Fixes identity

Revision ID: b3e8d19e2b3f
Revises: 90fc17718e11
Create Date: 2026-09-01

Stores the SHA-256 of the uploaded DOCX bytes (lowercase hex) at audit
creation so Guided Fixes can verify a re-uploaded file is the exact
original before mutating a copy. Nullable on purpose: historical rows
predate the column and have NULL — Guided Fixes is unavailable for them.
No backfill. The DOCX itself is never stored; only this 64-char digest.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'b3e8d19e2b3f'
down_revision: Union[str, Sequence[str], None] = '90fc17718e11'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema: add the nullable document_sha256 column."""
    op.add_column('audit_records', sa.Column('document_sha256', sa.String(64), nullable=True))


def downgrade() -> None:
    """Downgrade schema: remove only this column (rows untouched)."""
    op.drop_column('audit_records', 'document_sha256')
