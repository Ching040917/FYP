"""Add rendered PDF preview metadata columns to audit_records (Build 1)

Revision ID: d4e8d19e2b3f
Revises: c3d8d19e2b3f
Create Date: 2026-08-16

All six columns are nullable: NULL means "never attempted or historical
record". Only non-sensitive values are stored — status (AVAILABLE /
UNAVAILABLE) and a fixed error category. The final PDF path is derived
from the audit ID and is never stored, so no path column exists.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'd4e8d19e2b3f'
down_revision: Union[str, Sequence[str], None] = 'c3d8d19e2b3f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema: add nullable preview metadata columns."""
    op.add_column('audit_records', sa.Column('rendered_preview_status', sa.String(length=20), nullable=True))
    op.add_column('audit_records', sa.Column('rendered_preview_sha256', sa.String(length=64), nullable=True))
    op.add_column('audit_records', sa.Column('rendered_preview_size', sa.Integer(), nullable=True))
    op.add_column('audit_records', sa.Column('rendered_preview_pages', sa.Integer(), nullable=True))
    op.add_column('audit_records', sa.Column('rendered_preview_converted_at', sa.DateTime(), nullable=True))
    op.add_column('audit_records', sa.Column('rendered_preview_error', sa.String(length=50), nullable=True))


def downgrade() -> None:
    """Downgrade schema: remove only these fields."""
    op.drop_column('audit_records', 'rendered_preview_error')
    op.drop_column('audit_records', 'rendered_preview_converted_at')
    op.drop_column('audit_records', 'rendered_preview_pages')
    op.drop_column('audit_records', 'rendered_preview_size')
    op.drop_column('audit_records', 'rendered_preview_sha256')
    op.drop_column('audit_records', 'rendered_preview_status')
