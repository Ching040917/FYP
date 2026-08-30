from PIL import Image
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "assets" / "branding" / "aca-icon-source.png"
ICO_OUT = REPO / "assets" / "branding" / "aca-icon.ico"
FAVICON_OUT = REPO / "frontend" / "public" / "assets" / "favicon.ico"

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def fail(msg: str):
    print(f"FAIL: {msg}")
    sys.exit(1)


if not SRC.is_file():
    fail(f"missing source image: {SRC}")

img = Image.open(SRC)
if img.format != "PNG":
    fail(f"source is {img.format}, expected PNG")

w, h = img.size
if w != h:
    fail(f"source is {w}x{h}, expected square")

# RGBA for alpha-preserving output; a source with no alpha becomes opaque.
rgba = img.convert("RGBA")

# One ICO containing every requested resolution (Windows picks the best).
ICO_OUT.parent.mkdir(parents=True, exist_ok=True)
FAVICON_OUT.parent.mkdir(parents=True, exist_ok=True)
rgba.save(ICO_OUT, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
rgba.save(FAVICON_OUT, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
print(f"ICO written: {ICO_OUT}")
print(f"  sizes: {ICO_SIZES}")
print(f"Favicon written: {FAVICON_OUT}")

# Inno Setup wizard small image requires a 32x32 BMP-compatible image; its ICO
# loader rejects large multi-size ICOs here ("Bitmap image is not valid").
WIZARD_OUT = REPO / "assets" / "branding" / "aca-icon-wizard.bmp"
rgba.resize((32, 32), Image.LANCZOS).save(WIZARD_OUT, format="BMP")
print(f"Wizard BMP written: {WIZARD_OUT}")
