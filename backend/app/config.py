import os
import re
from pathlib import Path
from typing import List, Pattern
from pydantic_settings import BaseSettings
from typing import Literal


class PresetConfig:
    """SUC (Southern University College) thesis formatting defaults.

    Multilingual caption support: SUC theses may contain English, Malay,
    and Chinese captions. CAPTION_PATTERNS is a compiled regex list that
    matches any of these prefixes — extending it does NOT require touching
    the rules engine.
    """

    # ---- Font ----
    FONT_FAMILY = "Times New Roman"
    FONT_SIZE_BODY = 12
    FONT_SIZE_H1 = 16
    FONT_SIZE_H2 = 14
    FONT_SIZE_H3 = 12
    FONT_WEIGHT_HEADING = "bold"

    # ---- Spacing ----
    LINE_SPACING_BODY = 1.5
    LINE_SPACING_HEADING = 1.0
    SPACE_BEFORE_HEADING = 12  # pt
    SPACE_AFTER_HEADING = 6    # pt
    SPACE_BEFORE_BODY = 0
    SPACE_AFTER_BODY = 6

    # ---- Alignment ----
    ALIGNMENT_BODY = "justify"
    ALIGNMENT_HEADING = "left"

    # ---- Margins (in inches) — SUC standard ----
    MARGIN_LEFT = 1.5
    MARGIN_RIGHT = 1.0
    MARGIN_TOP = 1.0
    MARGIN_BOTTOM = 1.0
    MARGIN_TOLERANCE = 0.05  # inches

    # ---- Captions ----
    # Legacy single-prefix fields kept for backward compat with existing
    # check_media_captions code paths and tests. New code should use
    # CAPTION_PATTERNS instead.
    CAPTION_TABLE_PREFIX = "Table"
    CAPTION_FIGURE_PREFIX = "Figure"
    CAPTION_POSITION_TABLE = "above"
    CAPTION_POSITION_FIGURE = "below"

    # Multilingual caption patterns — SUC thesis context.
    # Matches prefixes like:
    #   English:  "Table 1", "Figure 1", "Fig. 1", "Tab. 1", "Chart 1"
    #   Malay:    "Jadual 1", "Gambar 1", "Rajah 1", "Graf 1"
    #   Chinese:  "表 1", "图 1", "图表 1"
    # The number after the prefix is mandatory — "Table" alone (without a
    # digit) is NOT a caption, it's just the word "table" in prose.
    CAPTION_PATTERNS: List[Pattern[str]] = [
        re.compile(r"^\s*table\s+\d+", re.IGNORECASE),
        re.compile(r"^\s*tab\.\s+\d+", re.IGNORECASE),
        re.compile(r"^\s*figure\s+\d+", re.IGNORECASE),
        re.compile(r"^\s*fig\.\s+\d+", re.IGNORECASE),
        re.compile(r"^\s*chart\s+\d+", re.IGNORECASE),
        re.compile(r"^\s*jadual\s+\d+", re.IGNORECASE),   # Malay: table
        re.compile(r"^\s*gambar\s+\d+", re.IGNORECASE),   # Malay: figure/image
        re.compile(r"^\s*rajah\s+\d+", re.IGNORECASE),    # Malay: diagram
        re.compile(r"^\s*graf\s+\d+", re.IGNORECASE),     # Malay: graph
        re.compile(r"^\s*图\s*\d+"),                       # Chinese: figure
        re.compile(r"^\s*表\s*\d+"),                       # Chinese: table
        re.compile(r"^\s*图表\s*\d+"),                     # Chinese: chart
    ]

    def is_caption_text(self, text: str) -> bool:
        """Return True if the given paragraph text matches any caption pattern.

        Centralised here so the rules engine, citation sensor, and tests
        all agree on what counts as a caption. Trims leading whitespace
        before matching — Word often inserts stray spaces.
        """
        if not text:
            return False
        return any(p.search(text) for p in self.CAPTION_PATTERNS)


class Settings(BaseSettings):
    DEPLOY_MODE: Literal["LOCAL", "CLOUD"] = "LOCAL"
    MAX_FILE_SIZE: int = 10 * 1024 * 1024  # 10 MB
    GEMINI_API_KEY: str = ""
    OLLAMA_HOST: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen3.5:4b"
    DATABASE_URL: str = "sqlite:///./audit.db"

    # SUC Preset (default)
    PRESET: PresetConfig = PresetConfig()

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()
