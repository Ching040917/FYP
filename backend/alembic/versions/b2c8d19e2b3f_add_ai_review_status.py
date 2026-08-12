"""Add AI-assisted citation review execution metadata to audit_records

Revision ID: b2c8d19e2b3f
Revises: a4c7d19e2b3f
Create Date: 2026-08-09

Nullable on purpose: historical rows predate the columns, and NULL means
"AI review status not recorded" — never a fabricated "ran" or
"unavailable" value. No raw prompts, model responses, or document text
are stored.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'b2c8d19e2b3f'
down_revision: Union[str, Sequence[str], None] = 'a4c7d19e2b3f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('audit_records', sa.Column('ai_review_status', sa.String(length=40), nullable=True))
    op.add_column('audit_records', sa.Column('ai_provider', sa.String(length=40), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('audit_records', 'ai_provider')
    op.drop_column('audit_records', 'ai_review_status')
