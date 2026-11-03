#!/usr/bin/env python3
"""Build docs/stickers.png — the contact sheet the README shows.

The pack list comes from `src/message/stickers.js` itself (through node), so the
sheet can never drift from what the plugin actually offers: a sticker added to
the catalog and drawn by `make-stickers.py` shows up here on the next run.

Needs Pillow, same as make-stickers.py.

Run: python3 scripts/make-sticker-sheet.py
"""

import json
import os
import subprocess
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ModuleNotFoundError:
    sys.stderr.write("needs Pillow: %s -m pip install Pillow\n(if this one lacks it: /usr/local/bin/python3.14 has Pillow here)\n" % sys.executable)
    raise SystemExit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'docs', 'stickers.png')
COLS = 6
THUMB = 150
PAD = 10
LABEL_H = 26
FONT_CANDIDATES = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
]
COLORS = {
    'base': (0x8A, 0x8A, 0x8A),
    'cute': (0xE0, 0x7A, 0xA0),
    'pack': (0x3D, 0x7A, 0xD8),
}


def catalog():
    """Ask node for the catalog so this script and the plugin share one source."""
    script = (
        "import('./src/message/stickers.js').then((m) => "
        "process.stdout.write(JSON.stringify(m.STICKERS.map((s) => "
        "{ return { id: s.id, caption: s.caption, mode: s.mode ?? '' } }))))"
    )
    raw = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(raw)


def font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def group_of(mode):
    return mode or 'base'


def main():
    items = catalog()
    rows = (len(items) + COLS - 1) // COLS
    width = COLS * (THUMB + PAD) + PAD
    height = rows * (THUMB + LABEL_H + PAD) + PAD
    sheet = Image.new('RGBA', (width, height), (0x14, 0x00, 0x00, 0x00))
    sheet = Image.new('RGBA', (width, height), (255, 255, 255, 0))
    draw = ImageDraw.Draw(sheet)
    label_font = font(15)
    caption_font = font(13)

    for index, item in enumerate(items):
        col, row = index % COLS, index // COLS
        x = PAD + col * (THUMB + PAD)
        y = PAD + row * (THUMB + LABEL_H + PAD)
        path = os.path.join(ROOT, 'assets', 'stickers', item['id'] + '.png')
        if not os.path.exists(path):
            draw.rectangle([x, y, x + THUMB, y + THUMB], outline=(0xFF, 0, 0), width=2)
            continue
        with Image.open(path) as image:
            thumb = image.convert('RGBA')
            thumb.thumbnail((THUMB, THUMB), Image.LANCZOS)
        # The art is transparent; a light card keeps pale stickers readable.
        draw.rounded_rectangle(
            [x, y, x + THUMB, y + THUMB], radius=8,
            fill=(0xF7, 0xF7, 0xF9, 255), outline=(0xDD, 0xDD, 0xE2, 255), width=1,
        )
        sheet.alpha_composite(thumb, (x + (THUMB - thumb.width) // 2, y + (THUMB - thumb.height) // 2))
        accent = COLORS['pack'] if item['mode'] else COLORS['base']
        draw.line([x, y + THUMB + 6, x + THUMB, y + THUMB + 6], fill=accent, width=2)
        draw.text((x + 2, y + THUMB + 8), item['id'], font=caption_font, fill=(0x33, 0x33, 0x3A, 255))
        if item['caption']:
            draw.text((x + THUMB - 2, y + THUMB + 8), item['caption'], font=label_font,
                      fill=accent, anchor='ra')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sheet.save(OUT)
    print('wrote %s (%d stickers, %dx%d)' % (OUT, len(items), width, height))


main()