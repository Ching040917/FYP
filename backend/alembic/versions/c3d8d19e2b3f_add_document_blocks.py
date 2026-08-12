"""Add document-blocks JSON to audit_records for the Evidence-Linked Document Preview

Revision ID: c3d8d19e2b3f
Revises: b2c8d19e2b3f
Create Date: 2026-08-10

Nullable on purpose: historical rows predate the column, and NULL means
"preview unavailable" — never a silently empty document. Stores ordered
paragraph-only blocks (text, style, heading level). The original DOCX is
never stored.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'c3d8d19e2b3f'
down_revision: Union[str, Sequence[str], None] = 'b2c8d19e2b3f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('audit_records', sa.Column('document_blocks', sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('audit_records', 'document_blocks')
