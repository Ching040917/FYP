"""Add document statistics columns to audit_records

Revision ID: a4c7d19e2b3f
Revises: f17a86596071
Create Date: 2026-08-08

Nullable on purpose: existing rows predate the columns, and the API treats
NULL as "stats unavailable" rather than fabricated zero counts.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'a4c7d19e2b3f'
down_revision: Union[str, Sequence[str], None] = 'f17a86596071'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('audit_records', sa.Column('paragraph_count', sa.Integer(), nullable=True))
    op.add_column('audit_records', sa.Column('heading_count', sa.Integer(), nullable=True))
    op.add_column('audit_records', sa.Column('table_count', sa.Integer(), nullable=True))
    op.add_column('audit_records', sa.Column('image_count', sa.Integer(), nullable=True))
    op.add_column('audit_records', sa.Column('section_count', sa.Integer(), nullable=True))
    op.add_column('audit_records', sa.Column('word_count', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('audit_records', 'word_count')
    op.drop_column('audit_records', 'section_count')
    op.drop_column('audit_records', 'image_count')
    op.drop_column('audit_records', 'table_count')
    op.drop_column('audit_records', 'heading_count')
    op.drop_column('audit_records', 'paragraph_count')
