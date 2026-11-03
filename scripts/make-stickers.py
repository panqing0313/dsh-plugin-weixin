#!/usr/bin/env python3
"""Draw the built-in sticker packs.

WeChat has no sticker message type on the iLink protocol (see
`vendor/openclaw-weixin/api/types.js` — TEXT/IMAGE/VOICE/FILE/VIDEO only), so a
sticker has to travel as an ordinary image. These are drawn here instead of
shipped as binary blobs so the packs can be regenerated, reviewed in a diff, and
recoloured without a design tool.

Every sticker is a half/full body character — head, shoulders, chest, both arms
and hands are always in frame — because a bare floating face cannot show what a
person is *doing*. The action lives in the arm pose plus one prop (a cup, an
umbrella, a slice of melon, a clipboard, a hologram pane, a bubble tea, a gift
box), and the caption band repeats it in words.

Two tables drive everything:

* ``CHARACTERS`` — one entry per companion mode (skin, hair style and colour,
  outfit, accessories, figure height). The shared packs (base + cute) show up in
  every mode, so they are drawn as one neutral companion rather than borrowing a
  mode's look.
* ``POSES`` — one entry per sticker id: arm angles, hand target, prop, eyes,
  mouth, brows and background decorations.

Style: flat vector cartoon. Solid fills, two or three shading steps, a dark
3-4px outline, no gradients, transparent background. The art is drawn at 3x and
downsampled with LANCZOS, which is where the smooth line art comes from.

Run: python3 scripts/make-stickers.py            (all packs)
     python3 scripts/make-stickers.py --only hug (one sticker)
Output: assets/stickers/<id>.png (360x420, RGBA, transparent)

Needs Pillow. A `python3` without it fails at the import below with a hint; on
macOS `/usr/local/bin/python3.14` has it when the Homebrew one does not.
"""
import sys

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageFilter
except ModuleNotFoundError:  # the one thing that stops this script cold
    sys.stderr.write(
        "make-stickers needs Pillow: %s -m pip install Pillow\n"
        "(if this python3 lacks it: /usr/local/bin/python3.14 has Pillow here)\n" % sys.executable
    )
    raise SystemExit(1)
import glob as _glob
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'stickers')

W, H = 360, 420
SS = 3                      # supersampling factor: draw big, shrink once
CW, CH = W * SS, H * SS

# --- figure skeleton, in final-image pixels (y grows downwards) -------------
CX = 180.0                  # centre line
FOOT_Y = 336.0              # baseline: feet, and the anchor every figure scales from
HEAD_CY = 96.0              # mascot head: bigger and rounder than a human one
HEAD_RX = 52.0
HEAD_RY = 47.0              # head is 94 tall; body is ~206 -> ratio 1:2.19
NECK_Y = 133.0
SHOULDER_Y = 144.0
SHOULDER_X = 50.0           # half distance between shoulder joints
WAIST_Y = 234.0
WAIST_X = 33.0
HIP_Y = 262.0
HIP_X = 44.0
FOOT_X = 17.0

# --- palette -----------------------------------------------------------------
INK = (34, 48, 107, 255)       # deep navy lineart everywhere, never pure black
HAIR_INK = (34, 48, 107, 255)
SHADE_A = (34, 48, 107, 40)      # right-side shading, translucent
LIGHT_A = (255, 255, 255, 56)   # top-left highlight, translucent
BLUSH = (255, 148, 162, 120)


def mix(c1, c2, k):
    """Blend two colours; k=0 gives c1."""
    return tuple(int(round(a + (b - a) * k)) for a, b in zip(c1[:3], c2[:3])) + (255,)


def dark(c, k=0.18):
    return mix(c, (32, 24, 28), k)


def lighten(c, k=0.30):
    return tuple(int(round(a + (255 - a) * k)) for a in c[:3]) + (255,)


# ============================================================================
# CHARACTERS — one look per companion mode
# ============================================================================
# Every mode is the SAME whale. Body, belly and outline colours are fixed so all
# 68 stickers read as one mascot; only the outfit tags and the accent colours
# change. Daughter is the small one, boyfriend / jarvis / oneesan the tall ones —
# the proportions never change, only the scale.
#   skin  = belly / light colour      hair  = headwear + accent colour
#   hair2 = second accent             top   = garment (cap / scarf / jacket)
#   top2  = garment trim              bottom / shoe = fin + flipper tip tint
#   acc   = accessory tags            scale = overall size
#   lip   = blush colour (None = the default pink)
BODY_BLUE = (77, 107, 254, 255)
BODY_DEEP = (40, 62, 178, 255)
BELLY_WHITE = (234, 241, 255, 255)
OUTLINE_BLUE = (34, 48, 107, 255)
GLOW_BLUE = (150, 205, 255, 255)
WHALE_PINK = (255, 150, 178, 255)
WHALE_MINT = (86, 178, 150, 255)
WHALE_WARM = (244, 196, 140, 255)
WHALE_SKY = (96, 196, 255, 255)


def _whale(label, acc, hair=None, hair2=None, top=None, top2=None, shoe=None,
           scale=1.0, lip=None):
    """One row of CHARACTERS: the fixed whale wearing one outfit."""
    hair = hair or BODY_BLUE
    return dict(label=label, skin=BELLY_WHITE, hair=hair, hair2=hair2 or hair,
                style='whale', top=top or BODY_BLUE, top2=top2 or BELLY_WHITE,
                bottom=BODY_DEEP, shoe=shoe or BELLY_WHITE, sleeve=hair,
                acc=list(acc), scale=scale, bottom_kind='tail', lip=lip)


CHARACTERS = {
    # The shared packs show in every mode, so they belong to no mode: the plain
    # whale, wearing nothing at all.
    'default': _whale('大肥鱼', []),
    # girl / boy / friend / assistant / the big sisters and brothers
    'girlfriend': _whale('女友鱼', ['bow', 'knit', 'lashes'], hair=WHALE_PINK,
                         top=(255, 196, 214, 255), top2=WHALE_PINK, scale=0.99,
                         lip=(255, 150, 178, 165)),
    'boyfriend': _whale('男友鱼', ['collar', 'tie'], hair=(70, 96, 230, 255),
                        top=(226, 234, 255, 255), top2=(70, 96, 230, 255),
                        scale=1.04),
    'friend': _whale('朋友鱼', ['cap'], hair=WHALE_MINT, top=WHALE_MINT,
                     top2=(58, 140, 118, 255), scale=1.0),
    'jarvis': _whale('贾维斯鱼', ['headset', 'visor', 'glow', 'bowtie'],
                     hair=(52, 66, 128, 255), top=(52, 66, 128, 255),
                     top2=GLOW_BLUE, scale=1.03),
    'oneesan': _whale('御姐鱼', ['pearls', 'lashes', 'lapel'],
                      hair=(206, 52, 84, 255), top=(206, 52, 84, 255),
                      top2=BELLY_WHITE, scale=1.04, lip=(226, 74, 108, 175)),
    'big-sister': _whale('大姐姐鱼', ['scarf'], hair=WHALE_WARM, top=WHALE_WARM,
                         top2=(216, 160, 108, 255), scale=1.0),
    'warm-guy': _whale('暖男鱼', ['glasses', 'scarf'], hair=(126, 156, 238, 255),
                       top=(255, 209, 178, 255), top2=(228, 174, 140, 255),
                       scale=1.03),
    'daughter': _whale('闺女鱼', ['bow', 'tuft'], hair=WHALE_PINK,
                       top=(255, 196, 214, 255), top2=WHALE_PINK, scale=0.88,
                       lip=(255, 150, 178, 150)),
    'neko': _whale('猫娘鱼', ['cat_ears', 'cat_tail', 'whiskers'],
                   hair=(124, 112, 236, 255), top=(150, 140, 250, 255),
                   top2=WHALE_PINK, scale=0.98),
    'whale-girl': _whale('鲸鱼娘鱼', ['bib', 'drop', 'blowhole'], hair=WHALE_SKY,
                         top=WHALE_SKY, top2=BELLY_WHITE, scale=0.99),
    'tsundere': _whale('傲娇鱼', ['tie', 'band'], hair=(255, 214, 130, 255),
                       top=(246, 248, 255, 255), top2=(90, 110, 220, 255),
                       scale=0.97),
}


# ============================================================================
# ARM POSES — (upper arm angle, forearm angle), degrees, 0 = straight down,
# 90 = straight out to the side, 180 = straight up. The left arm is mirrored.
# ============================================================================
A = {
    'down': (14, 8),
    'out': (60, 38),
    'open': (76, 82),
    'up': (140, 174),
    'wave': (158, 176),
    'reach': (96, 120),
    'chest': (26, -66),
    'hug': dict(t1=34, t2=-30, l1=42, l2=44),
    'clap': dict(t1=-6, t2=-118, l1=44, l2=40),
    'support': dict(t1=24, t2=24, l1=46, l2=48),
    'ledge': dict(t1=22, t2=6, l1=44, l2=46),
    'heart': (32, -72),
    'hold_low': dict(t1=30, t2=-40, l1=40, l2=40),
    'cross': dict(t1=30, t2=-96, l2=62),
    'hip': dict(t1=55, t2=-51, l2=60),
    'pat_self': dict(t1=118, t2=-115, l2=60),
    'pat_low': dict(t1=24, t2=34, l1=48, l2=56),
    'cheek': dict(t1=-138, single=True, l1=46),
    'mouth': dict(t1=-127, single=True, l1=36),
    'ear': dict(t1=-169, single=True, l1=46),
    'toast': dict(t1=105, t2=-160, l1=42, l2=44),
    'present': dict(t1=40, t2=78, l1=42, l2=42),
    'present_hi': dict(t1=60, t2=100, l1=42, l2=44),
    'highfive': dict(t1=118, t2=88, l1=46, l2=44),
    'protect': dict(t1=88, t2=96, l1=44, l2=46),
    'throw': dict(t1=78, t2=110, l1=44, l2=46),
    'carry': dict(t1=52, t2=-70, l2=56),
    'shrug': dict(t1=70, t2=30),
}


def POSE(pid, mode, caption, eyes, mouth, arms, prop=None, hand='R', deco=(),
         brows=None, hdx=0.0, hdy=0.0, lean=0.0, dx=0.0, dy=0.0, chibi=None,
         chibi_rot=0.0, ledge=None, wall=None, hand_style='open', look=0.0,
         mouth_kind=None, extra=None):
    """One row of the POSES table."""
    return dict(id=pid, mode=mode, caption=caption, eyes=eyes, mouth=mouth,
                arms=arms, prop=prop, hand=hand, deco=list(deco), brows=brows,
                hdx=hdx, hdy=hdy, lean=lean, dx=dx, dy=dy, chibi=chibi,
                chibi_rot=chibi_rot, ledge=ledge, wall=wall,
                hand_style=hand_style, look=look, extra=extra or {})


