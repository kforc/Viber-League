#!/usr/bin/env python3
"""Dev-only: tile a directory of screenshots into one labelled contact sheet.

    tools/cdp/contact-sheet.py <dir> <out.png> [--cols 2] [--scale 0.6]

Shots are ordered by their numeric filename prefix (01-, 02-, ...), which is the
order the harness walked the flow, so the sheet reads as a storyboard.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

def load_font(size: int):
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()

def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        return 2
    src, dst = Path(args[0]), Path(args[1])
    cols = int(sys.argv[sys.argv.index("--cols") + 1]) if "--cols" in sys.argv else 2
    scale = float(sys.argv[sys.argv.index("--scale") + 1]) if "--scale" in sys.argv else 0.6

    shots = sorted(src.glob("*.png"), key=lambda p: p.name)
    shots = [p for p in shots if p.name != dst.name]
    if not shots:
        print(f"no PNGs in {src}")
        return 1

    imgs = [Image.open(p).convert("RGB") for p in shots]
    w, h = imgs[0].size
    tw, th = int(w * scale), int(h * scale)
    pad, label_h = 12, 26
    rows = (len(imgs) + cols - 1) // cols

    sheet_w = cols * tw + (cols + 1) * pad
    sheet_h = rows * (th + label_h) + (rows + 1) * pad
    sheet = Image.new("RGB", (sheet_w, sheet_h), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)
    font = load_font(15)

    for i, (img, path) in enumerate(zip(imgs, shots)):
        r, c = divmod(i, cols)
        x = pad + c * (tw + pad)
        y = pad + r * (th + label_h + pad)
        sheet.paste(img.resize((tw, th), Image.LANCZOS), (x, y))
        draw.rectangle([x, y, x + tw - 1, y + th - 1], outline=(90, 90, 100), width=1)
        draw.text((x + 2, y + th + 5), path.stem, fill=(223, 249, 2), font=font)

    sheet.save(dst)
    print(f"wrote {dst}  {sheet_w}x{sheet_h}  ({len(imgs)} shots, {cols} cols)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
