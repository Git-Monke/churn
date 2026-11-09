#!/usr/bin/env python3
"""Render the churn wordmark banner to SVG from the dashboard's real webfonts.

The dashboard renders its name as text in Space Grotesk (see
`server/frontend/src/index.css`: `--font-heading`) at font-weight 600 with
`tracking-tight`, lowercased in the header. An SVG in a README cannot load a
webfont, so this script instantiates the variable font at the weight it needs
and converts the glyphs to paths.

Colours are the dashboard's own dark-theme tokens, converted from the OKLCH
values in `server/frontend/src/index.css`.

    pip install fonttools brotli
    python3 scripts/gen-logo.py                          # assets/churn-logo.svg
    python3 scripts/gen-logo.py --png /tmp/preview.png   # also rasterise
"""

from __future__ import annotations

import argparse
import math
import pathlib
import subprocess
import tempfile
from dataclasses import dataclass

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "server/node_modules/@fontsource-variable"

TITLE = "Churn"
SUBTITLE = "For those who hate streaming apps, and love open source"

# Dark-theme tokens from server/frontend/src/index.css.
BACKGROUND = "#111111"  # --background   oklch(0.1776 0 0)
TITLE_COLOR = "#ffe0c2"  # --primary      oklch(0.9247 0.0524 66.1732)
SUBTITLE_COLOR = "#b4b4b4"  # --muted-foreground oklch(0.7699 0 0)
BORDER_COLOR = "#201e18"  # --border       oklch(0.2351 0.0115 91.7467)

# Canvas geometry, in the output's own units.
PADDING_X = 120
PADDING_TOP = 96
PADDING_BOTTOM = 96
GAP = 52  # between the wordmark and the subtitle
BORDER_WIDTH = 2


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


@dataclass
class Run:
    """A string of text converted to one or more SVG paths."""

    paths: list[str]  # `d` attributes, one per glyph
    offsets: list[float]  # x offset of each glyph, in font units
    bounds: tuple[float, float, float, float]  # minx, miny, maxx, maxy
    advance: float


def load_font(path: pathlib.Path, weight: int) -> TTFont:
    font = TTFont(path)
    font.flavor = None  # drop the WOFF2 wrapper so fontTools can instantiate it
    with tempfile.NamedTemporaryFile(suffix=".ttf") as scratch:
        font.save(scratch.name)
        return instantiateVariableFont(TTFont(scratch.name), {"wght": weight}, inplace=False)


def shape(font: TTFont, text: str, em: float, tracking_em: float) -> Run:
    """Convert `text` to glyph outlines scaled so one em is `em` units."""
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm
    scale = em / upm
    tracking = tracking_em * upm

    paths: list[str] = []
    offsets: list[float] = []
    xs: list[float] = []
    ys: list[float] = []

    pen_x = 0.0
    for char in text:
        glyph = glyphs[cmap[ord(char)]]

        outline = SVGPathPen(glyphs, ntos=lambda value: f"{value * scale:.2f}")
        glyph.draw(outline)

        bounds = BoundsPen(glyphs)
        glyph.draw(bounds)
        if bounds.bounds is None:  # a space
            pen_x += glyph.width + tracking
            continue

        paths.append(outline.getCommands())
        offsets.append(pen_x * scale)

        min_x, min_y, max_x, max_y = bounds.bounds
        xs += [pen_x * scale + min_x * scale, pen_x * scale + max_x * scale]
        ys += [min_y * scale, max_y * scale]
        pen_x += glyph.width + tracking

    return Run(
        paths=paths,
        offsets=offsets,
        bounds=(min(xs), min(ys), max(xs), max(ys)),
        advance=(pen_x - tracking) * scale,
    )


def build() -> str:
    title = shape(load_font(FONT_DIR / "space-grotesk/files/space-grotesk-latin-wght-normal.woff2", 600),
                  TITLE, em=300, tracking_em=-0.03)
    subtitle = shape(load_font(FONT_DIR / "space-grotesk/files/space-grotesk-latin-wght-normal.woff2", 300),
                     SUBTITLE, em=44, tracking_em=0.0)

    title_w = title.bounds[2] - title.bounds[0]
    subtitle_w = subtitle.bounds[2] - subtitle.bounds[0]
    title_h = title.bounds[3] - title.bounds[1]
    subtitle_h = subtitle.bounds[3] - subtitle.bounds[1]

    content_w = max(title_w, subtitle_w)
    width = round(content_w + 2 * PADDING_X)
    height = round(title_h + GAP + subtitle_h + PADDING_TOP + PADDING_BOTTOM)

    def render(run: Run, baseline_y: float) -> str:
        # Centre each run on the canvas, then flip the font's Y-up axis.
        left = (width - (run.bounds[2] - run.bounds[0])) / 2
        x0 = left - run.bounds[0]
        return "\n".join(
            f'    <path transform="translate({x0 + offset:.2f} {baseline_y:.2f}) scale(1 -1)" d="{d}"/>'
            for offset, d in zip(run.offsets, run.paths)
        )

    # The Y axis is flipped below, so the baseline sits at the run's top edge
    # plus its ascent: y_out = baseline - y_font.
    title_baseline = PADDING_TOP + title.bounds[3]
    subtitle_baseline = PADDING_TOP + title_h + GAP + subtitle.bounds[3]

    inset = BORDER_WIDTH / 2
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" \
width="{width}" height="{height}" role="img" aria-label="{TITLE}">
  <title>{TITLE}</title>
  <rect x="0" y="0" width="{width}" height="{height}" fill="{BACKGROUND}"/>
  <rect x="{inset:g}" y="{inset:g}" width="{width - BORDER_WIDTH}" \
height="{height - BORDER_WIDTH}" fill="none" stroke="{BORDER_COLOR}" \
stroke-width="{BORDER_WIDTH}"/>
  <g fill="{TITLE_COLOR}">
{render(title, title_baseline)}
  </g>
  <g fill="{SUBTITLE_COLOR}">
{render(subtitle, subtitle_baseline)}
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
            ["magick", "-background", "none", str(args.out), str(args.png)], check=True
        )
        print(f"wrote {args.png}")


if __name__ == "__main__":
    main()