# ============================================================================
# POSES — one row per sticker id, in the order the catalog lists them
# ============================================================================
POSES = [
    # ---- shared: base twelve ------------------------------------------------
    POSE('happy', 'default', '开心', 'happy', 'smile', (A['out'], A['out']),
         deco=['sparkle']),
    POSE('laugh', 'default', '哈哈', 'happy', 'grin', (A['up'], A['up']),
         deco=['sparkle', 'motion_dots'], hdy=-3),
    POSE('cry', 'default', '呜呜', 'closed', 'frown', (A['cheek'], A['cheek']),
         deco=['tears', 'drops'], brows='sad'),
    POSE('sad', 'default', '委屈', 'plead', 'wavy', (A['chest'], A['chest']),
         deco=['drops', 'ellipsis'], brows='sad', hdy=2),
    POSE('angry', 'default', '生气', 'angry', 'pout', (A['cross'], A['cross']),
         deco=['steam', 'huff'], brows='angry'),
    POSE('shy', 'default', '害羞', 'closed', 'o', (A['cheek'], A['cheek']),
         deco=['heart_blush', 'hearts'], brows='up', hdy=2),
    POSE('speechless', 'default', '无语', 'flat', 'flat', (A['down'], A['down']),
         deco=['sweat', 'ellipsis'], hdx=5, look=3),
    POSE('sleepy', 'default', '困了', 'closed', 'o', (A['mouth'], A['down']),
         deco=['zzz', 'moon'], hdy=3, hdx=3),
    POSE('love', 'default', '喜欢你', 'love', 'smile', (A['heart'], A['heart']),
         prop='heart', deco=['hearts', 'sparkle']),
    POSE('awesome', 'default', '厉害', 'star', 'grin', (A['toast'], A['hip']),
         prop='thumb', deco=['sparkle', 'stars']),
    POSE('cheer', 'default', '加油', 'happy', 'grin', (A['up'], A['up']),
         prop='fist', hand='both', deco=['sparkle', 'speed_lines'], lean=-2),
    POSE('goodnight', 'default', '晚安', 'closed', 'smile', (A['mouth'], A['down']),
         deco=['stars', 'moon', 'zzz']),

    # ---- shared: cute twelve ------------------------------------------------
    POSE('expect', 'default', '期待', 'sparkle_eyes', 'grin', (A['chest'], A['chest']),
         deco=['sparkle', 'stars'], hdy=-2),
    POSE('giggle', 'default', '偷笑', 'closed', 'grin_small', (A['mouth'], A['down']),
         deco=['hearts', 'sparkle'], hdx=4, look=3, hdy=-2),
    POSE('cover', 'default', '捂脸', 'closed', 'none', (A['cheek'], A['cheek']),
         deco=['sweat'], brows='up'),
    POSE('hug', 'default', '抱抱', 'happy', 'smile', (A['hug'], A['hug']),
         prop='chibi', chibi=(180, 196), deco=['hearts', 'sparkle']),
    POSE('cheer_up', 'default', '打气', 'happy', 'grin', (A['up'], A['up']),
         prop='fist', hand='both', deco=['sparkle', 'speed_lines'], lean=2),
    POSE('confetti', 'default', '撒花', 'star', 'grin', (A['open'], A['open']),
         deco=['confetti', 'petals', 'sparkle'], lean=-2),
    POSE('melon', 'default', '吃瓜', 'wide', 'grin_small', (A['chest'], A['chest']),
         prop='melon', deco=['seeds'], look=3, hdx=3),
    POSE('clap', 'default', '鼓掌', 'happy', 'smile', (A['clap'], A['clap']),
         prop='clapline', hand='both', deco=['sparkle'], hand_style='flat'),
    POSE('nod', 'default', '点头', 'happy', 'smile', (A['down'], A['down']),
         deco=['motion_dots', 'nod_arc'], hdy=4),
    POSE('shake', 'default', '摇头', 'closed', 'wavy', (A['down'], A['down']),
         deco=['motion_side', 'sweat'], hdx=-4),
    POSE('shock', 'default', '大惊', 'wide', 'o_big', (A['cheek'], A['cheek']),
         deco=['shock_lines', 'exclaim'], brows='up', lean=-3),
    POSE('heart_hands', 'default', '比心', 'love', 'smile', (A['heart'], A['heart']),
         prop='heart', deco=['hearts', 'sparkle']),

    # ---- neko ---------------------------------------------------------------
    POSE('meow', 'neko', '喵', 'open', 'wavy', (A['mouth'], A['down']),
         deco=['whiskers', 'music_notes', 'sparkle'], hdy=-2, hand_style='paw'),
    POSE('paw', 'neko', '舔爪', 'closed', 'tongue', (A['mouth'], A['down']),
         prop='paw', deco=['whiskers', 'sparkle'], hdx=4, look=3),
    POSE('fluff', 'neko', '炸毛', 'angry', 'pout', (A['up'], A['up']),
         deco=['spikes', 'steam', 'speed_lines'], brows='angry', lean=-2),
    POSE('nuzzle', 'neko', '蹭蹭', 'happy', 'smile', (A['cheek'], A['down']),
         deco=['hearts', 'whiskers', 'sparkle'], hdx=6, hdy=3, lean=6),

    # ---- whale-girl ---------------------------------------------------------
    POSE('burble', 'whale-girl', '咕噜噜', 'happy', 'o', (A['out'], A['out']),
         deco=['bubbles', 'bubbles_big', 'sparkle'], hdy=-2),
    POSE('spout', 'whale-girl', '喷水', 'happy', 'grin', (A['open'], A['open']),
         deco=['spout', 'bubbles', 'drops'], hdy=-4),
    POSE('tail', 'whale-girl', '摆尾', 'happy', 'smile', (A['out'], A['open']),
         deco=['tail_arc', 'motion_side', 'bubbles'], lean=5),
    POSE('peek', 'whale-girl', '探头', 'wide', 'o', (A['ledge'], A['ledge']),
         deco=['bubbles', 'sparkle'], ledge=(6, 236, 354, 344), hand_style='grip'),

    # ---- daughter -----------------------------------------------------------
    POSE('actcute', 'daughter', '撒娇', 'plead', 'smile', (A['chest'], A['chest']),
         deco=['sparkle', 'hearts', 'sway'], hdx=5, hdy=3, lean=7),
    POSE('headpat', 'daughter', '摸摸头', 'closed', 'smile', (A['up'], A['up']),
         prop='pat_hand', deco=['pat_arc', 'sparkle', 'hearts'], hdy=2),
    POSE('proud', 'daughter', '得意', 'happy', 'grin', (A['hip'], A['hip']),
         deco=['sparkle', 'stars', 'shine'], hdy=-4),
    POSE('weepy', 'daughter', '委屈哭', 'closed', 'frown', (A['cheek'], A['cheek']),
         deco=['tears', 'drops', 'ellipsis'], brows='sad', hdy=3),

    # ---- girlfriend ---------------------------------------------------------
    POSE('gf_embrace', 'girlfriend', '抱紧你', 'closed', 'smile', (A['hug'], A['hug']),
         prop='chibi', chibi=(180, 196), deco=['hearts', 'sparkle'], hdx=-4, hdy=3),
    POSE('gf_kiss', 'girlfriend', '亲一下', 'closed', 'kiss', (A['chest'], A['down']),
         deco=['hearts', 'kiss_mark', 'sparkle'], hdy=-2),
    POSE('gf_pout', 'girlfriend', '撅嘴', 'closed', 'pout', (A['cross'], A['cross']),
         deco=['huff', 'sweat'], brows='angry', hdx=-4, look=-3),
    POSE('gf_wait', 'girlfriend', '等你', 'happy', 'smile', (A['hold_low'], A['down']),
         prop='phone', deco=['clock', 'sparkle'], hdx=4, look=3),

    # ---- boyfriend ----------------------------------------------------------
    POSE('bf_headpat', 'boyfriend', '摸你头', 'closed', 'smile', (A['pat_low'], A['down']),
         prop='chibi', chibi=(283, 268), deco=['pat_arc', 'sparkle'], lean=4),
    POSE('bf_carry', 'boyfriend', '抱起你', 'closed', 'smile', (A['carry'], A['hug']),
         prop='chibi', chibi=(180, 206), chibi_rot=-12, deco=['hearts', 'sparkle']),
    POSE('bf_protect', 'boyfriend', '护着你', 'wide', 'flat', (A['protect'], A['chest']),
         prop='shield', deco=['protect_lines', 'sparkle'], lean=-4,
         brows='angry', hand_style='flat'),
    POSE('bf_coffee', 'boyfriend', '递咖啡', 'happy', 'smile', (A['present'], A['down']),
         prop='coffee', deco=['steam', 'sparkle'], hdx=4),

    # ---- friend -------------------------------------------------------------
    POSE('fr_wave', 'friend', '挥手', 'happy', 'grin', (A['wave'], A['hip']),
         deco=['wave_arc', 'sparkle'], lean=3, hdx=3),
    POSE('fr_tea', 'friend', '递奶茶', 'happy', 'smile', (A['present'], A['down']),
         prop='milktea', deco=['sparkle', 'shine'], hdx=3),
    POSE('fr_highfive', 'friend', '击掌', 'star', 'grin', (A['highfive'], A['highfive']),
         deco=['impact', 'speed_lines', 'sparkle'], hand_style='flat', lean=-3),
    POSE('fr_listen', 'friend', '听你说', 'closed', 'smile', (A['ear'], A['hip']),
         deco=['sound_waves', 'sparkle'], hdx=5, look=3, lean=4),

    # ---- jarvis -------------------------------------------------------------
    POSE('jv_scan', 'jarvis', '扫描', 'scan', 'flat', (A['present_hi'], A['hip']),
         prop='scanner', deco=['scan_grid', 'holo_rings', 'sparkle'], hdy=-2),
    POSE('jv_report', 'jarvis', '递报告', 'open', 'flat', (A['present'], A['down']),
         prop='board', deco=['sparkle', 'holo_rings'], hdx=4),
    POSE('jv_hologram', 'jarvis', '投影', 'scan', 'smile', (A['toast'], A['hip']),
         prop='hologram', deco=['holo_rings', 'scan_grid', 'sparkle']),
    POSE('jv_alert', 'jarvis', '警报', 'wide', 'flat', (A['reach'], A['reach']),
         prop='alert', hand='L', deco=['alert_lines', 'exclaim', 'sparkle'],
         brows='angry', lean=-2),

    # ---- oneesan ------------------------------------------------------------
    POSE('os_headpat', 'oneesan', '摸头杀', 'happy', 'smirk', (A['pat_low'], A['hip']),
         prop='chibi', chibi=(283, 268), deco=['pat_arc', 'sparkle', 'hearts'], lean=4),
    POSE('os_smile', 'oneesan', '微笑', 'closed', 'smile', (A['chest'], A['hip']),
         deco=['sparkle', 'shine'], hdy=-2),
    POSE('os_toast', 'oneesan', '举杯', 'happy', 'smile', (A['toast'], A['hip']),
         prop='wine', deco=['sparkle', 'shine', 'stars']),
    POSE('os_scold', 'oneesan', '轻拍', 'smirk', 'smirk', (A['present_hi'], A['hip']),
         prop='tap_hand', deco=['tap_lines', 'sparkle'], lean=-3, hdx=4, hand_style='point'),

    # ---- big-sister ---------------------------------------------------------
    POSE('bs_hug', 'big-sister', '抱抱你', 'closed', 'smile', (A['hug'], A['hug']),
         prop='chibi', chibi=(180, 196), deco=['hearts', 'sparkle'], hdy=2),
    POSE('bs_hair', 'big-sister', '理头发', 'closed', 'smile', (A['pat_self'], A['hold_low']),
         deco=['stroke_arc', 'sparkle', 'hearts'], hdx=4, hdy=2),
    POSE('bs_advice', 'big-sister', '讲道理', 'open', 'talk', (A['shrug'], A['hip']),
         deco=['talk_lines', 'sparkle', 'ellipsis'], hdy=-2, hand_style='flat'),
    POSE('bs_lead', 'big-sister', '牵着走', 'happy', 'smile', (A['present'], A['down']),
         prop='handhold', deco=['motion_arcs', 'hearts', 'sparkle'], lean=6),

    # ---- warm-guy -----------------------------------------------------------
    POSE('wg_coat', 'warm-guy', '披外套', 'closed', 'smile', (A['chest'], A['chest']),
         prop='coat', deco=['warm', 'sparkle', 'hearts'], hdy=2),
    POSE('wg_umbrella', 'warm-guy', '撑伞', 'happy', 'smile', (A['toast'], A['down']),
         prop='umbrella', deco=['rain', 'sparkle'], hdx=4),
    POSE('wg_steady', 'warm-guy', '扶住你', 'happy', 'smile', (A['pat_low'], A['down']),
         prop='chibi', chibi=(283, 268), deco=['support_lines', 'protect_lines', 'sparkle', 'hearts'],
         lean=5, hdx=3, hand_style='flat'),
    POSE('wg_lunch', 'warm-guy', '带饭', 'happy', 'smile', (A['present'], A['down']),
         prop='lunch', deco=['steam', 'sparkle', 'shine'], hdx=4),

    # ---- tsundere -----------------------------------------------------------
    POSE('ts_hmph', 'tsundere', '哼', 'closed', 'pout', (A['cross'], A['cross']),
         deco=['huff', 'motion_side'], brows='angry', hdx=-6, look=-4, hdy=-2),
    POSE('ts_blush', 'tsundere', '嘴硬脸红', 'side', 'wavy', (A['cross'], A['cross']),
         deco=['heart_blush', 'hearts', 'sweat'], brows='angry', hdx=-6, look=-4),
    POSE('ts_gift', 'tsundere', '扔给你', 'closed', 'pout', (A['throw'], A['hip']),
         prop='gift', deco=['throw_lines', 'speed_lines'], brows='angry',
         lean=-4, hdx=-3),
    POSE('ts_wait', 'tsundere', '偷偷等', 'side', 'flat', (A['chest'], A['chest']),
         deco=['ellipsis', 'sweat', 'sparkle'], wall=(0, 44, 104, 340),
         dx=34, look=4),
]

# ============================================================================
# fonts
# ============================================================================
FONT_CANDIDATES = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/Supplemental/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
]
FONT_GLOBS = [
    '/usr/share/fonts/**/NotoSansCJK*',
    '/usr/share/fonts/**/Noto*CJK*',
    '/usr/local/share/fonts/**/Noto*CJK*',
    os.path.join(ROOT, '**', 'NotoSansCJK*'),
]

FONT_PATH = None
WARNED = []


def find_font():
    for path in FONT_CANDIDATES:
        if os.path.isfile(path):
            return path
    for pattern in FONT_GLOBS:
        for hit in sorted(_glob.glob(pattern, recursive=True)):
            if hit.lower().endswith(('.ttc', '.ttf', '.otf')):
                return hit
    return None


def warn_once(msg):
    if msg not in WARNED:
        WARNED.append(msg)
        print('warning: ' + msg, file=sys.stderr)


def caption_font(size):
    if FONT_PATH:
        try:
            return ImageFont.truetype(FONT_PATH, size)
        except Exception as exc:                       # pragma: no cover
            warn_once(f'could not load {FONT_PATH}: {exc}')
    return ImageFont.load_default()


# ============================================================================
# tiny geometry helpers
# ============================================================================
class T:
    """Canonical figure coordinates -> supersampled canvas pixels."""

    def __init__(self, s=1.0, rot=0.0, dx=0.0, dy=0.0):
        self.s = s
        self.rot = rot
        self.dx = dx
        self.dy = dy

    def pt(self, x, y):
        x = CX + (x - CX) * self.s
        y = FOOT_Y + (y - FOOT_Y) * self.s
        if self.rot:
            a = math.radians(self.rot)
            ux, uy = x - CX, y - FOOT_Y
            x = CX + ux * math.cos(a) - uy * math.sin(a)
            y = FOOT_Y + ux * math.sin(a) + uy * math.cos(a)
        return ((x + self.dx) * SS, (y + self.dy) * SS)

    def w(self, v):
        return max(1, int(round(v * self.s * SS)))


def poly(d, t, pts, fill=None, outline=INK, ow=3.2):
    p = [t.pt(x, y) for x, y in pts]
    if fill:
        d.polygon(p, fill=fill)
    if outline:
        d.line(p + [p[0]], fill=outline, width=t.w(ow), joint='curve')


def ell(d, t, box, fill=None, outline=None, ow=3.2):
    x0, y0, x1, y1 = box
    a = t.pt(x0, y0)
    b = t.pt(x1, y1)
    bb = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
    d.ellipse(bb, fill=fill, outline=outline, width=t.w(ow) if outline else 0)


