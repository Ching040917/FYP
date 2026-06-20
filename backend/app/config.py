import os
from pathlib import Path
from pydantic_settings import BaseSettings
from typing import Literal


class PresetConfig:
    """SUC (Southern University College) thesis formatting defaults.
    Extend this class for other university presets.
    """
    # Font
    FONT_FAMILY = "Times New Roman"
    FONT_SIZE_BODY = 12
    FONT_SIZE_H1 = 16
    FONT_SIZE_H2 = 14
    FONT_SIZE_H3 = 12
    FONT_WEIGHT_HEADING = "bold"

    # Spacing
    LINE_SPACING_BODY = 1.5
    LINE_SPACING_HEADING = 1.0
    SPACE_BEFORE_HEADING = 12  # pt
    SPACE_AFTER_HEADING = 6    # pt
    SPACE_BEFORE_BODY = 0
    SPACE_AFTER_BODY = 6

    # Alignment
    ALIGNMENT_BODY = "justify"
    ALIGNMENT_HEADING = "left"

    # Margins (in inches)
    MARGIN_LEFT = 1.5
    MARGIN_RIGHT = 1.0
    MARGIN_TOP = 1.0
    MARGIN_BOTTOM = 1.0

    # Captions
    CAPTION_TABLE_PREFIX = "Table"
    CAPTION_FIGURE_PREFIX = "Figure"
    CAPTION_POSITION_TABLE = "above"
    CAPTION_POSITION_FIGURE = "below"


class Settings(BaseSettings):
    DEPLOY_MODE: Literal["LOCAL", "CLOUD"] = "LOCAL"
    MAX_FILE_SIZE: int = 10 * 1024 * 1024  # 10 MB
    GEMINI_API_KEY: str = ""
    OLLAMA_HOST: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen2.5:3b"
    DATABASE_URL: str = "sqlite:///./audit.db"

    # SUC Preset (default)
    PRESET: PresetConfig = PresetConfig()

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()