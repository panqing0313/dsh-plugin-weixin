#!/usr/bin/env python3
"""Draw the built-in sticker pack.

WeChat has no sticker message type on the iLink protocol (see
`vendor/openclaw-weixin/api/types.js` — TEXT/IMAGE/VOICE/FILE/VIDEO only), so a
sticker has to travel as an ordinary image. These are drawn here instead of
shipped as binary blobs so the pack can be regenerated, reviewed in a diff, and
recoloured without a design tool.

Run: python3 scripts/make-stickers.py
Output: assets/stickers/<id>.png (360x420, transparent)
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'stickers')
W, H = 360, 420
FACE_R = 128
FACE_Y = 178
FONT = '/System/Library/Fonts/Hiragino Sans GB.ttc'

INK = (48, 44, 42, 255)
BLUSH = (255, 150, 160, 130)

# id, caption, body colour, rim colour
FACES = [
    ('happy', '开心', (255, 224, 130, 255), (230, 186, 74, 255)),
    ('laugh', '哈哈', (255, 214, 120, 255), (228, 178, 60, 255)),
    ('cry', '呜呜', (186, 224, 255, 255), (128, 186, 232, 255)),
    ('sad', '委屈', (208, 226, 255, 255), (150, 180, 222, 255)),
    ('angry', '生气', (255, 172, 150, 255), (226, 128, 104, 255)),
    ('shy', '害羞', (255, 200, 214, 255), (228, 148, 172, 255)),
    ('speechless', '无语', (216, 214, 208, 255), (176, 172, 166, 255)),
    ('sleepy', '困了', (196, 202, 240, 255), (146, 152, 200, 255)),
    ('love', '喜欢你', (255, 190, 196, 255), (226, 134, 144, 255)),
    ('awesome', '厉害', (190, 236, 200, 255), (128, 190, 146, 255)),
    ('cheer', '加油', (255, 232, 168, 255), (226, 192, 96, 255)),
    ('goodnight', '晚安', (186, 198, 236, 255), (132, 146, 196, 255)),
]


def eyes(d, kind):
    """Two eyes centred on the face; kinds keep the moods legible at 200px."""
    lx, rx, ey = 128, 232, 150
    if kind == 'open':
        for x in (lx, rx):
            d.ellipse((x - 15, ey - 18, x + 15, ey + 18), fill=INK)
            d.ellipse((x - 3, ey - 12, x + 6, ey - 2), fill=(255, 255, 255, 230))
    elif kind == 'happy':          # ^ ^
        for x in (lx, rx):
            d.arc((x - 22, ey - 16, x + 22, ey + 18), 200, 340, fill=INK, width=9)
    elif kind == 'closed':
        for x in (lx, rx):
            d.arc((x - 20, ey - 8, x + 20, ey + 16), 200, 340, fill=INK, width=8)
    elif kind == 'wide':           # shocked / pleading
        for x in (lx, rx):
            d.ellipse((x - 20, ey - 24, x + 20, ey + 24), fill=(255, 255, 255, 255), outline=INK, width=5)
            d.ellipse((x - 8, ey - 6, x + 8, ey + 14), fill=INK)
    elif kind == 'angry':
        for x, sign in ((lx, 1), (rx, -1)):
            d.line((x - 24, ey - 22 * sign, x + 24, ey - 6 * sign), fill=INK, width=9)
            d.ellipse((x - 9, ey + 2, x + 9, ey + 18), fill=INK)
    elif kind == 'flat':           # — —
        for x in (lx, rx):
            d.line((x - 20, ey, x + 20, ey), fill=INK, width=8)
    elif kind == 'love':           # hearts
        for x in (lx, rx):
            d.polygon([(x, ey + 16), (x - 20, ey - 4), (x - 8, ey - 19), (x, ey - 9),
                       (x + 8, ey - 19), (x + 20, ey - 4)], fill=(232, 72, 96, 255))
    elif kind == 'star':
        import math
        for x in (lx, rx):
            pts = []
            for i in range(10):
                ang = -math.pi / 2 + i * math.pi / 5
                r = 22 if i % 2 == 0 else 9
                pts.append((x + r * math.cos(ang), ey + r * math.sin(ang)))
            d.polygon(pts, fill=(240, 176, 40, 255))


def mouth(d, kind):
    mx, my = 180, 210
    if kind == 'smile':
        d.arc((mx - 40, my - 26, mx + 40, my + 26), 20, 160, fill=INK, width=8)
    elif kind == 'grin':           # open laugh
        d.arc((mx - 46, my - 30, mx + 46, my + 34), 0, 180, fill=INK, width=8)
        d.arc((mx - 44, my - 24, mx + 44, my + 20), 0, 180, fill=(120, 60, 60, 255))
    elif kind == 'frown':
        d.arc((mx - 36, my + 6, mx + 36, my + 54), 200, 340, fill=INK, width=8)
    elif kind == 'wavy':
        d.line([(mx - 34, my + 14), (mx - 17, my + 2), (mx, my + 16), (mx + 17, my + 2), (mx + 34, my + 14)], fill=INK, width=7, joint='curve')
    elif kind == 'pout':
        d.ellipse((mx - 20, my, mx + 20, my + 26), outline=INK, width=7)
    elif kind == 'o':
        d.ellipse((mx - 13, my + 2, mx + 13, my + 30), outline=INK, width=7)
    elif kind == 'flat':
        d.line((mx - 26, my + 12, mx + 26, my + 12), fill=INK, width=7)


def draw_face(spec):
    sid, caption, body, rim = spec
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = W // 2
    # body + rim
    d.ellipse((cx - FACE_R, FACE_Y - FACE_R, cx + FACE_R, FACE_Y + FACE_R), fill=body, outline=rim, width=6)

    look = {
        'happy': ('open', 'smile', 'blush'),
        'laugh': ('happy', 'grin', 'blush'),
        'cry': ('closed', 'frown', 'tears'),
        'sad': ('wide', 'wavy', 'blush'),
        'angry': ('angry', 'pout', 'steam'),
        'shy': ('happy', 'o', 'blush'),
        'speechless': ('flat', 'flat', 'sweat'),
        'sleepy': ('closed', 'o', 'zzz'),
        'love': ('love', 'smile', 'blush'),
        'awesome': ('star', 'grin', 'blush'),
        'cheer': ('wide', 'grin', 'blush'),
        'goodnight': ('closed', 'smile', 'stars'),
    }[sid]
    eye_kind, mouth_kind, extra = look
    eyes(d, eye_kind)
    mouth(d, mouth_kind)

    if extra == 'blush' or extra == 'tears':
        for x in (96, 264):
            d.ellipse((x - 22, 196, x + 22, 218), fill=BLUSH)
    if extra == 'tears':
        for x in (128, 232):
            d.ellipse((x - 9, 178, x + 9, 214), fill=(120, 190, 245, 235))
            d.ellipse((x - 5, 214, x + 5, 232), fill=(150, 210, 250, 235))
    if extra == 'steam':
        # 怒 marks: two thick strokes over the brows, kept inside the face.
        for x, ty, by in ((96, 96, 116), (264, 96, 116)):
            d.line((x, ty, x + (18 if x < 180 else -18), by), fill=(206, 92, 74, 255), width=8)
    if extra == 'sweat':
        d.ellipse((272, 112, 298, 152), fill=(150, 205, 240, 240))
        d.ellipse((278, 120, 288, 134), fill=(255, 255, 255, 170))
    if extra == 'zzz':
        f = ImageFont.truetype(FONT, 44)
        d.text((248, 96), 'Z', font=f, fill=(120, 132, 190, 255))
        f2 = ImageFont.truetype(FONT, 28)
        d.text((282, 66), 'z', font=f2, fill=(120, 132, 190, 200))
    if extra == 'stars':
        import math
        for cx, cy, r in ((268, 96, 15), (296, 122, 10), (246, 116, 9)):
            pts = []
            for i in range(10):
                ang = -math.pi / 2 + i * math.pi / 5
                rr = r if i % 2 == 0 else r * 0.42
                pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
            d.polygon(pts, fill=(255, 246, 198, 255))

    # caption
    f = ImageFont.truetype(FONT, 40)
    box = d.textbbox((0, 0), caption, font=f)
    d.text(((W - (box[2] - box[0])) / 2 - box[0], 340), caption, font=f, fill=(70, 64, 60, 255))
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    for spec in FACES:
        img = draw_face(spec)
        path = os.path.join(OUT, f'{spec[0]}.png')
        img.save(path, optimize=True)
        print(f'{path} {os.path.getsize(path)} bytes')


if __name__ == '__main__':
    main()