def arc(d, t, box, start, end, fill=INK, width=4.0):
    x0, y0, x1, y1 = box
    a = t.pt(x0, y0)
    b = t.pt(x1, y1)
    bb = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
    d.arc(bb, start, end, fill=fill, width=t.w(width))


def line(d, t, pts, fill=INK, width=3.0, joint='curve'):
    d.line([t.pt(x, y) for x, y in pts], fill=fill, width=t.w(width), joint=joint)


class Canvas:
    """ImageDraw wrapper that composites translucent shapes instead of replacing.

    PIL's ImageDraw *replaces* pixels for polygon / ellipse / line fills even on an
    'RGBA' draw context, so a translucent shade drawn straight onto the canvas would
    punch a hole through the artwork underneath it. Every translucent operation is
    therefore rendered onto a scratch layer and alpha-composited, and opaque ones go
    straight to ImageDraw so the common path stays fast.
    """

    def __init__(self, im):
        self.im = im
        self.d = ImageDraw.Draw(im, 'RGBA')
        self._sc = None

    @staticmethod
    def _alpha(c):
        return isinstance(c, (tuple, list)) and len(c) == 4 and c[3] < 255

    def _blend(self, bbox, fn):
        w, h = self.im.size
        x0 = max(0, int(math.floor(bbox[0])) - 1)
        y0 = max(0, int(math.floor(bbox[1])) - 1)
        x1 = min(w, int(math.ceil(bbox[2])) + 2)
        y1 = min(h, int(math.ceil(bbox[3])) + 2)
        if x1 <= x0 or y1 <= y0:
            return
        if self._sc is None:
            self._sc = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        sc = self._sc
        # the scratch layer is canvas-sized, so shapes keep their real coordinates
        fn(ImageDraw.Draw(sc), 0.0, 0.0)
        self.im.alpha_composite(sc.crop((x0, y0, x1, y1)), (x0, y0))
        sc.paste((0, 0, 0, 0), (x0, y0, x1, y1))

    @staticmethod
    def _box(pts):
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return (min(xs), min(ys), max(xs), max(ys))

    def polygon(self, pts, fill=None, outline=None):
        pts = [(float(x), float(y)) for x, y in pts]
        if self._alpha(fill) or self._alpha(outline):
            self._blend(self._box(pts),
                        lambda sd, ox, oy: sd.polygon([(x + ox, y + oy) for x, y in pts],
                                                      fill=fill, outline=outline))
        else:
            self.d.polygon(pts, fill=fill, outline=outline)

    def ellipse(self, box, fill=None, outline=None, width=1):
        box = tuple(float(v) for v in box)
        if self._alpha(fill) or self._alpha(outline):
            self._blend(box, lambda sd, ox, oy: sd.ellipse((box[0] + ox, box[1] + oy, box[2] + ox, box[3] + oy),
                                                           fill=fill, outline=outline, width=width))
        else:
            self.d.ellipse(box, fill=fill, outline=outline, width=width)

    def line(self, pts, fill=None, width=1, joint=None):
        pts = [(float(x), float(y)) for x, y in pts]
        if self._alpha(fill):
            pad = width
            b = self._box(pts)
            self._blend((b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad),
                        lambda sd, ox, oy: sd.line([(x + ox, y + oy) for x, y in pts],
                                                   fill=fill, width=width, joint=joint))
        elif len(pts) == 1:
            self.d.point(pts, fill=fill)
        else:
            self.d.line(pts, fill=fill, width=width, joint=joint)

    def arc(self, box, start, end, fill=None, width=1):
        box = tuple(float(v) for v in box)
        self._blend(box, lambda sd, ox, oy: sd.arc((box[0] + ox, box[1] + oy, box[2] + ox, box[3] + oy),
                                                   start, end, fill=fill, width=width))

    def pieslice(self, box, start, end, fill=None, outline=None, width=1):
        box = tuple(float(v) for v in box)
        if self._alpha(fill) or self._alpha(outline):
            self._blend(box, lambda sd, ox, oy: sd.pieslice(
                (box[0] + ox, box[1] + oy, box[2] + ox, box[3] + oy), start, end,
                fill=fill, outline=outline, width=width))
        else:
            self.d.pieslice(box, start, end, fill=fill, outline=outline, width=width)

    def rounded_rectangle(self, box, radius, fill=None, outline=None, width=1):
        box = tuple(float(v) for v in box)
        if self._alpha(fill) or self._alpha(outline):
            self._blend(box, lambda sd, ox, oy: sd.rounded_rectangle(
                (box[0] + ox, box[1] + oy, box[2] + ox, box[3] + oy), radius=radius,
                fill=fill, outline=outline, width=width))
        else:
            self.d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

    def text(self, xy, s, font=None, fill=None, anchor=None):
        self.d.text(xy, s, font=font, fill=fill, anchor=anchor)

    def textbbox(self, xy, s, font=None, anchor=None):
        return self.d.textbbox(xy, s, font=font, anchor=anchor)


def limb(d, t, pts, width, fill, outline=INK, ow=3.2):
    p = [t.pt(x, y) for x, y in pts]
    w = width * t.s * SS
    o = ow * t.s * SS
    if outline:
        if len(p) > 1:
            d.line(p, fill=outline, width=max(1, int(round(w + 2 * o))), joint='curve')
        for q in p:
            r = (w + 2 * o) / 2
            d.ellipse((q[0] - r, q[1] - r, q[0] + r, q[1] + r), fill=outline)
    if len(p) > 1:
        d.line(p, fill=fill, width=max(1, int(round(w))), joint='curve')
    for q in p:
        r = w / 2
        d.ellipse((q[0] - r, q[1] - r, q[0] + r, q[1] + r), fill=fill)


def soft(d, t, box, fill):
    """Translucent overlay: needs a Draw created with mode 'RGBA' to blend."""
    x0, y0, x1, y1 = box
    a = t.pt(x0, y0)
    b = t.pt(x1, y1)
    bb = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
    d.ellipse(bb, fill=fill)


def ink_shape(d, t, pts, base, shade_pts=None, light_pts=None, ow=3.2):
    p = [t.pt(x, y) for x, y in pts]
    d.polygon(p, fill=base)
    if light_pts:
        d.polygon([t.pt(x, y) for x, y in light_pts], fill=LIGHT_A)
    if shade_pts:
        d.polygon([t.pt(x, y) for x, y in shade_pts], fill=SHADE_A)
    d.line(p + [p[0]], fill=INK, width=t.w(ow), joint='curve')


def heart(d, t, cx, cy, r, fill):
    pts = [(cx, cy + r * 0.62), (cx - r * 0.82, cy - r * 0.16), (cx - r * 0.34, cy - r * 0.78),
           (cx, cy - r * 0.36), (cx + r * 0.34, cy - r * 0.78), (cx + r * 0.82, cy - r * 0.16)]
    d.polygon([t.pt(x, y) for x, y in pts], fill=fill)


def star_pts(cx, cy, r, rot=-90):
    out = []
    for i in range(10):
        ang = math.radians(rot + i * 36)
        rr = r if i % 2 == 0 else r * 0.42
        out.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
    return out


def star(d, t, cx, cy, r, fill):
    d.polygon([t.pt(x, y) for x, y in star_pts(cx, cy, r)], fill=fill)


def spark(d, t, cx, cy, r, fill):
    pts = [(cx, cy - r), (cx + r * 0.28, cy - r * 0.28), (cx + r, cy),
           (cx + r * 0.28, cy + r * 0.28), (cx, cy + r),
           (cx - r * 0.28, cy + r * 0.28), (cx - r, cy), (cx - r * 0.28, cy - r * 0.28)]
    d.polygon([t.pt(x, y) for x, y in pts], fill=fill)


def rrect(d, t, box, radius, fill=None, outline=None, ow=3.2):
    x0, y0, x1, y1 = box
    a = t.pt(x0, y0)
    b = t.pt(x1, y1)
    bb = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
    d.rounded_rectangle(bb, radius=t.w(radius), fill=fill, outline=outline,
                        width=t.w(ow) if outline else 0)


# ============================================================================
# POSES -> geometry
# ============================================================================
def arm_geom(spec, side):
    """Resolve an arm spec into shoulder/elbow/hand points (canonical coords)."""
    if isinstance(spec, dict):
        t1 = spec.get('t1', 0.0)
        single = bool(spec.get('single'))
        t2 = spec.get('t2', t1)
        l1 = spec.get('l1', 52.0 if single else 42.0)
        l2 = spec.get('l2', 40.0)
    else:
        t1, t2 = spec
        single = False
        l1, l2 = 42.0, 40.0
    s = float(side)
    a1 = math.radians(s * t1)
    sh = (CX + s * SHOULDER_X, SHOULDER_Y)
    ex = sh[0] + l1 * math.sin(a1)
    ey = sh[1] + l1 * math.cos(a1)
    if single:
        return sh, (ex, ey), (ex, ey)
    a2 = math.radians(s * t2)
    hx = ex + l2 * math.sin(a2)
    hy = ey + l2 * math.cos(a2)
    return sh, (ex, ey), (hx, hy)


def hand_points(spec):
    r = arm_geom(spec[0], 1)
    l = arm_geom(spec[1], -1)
    return {'R': r[2], 'L': l[2], 'R_elbow': r[1], 'L_elbow': l[1]}


# ============================================================================
# body
# ============================================================================
# ============================================================================
# the whale rig
# ============================================================================
# One chubby DeepSeek-blue whale. The silhouette is parametric, so a shape, its
# gradient, its cel shadow and its outline all share one path: that is what makes
# the flat "vector mascot" read as a rounded, lit character. Faces ride on the
# head transform, so a pose can still tilt or turn the head (hdx / hdy).

# body silhouette control points: (y, half width), cosine-eased between stations
WH_PROFILE = [(118.0, 24.0), (126.0, 36.0), (140.0, 45.0), (162.0, 52.0),
              (192.0, 57.0), (222.0, 59.0), (252.0, 57.0), (282.0, 53.0),
              (308.0, 45.0), (326.0, 30.0)]
EYE_X = 22.0
EYE_Y = HEAD_CY + 4.0
MOUTH_Y = HEAD_CY + 27.0
_GRADS = {}


def sh(c, k=0.24):
    """Cel shadow: mix towards the navy ink so every shade stays in palette."""
    return mix(c, OUTLINE_BLUE, k)


def gl(c, k=0.30):
    """Gloss / rim light: mix towards white."""
    return mix(c, (255, 255, 255, 255), k)


def ellipse_pts(cx, cy, rx, ry, n=48):
    return [(cx + rx * math.sin(2 * math.pi * i / n),
             cy - ry * math.cos(2 * math.pi * i / n)) for i in range(n)]


def _smooth(y0, w0, y1, w1, n=5):
    out = []
    for k in range(n):
        f = k / float(n)
        e = (1.0 - math.cos(math.pi * f)) / 2.0
        out.append((y0 + (y1 - y0) * f, w0 + (w1 - w0) * e))
    return out


def body_pts():
    """The whale's body: a chubby pear, widest at the hips, tucked under the head."""
    right = []
    for i in range(len(WH_PROFILE) - 1):
        right += _smooth(WH_PROFILE[i][0], WH_PROFILE[i][1],
                         WH_PROFILE[i + 1][0], WH_PROFILE[i + 1][1])
    y_end, w_end = WH_PROFILE[-1]
    out = [(CX + w, y) for y, w in right]
    for k in range(1, 7):
        a = math.pi * k / 7.0
        out.append((CX + w_end * math.cos(a), y_end + 15.0 * math.sin(a)))
    out += [(CX - w, y) for y, w in reversed(right)]
    return out


def belly_pts():
    return ellipse_pts(CX, 228.0, 44.0, 78.0, 56)


def chin_pts():
    return ellipse_pts(CX, HEAD_CY + 18.0, 38.0, 27.0, 48)


def head_pts():
    """Head blob: a round mascot head with slightly heavy cheeks and a soft chin."""
    out = []
    n = 64
    for i in range(n):
        a = 2 * math.pi * i / n
        low = max(0.0, -math.cos(a))
        out.append((CX + HEAD_RX * (1.0 + 0.10 * low) * math.sin(a),
                    HEAD_CY - HEAD_RY * (1.0 - 0.07 * low) * math.cos(a)))
    return out


def _tp(t, pts):
    return [t.pt(x, y) for x, y in pts]


def _mask_of(pts_t):
    mk = Image.new('L', (CW, CH), 0)
    ImageDraw.Draw(mk).polygon([(float(x), float(y)) for x, y in pts_t], fill=255)
    return mk


def _multi(ms):
    m = ms[0]
    for other in ms[1:]:
        m = ImageChops.multiply(m, other)
    return m


def vgrad(c_top, c_bot, steps=64):
    """A canvas-sized vertical gradient, cached because the palette repeats."""
    key = (tuple(c_top[:3]), tuple(c_bot[:3]), steps)
    got = _GRADS.get(key)
    if got is None:
        got = Image.new('RGBA', (CW, CH), c_top)
        gd = ImageDraw.Draw(got)
        for i in range(steps):
            y0 = CH * i // steps
            y1 = max(y0 + 1, CH * (i + 1) // steps)
            gd.rectangle((0, y0, CW, y1), fill=mix(c_top, c_bot, i / float(steps - 1)))
        _GRADS[key] = got
    return got


def clip(d, t, shapes, fn):
    """Draw fn on a scratch layer but keep only what falls inside every shape."""
    sc = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    fn(Canvas(sc))
    sc.putalpha(ImageChops.multiply(sc.getchannel('A'),
                                    _multi([_mask_of(_tp(t, p)) for p in shapes])))
    d.im.alpha_composite(sc)


def grad_in(d, t, shapes, top, bot):
    """Fill the intersection of `shapes` with a soft vertical gradient."""
    sc = vgrad(top, bot).copy()
    sc.putalpha(ImageChops.multiply(sc.getchannel('A'),
                                    _multi([_mask_of(_tp(t, p)) for p in shapes])))
    d.im.alpha_composite(sc)


def outline(d, t, pts, col=None, ow=4.4, closed=True):
    p = _tp(t, pts)
    if closed:
        p = p + [p[0]]
    d.line(p, fill=col or OUTLINE_BLUE, width=t.w(ow), joint='curve')


# ---------------------------------------------------------------- body & tail
def draw_fluke(d, t, ch):
    """The whale's tail: one fluke out to the lower right, behind the body."""
    base = gl(BODY_BLUE, 0.08)
    pts = [(CX + 34, 258), (CX + 108, 266), (CX + 62, 298), (CX + 104, 330),
           (CX + 30, 316)]
    poly(d, t, pts, fill=base, outline=OUTLINE_BLUE, ow=4.0)
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX + 56 - 74, 330 - 74,
                                             CX + 56 + 74, 330 + 74),
                                     fill=sh(base, 0.24)))
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX + 60, 262, CX + 116, 286),
                                     fill=(255, 255, 255, 110)))


