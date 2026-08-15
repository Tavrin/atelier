#!/usr/bin/env python3
"""
Build `village-humanist.woff2` — the theme's vendored display/body face.

WHY A VENDORED FACE AT ALL. The stack was `Optima, Candara, "Gill Sans", …`:
three faces that ship with three different operating systems and with none of
them reliably. On this Linux box every one of them misses and the village fell
through to `sans-serif`, so the "humanist face with calligraphic stress" the
stylesheet describes was, in practice, whatever the machine felt like. A face
that is only present on the designer's machine is not a typographic choice.

WHAT THIS IS. Ubuntu Sans 1.006 — a humanist sans with the open apertures and
slightly calligraphic terminals the direction asks for — subset to the Latin
the theme actually renders and instanced to a single weight AXIS (wght
100-800), so one file covers every weight the CSS asks for.

LICENCE. Ubuntu Sans is under the Ubuntu Font Licence 1.0, which permits
bundling, embedding and redistribution, and permits subsetting provided the
result is renamed. UFL 1.0 clause 2(c) governs a Modified Version that is NOT
Substantially Changed: it "must be renamed to both (i) retain the name of the
Original Version and (ii) add additional naming elements", spelled
"<Original> derivative X". Hence the family name below. The licence travels
with the binary in `UBUNTU-FONT-LICENCE-1.0.txt` (clause 1).

Rebuild:  python3 themes/cozy-village/vendor/fonts/build-font.py
Requires: fonttools + brotli, and Ubuntu Sans installed (fonts-ubuntu).
"""

import pathlib
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

SOURCE = pathlib.Path("/usr/share/fonts/truetype/ubuntu/UbuntuSans[wdth,wght].ttf")
HERE = pathlib.Path(__file__).parent
OUT = HERE / "village-humanist.woff2"

# UFL 1.0 §2(c): retain the original name, add a distinguishing element.
FAMILY = "Ubuntu Sans derivative Cozy Village"

# What the village actually sets: ASCII, Latin-1 and Latin Extended-A (villager
# and ticket text is arbitrary contract data, so European names must render),
# plus the typographic punctuation the copy uses.
#
# Deliberately NOT included, having been checked rather than assumed:
#   · emoji — the tour's five pictographs fall through to the system emoji
#     face, which is the only place they exist anyway.
#   · U+2190/U+2192 arrows and U+2500 box rule — they appear in this bundle
#     only inside SOURCE COMMENTS, never in rendered copy, and Ubuntu Sans
#     does not carry them either. Listing them would have produced a subset
#     silently missing three of its own requests.
UNICODES = [
    # U+00AD (soft hyphen) is excluded: Ubuntu Sans maps it in `cmap` but
    # carries no `gvar` deltas for it, which trips fontTools' subsetter. The
    # village never emits one.
    "0020-007E", "00A0-00AC", "00AE-00FF", "0100-017F",
    "2013-2014", "2018-2019", "201C-201D", "2022", "2026", "2032-2033",
    "2039-203A", "2212", "20AC", "2122",
]


def main() -> int:
    if not SOURCE.exists():
        print(f"missing source face: {SOURCE}\ninstall it with: apt install fonts-ubuntu", file=sys.stderr)
        return 1

    font = TTFont(SOURCE)

    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]      # keep kerning and the default ligatures
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.drop_tables += ["DSIG"]
    options.desubroutinize = False
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=subset.parse_unicodes(",".join(UNICODES)))
    subsetter.subset(font)

    # Pin the width axis at its default and keep weight variable. Two axes cost
    # bytes the village has no use for; nothing in the CSS sets font-stretch.
    #
    # ORDER MATTERS, and the reverse order does not work: instancing drops the
    # `gvar` entry of every glyph whose only variation was on the pinned axis,
    # and the subsetter then looks those glyphs up unconditionally and dies on
    # a KeyError (seen here on U+2009). Subsetting a fully variable font and
    # instancing the result keeps both tables consistent at every step.
    font = instantiateVariableFont(font, {"wdth": 100}, updateFontNames=False)

    rename(font)
    font.flavor = "woff2"
    font.save(OUT)

    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.1f} KiB)")
    return 0


def rename(font: TTFont) -> None:
    """Apply the UFL 2(c) name, and keep the copyright/licence IDs intact (§1)."""
    name = font["name"]
    subfamily = "Regular"
    replacements = {
        1: FAMILY,
        2: subfamily,
        3: f"{FAMILY}; subset for themes/cozy-village",
        4: FAMILY,
        6: FAMILY.replace(" ", ""),
        16: FAMILY,
        17: subfamily,
    }
    for record in list(name.names):
        if record.nameID in replacements:
            name.setName(replacements[record.nameID], record.nameID,
                         record.platformID, record.platEncID, record.langID)
    # The variable-font axis/instance names live in their own records; point the
    # family-name half of every named instance at the renamed family.
    if "fvar" in font:
        for instance in font["fvar"].instances:
            instance.postscriptNameID = 0xFFFF


if __name__ == "__main__":
    raise SystemExit(main())
