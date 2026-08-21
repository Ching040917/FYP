"""Add interruption_reason + interrupted_at to audit_records

Revision ID: f6a8d19e2b3f2
Revises: f6a8d19e2b3f
Create Date: 2026-08-26

Stale Audit recovery (Build 1). Nullable on purpose: historical rows and
non-interrupted audits have NULL — never an empty string, never a default.
`interruption_reason` holds only a safe non-sensitive category (Build 1
value: `application_restart`). `interrupted_at` records when the abandoned
`processing` row was claimed. Never stores paths, stack traces, exception
strings, document text, or provider responses.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'f6a8d19e2b3f2'
down_revision: Union[str, Sequence[str], None] = 'f6a8d19e2b3f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema: add the two nullable stale-recovery columns."""
    op.add_column('audit_records', sa.Column('interruption_reason', sa.String(length=50), nullable=True))
    op.add_column('audit_records', sa.Column('interrupted_at', sa.DateTime(), nullable=True))


def downgrade() -> None:
    """Downgrade schema: remove only these two columns (rows untouched)."""
    op.drop_column('audit_records', 'interrupted_at')
    op.drop_column('audit_records', 'interruption_reason')
