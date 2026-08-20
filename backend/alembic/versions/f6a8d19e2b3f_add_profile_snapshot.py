"""Add profile_snapshot JSON to audit_records for immutable profile persistence

Revision ID: f6a8d19e2b3f
Revises: e5f8d19e2b3f
Create Date: 2026-08-25

Nullable on purpose: historical rows predate the column, and NULL means
"Legacy formatting requirements" — never an empty profile, never an
auto-resolved default. Stores the complete immutable EffectiveProfileSnapshot
(identity, version, source, citation style, effective formatting
requirements, eligibility policies, canonical fingerprint). The original
DOCX is never stored; no document text, filenames, paths, or credentials
ever enter this column.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'f6a8d19e2b3f'
down_revision: Union[str, Sequence[str], None] = 'e5f8d19e2b3f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema: add the nullable profile snapshot JSON column."""
    op.add_column('audit_records', sa.Column('profile_snapshot', sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema: remove only this column (existing rows untouched)."""
    op.drop_column('audit_records', 'profile_snapshot')
