"""Pins the backend preset values that the frontend spec card mirrors.

The frontend hardcodes these values in SpecCard (Dashboard.tsx / LandingPage.tsx)
for display; backend/app/config.py PresetConfig is the authoritative source.
If this test fails, update BOTH the preset and the frontend copy together.
"""
from app.config import settings


def test_preset_body_line_spacing():
    assert settings.PRESET.LINE_SPACING_BODY == 1.5


def test_preset_margins():
    preset = settings.PRESET
    assert (preset.MARGIN_LEFT, preset.MARGIN_RIGHT, preset.MARGIN_TOP, preset.MARGIN_BOTTOM) == (
        1.5, 1.0, 1.0, 1.0,
    )


def test_preset_body_font():
    assert settings.PRESET.FONT_FAMILY == "Times New Roman"
    assert settings.PRESET.FONT_SIZE_BODY == 12