def draw_dorsal(d, t, ch):
    """Small dorsal fin, poking up behind the right shoulder."""
    base = gl(BODY_BLUE, 0.10)
    pts = [(CX + 34, 168), (CX + 84, 108), (CX + 100, 172)]
    poly(d, t, pts, fill=base, outline=OUTLINE_BLUE, ow=3.8)
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX + 70 - 56, 190 - 56,
                                             CX + 70 + 56, 190 + 56),
                                     fill=sh(base, 0.22)))
    pts2 = [(CX - 40, 150), (CX - 78, 128), (CX - 86, 176)]
    poly(d, t, pts2, fill=base, outline=OUTLINE_BLUE, ow=3.4)


def draw_cat_tail(d, t, ch):
    """Neko mode: a cat tail curled out from behind the body."""
    arc(d, t, (CX + 34, 196, CX + 122, 292), 200, 20, fill=ch['hair'], width=13.0)
    arc(d, t, (CX + 34, 196, CX + 122, 292), 200, 20, fill=OUTLINE_BLUE, width=3.0)
    soft(d, t, (CX + 92, 214, CX + 112, 240), (255, 255, 255, 90))


def draw_body(d, t, ch):
    """Body, belly and the set of shadows/highlights that give it volume."""
    draw_dorsal(d, t, ch)
    draw_fluke(d, t, ch)
    pts = body_pts()
    base = BODY_BLUE

    d.polygon(_tp(t, pts), fill=base)
    grad_in(d, t, [pts], gl(base, 0.22), sh(base, 0.10))
    # first cel step, then a deeper one right at the bottom edge
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX + 34 - 150, 348 - 150,
                                             CX + 34 + 150, 348 + 150),
                                     fill=sh(base, 0.26)))
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX + 46 - 150, 430 - 150,
                                             CX + 46 + 150, 430 + 150),
                                     fill=sh(base, 0.40)))
    # rim light down the left edge + a specular gloss on the upper belly
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX - 96, 118, CX + 6, 350),
                                     fill=(255, 255, 255, 88)))
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX - 62, 150, CX - 4, 226),
                                     fill=(255, 255, 255, 120)))

    # the pale belly panel
    bpts = belly_pts()
    d.polygon(_tp(t, bpts), fill=BELLY_WHITE)
    grad_in(d, t, [bpts], (255, 255, 255, 255), (198, 216, 248, 255))
    clip(d, t, [bpts], lambda dd: ell(dd, t, (CX + 24 - 90, 320 - 90,
                                              CX + 24 + 90, 320 + 90),
                                      fill=(178, 200, 242, 190)))
    for i in range(3):
        arc(d, t, (CX - 30, 176 + i * 38, CX + 30, 220 + i * 38), 20, 160,
            fill=(194, 210, 242, 210), width=2.8)
    outline(d, t, bpts, OUTLINE_BLUE, 3.0)
    outline(d, t, pts, OUTLINE_BLUE, 4.6)


# ------------------------------------------------------------------------ head
def draw_head(d, t, ch):
    """Head blob, pale throat, blowhole. Face and accessories come on top."""
    pts = head_pts()
    base = BODY_BLUE
    d.polygon(_tp(t, pts), fill=base)
    grad_in(d, t, [pts], gl(base, 0.26), sh(base, 0.08))
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX - 130, HEAD_CY + 10,
                                             CX + 130, HEAD_CY + 190),
                                     fill=sh(base, 0.22)))
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX - 120, HEAD_CY + 44,
                                             CX + 120, HEAD_CY + 210),
                                     fill=sh(base, 0.34)))
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX - 88, HEAD_CY - 74,
                                             CX + 44, HEAD_CY + 64),
                                     fill=(255, 255, 255, 92)))
    clip(d, t, [pts], lambda dd: ell(dd, t, (CX - 44, HEAD_CY - 46,
                                             CX + 6, HEAD_CY - 4),
                                     fill=(255, 255, 255, 140)))
    # pale throat, clipped to the head so it never spills over the silhouette
    cpts = chin_pts()
    grad_in(d, t, [pts, cpts], (255, 255, 255, 255), (200, 218, 248, 255))
    clip(d, t, [pts, cpts], lambda dd: ell(dd, t, (CX - 90, HEAD_CY + 44,
                                                   CX + 90, HEAD_CY + 170),
                                           fill=(180, 202, 244, 170)))
    arc(d, t, (CX - 15, HEAD_CY - 38, CX + 15, HEAD_CY - 16), 190, 350,
        fill=(206, 220, 250, 235), width=3.2)
    if not ch['acc'] or 'blowhole' in ch['acc']:
        for k, kx in enumerate((0, 15, 30)):
            r = 4.0 + k * 1.6
            ell(d, t, (CX - 6 + kx, HEAD_CY - 52 - k * 9 - r, CX - 6 + kx + 2 * r,
                       HEAD_CY - 52 - k * 9 + r), fill=(198, 230, 255, 225))
    outline(d, t, pts, OUTLINE_BLUE, 4.6)


# ---------------------------------------------------------------- arms & hands
def draw_hand(d, t, pt, side, base, style='open'):
    x, y = pt
    col = gl(base, 0.34)
    if style == 'flat':
        box = (x - 18, y - 12, x + 18, y + 12)
    elif style == 'point':
        pts = [(x - 13, y - 13), (x + 20, y - 5), (x + 20, y + 6), (x - 13, y + 13)]
        poly(d, t, pts, fill=col, outline=OUTLINE_BLUE, ow=3.8)
        soft(d, t, (x - 8, y - 9, x + 8, y - 1), (255, 255, 255, 120))
        return
    else:
        box = (x - 15, y - 15, x + 15, y + 15)
    ell(d, t, box, fill=col, outline=OUTLINE_BLUE, ow=3.8)
    w, h = box[2] - box[0], box[3] - box[1]
    grad_in(d, t, [ellipse_pts(x, y, w / 2.0, h / 2.0, 28)], gl(col, 0.22),
            sh(col, 0.12))
    soft(d, t, (x - w * 0.36, y - h * 0.42, x + w * 0.06, y - h * 0.02),
         (255, 255, 255, 160))
    if style == 'paw':
        for k in (-6, 0, 6):
            ell(d, t, (x + k - 3, y - h / 2 - 3, x + k + 3, y - h / 2 + 6),
                fill=col, outline=OUTLINE_BLUE, ow=2.6)
    elif style == 'grip':
        arc(d, t, (x - 12, y - 11, x + 12, y + 12), 200, 340,
            fill=OUTLINE_BLUE, width=3.4)


def draw_fin(d, t, ch, spec, side, style='open'):
    """A flipper standing in for an arm: capsule limb plus a rounded tip."""
    (sx, sy), (ex, ey), (hx, hy) = arm_geom(spec, side)
    base = BODY_BLUE
    limb(d, t, [(sx, sy), (ex, ey)], 30.0, base, OUTLINE_BLUE, 4.2)
    limb(d, t, [(ex, ey), (hx, hy)], 25.0, base, OUTLINE_BLUE, 4.2)
    # volume: rim along the outer edge, shadow along the inner one
    limb(d, t, [(sx + side * 5, sy - 6), (ex + side * 5, ey - 6)], 12.0,
         (255, 255, 255, 92), None, 0)
    limb(d, t, [(ex + side * 3, ey - 4), (hx + side * 3, hy - 4)], 8.0,
         (255, 255, 255, 78), None, 0)
    limb(d, t, [(sx + side * 3, sy + 10), (ex + side * 2, ey + 11)], 10.0,
         sh(base, 0.30), None, 0)
    draw_hand(d, t, (hx, hy), side, base, style)


def draw_arms(d, t, ch, spec):
    """Both flippers, in front of the body (left first, then right)."""
    draw_fin(d, t, ch, spec['arms'][1], -1, spec['hand_style'])
    draw_fin(d, t, ch, spec['arms'][0], 1, spec['hand_style'])


# ----------------------------------------------------------------------- face
def draw_eyes(d, t, kind, look=0.0):
    for side in (1, -1):
        x = CX + side * EYE_X + look * 3.0 * side
        draw_eye(d, t, x, EYE_Y, side, kind, look)


def draw_eye(d, t, x, y, side, kind, look=0.0):
    rx, ry = 14.5, 16.5
    if kind in ('closed', 'happy'):
        arc(d, t, (x - 13, y - 13, x + 13, y + 13), 196, 344,
            fill=OUTLINE_BLUE, width=4.2)
        for k in (-1, 0, 1):
            line(d, t, [(x + k * 9, y - 9 + abs(k) * 2), (x + k * 9 - 3, y - 5 + abs(k) * 3)],
                 fill=OUTLINE_BLUE, width=2.4)
        return
    if kind == 'flat':
        rrect(d, t, (x - 13, y - 4, x + 13, y + 4), 4,
              fill=(248, 250, 255, 255), outline=OUTLINE_BLUE, ow=3.0)
        line(d, t, [(x - 9, y - 1), (x + 9, y - 1)], fill=OUTLINE_BLUE, width=3.0)
        return
    if kind == 'smirk' and side > 0:
        arc(d, t, (x - 13, y - 11, x + 13, y + 15), 196, 344,
            fill=OUTLINE_BLUE, width=4.0)
        return
    wide = kind == 'wide'
    if wide:
        rx, ry = rx + 2.5, ry + 2.5
    box = (x - rx, y - ry, x + rx, y + ry)
    ell(d, t, box, fill=(248, 250, 255, 255), outline=OUTLINE_BLUE, ow=3.4)
    # iris: gradient from the deep navy top to a lit blue bottom
    iris_r = 11.5 if not wide else 10.0
    ibox = (x - iris_r, y - iris_r + (2.5 if not wide else 3.5),
            x + iris_r, y + iris_r + (2.5 if not wide else 3.5))
    ipts = ellipse_pts(x, (ibox[1] + ibox[3]) / 2.0, iris_r, iris_r, 32)
    d.polygon(_tp(t, ipts), fill=(58, 84, 190, 255))
    grad_in(d, t, [ipts], (34, 46, 110, 255), (108, 142, 246, 255))
    clip(d, t, [ipts], lambda dd: ell(dd, t, (x - iris_r, y - iris_r - 2,
                                              x + iris_r, y + iris_r + 11),
                                      fill=(150, 186, 255, 90)))
    # pupil
    ell(d, t, (x - 6.5, y - 5.5, x + 6.5, y + 9.5), fill=(24, 32, 78, 255))
    if kind == 'love':
        heart(d, t, x, y + 2, 8.5, WHALE_PINK)
    elif kind in ('star', 'sparkle_eyes'):
        star(d, t, x, y + 1, 9.0, (255, 232, 150, 255))
        star(d, t, x + 1, y - 2, 4.0, (255, 255, 255, 235))
    # two highlights: the big one upper-left, the small one lower-right
    ell(d, t, (x - 9.5, y - 12, x - 1.5, y - 4), fill=(255, 255, 255, 240))
    ell(d, t, (x + 2.5, y + 3.5, x + 7.5, y + 8.5), fill=(255, 255, 255, 205))
    if kind == 'scan':
        arc(d, t, (x - 12, y - 12, x + 12, y + 12), 300, 60,
            fill=(150, 205, 255, 230), width=2.6)
        line(d, t, [(x - 10, y + 10), (x + 10, y - 10)], fill=(180, 220, 255, 190), width=2.0)
    # upper lid, heavier for the annoyed faces
    lid = 0.0
    if kind == 'angry':
        lid = 6.0
    elif kind == 'side':
        lid = 2.5
    arc(d, t, (x - rx - 1, y - ry - 1 + lid, x + rx + 1, y + ry - 1 + lid),
        186, 354, fill=OUTLINE_BLUE, width=3.6)
    if kind in ('angry', 'side'):
        poly(d, t, [(x - rx - 1, y - ry + lid), (x + rx + 1, y - ry - 3 + lid),
                    (x + rx + 1, y - ry + 3 + lid), (x - rx - 1, y - ry + 6 + lid)],
             fill=OUTLINE_BLUE)
    if kind == 'plead':
        soft(d, t, (x - 10, y + 5, x + 10, y + 15), (255, 255, 255, 150))
        ell(d, t, (x + 12, y + 14, x + 18, y + 22), fill=(170, 214, 255, 235))


def draw_brows(d, t, kind):
    if not kind:
        return
    y = EYE_Y - 24.0
    for side in (1, -1):
        x = CX + side * EYE_X
        if kind == 'angry':
            pts = [(x - 12 * side, y - 3), (x + 11 * side, y + 6)]
        elif kind == 'sad':
            pts = [(x - 12 * side, y + 6), (x + 11 * side, y - 2)]
        else:                                   # 'up': raised, round brows
            arc(d, t, (x - 12, y - 9, x + 12, y + 9), 186, 354,
                fill=OUTLINE_BLUE, width=4.0)
            continue
        limb(d, t, pts, 6.4, OUTLINE_BLUE)


