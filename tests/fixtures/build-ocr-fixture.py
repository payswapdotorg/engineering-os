#!/usr/bin/env python3
"""build-ocr-fixture.py — the committed OCR fixture generator (Slice 16-B, 16-R2).

Renders the pinned callout strip `tests/fixtures/ocr-callout.png` with pillow +
DejaVuSans (the base-image font — present on this sandbox and the CI runners;
NOT a venv dependency): a title line, a bare dimension, a diameter callout and
a second dimension. The RENDERED Ø GLYPH is what tesseract never reads natively
(it emits "@400" — the number is always right; the 16-R2 finding this fixture
pins): the adapter's diameter normalization rule maps it back with the raw
transcript preserved.

Determinism: same font file + same pillow major → byte-identical PNG (verified
by regenerating and comparing sha256 on the dev host; the COMMITTED fixture is
what the harness reads — this generator is provenance, re-run only to rebuild
the fixture deliberately).

Pinned expectations (harness case `sheet-ocr-callout`, vendored eng.traineddata
sha 7d4322bd…, psm 6):
  LOADING BAY PLAN   conf ≥ 90 (three words)
  2400               conf ≥ 90
  Ø400 → read "@400" conf ≥ 40 → normalized "Ø400" (raw preserved)
  1200               conf ≥ 90
"""
from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
OUT = "tests/fixtures/ocr-callout.png"

img = Image.new("RGB", (920, 340), "#ffffff")
d = ImageDraw.Draw(img)
f = ImageFont.truetype(FONT, 44)
d.text((30, 20), "LOADING BAY PLAN", font=f, fill="#000000")
d.text((30, 110), "2400", font=f, fill="#000000")
d.text((330, 110), "\u00d8400", font=f, fill="#000000")
d.text((30, 210), "1200", font=f, fill="#000000")
d.text((330, 210), "GHS 225.00", font=f, fill="#000000")
img.save(OUT)
print(f"rendered {OUT} (920x340)")
