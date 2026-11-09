#!/usr/bin/env python3
"""Render the churn wordmark to an SVG from the dashboard's real webfont.

The dashboard renders its name as text in Space Grotesk (see
`server/frontend/src/index.css`: `--font-heading`) at font-weight 600 with
`tracking-tight` and lowercase. An SVG in a README cannot load a webfont, so
this script instantiates the variable font at that weight and converts the
glyphs to paths.

Colours are the dashboard's own dark-theme tokens, converted from the OKLCH
values in `server/frontend/src/index.css`.

    pip install fonttools brotli
    python3 scripts/gen-logo.py                 # writes assets/churn-logo.svg
    python3 scripts/gen-logo.py --png preview.png   # also rasterise (needs rsvg-convert)
"""

from __future__ import annotations

import argparse
import math
import pathlib
import subprocess
import tempfile

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONT = (
    ROOT
    / "server/node_modules/@fontsource-variable/space-grotesk/files"
    / "space-grotesk-latin-wght-normal.woff2"
)

TEXT = "churn"
WEIGHT = 600
TRACKING_EM = -0.025  # Tailwind's `tracking-tight`

# Dark-theme tokens from server/frontend/src/index.css.
BACKGROUND = "#111111"  # --background  oklch(0.1776 0 0)
WORDMARK = "#ffe0c2"  # --primary     oklch(0.9247 0.0524 66.1732)
BORDER = "#201e18"  # --border      oklch(0.2351 0.0115 91.7467)

PADDING_X = 96  # font units (1000 per em)
PADDING_Y = 80
BORDER_WIDTH = 3


def oklch_to_hex(lightness: float, chroma: float, hue: float) -> str:
    """Convert OKLCH to an sRGB hex string, the way oklch.com does it."""
    h = math.radians(hue)
    a = chroma * math.cos(h)
    b = chroma * math.sin(h)

    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3

    linear = (
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )

    def encode(value: float) -> int:
        value = min(1.0, max(0.0, value))
        srgb = 12.92 * value if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055
        return round(srgb * 255)

    return "#%02x%02x%02x" % tuple(encode(value) for value in linear)


def build() -> str:
    font = TTFont(FONT)
    font.flavor = None  # drop the WOFF2 wrapper so fontTools can instantiate it
    with tempfile.NamedTemporaryFile(suffix=".ttf") as scratch:
        font.save(scratch.name)
        variable = TTFont(scratch.name)
        static = instantiateVariableFont(variable, {"wght": WEIGHT}, inplace=False)

    glyphs = static.getGlyphSet()
    cmap = static.getBestCmap()
    tracking = TRACKING_EM * static["head"].unitsPerEm

    placed = []
    pen_x = 0.0
    for char in TEXT:
        name = cmap[ord(char)]
        glyph = glyphs[name]

        outline = SVGPathPen(glyphs)
        glyph.draw(outline)

        bounds = BoundsPen(glyphs)
        glyph.draw(bounds)
        if bounds.bounds is None:
            raise SystemExit(f"{char!r} has no outline")

        placed.append((pen_x, outline.getCommands(), bounds.bounds))
        pen_x += glyph.width + tracking

    min_x = min(x + box[0] for x, _, box in placed)
    max_x = max(x + box[2] for x, _, box in placed)
    min_y = min(box[1] for _, _, box in placed)
    max_y = max(box[3] for _, _, box in placed)

    width = (max_x - min_x) + 2 * PADDING_X
    height = (max_y - min_y) + 2 * PADDING_Y
    # The font's Y axis points up; flip it and shift the baseline into place.
    offset_x = PADDING_X - min_x
    offset_y = PADDING_Y + max_y

    paths = "\n".join(
        f'    <path transform="translate({offset_x + x:.2f} {offset_y:.2f})'
        f' scale(1 -1)" d="{commands}"/>'
        for x, commands, _ in placed
    )

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {height:.0f}" \
width="{width:.0f}" height="{height:.0f}" role="img" aria-label="churn">
  <title>churn</title>
  <rect x="0" y="0" width="{width:.0f}" height="{height:.0f}" fill="{BACKGROUND}"/>
  <rect x="{BORDER_WIDTH / 2:g}" y="{BORDER_WIDTH / 2:g}" \
width="{width - BORDER_WIDTH:.0f}" height="{height - BORDER_WIDTH:.0f}" \
fill="none" stroke="{BORDER}" stroke-width="{BORDER_WIDTH}"/>
  <g fill="{WORDMARK}">
{paths}
  </g>
</svg>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=ROOT / "assets/churn-logo.svg", type=pathlib.Path)
    parser.add_argument("--png", type=pathlib.Path, help="also rasterise to this PNG")
    args = parser.parse_args()

    svg = build()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(svg, encoding="utf-8")
    print(f"wrote {args.out}")

    if args.png:
        subprocess.run(
            ["rsvg-convert", "--zoom", "1.5", "-o", str(args.png), str(args.out)],
            check=True,
        )
        print(f"wrote {args.png}")


if __name__ == "__main__":
    main()