def draw_mouth(d, t, kind, lip=None):
    x, y = CX, MOUTH_Y
    navy = OUTLINE_BLUE
    if kind == 'none':
        return
    if kind in ('smile', 'grin_small'):
        w = 17 if kind == 'smile' else 12
        arc(d, t, (x - w, y - 12, x + w, y + 12), 20, 160, fill=navy, width=3.8)
        return
    if kind in ('grin', 'tongue', 'talk'):
        w, h = (21, 13) if kind == 'grin' else (17, 15)
        box = (x - w, y - h, x + w, y + h)
        ell(d, t, box, fill=(46, 40, 84, 255), outline=navy, ow=3.6)
        arc(d, t, (x - w + 5, y - h + 4, x + w - 5, y + h + 5), 20, 160,
            fill=(255, 150, 178, 255), width=int(max(3, h - 3) * SS / 3))
        if kind == 'tongue':
            ell(d, t, (x - 9, y + 6, x + 9, y + 22), fill=(255, 150, 178, 255),
                outline=navy, ow=3.0)
        elif kind == 'talk':
            ell(d, t, (x - 7, y - 2, x + 7, y + 10), fill=(255, 168, 190, 255))
        return
    if kind in ('o', 'o_big'):
        r = 7.0 if kind == 'o' else 11.0
        ell(d, t, (x - r, y - r, x + r, y + r + 2), fill=(46, 40, 84, 255),
            outline=navy, ow=3.4)
        ell(d, t, (x - r * 0.5, y + r * 0.1, x + r * 0.5, y + r * 0.9),
            fill=(255, 150, 178, 220))
        return
    if kind == 'frown':
        arc(d, t, (x - 15, y - 4, x + 15, y + 22), 190, 350, fill=navy, width=3.8)
        return
    if kind == 'wavy':
        line(d, t, [(x - 16, y + 3), (x - 8, y - 3), (x, y + 3), (x + 8, y - 3),
                    (x + 16, y + 3)], fill=navy, width=3.4)
        return
    if kind == 'flat':
        line(d, t, [(x - 11, y + 2), (x + 11, y + 2)], fill=navy, width=3.4)
        return
    if kind == 'smirk':
        line(d, t, [(x - 13, y + 4), (x - 2, y + 8), (x + 12, y - 4)],
             fill=navy, width=3.6)
        return
    if kind == 'kiss':
        ell(d, t, (x - 9, y - 5, x + 9, y + 7), fill=(255, 150, 178, 255),
            outline=navy, ow=3.2)
        line(d, t, [(x - 4, y - 2), (x + 4, y - 2)], fill=navy, width=2.4)
        return
    if kind == 'pout':
        ell(d, t, (x - 10, y - 4, x + 10, y + 9), fill=(255, 160, 186, 255),
            outline=navy, ow=3.2)
        line(d, t, [(x - 7, y + 2), (x + 7, y + 2)], fill=navy, width=2.4)


def draw_blush(d, t, ch, hearts=False, big=False):
    col = ch['lip'] or (255, 146, 172, 165)
    rx = 14.0 if big else 12.0
    ry = 8.5 if big else 7.5
    for side in (1, -1):
        x = CX + side * (EYE_X + 13.0)
        y = EYE_Y + 13.0
        ell(d, t, (x - rx, y - ry, x + rx, y + ry),
            fill=(col[0], col[1], col[2], col[3] - 60))
        ell(d, t, (x - rx * 0.78, y - ry * 0.8, x + rx * 0.78, y + ry * 0.8), fill=col)
        for k in (-1, 1):
            line(d, t, [(x + k * 5, y - 4), (x + k * 8, y + 4)],
                 fill=(255, 255, 255, 150), width=2.2)


def draw_face(d, t, ch, spec):
    """Brows, eyes, mouth and blush — all on the head transform."""
    draw_brows(d, t, spec['brows'])
    draw_eyes(d, t, spec['eyes'], spec['look'])
    draw_mouth(d, t, spec['mouth'], ch['lip'])
    draw_blush(d, t, ch,
               hearts=('heart_blush' in spec['deco']) or spec['eyes'] in ('love', 'plead'),
               big=bool(ch['lip']))


# ---------------------------------------------------------------- accessories
def draw_head_accessories(d, t, ch):
    """The mode's outfit, drawn over the face. One whale, eleven wardrobes."""
    acc = ch['acc']
    top, top2, hair = ch['top'], ch['top2'], ch['hair']
    ty = HEAD_CY - HEAD_RY
    by = HEAD_CY + HEAD_RY
    if 'cap' in acc:                            # friend: baseball cap
        ell(d, t, (CX - HEAD_RX - 5, ty - 16, CX + HEAD_RX + 5, HEAD_CY - 4),
            fill=top, outline=OUTLINE_BLUE, ow=3.8)
        clip(d, t, [ellipse_pts(CX, HEAD_CY - 10, HEAD_RX + 5, 30, 40)],
             lambda dd: ell(dd, t, (CX - 90, HEAD_CY + 4, CX + 90, HEAD_CY + 90),
                            fill=sh(top, 0.22)))
        pts = [(CX + 4, HEAD_CY - 16), (CX + 74, HEAD_CY - 8), (CX + 70, HEAD_CY + 10),
               (CX + 8, HEAD_CY + 2)]
        poly(d, t, pts, fill=sh(top, 0.14), outline=OUTLINE_BLUE, ow=3.4)
        ell(d, t, (CX - 6, ty - 24, CX + 6, ty - 12), fill=top2,
            outline=OUTLINE_BLUE, ow=2.6)
    if 'headset' in acc:                        # jarvis: headset band + earpieces
        arc(d, t, (CX - HEAD_RX - 12, ty - 22, CX + HEAD_RX + 12, HEAD_CY + 12),
            186, 354, fill=top, width=7.0)
        arc(d, t, (CX - HEAD_RX - 12, ty - 22, CX + HEAD_RX + 12, HEAD_CY + 12),
            186, 354, fill=OUTLINE_BLUE, width=2.4)
        for side in (1, -1):
            x = CX + side * (HEAD_RX + 6)
            rrect(d, t, (x - 11, HEAD_CY - 20, x + 11, HEAD_CY + 12), 8,
                  fill=top2, outline=OUTLINE_BLUE, ow=3.2)
        line(d, t, [(CX + HEAD_RX + 6, HEAD_CY + 12), (CX + HEAD_RX + 2, HEAD_CY + 44)],
             fill=OUTLINE_BLUE, width=3.4)
        ell(d, t, (CX + HEAD_RX - 4, HEAD_CY + 42, CX + HEAD_RX + 10, HEAD_CY + 54),
            fill=GLOW_BLUE, outline=OUTLINE_BLUE, ow=2.6)
    if 'visor' in acc:                          # jarvis: translucent HUD over one eye
        rrect(d, t, (CX - HEAD_RX - 2, EYE_Y - 17, CX + HEAD_RX + 2, EYE_Y + 15), 13,
              fill=(120, 190, 255, 82))
        for i in range(3):
            line(d, t, [(CX - HEAD_RX + 4, EYE_Y - 10 + i * 9),
                        (CX + HEAD_RX - 4, EYE_Y - 12 + i * 9)],
                 fill=(170, 225, 255, 170), width=2.0)
    if 'glasses' in acc:                        # warm-guy: round frames
        for side in (1, -1):
            x = CX + side * EYE_X
            ell(d, t, (x - 19, EYE_Y - 19, x + 19, EYE_Y + 19),
                outline=OUTLINE_BLUE, ow=4.0)
            arc(d, t, (x - 16, EYE_Y - 17, x + 16, EYE_Y + 8), 200, 340,
                fill=(255, 255, 255, 90), width=3.0)
        line(d, t, [(CX - 4, EYE_Y - 2), (CX + 4, EYE_Y - 2)], fill=OUTLINE_BLUE, width=4.0)
        for side in (1, -1):
            line(d, t, [(CX + side * (EYE_X + 18), EYE_Y - 4),
                        (CX + side * (EYE_X + 30), EYE_Y - 8)],
                 fill=OUTLINE_BLUE, width=3.6)
    if 'cat_ears' in acc:                       # neko: ears + whiskers
        for side in (1, -1):
            x = CX + side * 34
            pts = [(x - 17, ty + 12), (x + side * 2, ty - 26), (x + 17, ty + 8)]
            poly(d, t, pts, fill=hair, outline=OUTLINE_BLUE, ow=3.6)
            poly(d, t, [(x - 9, ty + 8), (x + side * 1, ty - 14), (x + 9, ty + 5)],
                 fill=WHALE_PINK)
        whiskers_face(d, t)
    if 'tuft' in acc:                           # daughter: a little sprout
        line(d, t, [(CX + 2, ty - 2), (CX + 12, ty - 26)], fill=hair, width=5.0)
        ell(d, t, (CX + 6, ty - 34, CX + 22, ty - 18), fill=hair,
            outline=OUTLINE_BLUE, ow=2.8)
    if 'bow' in acc:                            # girlfriend / daughter: ribbon bow, not ears
        bx, byy = CX - HEAD_RX + 12, ty - 4
        for side in (1, -1):
            poly(d, t, [(bx, byy), (bx + side * 27, byy - 17), (bx + side * 25, byy + 13)],
                 fill=WHALE_PINK, outline=OUTLINE_BLUE, ow=3.2)
            poly(d, t, [(bx + side * 6, byy - 2), (bx + side * 22, byy - 12),
                        (bx + side * 21, byy + 7)], fill=gl(WHALE_PINK, 0.22), outline=None)
        ell(d, t, (bx - 8, byy - 8, bx + 8, byy + 8), fill=gl(WHALE_PINK, 0.28),
            outline=OUTLINE_BLUE, ow=3.0)
    if 'band' in acc:                           # tsundere: pale streak over the head
        rrect(d, t, (CX - HEAD_RX - 3, ty + 10, CX + HEAD_RX + 3, ty + 30), 9,
              fill=top, outline=OUTLINE_BLUE, ow=3.0)
    if 'lashes' in acc:                         # girlfriend / oneesan: long lashes
        for side in (1, -1):
            x = CX + side * EYE_X
            for k in (-1, 0, 1):
                line(d, t, [(x + side * (EYE_X * 0.35) + k * 7, EYE_Y - 15),
                            (x + side * (EYE_X * 0.95) + k * 9, EYE_Y - 24)],
                     fill=OUTLINE_BLUE, width=2.6)
    if 'drop' in acc:                           # whale-girl: a water bead
        ell(d, t, (CX - HEAD_RX - 6, ty + 22, CX + HEAD_RX - 18, ty + 40),
            fill=(198, 230, 255, 240), outline=OUTLINE_BLUE, ow=2.6)
    if 'glow' in acc:                           # jarvis: a soft glow ring
        arc(d, t, (CX - HEAD_RX - 14, ty - 14, CX + HEAD_RX + 14, HEAD_CY + 40),
            170, 300, fill=(150, 205, 255, 170), width=3.0)
    draw_neckwear(d, t, ch)


def whiskers_face(d, t):
    for side in (1, -1):
        for dy in (-9, 2, 13):
            line(d, t, [(CX + side * (EYE_X + 30), MOUTH_Y + dy * 0.5),
                        (CX + side * (EYE_X + 62), MOUTH_Y + dy - side * 3)],
                 fill=(86, 104, 176, 200), width=2.6)


def draw_neckwear(d, t, ch):
    """Everything the mode wears at the throat: scarf, tie, collar, pearls."""
    acc = ch['acc']
    top, top2, hair = ch['top'], ch['top2'], ch['hair']
    ny = HEAD_CY + HEAD_RY + 6
    if 'scarf' in acc or 'knit' in acc:
        rrect(d, t, (CX - 52, ny - 14, CX + 52, ny + 16), 15, fill=top,
              outline=OUTLINE_BLUE, ow=3.6)
        for i in range(3):
            arc(d, t, (CX - 40 + i * 26, ny - 12, CX + 26 + i * 26, ny + 14), 200, 340,
                fill=sh(top, 0.16), width=2.4)
        rrect(d, t, (CX + 28, ny + 6, CX + 52, ny + 52), 9, fill=top2,
              outline=OUTLINE_BLUE, ow=3.2)
    if 'collar' in acc:
        for side in (1, -1):
            poly(d, t, [(CX + side * 6, ny - 16), (CX + side * 44, ny - 10),
                        (CX + side * 38, ny + 12), (CX + side * 8, ny + 6)],
                 fill=top, outline=OUTLINE_BLUE, ow=3.4)
    if 'tie' in acc:
        poly(d, t, [(CX - 13, ny - 14), (CX + 13, ny - 14), (CX + 11, ny + 2),
                    (CX - 11, ny + 2)], fill=top2, outline=OUTLINE_BLUE, ow=3.0)
        poly(d, t, [(CX - 11, ny + 4), (CX + 11, ny + 4), (CX + 16, ny + 34),
                    (CX, ny + 48), (CX - 16, ny + 34)], fill=top2,
             outline=OUTLINE_BLUE, ow=3.2)
    if 'bowtie' in acc:
        for side in (1, -1):
            poly(d, t, [(CX, ny + 1), (CX + side * 30, ny - 15),
                        (CX + side * 30, ny + 15)], fill=top2,
                 outline=OUTLINE_BLUE, ow=3.2)
        ell(d, t, (CX - 6, ny - 5, CX + 6, ny + 7), fill=gl(top2, 0.22),
            outline=OUTLINE_BLUE, ow=2.6)
    if 'pearls' in acc:
        for i in range(9):
            a = math.pi * (0.12 + 0.76 * i / 8.0)
            px = CX - 46 * math.cos(a)
            py = ny + 6 + 26 * math.sin(a)
            ell(d, t, (px - 5, py - 5, px + 5, py + 5), fill=(246, 250, 255, 255),
                outline=OUTLINE_BLUE, ow=2.2)
            ell(d, t, (px - 3, py - 3, px - 1, py - 1), fill=(255, 255, 255, 235))
    if 'bib' in acc:                            # whale-girl: a tiny tail bib
        poly(d, t, [(CX - 30, ny + 16), (CX + 30, ny + 16), (CX + 34, ny + 54),
                    (CX - 34, ny + 54)], fill=top2, outline=OUTLINE_BLUE, ow=3.4)
        for side in (1, -1):
            poly(d, t, [(CX + side * 12, ny + 50), (CX + side * 36, ny + 66),
                        (CX + side * 14, ny + 70)], fill=top2,
                 outline=OUTLINE_BLUE, ow=3.0)
    if 'lapel' in acc:
        for side in (1, -1):
            poly(d, t, [(CX + side * 6, ny - 14), (CX + side * 40, ny - 8),
                        (CX + side * 34, ny + 10), (CX + side * 10, ny + 4)],
                 fill=top, outline=OUTLINE_BLUE, ow=3.2)
        ell(d, t, (CX + 24, ny + 26, CX + 38, ny + 40), fill=top2,
            outline=OUTLINE_BLUE, ow=2.4)
    if 'whiskers' in acc and 'cat_ears' not in acc:
        whiskers_face(d, t)

