#!/usr/bin/env python3
"""Draw the built-in sticker packs.

WeChat has no sticker message type on the iLink protocol (see
`vendor/openclaw-weixin/api/types.js` — TEXT/IMAGE/VOICE/FILE/VIDEO only), so a
sticker has to travel as an ordinary image. These are drawn here instead of
shipped as binary blobs so the packs can be regenerated, reviewed in a diff, and
recoloured without a design tool.

Three packs live side by side:

* the base twelve, available in every companion mode;
* twelve "cute" additions, also available everywhere;
* three per-mode packs (neko / whale-girl / daughter) whose extra line art —
  cat ears, a spout, a hair bow — follows the character the conversation is in.

Run: python3 scripts/make-stickers.py
Output: assets/stickers/<id>.png (360x420, transparent)
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'stickers')
W, H = 360, 420
FACE_R = 128
FACE_Y = 178
FONT = '/System/Library/Fonts/Hiragino Sans GB.ttc'

INK = (58, 50, 46, 255)
WHITE = (255, 255, 255, 255)
BLUSH = (255, 148, 162, 130)
HEART_BLUSH = (255, 126, 148, 165)

# id, caption, body, rim, eyes, mouth, extras, deco
BASE = [
    ('happy', '开心', (255, 228, 140, 255), (232, 190, 82, 255), 'open', 'smile', ['blush'], None),
    ('laugh', '哈哈', (255, 216, 122, 255), (230, 180, 64, 255), 'happy', 'grin', ['blush'], None),
    ('cry', '呜呜', (190, 228, 255, 255), (132, 190, 236, 255), 'closed', 'frown', ['tears'], None),
    ('sad', '委屈', (212, 230, 255, 255), (154, 184, 226, 255), 'wide', 'wavy', ['blush'], None),
    ('angry', '生气', (255, 176, 152, 255), (230, 132, 108, 255), 'angry', 'pout', ['steam'], None),
    ('shy', '害羞', (255, 204, 218, 255), (232, 152, 176, 255), 'happy', 'o', ['heart_blush'], None),
    ('speechless', '无语', (220, 218, 212, 255), (180, 176, 170, 255), 'flat', 'flat', ['sweat'], None),
    ('sleepy', '困了', (200, 206, 244, 255), (150, 156, 204, 255), 'closed', 'o', ['zzz'], None),
    ('love', '喜欢你', (255, 194, 200, 255), (230, 138, 148, 255), 'love', 'smile', ['heart_blush', 'hearts'], None),
    ('awesome', '厉害', (194, 238, 204, 255), (132, 194, 150, 255), 'star', 'grin', ['blush', 'sparkle'], None),
    ('cheer', '加油', (255, 234, 172, 255), (230, 196, 100, 255), 'wide', 'grin', ['blush', 'sparkle'], None),
    ('goodnight', '晚安', (190, 202, 240, 255), (136, 150, 200, 255), 'closed', 'smile', ['stars'], None),
]

CUTE = [
    ('expect', '期待', (255, 232, 168, 255), (232, 196, 92, 255), 'sparkle_eyes', 'grin', ['blush', 'sparkle'], None),
    ('giggle', '偷笑', (255, 222, 150, 255), (234, 186, 76, 255), 'happy', 'grin_small', ['heart_blush'], None),
    ('cover', '捂脸', (255, 206, 196, 255), (232, 150, 138, 255), 'closed', 'none', ['hands_face'], None),
    ('hug', '抱抱', (255, 200, 214, 255), (230, 148, 172, 255), 'happy', 'smile', ['blush', 'hearts'], None),
    ('cheer_up', '打气', (186, 232, 250, 255), (120, 186, 220, 255), 'happy', 'grin', ['fists', 'sparkle'], None),
    ('confetti', '撒花', (200, 244, 210, 255), (134, 198, 154, 255), 'star', 'grin', ['confetti'], None),
    ('melon', '吃瓜', (206, 236, 176, 255), (140, 196, 118, 255), 'wide', 'grin_small', ['melon'], None),
    ('clap', '鼓掌', (255, 226, 176, 255), (230, 186, 96, 255), 'happy', 'smile', ['hands_side', 'blush'], None),
    ('nod', '点头', (196, 226, 255, 255), (136, 178, 226, 255), 'happy', 'smile', ['motion_dots'], None),
    ('shake', '摇头', (210, 214, 252, 255), (152, 158, 214, 255), 'happy', 'wavy', ['motion_side'], None),
    ('shock', '大惊', (255, 236, 204, 255), (232, 198, 128, 255), 'wide', 'o_big', ['shock_lines'], None),
    ('heart_hands', '比心', (255, 198, 208, 255), (230, 142, 156, 255), 'love', 'smile', ['hands_heart', 'hearts'], None),
]

CAT = [
    ('meow', '喵', (196, 202, 248, 255), (142, 148, 208, 255), 'open', 'wavy', ['whiskers'], 'cat'),
    ('paw', '舔爪', (206, 210, 252, 255), (152, 158, 216, 255), 'closed', 'o', ['whiskers', 'paw'], 'cat'),
    ('fluff', '炸毛', (240, 200, 220, 255), (210, 146, 176, 255), 'angry', 'pout', ['whiskers', 'steam'], 'cat'),
    ('nuzzle', '蹭蹭', (200, 220, 250, 255), (146, 176, 216, 255), 'happy', 'smile', ['whiskers', 'hearts'], 'cat'),
]

WHALE = [
    ('burble', '咕噜噜', (168, 226, 244, 255), (108, 178, 208, 255), 'open', 'o', ['bubbles'], 'whale'),
    ('spout', '喷水', (176, 232, 248, 255), (112, 184, 212, 255), 'happy', 'grin', ['spout', 'bubbles'], 'whale'),
    ('tail', '摆尾', (162, 220, 242, 255), (104, 172, 202, 255), 'happy', 'smile', ['tail', 'bubbles'], 'whale'),
    ('peek', '探头', (188, 236, 250, 255), (124, 190, 218, 255), 'wide', 'o', ['spout', 'blush'], 'whale'),
]

DAUGHTER = [
    ('actcute', '撒娇', (255, 214, 224, 255), (232, 158, 178, 255), 'wide', 'smile', ['blush', 'sparkle'], 'bow'),
    ('headpat', '摸摸头', (255, 226, 206, 255), (234, 176, 146, 255), 'closed', 'smile', ['pat'], 'bow'),
    ('proud', '得意', (255, 232, 196, 255), (234, 188, 118, 255), 'happy', 'grin', ['blush'], 'bow'),
    ('weepy', '委屈哭', (232, 224, 255, 255), (172, 162, 226, 255), 'closed', 'frown', ['tears', 'heart_blush'], 'bow'),
]

FACES = BASE + CUTE + CAT + WHALE + DAUGHTER


def eyes(d, kind):
    lx, rx, ey = 128, 232, 150
    if kind == 'open':
        for x in (lx, rx):
            d.ellipse((x - 19, ey - 23, x + 19, ey + 23), fill=INK)
            d.ellipse((x - 9, ey - 16, x + 1, ey - 6), fill=WHITE)
            d.ellipse((x + 4, ey + 4, x + 10, ey + 11), fill=(255, 255, 255, 200))
    elif kind == 'happy':          # ^ ^
        for x in (lx, rx):
            d.arc((x - 24, ey - 18, x + 24, ey + 20), 200, 340, fill=INK, width=10)
    elif kind == 'closed':
        for x in (lx, rx):
            d.arc((x - 22, ey - 10, x + 22, ey + 18), 200, 340, fill=INK, width=9)
    elif kind == 'wide':           # shocked / pleading
        for x in (lx, rx):
            d.ellipse((x - 23, ey - 27, x + 23, ey + 27), fill=WHITE, outline=INK, width=5)
            d.ellipse((x - 11, ey - 6, x + 11, ey + 19), fill=INK)
            d.ellipse((x - 6, ey - 1, x + 1, ey + 7), fill=WHITE)
    elif kind == 'angry':
        for x, sign in ((lx, 1), (rx, -1)):
            d.line((x - 26, ey - 24 * sign, x + 26, ey - 6 * sign), fill=INK, width=10)
            d.ellipse((x - 10, ey + 4, x + 10, ey + 21), fill=INK)
    elif kind == 'flat':           # — —
        for x in (lx, rx):
            d.line((x - 22, ey, x + 22, ey), fill=INK, width=9)
    elif kind == 'love':           # hearts
        for x in (lx, rx):
            heart(d, x, ey, 24, (232, 72, 96, 255))
    elif kind == 'star':
        for x in (lx, rx):
            star(d, x, ey, 24, (240, 176, 40, 255))
    elif kind == 'sparkle_eyes':   # big eyes with four-point sparks
        for x in (lx, rx):
            d.ellipse((x - 21, ey - 25, x + 21, ey + 25), fill=INK)
            d.ellipse((x - 13, ey - 19, x - 2, ey - 7), fill=WHITE)
            spark(d, x + 12, ey - 12, 7, WHITE)


def mouth(d, kind):
    mx, my = 180, 212
    if kind == 'none':
        return
    if kind == 'smile':
        d.arc((mx - 42, my - 28, mx + 42, my + 28), 20, 160, fill=INK, width=9)
    elif kind == 'grin':           # open laugh
        d.arc((mx - 48, my - 32, mx + 48, my + 36), 0, 180, fill=INK, width=9)
        d.arc((mx - 44, my - 24, mx + 44, my + 20), 0, 180, fill=(196, 96, 104, 255))
        d.arc((mx - 22, my + 4, mx + 22, my + 22), 0, 180, fill=(255, 150, 158, 255))
    elif kind == 'grin_small':
        d.arc((mx - 30, my - 20, mx + 30, my + 20), 10, 170, fill=INK, width=8)
    elif kind == 'frown':
        d.arc((mx - 38, my + 6, mx + 38, my + 56), 200, 340, fill=INK, width=9)
    elif kind == 'wavy':
        d.line([(mx - 36, my + 16), (mx - 18, my + 2), (mx, my + 18), (mx + 18, my + 2), (mx + 36, my + 16)],
               fill=INK, width=8, joint='curve')
    elif kind == 'pout':
        d.ellipse((mx - 22, my - 2, mx + 22, my + 26), outline=INK, width=8)
    elif kind == 'o':
        d.ellipse((mx - 14, my, mx + 14, my + 30), outline=INK, width=8)
    elif kind == 'o_big':
        d.ellipse((mx - 24, my - 10, mx + 24, my + 42), fill=(120, 70, 74, 255), outline=INK, width=7)
    elif kind == 'flat':
        d.line((mx - 28, my + 12, mx + 28, my + 12), fill=INK, width=8)


def heart(d, cx, cy, r, fill):
    d.polygon([(cx, cy + r * 0.62), (cx - r * 0.82, cy - r * 0.16), (cx - r * 0.34, cy - r * 0.78),
               (cx, cy - r * 0.36), (cx + r * 0.34, cy - r * 0.78), (cx + r * 0.82, cy - r * 0.16)], fill=fill)


def star(d, cx, cy, r, fill):
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        rr = r if i % 2 == 0 else r * 0.42
        pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
    d.polygon(pts, fill=fill)


def spark(d, cx, cy, r, fill):
    d.polygon([(cx, cy - r), (cx + r * 0.28, cy - r * 0.28), (cx + r, cy),
               (cx + r * 0.28, cy + r * 0.28), (cx, cy + r),
               (cx - r * 0.28, cy + r * 0.28), (cx - r, cy),
               (cx - r * 0.28, cy - r * 0.28)], fill=fill)


def blush(d, hearts=False):
    for x in (94, 266):
        if hearts:
            heart(d, x, 206, 15, HEART_BLUSH)
        else:
            d.ellipse((x - 24, 194, x + 24, 218), fill=BLUSH)


def decor(d, deco):
    if deco == 'cat':
        for side in (-1, 1):
            bx = 180 + side * 74
            d.polygon([(bx - 34, FACE_Y - 96), (bx + 34, FACE_Y - 96), (bx + side * 6, FACE_Y - 168)],
                      fill=(196, 202, 248, 255), outline=(142, 148, 208, 255))
            d.polygon([(bx - 17, FACE_Y - 104), (bx + 17, FACE_Y - 104), (bx + side * 3, FACE_Y - 150)],
                      fill=(255, 190, 205, 255))
    elif deco == 'whale':
        for dx, r in ((0, 9), (-16, 6), (16, 6)):
            d.ellipse((180 + dx - r, FACE_Y - FACE_R - 34 - r, 180 + dx + r, FACE_Y - FACE_R - 34 + r),
                      fill=(198, 240, 255, 230))
    elif deco == 'bow':
        # two loops and a knot: three circles read as a ribbon at this size
        bx, by = 246, FACE_Y - FACE_R + 96
        for side in (-1, 1):
            d.ellipse((bx + side * 22 - 26, by - 26, bx + side * 22 + 26, by + 26), fill=(255, 138, 158, 255))
            d.ellipse((bx + side * 22 - 13, by - 13, bx + side * 22 + 13, by + 13), fill=(255, 186, 200, 255))
        d.ellipse((bx - 12, by - 12, bx + 12, by + 12), fill=(255, 110, 136, 255))


def extras(d, names):
    for name in names:
        if name == 'blush':
            blush(d)
        elif name == 'heart_blush':
            blush(d, hearts=True)
        elif name == 'tears':
            blush(d, hearts=True)
            for x in (128, 232):
                d.ellipse((x - 9, 190, x + 9, 226), fill=(124, 194, 248, 235))
                d.ellipse((x - 6, 226, x + 6, 246), fill=(156, 214, 252, 235))
                d.ellipse((x - 4, 198, x + 1, 206), fill=(255, 255, 255, 190))
        elif name == 'steam':
            for x in (92, 268):
                d.line((x, 92, x + (20 if x < 180 else -20), 114), fill=(210, 96, 78, 255), width=9)
        elif name == 'sweat':
            d.ellipse((268, 108, 298, 152), fill=(152, 208, 242, 245))
            d.ellipse((275, 118, 286, 133), fill=(255, 255, 255, 180))
        elif name == 'zzz':
            f = ImageFont.truetype(FONT, 42)
            d.text((250, 84), 'Z', font=f, fill=(122, 134, 194, 255))
            d.text((290, 52), 'z', font=ImageFont.truetype(FONT, 28), fill=(122, 134, 194, 205))
        elif name == 'stars':
            for cx, cy, r in ((262, 100, 16), (292, 130, 11), (244, 116, 9)):
                star(d, cx, cy, r, (255, 246, 198, 255))
        elif name == 'sparkle':
            for cx, cy, r in ((96, 104, 15), (264, 100, 18), (292, 146, 10)):
                spark(d, cx, cy, r, (255, 240, 170, 235))
        elif name == 'hearts':
            for cx, cy, r in ((88, 132, 15), (284, 120, 17), (292, 172, 11)):
                heart(d, cx, cy, r, (255, 138, 158, 225))
        elif name == 'confetti':
            palette = [(255, 138, 158, 240), (255, 214, 120, 240), (150, 208, 246, 240),
                       (176, 226, 168, 240), (206, 168, 240, 240)]
            spots = ((84, 110), (112, 88), (272, 100), (290, 132), (268, 160), (96, 150))
            for i, (cx, cy) in enumerate(spots):
                d.ellipse((cx - 8, cy - 6, cx + 8, cy + 6), fill=palette[i % len(palette)])
        elif name == 'melon':
            d.pieslice((250, 240, 348, 338), 180, 360, fill=(140, 200, 120, 255))
            d.pieslice((262, 248, 336, 322), 180, 360, fill=(255, 140, 148, 255))
            for px, py in ((284, 276), (314, 276), (299, 300)):
                d.ellipse((px - 3, py - 5, px + 3, py + 5), fill=(70, 52, 48, 255))
        elif name == 'hands_face':
            for x in (112, 248):
                d.ellipse((x - 40, 190, x + 40, 270), fill=(255, 226, 214, 255), outline=(232, 170, 158, 255), width=4)
        elif name == 'arms':
            for box, start, end in (((66, 246, 150, 322), 300, 20), ((210, 246, 294, 322), 160, 240)):
                d.arc(box, start, end, fill=(240, 168, 176, 255), width=16)
        elif name == 'fists':
            for box in ((74, 256, 128, 310), (232, 256, 286, 310)):
                d.rounded_rectangle(box, radius=16, fill=(255, 226, 214, 255),
                                    outline=(232, 170, 158, 255), width=4)
                for k in range(1, 3):
                    d.line((box[0] + 14 + k * 13, box[1] + 6, box[0] + 14 + k * 13, box[1] + 22),
                           fill=(226, 168, 156, 255), width=3)
        elif name == 'hands_side':
            for box in ((70, 244, 118, 292), (242, 244, 290, 292)):
                d.ellipse(box, fill=(255, 226, 214, 255), outline=(232, 170, 158, 255), width=4)
            for x in (94, 266):
                d.arc((x - 34, 208, x + 34, 270), 210, 330, fill=(240, 190, 176, 235), width=6)
        elif name == 'hands_heart':
            heart(d, 180, 272, 30, (255, 130, 150, 255))
            for box in ((112, 238, 164, 298), (196, 238, 248, 298)):
                d.ellipse(box, fill=(255, 226, 214, 255), outline=(232, 170, 158, 255), width=4)
        elif name == 'motion_dots':
            for dy in (-16, 0, 16):
                d.ellipse((312, 158 + dy - 6, 328, 158 + dy + 6), fill=(150, 180, 220, 230))
        elif name == 'motion_side':
            for x in (44, 316):
                for dy in (-18, 0, 18):
                    d.line((x - 12, 150 + dy, x + 12, 150 + dy), fill=(160, 168, 214, 220), width=7)
        elif name == 'shock_lines':
            for ang in (-70, -20, 20, 70):
                rad = math.radians(ang)
                x0 = 180 + 150 * math.sin(rad)
                y0 = FACE_Y - 150 * math.cos(rad) * 0.72
                d.line((x0, y0, x0 + 26 * math.sin(rad), y0 - 26 * math.cos(rad) * 0.72),
                       fill=(240, 190, 120, 235), width=8)
        elif name == 'whiskers':
            for side in (-1, 1):
                for dy in (-14, 4, 22):
                    d.line((180 + side * 62, 206 + dy, 180 + side * 132, 196 + dy - side * 4),
                           fill=(150, 156, 200, 200), width=5)
        elif name == 'paw':
            x, y = 272, 286
            d.ellipse((x - 30, y - 26, x + 30, y + 26), fill=(255, 226, 214, 255),
                      outline=(232, 170, 158, 255), width=4)
            for dx in (-16, 0, 16):
                d.ellipse((x + dx - 5, y - 20, x + dx + 5, y - 8), fill=(255, 190, 200, 255))
        elif name == 'bubbles':
            for cx, cy, r in ((84, 108, 12), (108, 76, 8), (300, 96, 14), (276, 132, 7)):
                d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(140, 210, 240, 235), width=4)
        elif name == 'spout':
            top = FACE_Y - FACE_R - 26
            d.polygon([(180, top + 4), (166, top - 30), (194, top - 30)], fill=(206, 244, 255, 240))
            for dx, dy, r in ((0, -46, 7), (-22, -38, 6), (22, -38, 6), (-34, -18, 5), (34, -18, 5), (0, -62, 5)):
                d.ellipse((180 + dx - r, top + dy - r, 180 + dx + r, top + dy + r), fill=(206, 244, 255, 240))
        elif name == 'tail':
            d.arc((268, 250, 350, 340), 200, 20, fill=(128, 196, 226, 255), width=20)
        elif name == 'pat':
            d.rounded_rectangle((236, 22, 306, 58), radius=16, fill=(250, 214, 168, 255),
                                outline=(226, 178, 128, 255), width=4)
            for i in range(3):
                d.rounded_rectangle((240 + i * 22, 50, 258 + i * 22, 96 + (8 if i == 1 else 0)),
                                    radius=9, fill=(250, 214, 168, 255), outline=(226, 178, 128, 255), width=3)
            for i in range(2):
                d.arc((250 + i * 30, 0, 292 + i * 30, 26), 200, 340, fill=(236, 190, 146, 220), width=6)


def draw_face(spec):
    sid, caption, body, rim, eye_kind, mouth_kind, names, deco = spec
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = W // 2

    decor(d, deco)
    d.ellipse((cx - FACE_R, FACE_Y - FACE_R, cx + FACE_R, FACE_Y + FACE_R), fill=body, outline=rim, width=6)
    # a soft top-left highlight makes the flat body read as a round object
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((cx - 92, FACE_Y - 104, cx + 10, FACE_Y - 10), fill=(255, 255, 255, 42))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(12)))

    eyes(d, eye_kind)
    mouth(d, mouth_kind)
    extras(d, names)

    f = ImageFont.truetype(FONT, 40)
    box = d.textbbox((0, 0), caption, font=f)
    d.text(((W - (box[2] - box[0])) / 2 - box[0], 340), caption, font=f, fill=(72, 64, 60, 255))
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