def prop_chibi(d, t, spec, ch):
    """The little chibi whale the mascot hugs, pats or carries."""
    x, y = spec.get('chibi', (CX, 200))
    tt = T(t.s, t.rot + spec.get('chibi_rot', 0.0), t.dx, t.dy)
    base = (210, 231, 255, 255)                # pale calf: has to read against the parent
    body = ellipse_pts(x, y + 12, 30, 46, 44)
    for s in (-1, 1):
        poly(d, tt, [(x + s * 8, y + 40), (x + s * 36, y + 50), (x + s * 12, y + 62)],
             fill=base, outline=OUTLINE_BLUE, ow=3.0)
    ell(d, tt, (x - 30, y - 34, x + 30, y + 58), fill=base, outline=OUTLINE_BLUE, ow=3.8)
    grad_in(d, tt, [body], gl(base, 0.24), sh(base, 0.14))
    clip(d, tt, [body], lambda dd: ell(dd, tt, (x + 12 - 60, y + 70 - 60,
                                                x + 12 + 60, y + 70 + 60),
                                       fill=sh(base, 0.26)))
    ell(d, tt, (x - 19, y - 7, x + 19, y + 50), fill=(250, 252, 255, 255))
    outline(d, tt, ellipse_pts(x, y + 21, 19, 29, 32), OUTLINE_BLUE, 2.6)
    for s in (-1, 1):
        ell(d, tt, (x + s * 12 - 8, y - 25, x + s * 12 + 8, y - 9),
            fill=(252, 253, 255, 255), outline=OUTLINE_BLUE, ow=2.8)
        ell(d, tt, (x + s * 12 - 3.4, y - 20, x + s * 12 + 3.4, y - 12),
            fill=(30, 42, 96, 255))
        ell(d, tt, (x + s * 12 - 6, y - 22, x + s * 12 - 1, y - 17),
            fill=(255, 255, 255, 240))
        ell(d, tt, (x + s * 18 - 5, y - 6, x + s * 18 + 5, y + 3),
            fill=(255, 146, 172, 170))
    arc(d, tt, (x - 7, y - 6, x + 7, y + 6), 20, 160, fill=OUTLINE_BLUE, width=3.0)
    for k in range(3):
        ell(d, tt, (x - 9 + k * 9, y - 62 + abs(k - 1) * 7, x - 3 + k * 9,
                    y - 52 + abs(k - 1) * 7), fill=(198, 230, 255, 235))


def prop_heart(d, t, x, y):
    heart(d, t, x, y, 26, (255, 120, 148, 255))
    heart(d, t, x - 6, y - 6, 10, (255, 186, 200, 235))


def prop_fist(d, t, pt):
    pass                                          # fists are the hand style itself


def prop_thumb(d, t, pt):
    x, y = pt
    ell(d, t, (x - 11, y - 11, x + 11, y + 11), fill=(255, 224, 205, 255), outline=INK, ow=3.0)
    limb(d, t, [(x - 2, y - 8), (x + 2, y - 22)], 8, (255, 224, 205, 255))


def prop_paw(d, t, pt, ch):
    x, y = pt
    ell(d, t, (x - 12, y - 12, x + 12, y + 12), fill=ch['skin'], outline=INK, ow=3.2)
    for k in (-6, 0, 6):
        ell(d, t, (x + k - 3, y - 10, x + k + 3, y - 2), fill=(255, 176, 190, 255), outline=None)


def prop_coffee(d, t, x, y):
    rrect(d, t, (x - 13, y - 6, x + 13, y + 26), 4, fill=(250, 248, 244, 255), outline=INK, ow=3.0)
    rrect(d, t, (x - 15, y - 12, x + 15, y + 2), 4, fill=(120, 84, 66, 255), outline=INK, ow=3.0)
    rrect(d, t, (x - 9, y + 2, x + 9, y + 14), 2, fill=(196, 150, 116, 255), outline=None)
    for i, dx in enumerate((-7, 0, 7)):
        arc(d, t, (x + dx - 6, y - 30, x + dx + 6, y - 12), 200, 340, fill=(230, 226, 220, 200), width=2.4)


def prop_milktea(d, t, x, y):
    rrect(d, t, (x - 14, y - 8, x + 14, y + 32), 5, fill=(240, 226, 208, 255), outline=INK, ow=3.0)
    rrect(d, t, (x - 16, y - 14, x + 16, y + 2), 5, fill=(250, 244, 238, 255), outline=INK, ow=3.0)
    rrect(d, t, (x - 11, y + 6, x + 11, y + 26), 4, fill=(206, 164, 122, 255), outline=None)
    for dx, dy in ((-6, 24), (0, 28), (6, 22), (-3, 18), (3, 30)):
        ell(d, t, (x + dx - 3, y + dy - 3, x + dx + 3, y + dy + 3), fill=(80, 62, 58, 255), outline=None)
    limb(d, t, [(x + 4, y - 14), (x + 16, y + 6)], 5, (244, 150, 160, 255))


def prop_melon(d, t, x, y):
    # a watermelon wedge, bite taken out of the top
    d.polygon([t.pt(a, b) for a, b in
               [(x - 26, y + 12), (x + 26, y + 12), (x + 22, y + 2), (x - 22, y + 2)]],
              fill=(244, 246, 240, 255))
    d.polygon([t.pt(a, b) for a, b in [(x - 26, y + 12), (x + 26, y + 12), (x + 6, y + 34), (x - 6, y + 34)]],
              fill=(240, 244, 238, 255))
    d.polygon([t.pt(a, b) for a, b in [(x - 22, y + 12), (x + 22, y + 12), (x + 5, y + 30), (x - 5, y + 30)]],
              fill=(226, 88, 96, 255))
    d.polygon([t.pt(a, b) for a, b in [(x - 22, y + 12), (x + 22, y + 12), (x + 20, y + 8), (x - 20, y + 8)]],
              fill=(150, 206, 128, 255))
    for dx, dy in ((-10, 16), (10, 16), (0, 22)):
        ell(d, t, (x + dx - 2, y + dy - 3, x + dx + 2, y + dy + 3), fill=(70, 52, 48, 255), outline=None)
    d.line([t.pt(x - 26, y + 12), t.pt(x + 26, y + 12)], fill=INK, width=t.w(2.6))
    d.line([t.pt(x - 26, y + 12), t.pt(x - 6, y + 34)], fill=INK, width=t.w(2.6))
    d.line([t.pt(x + 26, y + 12), t.pt(x + 6, y + 34)], fill=INK, width=t.w(2.6))


def prop_board(d, t, x, y):
    rrect(d, t, (x - 22, y - 30, x + 22, y + 26), 4, fill=(250, 250, 246, 255), outline=INK, ow=3.2)
    rrect(d, t, (x - 8, y - 36, x + 8, y - 24), 3, fill=(150, 156, 168, 255), outline=INK, ow=2.6)
    for i, w in enumerate((30, 34, 26, 32)):
        d.line([t.pt(x - 15, y - 16 + i * 10), t.pt(x - 15 + w, y - 16 + i * 10)], fill=(96, 108, 138, 255), width=t.w(3.0))
    ell(d, t, (x + 6, y + 12, x + 18, y + 24), fill=(120, 200, 244, 255), outline=None)


def prop_hologram(d, t, x, y):
    for i, (w, h, a) in enumerate(((34, 26, 150), (44, 34, 110), (54, 42, 80))):
        rrect(d, t, (x - w, y - 26 - h + i * 4, x + w, y - 6 + i * 4), 3,
              fill=(120, 206, 246, a), outline=(186, 236, 255, 200), ow=2.4)
    for i, w in enumerate((26, 18, 22)):
        line(d, t, [(x - 12, y - 44 + i * 9), (x - 12 + w, y - 44 + i * 9)],
             fill=(226, 248, 255, 210), width=2.4)
    for i in range(3):
        ell(d, t, (x - 20 - i * 6, y + 8 - i * 5, x + 20 + i * 6, y + 16 + i * 5),
            outline=(140, 214, 248, 150 - i * 35), ow=2.0)


def prop_alert(d, t, x, y):
    poly(d, t, [(x, y - 34), (x + 30, y + 18), (x - 30, y + 18)], fill=(250, 196, 88, 255), outline=INK, ow=3.4)
    rrect(d, t, (x - 4, y - 20, x + 4, y + 2), 2, fill=INK, outline=None)
    ell(d, t, (x - 4, y + 6, x + 4, y + 14), fill=INK, outline=None)


def prop_wine(d, t, x, y):
    d.polygon([t.pt(a, b) for a, b in [(x - 15, y - 26), (x + 15, y - 26), (x + 9, y - 2), (x - 9, y - 2)]],
              fill=(226, 70, 92, 235))
    d.polygon([t.pt(a, b) for a, b in [(x - 15, y - 26), (x + 15, y - 26), (x + 13, y - 20), (x - 13, y - 20)]],
              fill=(246, 140, 156, 225))
    d.line([t.pt(x - 15, y - 26), t.pt(x + 15, y - 26)], fill=(246, 246, 244, 255), width=t.w(3.2))
    d.line([t.pt(x - 15, y - 26), t.pt(x - 9, y - 2)], fill=(246, 246, 244, 255), width=t.w(3.0))
    d.line([t.pt(x + 15, y - 26), t.pt(x + 9, y - 2)], fill=(246, 246, 244, 255), width=t.w(3.0))
    line(d, t, [(x, y - 2), (x, y + 16)], fill=(246, 246, 244, 255), width=3.4)
    line(d, t, [(x - 13, y + 20), (x + 13, y + 20)], fill=(246, 246, 244, 255), width=4.0)
    ell(d, t, (x - 6, y - 20, x + 2, y - 8), fill=(255, 255, 255, 120), outline=None)


def prop_gift(d, t, x, y):
    rrect(d, t, (x - 22, y - 16, x + 22, y + 20), 4, fill=(250, 168, 180, 255), outline=INK, ow=3.2)
    rrect(d, t, (x - 26, y - 26, x + 26, y - 10), 4, fill=(255, 196, 206, 255), outline=INK, ow=3.2)
    rrect(d, t, (x - 5, y - 26, x + 5, y + 20), 2, fill=(255, 226, 150, 255), outline=None)
    for s in (-1, 1):
        ell(d, t, (x + s * 11 - 9, y - 42, x + s * 11 + 9, y - 24), fill=(255, 226, 150, 255), outline=INK, ow=2.4)


def prop_lunch(d, t, x, y):
    rrect(d, t, (x - 24, y - 10, x + 24, y + 22), 5, fill=(86, 130, 172, 255), outline=INK, ow=3.2)
    rrect(d, t, (x - 22, y - 22, x + 22, y - 6), 4, fill=(120, 168, 208, 255), outline=INK, ow=3.0)
    rrect(d, t, (x - 16, y - 2, x + 16, y + 16), 3, fill=(250, 240, 220, 255), outline=None)
    ell(d, t, (x - 9, y + 2, x + 1, y + 10), fill=(240, 140, 120, 255), outline=None)
    for i, dx in enumerate((-10, 0, 10)):
        arc(d, t, (x + dx - 5, y - 44, x + dx + 5, y - 26), 200, 340, fill=(240, 238, 232, 210), width=2.4)


def prop_phone(d, t, x, y):
    rrect(d, t, (x - 13, y - 20, x + 13, y + 20), 5, fill=(64, 60, 72, 255), outline=INK, ow=3.0)
    rrect(d, t, (x - 10, y - 16, x + 10, y + 14), 3, fill=(186, 226, 246, 255), outline=None)
    heart(d, t, x, y - 6, 7, (240, 120, 150, 255))
    ell(d, t, (x - 3, y + 15, x + 3, y + 18), fill=(160, 160, 170, 255), outline=None)


def prop_clapline(d, t, x, y):
    for dx in (-16, 16):
        line(d, t, [(x + dx, y - 22), (x + dx + (8 if dx > 0 else -8), y - 34)],
             fill=(255, 214, 130, 235), width=2.6)


def prop_pat_hand(d, t, x, y):
    """A flipper from outside the frame, patting the mascot's head."""
    px, py = CX + 58, HEAD_CY - HEAD_RY - 14
    col = gl(BODY_BLUE, 0.26)
    limb(d, t, [(px + 36, py - 52), (px, py)], 27, col, OUTLINE_BLUE, 4.0)
    limb(d, t, [(px + 30, py - 46), (px + 4, py - 6)], 10, (255, 255, 255, 95), None, 0)
    ell(d, t, (px - 27, py - 16, px + 23, py + 13), fill=col, outline=OUTLINE_BLUE, ow=3.8)
    soft(d, t, (px - 20, py - 12, px + 2, py + 2), (255, 255, 255, 150))


def prop_tap_hand(d, t, pt):
    """A flipper tip tapping along, for the 'there there' pats."""
    x, y = pt
    col = gl(BODY_BLUE, 0.26)
    ell(d, t, (x - 13, y - 13, x + 13, y + 14), fill=col, outline=OUTLINE_BLUE, ow=3.4)
    for k in (-6, 0, 6):
        limb(d, t, [(x + k, y - 8), (x + k + 3, y - 20)], 4.6, col)
    soft(d, t, (x - 9, y - 10, x + 3, y + 1), (255, 255, 255, 150))


def prop_scanner(d, t, x, y):
    rrect(d, t, (x - 16, y - 14, x + 16, y + 16), 7, fill=(60, 72, 104, 255), outline=INK, ow=3.2)
    ell(d, t, (x - 9, y - 9, x + 9, y + 9), fill=(150, 226, 255, 255), outline=None)
    ell(d, t, (x - 4, y - 5, x + 4, y + 3), fill=(230, 250, 255, 255), outline=None)
    for i, w in enumerate((10, 20, 30)):
        line(d, t, [(x + 20 + i * 10, y - 26 - i * 8), (x + 20 + i * 10, y - 16 - i * 8)],
             fill=(150, 226, 255, 230 - i * 60), width=3.0)


def prop_shield(d, t, x, y):
    pts = [(x - 26, y - 48), (x + 20, y - 36), (x + 22, y + 8), (x, y + 40), (x - 24, y + 10)]
    d.polygon([t.pt(a, b) for a, b in pts], fill=(146, 216, 250, 190))
    d.line([t.pt(a, b) for a, b in pts + [pts[0]]],
           fill=(120, 200, 244, 235), width=t.w(3.0), joint='curve')


def prop_handhold(d, t, x, y):
    """The character holds a smaller hand: two hands clasped."""
    ell(d, t, (x - 12, y - 10, x + 4, y + 12), fill=(255, 224, 205, 255), outline=INK, ow=3.0)
    ell(d, t, (x - 2, y - 8, x + 16, y + 14), fill=(255, 232, 214, 255), outline=INK, ow=3.0)
    limb(d, t, [(x + 12, y + 12), (x + 12, y + 44)], 15, (255, 232, 214, 255))


def prop_coat(d, t, ch):
    """A jacket draped over the mascot's shoulders."""
    col = (122, 158, 236, 255)
    for s in (-1, 1):
        pts = [(CX + s * 16, 126), (CX + s * 72, 150), (CX + s * 78, 236),
               (CX + s * 34, 250)]
        poly(d, t, pts, fill=col, outline=OUTLINE_BLUE, ow=3.4)
        clip(d, t, [pts], lambda dd, k=s: ell(dd, t, (CX + k * 90 - 80, 300 - 80,
                                                     CX + k * 90 + 80, 300 + 80),
                                              fill=sh(col, 0.20)))


def prop_umbrella(d, t, pt):
    """Canopy above the head; the shaft runs from the hand up to it."""
    x, y = pt
    top = 34.0
    box = (t.pt(CX - 88, top - 20), t.pt(CX + 88, top + 52))
    cbox = (box[0][0], box[0][1], box[1][0], box[1][1])
    for i in range(5):
        d.pieslice(cbox, 180 + i * 36, 180 + i * 36 + 36,
                   fill=(226, 92, 108, 255) if i % 2 == 0 else (250, 246, 244, 255))
    d.arc(cbox, 180, 360, fill=INK, width=t.w(3.4))
    line(d, t, [(CX - 88, top + 16), (CX + 88, top + 16)], fill=INK, width=3.2)
    ell(d, t, (CX - 4, top - 4, CX + 4, top + 12), fill=(120, 96, 84, 255), outline=INK, ow=2.4)
    limb(d, t, [(x, y + 6), (CX - 4, top + 12)], 6.5, (120, 96, 84, 255))
    ell(d, t, (x - 7, y - 4, x + 7, y + 10), fill=(255, 226, 208, 255), outline=INK, ow=2.8)


PROPS = {
    'heart': lambda d, t, x, y, spec, ch: prop_heart(d, t, x, y),
    'chibi': lambda d, t, x, y, spec, ch: None,
    'thumb': lambda d, t, x, y, spec, ch: prop_thumb(d, t, (x, y)),
    'paw': lambda d, t, x, y, spec, ch: prop_paw(d, t, (x, y), ch),
    'coffee': lambda d, t, x, y, spec, ch: prop_coffee(d, t, x, y),
    'milktea': lambda d, t, x, y, spec, ch: prop_milktea(d, t, x, y),
    'melon': lambda d, t, x, y, spec, ch: prop_melon(d, t, x, y),
    'board': lambda d, t, x, y, spec, ch: prop_board(d, t, x, y),
    'hologram': lambda d, t, x, y, spec, ch: prop_hologram(d, t, x, y),
    'alert': lambda d, t, x, y, spec, ch: prop_alert(d, t, x, y),
    'wine': lambda d, t, x, y, spec, ch: prop_wine(d, t, x, y),
    'gift': lambda d, t, x, y, spec, ch: prop_gift(d, t, x, y),
    'lunch': lambda d, t, x, y, spec, ch: prop_lunch(d, t, x, y),
    'phone': lambda d, t, x, y, spec, ch: prop_phone(d, t, x, y),
    'clapline': lambda d, t, x, y, spec, ch: prop_clapline(d, t, x, y),
    'pat_hand': lambda d, t, x, y, spec, ch: prop_pat_hand(d, t, x, y),
    'tap_hand': lambda d, t, x, y, spec, ch: prop_tap_hand(d, t, (x, y)),
    'scanner': lambda d, t, x, y, spec, ch: prop_scanner(d, t, x, y),
    'shield': lambda d, t, x, y, spec, ch: prop_shield(d, t, x, y),
    'handhold': lambda d, t, x, y, spec, ch: prop_handhold(d, t, x, y),
    'umbrella': lambda d, t, x, y, spec, ch: prop_umbrella(d, t, (x, y)),
    'fist': lambda d, t, x, y, spec, ch: None,
}


# ============================================================================
# decorations
# ============================================================================
def deco(d, t, names, ch):
    top = HEAD_CY - HEAD_RY
    for name in names:
        if name == 'sparkle':
            for cx, cy, r in ((CX - 84, 96, 11), (CX + 88, 84, 13), (CX + 106, 150, 7), (CX - 100, 150, 7)):
                spark(d, t, cx, cy, r, (255, 240, 170, 235))
        elif name == 'stars':
            for cx, cy, r in ((CX + 84, 62, 12), (CX - 80, 70, 10), (CX + 104, 106, 7)):
                d.polygon([t.pt(a, b) for a, b in star_pts(cx, cy, r)], fill=(255, 246, 198, 255))
        elif name == 'shine':
            for cx, cy, r in ((CX + 92, 116, 13), (CX - 88, 130, 9)):
                spark(d, t, cx, cy, r, (255, 255, 255, 210))
        elif name == 'hearts':
            for cx, cy, r in ((CX - 86, 120, 12), (CX + 88, 104, 13), (CX + 104, 156, 8)):
                heart(d, t, cx, cy, r, (255, 138, 158, 225))
        elif name == 'heart_blush':
            pass
        elif name == 'confetti':
            palette = [(255, 138, 158, 240), (255, 214, 120, 240), (150, 208, 246, 240),
                       (176, 226, 168, 240), (206, 168, 240, 240)]
            spots = ((64, 84), (96, 58), (CX + 96, 70), (CX + 116, 108), (CX + 88, 146),
                     (72, 132), (CX - 118, 96), (CX - 74, 46))
            for i, (cx, cy) in enumerate(spots):
                d.polygon([t.pt(a, b) for a, b in
                           [(cx - 7, cy - 5), (cx + 7, cy - 5), (cx + 6, cy + 5), (cx - 6, cy + 5)]],
                          fill=palette[i % len(palette)])
        elif name == 'petals':
            for cx, cy, r in ((CX + 70, 44, 9), (CX - 96, 108, 8), (CX + 120, 132, 7)):
                ell(d, t, (cx - r, cy - r * 0.6, cx + r, cy + r * 0.6), fill=(255, 196, 214, 220), outline=None)
        elif name == 'tears':
            for s in (-1, 1):
                ell(d, t, (CX + s * 30 - 6, HEAD_CY + 8, CX + s * 30 + 6, HEAD_CY + 26),
                    fill=(124, 194, 248, 235), outline=None)
                ell(d, t, (CX + s * 30 - 5, HEAD_CY + 28, CX + s * 30 + 5, HEAD_CY + 42),
                    fill=(156, 214, 252, 235), outline=None)
                ell(d, t, (CX + s * 30 - 3, HEAD_CY + 11, CX + s * 30 + 1, HEAD_CY + 17),
                    fill=(255, 255, 255, 190), outline=None)
        elif name == 'drops':
            for cx, cy, r in ((CX + 78, 156, 7), (CX - 84, 176, 6)):
                d.polygon([t.pt(cx, cy - r), t.pt(cx + r * 0.8, cy + r * 0.7),
                           t.pt(cx - r * 0.8, cy + r * 0.7)], fill=(150, 208, 244, 220))
        elif name == 'sweat':
            d.polygon([t.pt(CX + 62, 96), t.pt(CX + 74, 118), t.pt(CX + 50, 118)], fill=(158, 212, 246, 235))
            ell(d, t, (CX + 56, 102, CX + 64, 110), fill=(255, 255, 255, 170), outline=None)
        elif name == 'bubbles':
            for cx, cy, r in ((CX - 84, 88, 11), (CX - 100, 60, 7), (CX + 96, 128, 9), (CX + 76, 66, 6)):
                ell(d, t, (cx - r, cy - r, cx + r, cy + r), outline=(140, 210, 240, 235), ow=2.6)
        elif name == 'bubbles_big':
            for cx, cy, r in ((CX + 108, 172, 12), (CX - 112, 152, 10)):
                ell(d, t, (cx - r, cy - r, cx + r, cy + r), outline=(140, 210, 240, 215), ow=2.6)
        elif name == 'spout':
            for dx, dy, r in ((0, -22, 7), (-20, -14, 6), (20, -14, 6), (-36, 4, 5), (36, 4, 5), (0, -40, 5)):
                ell(d, t, (CX + dx - r, top + dy - r, CX + dx + r, top + dy + r),
                    fill=(206, 244, 255, 235), outline=None)
        elif name == 'zzz':
            for cx, cy, size in ((CX + 62, 46, 30), (CX + 92, 30, 20)):
                f = caption_font(int(size * t.s * SS))
                d.text(t.pt(cx, cy), 'Z', font=f, fill=(122, 134, 194, 255))
        elif name == 'moon':
            ell(d, t, (CX + 78, 24, CX + 116, 62), fill=(255, 236, 168, 245), outline=None)
            ell(d, t, (CX + 92, 20, CX + 126, 54), fill=(0, 0, 0, 0), outline=None)
        elif name == 'clock':
            ell(d, t, (CX + 74, 44, CX + 110, 80), fill=(250, 250, 248, 240), outline=(120, 130, 168, 235), ow=2.6)
            line(d, t, [(CX + 92, 62), (CX + 92, 50)], fill=(120, 130, 168, 255), width=2.2)
            line(d, t, [(CX + 92, 62), (CX + 101, 62)], fill=(120, 130, 168, 255), width=2.2)
        elif name == 'steam':
            for cx in (CX - 74, CX + 74):
                for i, dy in enumerate((0, 14, 28)):
                    arc(d, t, (cx - 9, 96 + dy, cx + 9, 116 + dy), 200, 340,
                        fill=(226, 138, 118, 200), width=3.0)
        elif name == 'huff':
            ell(d, t, (CX + 46, HEAD_CY - 54, CX + 92, HEAD_CY - 26), fill=(240, 240, 244, 235), outline=None)
            ell(d, t, (CX + 44, HEAD_CY - 56, CX + 76, HEAD_CY - 30), fill=(240, 240, 244, 235), outline=None)
            for i in range(3):
                line(d, t, [(CX + 40 + i * 8, HEAD_CY - 52), (CX + 56 + i * 8, HEAD_CY - 42)],
                     fill=(176, 176, 190, 220), width=2.6)
        elif name == 'spikes':
            for s in (-1, 1):
                for k in range(3):
                    x = CX + s * (30 + k * 14)
                    poly(d, t, [(x, HEAD_CY - 34), (x + s * 10, HEAD_CY - 56), (x + s * 16, HEAD_CY - 30)],
                         fill=ch['hair'], outline=INK, ow=2.4)
        elif name == 'whiskers':
            for s in (-1, 1):
                for dy in (-6, 6, 18):
                    line(d, t, [(CX + s * 34, HEAD_CY + 18 + dy * 0.6),
                                (CX + s * 70, HEAD_CY + 14 + dy - s * 2)],
                         fill=(150, 156, 200, 190), width=2.2)
        elif name == 'shock_lines':
            for ang in (-66, -22, 22, 66):
                rad = math.radians(ang)
                x0 = CX + 88 * math.sin(rad)
                y0 = HEAD_CY - 70 * math.cos(rad)
                line(d, t, [(x0, y0), (x0 + 16 * math.sin(rad), y0 - 16 * math.cos(rad))],
                     fill=(240, 190, 120, 235), width=3.4)
        elif name == 'exclaim':
            for cx, cy in ((CX - 92, 56), (CX + 96, 60)):
                rrect(d, t, (cx - 4, cy - 18, cx + 4, cy + 4), 2, fill=(244, 150, 96, 245), outline=None)
                ell(d, t, (cx - 4, cy + 9, cx + 4, cy + 17), fill=(244, 150, 96, 245), outline=None)
        elif name == 'alert_lines':
            for s in (-1, 1):
                for k in range(3):
                    line(d, t, [(CX + s * (58 + k * 10), HEAD_CY - 40 - k * 12),
                                (CX + s * (76 + k * 10), HEAD_CY - 52 - k * 12)],
                         fill=(250, 180, 96, 235), width=3.2)
        elif name == 'ellipsis':
            for i in range(3):
                ell(d, t, (CX + 52 + i * 15, HEAD_CY - 64, CX + 60 + i * 15, HEAD_CY - 56),
                    fill=(140, 148, 172, 235), outline=None)
        elif name == 'motion_dots':
            for dy in (-16, 0, 16):
                ell(d, t, (CX + 92, 140 + dy - 4, CX + 100, 140 + dy + 4), fill=(150, 180, 220, 225), outline=None)
        elif name == 'motion_side':
            for s in (-1, 1):
                for dy in (-18, 0, 18):
                    line(d, t, [(CX + s * 78 - 9, 128 + dy), (CX + s * 78 + 9, 128 + dy)],
                         fill=(160, 168, 214, 220), width=3.0)
        elif name == 'motion_arcs':
            for i in range(3):
                arc(d, t, (CX - 78 - i * 12, 168 - i * 10, CX - 18, 226 + i * 10), 240, 360,
                    fill=(150, 180, 220, 150 - i * 40), width=2.6)
        elif name == 'nod_arc':
            arc(d, t, (CX - 62, HEAD_CY - 6, CX + 62, HEAD_CY + 70), 30, 150,
                fill=(150, 180, 220, 200), width=3.0)
        elif name == 'wave_arc':
            for i in range(3):
                arc(d, t, (CX + 86 + i * 14, 30 - i * 6, CX + 130 + i * 16, 96 + i * 6), 300, 60,
                    fill=(150, 180, 220, 200 - i * 50), width=2.8)
        elif name == 'pat_arc':
            for i in range(3):
                arc(d, t, (CX + 34, HEAD_CY + 6 + i * 8, CX + 120, HEAD_CY + 60 + i * 8), 250, 10,
                    fill=(255, 190, 150, 210 - i * 50), width=2.8)
        elif name == 'stroke_arc':
            for i in range(2):
                arc(d, t, (CX + 6, HEAD_CY - 34 + i * 12, CX + 92, HEAD_CY + 30 + i * 12), 260, 20,
                    fill=(255, 214, 190, 200 - i * 60), width=2.6)
        elif name == 'talk_lines':
            for i, dx in enumerate((50, 62, 50)):
                line(d, t, [(CX + dx, HEAD_CY - 30 + i * 16), (CX + dx + 16, HEAD_CY - 34 + i * 16)],
                     fill=(150, 180, 220, 210), width=2.8)
        elif name == 'sound_waves':
            for i in range(3):
                arc(d, t, (CX + 90 - i * 12, HEAD_CY - 26 + i * 8, CX + 128 + i * 8, HEAD_CY + 34 + i * 8),
                    300, 60, fill=(150, 180, 220, 205 - i * 55), width=2.8)
        elif name == 'throw_lines':
            for i, dy in enumerate((-26, -6, 14)):
                line(d, t, [(CX + 46 + i * 6, 128 + dy), (CX + 92 + i * 6, 126 + dy)],
                     fill=(150, 180, 220, 210), width=2.8)
        elif name == 'speed_lines':
            for s in (-1, 1):
                for dy in (-14, 4, 22):
                    line(d, t, [(CX + s * 66, 108 + dy), (CX + s * 74, 96 + dy)],
                         fill=(255, 214, 130, 200), width=2.6)
        elif name == 'impact':
            for ang in range(0, 360, 45):
                rad = math.radians(ang)
                x0 = CX + 40 * math.cos(rad)
                y0 = 118 + 40 * math.sin(rad)
                line(d, t, [(x0, y0), (x0 + 22 * math.cos(rad), y0 + 22 * math.sin(rad))],
                     fill=(255, 206, 120, 225), width=3.2)
        elif name == 'protect_lines':
            for i in range(3):
                arc(d, t, (CX + 30, 92 + i * 16, CX + 120, 180 + i * 16), 250, 20,
                    fill=(150, 214, 248, 200 - i * 55), width=2.8)
        elif name == 'support_lines':
            for s in (-1, 1):
                for i in range(2):
                    line(d, t, [(CX + s * (66 + i * 12), 244 + i * 14), (CX + s * (58 + i * 12), 262 + i * 14)],
                         fill=(255, 206, 150, 210), width=2.8)
        elif name == 'tap_lines':
            for i in range(2):
                arc(d, t, (CX + 44, 196 + i * 10, CX + 108, 240 + i * 10), 220, 340,
                    fill=(255, 206, 150, 205 - i * 70), width=2.6)
        elif name == 'sway':
            for i in range(2):
                arc(d, t, (CX - 96 + i * 8, 200, CX - 66 + i * 8, 320), 120, 240,
                    fill=(150, 180, 220, 170 - i * 60), width=2.6)
        elif name == 'tail_arc':
            for i in range(2):
                arc(d, t, (CX + 46 + i * 10, 196 + i * 8, CX + 128 + i * 10, 300 + i * 8), 200, 20,
                    fill=(150, 180, 220, 190 - i * 60), width=2.8)
        elif name == 'scan_grid':
            for i in range(5):
                y = 40 + i * 18
                line(d, t, [(CX - 72, y), (CX + 72, y)], fill=(150, 226, 255, 110), width=1.6)
            for i in range(5):
                x = CX - 64 + i * 32
                line(d, t, [(x, 40), (x, 128)], fill=(150, 226, 255, 110), width=1.6)
        elif name == 'holo_rings':
            for i in range(3):
                ell(d, t, (CX - 46 - i * 12, 168 + i * 14, CX + 46 + i * 12, 190 + i * 14),
                    outline=(140, 214, 248, 190 - i * 45), ow=2.4)
        elif name == 'kiss_mark':
            heart(d, t, CX + 62, HEAD_CY - 30, 11, (255, 126, 148, 235))
            for i in range(2):
                arc(d, t, (CX + 74 + i * 8, HEAD_CY - 46 - i * 6, CX + 104 + i * 10, HEAD_CY - 20 + i * 6),
                    300, 60, fill=(255, 178, 194, 190 - i * 70), width=2.4)
        elif name == 'music_notes':
            for cx, cy in ((CX + 78, 62), (CX + 102, 44)):
                ell(d, t, (cx - 8, cy + 8, cx + 2, cy + 16), fill=(150, 180, 220, 225), outline=None)
                line(d, t, [(cx, cy + 12), (cx, cy - 8), (cx + 10, cy - 12)],
                     fill=(150, 180, 220, 225), width=2.6)
        elif name == 'seeds':
            pass
        elif name == 'rain':
            for cx, cy in ((CX - 100, 60), (CX - 78, 96), (CX - 112, 118), (CX + 108, 70),
                           (CX + 92, 112), (CX + 118, 142)):
                d.polygon([t.pt(cx, cy), t.pt(cx + 5, cy + 16), t.pt(cx - 5, cy + 16)],
                          fill=(150, 208, 244, 215))
        elif name == 'warm':
            for cx, cy in ((CX - 96, 108), (CX + 100, 100), (CX - 88, 176), (CX + 94, 180)):
                arc(d, t, (cx - 14, cy - 14, cx + 14, cy + 14), 200, 340,
                    fill=(255, 190, 130, 190), width=3.0)
        else:
            warn_once(f'unknown decoration {name!r}')


# ============================================================================
# body / head assembly
# ============================================================================
def draw_ledge(d, t, box):
    """A low wall / desk edge the character leans on, hands resting on top."""
    x0, y0, x1, y1 = box
    poly(d, t, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)],
         fill=(150, 174, 226, 255), outline=INK, ow=3.6)
    poly(d, t, [(x0, y0), (x1, y0), (x1, y0 + 12), (x0, y0 + 12)],
         fill=(228, 238, 255, 255), outline=None)
    line(d, t, [(x0 + 5, y0 + 12), (x1 - 5, y0 + 12)], fill=(104, 128, 190, 255), width=2.4)
    for i in range(3):
        x = x0 + 88 + i * 88
        line(d, t, [(x, y0 + 24), (x, y1)], fill=(126, 150, 208, 255), width=2.0)
        poly(d, t, [(x - 14, y0 + 54), (x + 14, y0 + 54), (x + 14, y0 + 84),
                    (x - 14, y0 + 84)], fill=(140, 164, 218, 255), outline=None)


def draw_prop(d, t, ch, spec, layer):
    """The pose's prop: layer='back' tucks it behind the flippers, 'hand' puts it in one."""
    prop = spec['prop']
    if layer == 'back':
        if prop == 'coat':
            prop_coat(d, t, ch)
        elif prop == 'chibi':
            prop_chibi(d, t, spec, ch)
        return
    if prop in PROPS and prop not in ('chibi', 'pat_hand', 'umbrella', 'fist'):
        hand = spec['hand']
        targets = [1, -1] if hand == 'both' else ([1] if hand == 'R' else [-1])
        for side in targets:
            _, _, hd = arm_geom(spec['arms'][0] if side == 1 else spec['arms'][1], side)
            PROPS[prop](d, t, hd[0], hd[1], spec, ch)
    if prop == 'umbrella':
        _, _, hd = arm_geom(spec['arms'][0], 1)
        prop_umbrella(d, t, hd)
    if prop == 'pat_hand':
        prop_pat_hand(d, t, 0, 0)


def draw_figure(d, t, ch, spec):
    """Everything on the canvas except the caption band."""
    # the head rides on its own offset, so a pose can tilt or turn it
    th = T(t.s, t.rot, t.dx + spec['hdx'], t.dy + spec['hdy'])

    # 1. behind the body: the cat tail, then the fins and the fluke
    if 'cat_tail' in ch['acc']:
        draw_cat_tail(d, t, ch)

    # 2. the body, then the props that sit behind the flippers
    draw_body(d, t, ch)
    draw_prop(d, t, ch, spec, 'back')

    # 3. head, face, then the outfit that goes over both
    draw_head(d, th, ch)
    draw_face(d, th, ch, spec)
    draw_head_accessories(d, th, ch)

    # 4. the ledge the whale leans on: hides the lower body, flippers rest on its rim
    if spec['ledge']:
        draw_ledge(d, t, spec['ledge'])

    # 5. flippers in front of the body, then whatever they hold
    draw_arms(d, t, ch, spec)
    draw_prop(d, t, ch, spec, 'hand')

    # 6. decorations
    deco(d, t, spec['deco'], ch)

def draw_caption(d, caption, display):
    size = int(40 * SS)
    f = caption_font(size)
    label = caption if FONT_PATH else display
    box = d.textbbox((0, 0), label, font=f)
    tw = box[2] - box[0]
    th = box[3] - box[1]
    pad_x = int(22 * SS)
    pad_y = int(9 * SS)
    bw = tw + pad_x * 2
    bh = th + pad_y * 2
    x0 = (CW - bw) / 2
    y0 = 352 * SS
    r = bh / 2
    d.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=r, fill=(28, 40, 96, 200))
    d.text((x0 + pad_x - box[0], y0 + pad_y - box[1]), label, font=f, fill=(255, 255, 255, 255))


def render(spec):
    ch = CHARACTERS[spec['mode']]
    t = T(s=ch['scale'], rot=spec['lean'], dx=spec['dx'], dy=spec['dy'])
    img = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    d = Canvas(img)

    draw_figure(d, t, ch, spec)

    # a wall the character peeks out from, and a ledge it leans on
    if spec['wall']:
        x0, y0, x1, y1 = spec['wall']
        poly(d, t, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], fill=(150, 174, 226, 255), outline=INK, ow=3.6)
        for i in range(6):
            y = y0 + 20 + i * 48
            line(d, t, [(x0 + 8, y), (x1 - 8, y)], fill=(126, 150, 208, 255), width=2.4)
        poly(d, t, [(x1, y0), (x1 - 22, y0), (x1 - 22, y1), (x1, y1)],
             fill=(228, 238, 255, 255), outline=None)
        line(d, t, [(x1, y0), (x1, y1)], fill=INK, width=3.6)
    draw_caption(d, spec['caption'], spec['id'])

    return img.resize((W, H), Image.LANCZOS)


# ============================================================================
# main
# ============================================================================
def main(argv):
    global FONT_PATH
    FONT_PATH = find_font()
    if FONT_PATH:
        print(f'font: {FONT_PATH}')
    else:
        warn_once('no CJK font found (tried Hiragino Sans GB / PingFang / Noto CJK); '
                  'captions will show the English sticker id')

    only = None
    if '--only' in argv:
        i = argv.index('--only')
        if i + 1 >= len(argv):
            print('usage: make-stickers.py [--only <id>]', file=sys.stderr)
            return 2
        only = argv[i + 1]

    by_id = {p['id']: p for p in POSES}
    if len(by_id) != len(POSES):
        dupes = sorted({p['id'] for p in POSES if [q['id'] for q in POSES].count(p['id']) > 1})
        print(f'error: duplicate sticker ids: {dupes}', file=sys.stderr)
        return 2

    if only is not None:
        if only not in by_id:
            print(f'error: unknown sticker id {only!r}', file=sys.stderr)
            print(f'known ids: {", ".join(by_id)}', file=sys.stderr)
            return 2
        todo = [by_id[only]]
    else:
        todo = POSES

    os.makedirs(OUT, exist_ok=True)
    for spec in todo:
        img = render(spec)
        path = os.path.join(OUT, f"{spec['id']}.png")
        img.save(path, optimize=True)
        print(f'{path} {os.path.getsize(path)} bytes')
    print(f'wrote {len(todo)} files')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))