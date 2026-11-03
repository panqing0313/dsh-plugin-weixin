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
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
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
HEAD_CY = 91.0
HEAD_RX = 38.0
HEAD_RY = 43.0              # head is 86 tall; body is ~202 -> ratio 1:2.35
NECK_Y = 133.0
SHOULDER_Y = 144.0
SHOULDER_X = 50.0           # half distance between shoulder joints
WAIST_Y = 234.0
WAIST_X = 33.0
HIP_Y = 262.0
HIP_X = 44.0
FOOT_X = 17.0

# --- palette -----------------------------------------------------------------
INK = (54, 46, 42, 255)
HAIR_INK = (44, 36, 40, 255)
SHADE_A = (40, 30, 34, 40)      # right-side shading, translucent
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
# skin, hair, hair2, style, top, top2 (accent/cuff), bottom, shoe, acc, scale, bottom_kind
CHARACTERS = {
    # The shared packs are available in every mode, so they belong to no mode:
    # a neutral companion in a mint top with a soft brown bob.
    'default': dict(
        label='通用', skin=(255, 224, 205, 255), hair=(96, 76, 66, 255), hair2=None,
        style='bob', top=(150, 214, 190, 255), top2=(120, 182, 160, 255),
        bottom=(108, 138, 186, 255), shoe=(84, 70, 66, 255), acc=[], scale=1.0,
        bottom_kind='pants', sleeve='long', lip=None),

    'neko': dict(
        label='猫娘', skin=(255, 228, 212, 255), hair=(178, 152, 232, 255), hair2=(226, 196, 246, 255),
        style='bob', top=(198, 204, 250, 255), top2=(160, 166, 224, 255),
        bottom=(112, 106, 152, 255), shoe=(74, 66, 100, 255),
        acc=['cat_ears', 'cat_tail', 'whiskers', 'fangs'], scale=0.985,
        bottom_kind='pants', sleeve='long', lip=None),

    'whale-girl': dict(
        label='鲸鱼娘', skin=(255, 232, 218, 255), hair=(118, 190, 236, 255), hair2=(176, 224, 248, 255),
        style='bob', top=(190, 232, 248, 255), top2=(142, 200, 228, 255),
        bottom=(86, 142, 180, 255), shoe=(70, 106, 140, 255),
        acc=['whale_hood', 'drop', 'blowhole'], scale=0.985,
        bottom_kind='pants', sleeve='long', lip=None),

    'daughter': dict(
        label='闺女', skin=(255, 230, 216, 255), hair=(228, 168, 122, 255), hair2=(250, 206, 168, 255),
        style='twin_tails', top=(255, 205, 218, 255), top2=(250, 240, 240, 255),
        bottom=(170, 196, 232, 255), shoe=(228, 120, 140, 255),
        acc=['bow', 'round_cheeks'], scale=0.84,
        bottom_kind='dress', sleeve='puff', lip=None),

    'girlfriend': dict(
        label='女友', skin=(255, 226, 210, 255), hair=(76, 56, 52, 255), hair2=(122, 88, 78, 255),
        style='long_straight', top=(250, 214, 208, 255), top2=(232, 186, 182, 255),
        bottom=(168, 150, 188, 255), shoe=(150, 122, 140, 255),
        acc=['earring', 'knit'], scale=0.99,
        bottom_kind='skirt', sleeve='long', lip=None),

    'boyfriend': dict(
        label='男友', skin=(255, 226, 202, 255), hair=(52, 44, 50, 255), hair2=(96, 86, 92, 255),
        style='short', top=(142, 178, 216, 255), top2=(112, 146, 186, 255),
        bottom=(70, 76, 100, 255), shoe=(48, 44, 52, 255),
        acc=['collar'], scale=1.03,
        bottom_kind='pants', sleeve='long', lip=None),

    'friend': dict(
        label='朋友', skin=(255, 226, 200, 255), hair=(100, 76, 60, 255), hair2=(140, 110, 88, 255),
        style='messy', top=(126, 198, 180, 255), top2=(246, 246, 244, 255),
        bottom=(96, 106, 124, 255), shoe=(238, 238, 236, 255),
        acc=['cap', 'hood'], scale=1.0,
        bottom_kind='pants', sleeve='short', lip=None),

    'jarvis': dict(
        label='贾维斯', skin=(250, 228, 208, 255), hair=(44, 42, 58, 255), hair2=(86, 92, 120, 255),
        style='slick', top=(40, 48, 70, 255), top2=(122, 200, 244, 255),
        bottom=(32, 38, 56, 255), shoe=(28, 30, 44, 255),
        acc=['suit', 'bowtie', 'glow', 'headset'], scale=1.0,
        bottom_kind='pants', sleeve='long', lip=None),

    'oneesan': dict(
        label='御姐', skin=(255, 224, 208, 255), hair=(58, 44, 48, 255), hair2=(96, 74, 78, 255),
        style='wavy_long', top=(200, 74, 92, 255), top2=(246, 240, 240, 255),
        bottom=(62, 56, 68, 255), shoe=(150, 62, 76, 255),
        acc=['lapel', 'earring', 'heels'], scale=1.0,
        bottom_kind='skirt', sleeve='long', lip=(226, 74, 92, 255)),

    'big-sister': dict(
        label='大姐姐', skin=(255, 228, 208, 255), hair=(112, 72, 54, 255), hair2=(160, 116, 90, 255),
        style='low_ponytail', top=(240, 198, 152, 255), top2=(214, 168, 124, 255),
        bottom=(208, 168, 128, 255), shoe=(150, 116, 92, 255),
        acc=['knit'], scale=1.0,
        bottom_kind='long_skirt', sleeve='long', lip=None),

    'warm-guy': dict(
        label='暖男', skin=(255, 228, 204, 255), hair=(84, 66, 58, 255), hair2=(130, 106, 92, 255),
        style='soft_short', top=(222, 172, 122, 255), top2=(196, 146, 100, 255),
        bottom=(122, 112, 106, 255), shoe=(92, 74, 64, 255),
        acc=['scarf', 'glasses'], scale=1.01,
        bottom_kind='pants', sleeve='long', lip=None),

    'tsundere': dict(
        label='傲娇', skin=(255, 226, 208, 255), hair=(242, 214, 150, 255), hair2=(240, 140, 172, 255),
        style='two_tone', top=(242, 242, 246, 255), top2=(96, 120, 172, 255),
        bottom=(74, 78, 108, 255), shoe=(88, 76, 84, 255),
        acc=['tie', 'collar'], scale=0.97,
        bottom_kind='skirt', sleeve='long', lip=None),
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
    'clap': dict(t1=-10, t2=-125, l1=42, l2=42),
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
def draw_legs(d, t, ch):
    top = ch['top']
    bottom = ch['bottom']
    kind = ch['bottom_kind']
    skin = ch['skin']
    shoe = ch['shoe']

    if kind in ('skirt', 'dress', 'long_skirt'):
        hem = {'skirt': 300.0, 'dress': 296.0, 'long_skirt': 322.0}[kind]
        spread = {'skirt': 54.0, 'dress': 52.0, 'long_skirt': 44.0}[kind]
        # bare legs under the hem
        for s in (-1, 1):
            limb(d, t, [(CX + s * 15, 268), (CX + s * 16, 322)], 15, skin)
        for s in (-1, 1):
            ell(d, t, (CX + s * 16 - 15, 320, CX + s * 16 + 15, 340), fill=shoe, outline=INK)
        if kind == 'dress':
            body_pts = [(CX - WAIST_X, WAIST_Y - 2), (CX + WAIST_X, WAIST_Y - 2),
                        (CX + 30, 200), (CX - 30, 200)]
            ink_shape(d, t, body_pts, ch['top2'],
                      shade_pts=[(CX + 8, 200), (CX + 30, 200), (CX + 30, 300), (CX + 8, 300)][::-1])
        skirt_pts = [(CX - WAIST_X, WAIST_Y - 4), (CX + WAIST_X, WAIST_Y - 4),
                     (CX + spread, hem), (CX - spread, hem)]
        ink_shape(d, t, skirt_pts, ch['top'],
                  shade_pts=[(CX + 6, WAIST_Y), (CX + WAIST_X, WAIST_Y),
                             (CX + spread, hem), (CX + 6, hem)],
                  light_pts=[(CX - WAIST_X + 8, WAIST_Y + 6), (CX - 12, WAIST_Y + 6),
                             (CX - 20, hem - 6), (CX - spread + 6, hem - 6)])
    else:
        if kind == 'pants':
            for s in (-1, 1):
                limb(d, t, [(CX + s * 16, 238), (CX + s * 17, 322)], 26, bottom)
            for s in (-1, 1):
                rrect(d, t, (CX + s * 17 - 19, 318, CX + s * 17 + 17, 340), 8,
                      fill=shoe, outline=INK)
        if kind == 'dress':
            pass


def draw_torso(d, t, ch):
    top = ch['top']
    top2 = ch['top2']
    kind = ch['bottom_kind']
    if kind == 'dress':
        return                                   # the dress covers the whole torso
    if kind == 'long_skirt':
        bottom = ch['bottom']
        pts = [(CX - SHOULDER_X + 2, SHOULDER_Y - 6), (CX + SHOULDER_X - 2, SHOULDER_Y - 6),
               (CX + WAIST_X, WAIST_Y), (CX + 40, 340), (CX - 40, 340), (CX - WAIST_X, WAIST_Y)]
        ink_shape(d, t, pts, top,
                  shade_pts=[(CX + 8, SHOULDER_Y), (CX + SHOULDER_X - 2, SHOULDER_Y - 6),
                             (CX + WAIST_X, WAIST_Y), (CX + 40, 340), (CX + 8, 340)],
                  light_pts=[(CX - SHOULDER_X + 12, SHOULDER_Y), (CX - 16, SHOULDER_Y),
                             (CX - WAIST_X + 6, WAIST_Y), (CX - 22, 338), (CX - 38, 338)])
        # sleeve caps read as a knit cardigan
        for s in (-1, 1):
            arc(d, t, (CX + s * SHOULDER_X - 22, SHOULDER_Y - 8, CX + s * SHOULDER_X + 22, SHOULDER_Y + 30),
                0, 360, fill=top2, width=3.0)
        return

    pts = [(CX - 15, SHOULDER_Y - 16), (CX - SHOULDER_X, SHOULDER_Y + 4),
           (CX - WAIST_X - 2, WAIST_Y), (CX + WAIST_X + 2, WAIST_Y),
           (CX + SHOULDER_X, SHOULDER_Y + 4), (CX + 15, SHOULDER_Y - 16)]
    light = [(CX - 15, SHOULDER_Y - 12), (CX - SHOULDER_X + 12, SHOULDER_Y + 6),
             (CX - 16, WAIST_Y - 4), (CX - WAIST_X + 4, WAIST_Y - 4)]
    shade = [(CX + 12, SHOULDER_Y + 2), (CX + SHOULDER_X, SHOULDER_Y + 4),
             (CX + WAIST_X + 2, WAIST_Y), (CX + 12, WAIST_Y)]
    ink_shape(d, t, pts, top, shade_pts=shade, light_pts=light)

    # neckline: a shallow skin-coloured V, plus a collar band when the character wears one
    poly(d, t, [(CX - 14, SHOULDER_Y - 14), (CX, SHOULDER_Y + 6), (CX + 14, SHOULDER_Y - 14)],
         fill=ch['skin'], outline=None)
    if 'collar' in ch['acc'] or 'suit' in ch['acc'] or 'tie' in ch['acc']:
        poly(d, t, [(CX - 16, SHOULDER_Y - 16), (CX - 2, SHOULDER_Y + 8), (CX + 2, SHOULDER_Y + 8),
                    (CX + 16, SHOULDER_Y - 16), (CX + 16, SHOULDER_Y - 22), (CX - 16, SHOULDER_Y - 22)],
             fill=top2, outline=None)

    if kind == 'skirt':
        skirt = [(CX - WAIST_X + 2, WAIST_Y - 2), (CX + WAIST_X - 2, WAIST_Y - 2),
                 (CX + 56, 302), (CX - 56, 302)]
        ink_shape(d, t, skirt, ch['bottom'],
                  shade_pts=[(CX + 8, WAIST_Y), (CX + WAIST_X, WAIST_Y), (CX + 56, 302), (CX + 8, 302)],
                  light_pts=[(CX - WAIST_X + 6, WAIST_Y + 6), (CX - 14, WAIST_Y + 6),
                             (CX - 40, 296), (CX - 54, 296)])
    elif kind == 'pants':
        hip = [(CX - WAIST_X - 2, WAIST_Y - 2), (CX + WAIST_X + 2, WAIST_Y - 2),
               (CX + HIP_X, HIP_Y + 14), (CX - HIP_X, HIP_Y + 14)]
        ink_shape(d, t, hip, ch['bottom'],
                  shade_pts=[(CX + 10, WAIST_Y), (CX + WAIST_X + 2, WAIST_Y),
                             (CX + HIP_X, HIP_Y + 14), (CX + 10, HIP_Y + 14)])

    acc = ch['acc']
    if 'suit' in acc:
        for s in (-1, 1):
            poly(d, t, [(CX + s * 12, SHOULDER_Y - 6), (CX + s * 40, SHOULDER_Y - 4),
                        (CX + s * 30, SHOULDER_Y + 62), (CX + s * 10, SHOULDER_Y + 40)],
                 fill=lighten(top, 0.10), outline=None)
            line(d, t, [(CX + s * 30, SHOULDER_Y + 4), (CX + s * 26, SHOULDER_Y + 58)],
                 fill=lighten(top, 0.22), width=2.0)
    if 'tie' in acc:
        poly(d, t, [(CX - 8, SHOULDER_Y - 2), (CX + 8, SHOULDER_Y - 2),
                    (CX + 6, SHOULDER_Y + 14), (CX, SHOULDER_Y + 26), (CX - 6, SHOULDER_Y + 14)],
             fill=ch['top2'], outline=None)
    if 'lapel' in acc:
        for s in (-1, 1):
            poly(d, t, [(CX + s * 10, SHOULDER_Y - 6), (CX + s * 36, SHOULDER_Y - 2),
                        (CX + s * 26, SHOULDER_Y + 56), (CX + s * 8, SHOULDER_Y + 30)],
                 fill=ch['top2'], outline=None)
    if 'knit' in acc:
        for y in range(int(SHOULDER_Y) + 16, int(WAIST_Y) - 6, 14):
            line(d, t, [(CX - WAIST_X + 8, y), (CX + WAIST_X - 8, y)],
                 fill=dark(top, 0.10), width=1.6)
    if 'pocket' in acc or True:
        pass
    if 'buttons' in acc:
        for y in range(int(SHOULDER_Y) + 14, int(WAIST_Y) - 10, 22):
            ell(d, t, (CX - 4, y - 4, CX + 4, y + 4), fill=dark(top, 0.30), outline=None)
    if 'scarf' in acc:
        ink_shape(d, t, [(CX - 30, NECK_Y - 4), (CX + 30, NECK_Y - 4),
                         (CX + 26, NECK_Y + 20), (CX - 26, NECK_Y + 20)],
                  (208, 118, 110, 255),
                  shade_pts=[(CX + 8, NECK_Y), (CX + 30, NECK_Y), (CX + 26, NECK_Y + 20), (CX + 8, NECK_Y + 20)])
        poly(d, t, [(CX + 14, NECK_Y + 16), (CX + 30, NECK_Y + 18), (CX + 26, NECK_Y + 54),
                    (CX + 12, NECK_Y + 48)], fill=(230, 138, 128, 255), outline=INK, ow=2.6)


def draw_neck(d, t, ch):
    limb(d, t, [(CX, NECK_Y - 10), (CX, NECK_Y + 14)], 21, ch['skin'])


# ============================================================================
# head, hair, accessories
# ============================================================================
def draw_hair_back(d, t, ch):
    style = ch['style']
    hair = ch['hair']
    hair2 = ch['hair2'] or dark(hair, 0.14)
    # skull-hugging cap: the hairline follows the cranium instead of a straight band
    short = style in ('short', 'messy', 'slick', 'soft_short')
    cap_rx = HEAD_RX + (4.0 if short else 7.0)
    cap_bot = HEAD_CY + (HEAD_RY * 0.28 if short else HEAD_RY * 0.60)
    ell(d, t, (CX - cap_rx, HEAD_CY - HEAD_RY - 6, CX + cap_rx, cap_bot),
        fill=hair, outline=INK, ow=3.2)
    if style == 'long_straight':
        ink_shape(d, t, [(CX - 48, HEAD_CY - 8), (CX + 48, HEAD_CY - 8),
                         (CX + 56, 210), (CX + 40, 236), (CX - 40, 236), (CX - 56, 210)],
                  hair, shade_pts=[(CX + 14, HEAD_CY), (CX + 48, HEAD_CY - 8),
                                   (CX + 56, 210), (CX + 40, 236), (CX + 14, 236)],
                  light_pts=[(CX - 44, HEAD_CY + 4), (CX - 20, HEAD_CY + 4),
                             (CX - 24, 230), (CX - 50, 226)])
        for s in (-1, 1):
            line(d, t, [(CX + s * 34, HEAD_CY + 30), (CX + s * 42, 212)], fill=hair2, width=2.4)
    elif style == 'wavy_long':
        ink_shape(d, t, [(CX - 50, HEAD_CY - 10), (CX + 50, HEAD_CY - 10),
                         (CX + 60, 160), (CX + 44, 186), (CX + 58, 214),
                         (CX + 38, 242), (CX - 38, 242), (CX - 58, 214),
                         (CX - 44, 186), (CX - 60, 160)],
                  hair, shade_pts=[(CX + 16, HEAD_CY), (CX + 50, HEAD_CY - 10),
                                   (CX + 60, 160), (CX + 58, 214), (CX + 38, 242), (CX + 16, 242)])
    elif style == 'twin_tails':
        for s in (-1, 1):
            ink_shape(d, t, [(CX + s * 34, HEAD_CY - 6), (CX + s * 62, HEAD_CY + 16),
                             (CX + s * 70, 148), (CX + s * 52, 168), (CX + s * 40, HEAD_CY + 30)],
                      hair, shade_pts=[(CX + s * 52, HEAD_CY + 8), (CX + s * 70, 148),
                                       (CX + s * 52, 168), (CX + s * 48, HEAD_CY + 34)])
            ell(d, t, (CX + s * 58 - 11, 142, CX + s * 58 + 11, 164), fill=(240, 120, 148, 255), outline=INK, ow=2.4)
    elif style == 'low_ponytail':
        ink_shape(d, t, [(CX + 30, HEAD_CY + 6), (CX + 66, 150), (CX + 84, 206),
                         (CX + 60, 214), (CX + 44, 168)],
                  hair, shade_pts=[(CX + 56, 156), (CX + 84, 206), (CX + 60, 214), (CX + 52, 172)])
        for s in (-1, 1):
            ink_shape(d, t, [(CX + s * 40, HEAD_CY - 4), (CX + s * 52, HEAD_CY + 40),
                             (CX + s * 46, 176), (CX + s * 30, 150)],
                      hair, shade_pts=[(CX + s * 46, HEAD_CY + 20), (CX + s * 52, HEAD_CY + 40),
                                       (CX + s * 46, 176), (CX + s * 40, 160)])
    elif style in ('bob', 'two_tone'):
        ink_shape(d, t, [(CX - 44, HEAD_CY - 18), (CX + 44, HEAD_CY - 18),
                         (CX + 50, HEAD_CY + 30), (CX + 34, HEAD_CY + 50),
                         (CX - 34, HEAD_CY + 50), (CX - 50, HEAD_CY + 30)],
                  hair, shade_pts=[(CX + 16, HEAD_CY - 12), (CX + 44, HEAD_CY - 18),
                                   (CX + 50, HEAD_CY + 30), (CX + 34, HEAD_CY + 50), (CX + 16, HEAD_CY + 50)])
        if style == 'two_tone' and ch['hair2']:
            for s in (-1, 1):
                ink_shape(d, t, [(CX + s * 30, HEAD_CY + 4), (CX + s * 50, HEAD_CY + 26),
                                 (CX + s * 50, HEAD_CY + 48), (CX + s * 28, HEAD_CY + 44)],
                          ch['hair2'], ow=2.6)
    else:                                   # short / messy / soft_short / slick
        ink_shape(d, t, [(CX - 43, HEAD_CY - 30), (CX + 43, HEAD_CY - 30),
                         (CX + 46, HEAD_CY + 18), (CX + 34, HEAD_CY + 26),
                         (CX - 34, HEAD_CY + 26), (CX - 46, HEAD_CY + 18)],
                  hair, shade_pts=[(CX + 14, HEAD_CY - 26), (CX + 43, HEAD_CY - 30),
                                   (CX + 46, HEAD_CY + 18), (CX + 34, HEAD_CY + 26), (CX + 14, HEAD_CY + 26)])


def draw_ears(d, t, ch):
    for s in (-1, 1):
        ell(d, t, (CX + s * 38 - 8, HEAD_CY + 2, CX + s * 38 + 8, HEAD_CY + 22),
            fill=ch['skin'], outline=INK, ow=2.6)


def draw_head(d, t, ch):
    """Head layer: ears, skull, front hair and accessories all follow the head offset."""
    draw_ears(d, t, ch)
    draw_head_shape(d, t, ch)
    draw_hair_front(d, t, ch)
    draw_head_accessories(d, t, ch)


def draw_head_shape(d, t, ch):
    skin = ch['skin']
    # egg-shaped head: full width at the temples, a gentle taper to a round chin
    pts = []
    n = 40
    for i in range(n):
        a = 2 * math.pi * i / n
        c = math.cos(a)
        taper = 1.0 - (0.30 * (-c) if c < 0 else 0.0)
        x = CX + HEAD_RX * taper * math.sin(a)
        y = HEAD_CY - HEAD_RY * c
        pts.append((x, y))
    ink_shape(d, t, pts, skin, ow=3.4)
    soft(d, t, (CX - 30, HEAD_CY - 38, CX + 2, HEAD_CY - 6), (255, 255, 255, 42))


def fringe_pts(inner, grow=3.0):
    """Outer arc over the crown + the wavy inner edge, as one closed path."""
    rx = HEAD_RX + grow
    ry = HEAD_RY + grow
    pts = []
    for a in range(268, 453, 6):
        r = math.radians(a % 360)
        pts.append((CX + rx * math.sin(r), HEAD_CY - ry * math.cos(r)))
    pts.extend(inner)
    return pts


def draw_hair_front(d, t, ch):
    style = ch['style']
    hair = ch['hair']
    hair2 = ch['hair2']
    if style == 'twin_tails':
        inner = [(CX + 40, HEAD_CY - 6), (CX + 16, HEAD_CY - 3), (CX - 8, HEAD_CY + 3),
                 (CX - 40, HEAD_CY - 6)]
        grow = 5.0
    elif style == 'messy':
        inner = [(CX + 41, HEAD_CY - 9), (CX + 18, HEAD_CY - 2), (CX - 2, HEAD_CY - 11),
                 (CX - 24, HEAD_CY + 1), (CX - 41, HEAD_CY - 6)]
        grow = 4.0
    elif style == 'slick':
        inner = [(CX + 40, HEAD_CY - 11), (CX + 4, HEAD_CY - 6), (CX - 40, HEAD_CY - 9)]
        grow = 2.0
    elif style in ('short', 'soft_short'):
        inner = [(CX + 41, HEAD_CY - 8), (CX + 12, HEAD_CY - 13), (CX - 16, HEAD_CY - 2),
                 (CX - 41, HEAD_CY - 6)]
        grow = 3.0
    else:                                   # bob / long / wavy / low ponytail
        inner = [(CX + 42, HEAD_CY - 4), (CX + 14, HEAD_CY - 15), (CX - 10, HEAD_CY + 1),
                 (CX - 42, HEAD_CY - 5)]
        grow = 3.0
    pts = fringe_pts(inner, grow)
    shade = [p for p in pts if p[0] >= CX + 6]
    ink_shape(d, t, pts, hair, shade_pts=shade)

    if style == 'messy':
        for dx in (-30, -8, 16, 32):
            poly(d, t, [(CX + dx, HEAD_CY - 52), (CX + dx + 13, HEAD_CY - 40),
                        (CX + dx + 4, HEAD_CY - 30)], fill=hair, outline=INK, ow=2.4)
    if hair2 and style == 'two_tone':
        poly(d, t, [(CX - 24, HEAD_CY - 42), (CX - 6, HEAD_CY - 36), (CX - 14, HEAD_CY - 6),
                    (CX - 26, HEAD_CY - 14)], fill=hair2, outline=None)
        poly(d, t, [(CX + 2, HEAD_CY - 44), (CX + 18, HEAD_CY - 38), (CX + 10, HEAD_CY - 16),
                    (CX - 2, HEAD_CY - 22)], fill=hair2, outline=None)
    if hair2 and style == 'bob':
        poly(d, t, [(CX - 22, HEAD_CY - 40), (CX - 6, HEAD_CY - 36), (CX - 14, HEAD_CY - 8)],
             fill=hair2, outline=None)


def draw_head_accessories(d, t, ch):
    acc = ch['acc']
    if 'cat_ears' in acc:
        for s in (-1, 1):
            poly(d, t, [(CX + s * 22, HEAD_CY - 34), (CX + s * 46, HEAD_CY - 40),
                        (CX + s * 40, HEAD_CY - 76)], fill=ch['hair'], outline=INK, ow=2.6)
            poly(d, t, [(CX + s * 28, HEAD_CY - 38), (CX + s * 41, HEAD_CY - 42),
                        (CX + s * 38, HEAD_CY - 62)], fill=(255, 186, 202, 255), outline=None)
    if 'bow' in acc:
        bx, by = CX + 34, HEAD_CY - 36
        for s in (-1, 1):
            ell(d, t, (bx + s * 16 - 13, by - 13, bx + s * 16 + 13, by + 13),
                fill=(255, 138, 158, 255), outline=INK, ow=2.4)
        ell(d, t, (bx - 7, by - 7, bx + 7, by + 7), fill=(255, 106, 134, 255), outline=INK, ow=2.2)
    if 'cap' in acc:
        ink_shape(d, t, [(CX - 44, HEAD_CY - 26), (CX + 44, HEAD_CY - 26),
                         (CX + 44, HEAD_CY - 8), (CX - 44, HEAD_CY - 8)],
                  (236, 122, 112, 255),
                  shade_pts=[(CX + 12, HEAD_CY - 24), (CX + 44, HEAD_CY - 26),
                             (CX + 44, HEAD_CY - 8), (CX + 12, HEAD_CY - 8)], ow=2.8)
        for s in (-1, 1):
            poly(d, t, [(CX + s * 30, HEAD_CY - 12), (CX + s * 62, HEAD_CY - 6),
                        (CX + s * 60, HEAD_CY + 6), (CX + s * 30, HEAD_CY + 4)],
                 fill=(214, 100, 92, 255), outline=INK, ow=2.6)
    if 'whale_hood' in acc:
        ink_shape(d, t, [(CX - 50, HEAD_CY - 30), (CX + 50, HEAD_CY - 30),
                         (CX + 52, HEAD_CY + 16), (CX + 30, HEAD_CY + 30),
                         (CX - 30, HEAD_CY + 30), (CX - 52, HEAD_CY + 16)],
                  ch['top'],
                  shade_pts=[(CX + 16, HEAD_CY - 26), (CX + 50, HEAD_CY - 30),
                             (CX + 52, HEAD_CY + 16), (CX + 30, HEAD_CY + 30), (CX + 16, HEAD_CY + 30)],
                  ow=3.2)
        # whale tail fin on top and a soft belly patch
        poly(d, t, [(CX - 4, HEAD_CY - 30), (CX + 4, HEAD_CY - 30),
                    (CX + 22, HEAD_CY - 52), (CX + 8, HEAD_CY - 40)], fill=ch['top2'], outline=INK, ow=2.4)
        poly(d, t, [(CX - 4, HEAD_CY - 30), (CX + 4, HEAD_CY - 30),
                    (CX - 22, HEAD_CY - 52), (CX - 8, HEAD_CY - 40)], fill=ch['top2'], outline=INK, ow=2.4)
        ell(d, t, (CX - 22, HEAD_CY + 6, CX + 22, HEAD_CY + 30), fill=(240, 250, 255, 190), outline=None)
    if 'headset' in acc:
        arc(d, t, (CX - 46, HEAD_CY - 52, CX + 46, HEAD_CY + 22), 180, 360, fill=(120, 200, 244, 255), width=5.0)
        for s in (-1, 1):
            ell(d, t, (CX + s * 46 - 10, HEAD_CY - 12, CX + s * 46 + 10, HEAD_CY + 16),
                fill=(60, 74, 104, 255), outline=(120, 200, 244, 255), ow=2.6)
    if 'glasses' in acc:
        for s in (-1, 1):
            arc(d, t, (CX + s * 16 - 14, HEAD_CY - 8, CX + s * 16 + 14, HEAD_CY + 20),
                0, 360, fill=(72, 58, 52, 255), width=3.0)
            line(d, t, [(CX + s * 30, HEAD_CY + 2), (CX + s * 40, HEAD_CY - 2)], fill=(72, 58, 52, 255), width=2.4)
        line(d, t, [(CX - 2, HEAD_CY + 2), (CX + 2, HEAD_CY + 2)], fill=(72, 58, 52, 255), width=2.4)


# ============================================================================
# face
# ============================================================================
def eye_pair_y():
    return HEAD_CY + 6.0


def draw_eyes(d, t, kind, look=0.0):
    lx, rx = CX - 15.5, CX + 15.5
    ey = eye_pair_y()
    sk = (255, 255, 255, 255)
    if kind == 'open':
        for x in (lx, rx):
            ell(d, t, (x - 12, ey - 14, x + 12, ey + 16), fill=INK, outline=None)
            ell(d, t, (x - 7 + look * 0.6, ey - 9, x - 1 + look * 0.6, ey - 3), fill=sk, outline=None)
            ell(d, t, (x + 2 + look * 0.6, ey + 3, x + 6 + look * 0.6, ey + 7), fill=(255, 255, 255, 200), outline=None)
    elif kind == 'happy':
        for x in (lx, rx):
            arc(d, t, (x - 15 + look, ey - 10, x + 15 + look, ey + 14), 200, 340, fill=INK, width=5.0)
    elif kind == 'closed':
        for x in (lx, rx):
            arc(d, t, (x - 14 + look, ey - 6, x + 14 + look, ey + 12), 200, 340, fill=INK, width=4.6)
    elif kind == 'wide':
        for x in (lx, rx):
            ell(d, t, (x - 14, ey - 17, x + 14, ey + 19), fill=sk, outline=INK, ow=3.0)
            ell(d, t, (x - 7 + look * 0.8, ey - 4, x + 7 + look * 0.8, ey + 14), fill=INK, outline=None)
            ell(d, t, (x - 4 + look * 0.8, ey - 1, x + 1 + look * 0.8, ey + 5), fill=sk, outline=None)
    elif kind == 'plead':
        for x in (lx, rx):
            ell(d, t, (x - 14, ey - 15, x + 14, ey + 17), fill=sk, outline=INK, ow=3.0)
            ell(d, t, (x - 8 + look * 0.7, ey - 2, x + 8 + look * 0.7, ey + 15), fill=INK, outline=None)
            ell(d, t, (x - 5 + look * 0.7, ey + 1, x + 1 + look * 0.7, ey + 7), fill=sk, outline=None)
            ell(d, t, (x - 3, ey - 11, x + 4, ey - 5), fill=(255, 214, 226, 200), outline=None)
    elif kind == 'angry':
        for x, s in ((lx, -1), (rx, 1)):
            line(d, t, [(x - 16, ey - 16), (x + 16, ey - 6)], fill=INK, width=5.0)
            ell(d, t, (x - 8, ey + 2, x + 8, ey + 15), fill=INK, outline=None)
    elif kind == 'flat':
        for x in (lx, rx):
            line(d, t, [(x - 14, ey + 2), (x + 14, ey + 2)], fill=INK, width=4.4)
    elif kind == 'side':
        for x in (lx, rx):
            ell(d, t, (x - 12, ey - 13, x + 12, ey + 15), fill=sk, outline=INK, ow=3.0)
            ell(d, t, (x - 9 + look, ey - 2, x + 3 + look, ey + 11), fill=INK, outline=None)
    elif kind == 'smirk':
        for x in (lx, rx):
            arc(d, t, (x - 15, ey - 8, x + 15, ey + 12), 200, 350, fill=INK, width=4.6)
    elif kind == 'scan':
        for x in (lx, rx):
            ell(d, t, (x - 12, ey - 14, x + 12, ey + 16), fill=(96, 200, 246, 255), outline=INK, ow=2.8)
            ell(d, t, (x - 7, ey - 9, x - 1, ey - 3), fill=sk, outline=None)
            arc(d, t, (x - 12, ey - 14, x + 12, ey + 16), 0, 360, fill=(198, 244, 255, 255), width=2.0)
    elif kind == 'love':
        for x in (lx, rx):
            heart(d, t, x, ey, 13, (232, 72, 96, 255))
            heart(d, t, x - 2, ey - 2, 6, (255, 168, 180, 220))
    elif kind == 'star':
        for x in (lx, rx):
            d.polygon([t.pt(a, b) for a, b in star_pts(x, ey, 15, -90)], fill=(240, 176, 40, 255))
            d.polygon([t.pt(a, b) for a, b in star_pts(x, ey, 6, -90)], fill=(255, 240, 190, 255))
    elif kind == 'sparkle_eyes':
        for x in (lx, rx):
            ell(d, t, (x - 13, ey - 16, x + 13, ey + 17), fill=INK, outline=None)
            ell(d, t, (x - 9, ey - 12, x - 1, ey - 4), fill=(255, 255, 255, 255), outline=None)
            spark(d, t, x + 10, ey - 10, 6, (255, 244, 200, 255))


def draw_brows(d, t, kind):
    if not kind:
        return
    lx, rx = CX - 15.5, CX + 15.5
    by = HEAD_CY - 14
    if kind == 'angry':
        for x, s in ((lx, -1), (rx, 1)):
            line(d, t, [(x - 12, by - 6 + (0 if s < 0 else 0)), (x + 12, by + 4)], fill=HAIR_INK, width=3.6)
    elif kind == 'sad':
        for x, s in ((lx, -1), (rx, 1)):
            line(d, t, [(x - 12, by + 4), (x + 12, by - 6)], fill=HAIR_INK, width=3.6)
    elif kind == 'up':
        for x in (lx, rx):
            arc(d, t, (x - 13, by - 12, x + 13, by + 8), 190, 350, fill=HAIR_INK, width=3.4)


def draw_mouth(d, t, kind, lip=None):
    mx, my = CX, HEAD_CY + 27
    if kind in (None, 'none'):
        return
    if kind == 'smile':
        arc(d, t, (mx - 17, my - 10, mx + 17, my + 12), 20, 160, fill=INK, width=4.4)
    elif kind == 'grin':
        pts = [(mx - 19, my - 6)] + [(mx - 19 + 38 * i / 8, my - 6 + 20 * math.sin(math.pi * i / 8)) for i in range(9)]
        d.polygon([t.pt(x, y) for x, y in pts], fill=(168, 74, 84, 255))
        arc(d, t, (mx - 20, my - 8, mx + 20, my + 16), 0, 180, fill=INK, width=4.0)
        line(d, t, [(mx - 20, my - 6), (mx + 20, my - 6)], fill=INK, width=3.4)
        rrect(d, t, (mx - 9, my + 8, mx + 9, my + 14), 3, fill=(255, 150, 158, 255), outline=None)
    elif kind == 'grin_small':
        arc(d, t, (mx - 12, my - 6, mx + 12, my + 10), 10, 170, fill=INK, width=4.0)
    elif kind == 'frown':
        arc(d, t, (mx - 15, my + 2, mx + 15, my + 22), 200, 340, fill=INK, width=4.4)
    elif kind == 'wavy':
        line(d, t, [(mx - 15, my + 7), (mx - 7, my + 1), (mx, my + 8), (mx + 7, my + 1), (mx + 15, my + 7)],
             fill=INK, width=4.0)
    elif kind == 'pout':
        ell(d, t, (mx - 9, my - 2, mx + 9, my + 12), fill=(196, 96, 104, 255), outline=INK, ow=3.4)
    elif kind == 'o':
        ell(d, t, (mx - 6, my - 2, mx + 6, my + 13), fill=(150, 74, 82, 255), outline=INK, ow=3.2)
    elif kind == 'o_big':
        ell(d, t, (mx - 11, my - 8, mx + 11, my + 20), fill=(120, 62, 70, 255), outline=INK, ow=3.4)
        arc(d, t, (mx - 8, my + 8, mx + 8, my + 18), 0, 180, fill=(255, 140, 150, 255), width=3.0)
    elif kind == 'flat':
        line(d, t, [(mx - 11, my + 6), (mx + 11, my + 6)], fill=INK, width=4.0)
    elif kind == 'smirk':
        arc(d, t, (mx - 6, my - 4, mx + 20, my + 14), 40, 150, fill=INK, width=4.2)
    elif kind == 'kiss':
        poly(d, t, [(mx - 8, my), (mx - 4, my - 5), (mx, my), (mx + 4, my - 5), (mx + 8, my),
                    (mx + 4, my + 7), (mx, my + 4), (mx - 4, my + 7)], fill=(226, 88, 104, 255), outline=None)
    elif kind == 'talk':
        ell(d, t, (mx - 9, my - 4, mx + 9, my + 14), fill=(150, 74, 82, 255), outline=INK, ow=3.6)
    elif kind == 'tongue':
        arc(d, t, (mx - 8, my - 4, mx + 8, my + 10), 0, 180, fill=INK, width=3.6)
        ell(d, t, (mx - 6, my + 2, mx + 7, my + 16), fill=(240, 140, 156, 255), outline=INK, ow=2.8)
    if lip:
        # a soft lipstick mark over the mouth
        arc(d, t, (mx - 14, my - 6, mx + 14, my + 12), 20, 170, fill=lip, width=2.6)


def draw_blush(d, t, ch, hearts=False, big=False):
    if 'round_cheeks' in ch['acc'] or hearts or big:
        for x in (CX - 27, CX + 27):
            if hearts:
                heart(d, t, x, HEAD_CY + 16, 8, (255, 126, 148, 160))
            else:
                r = 11 if not big else 13
                ell(d, t, (x - r, HEAD_CY + 12 - r * 0.7, x + r, HEAD_CY + 12 + r * 0.7),
                    fill=BLUSH, outline=None)
    else:
        for x in (CX - 28, CX + 28):
            ell(d, t, (x - 10, HEAD_CY + 12, x + 10, HEAD_CY + 24), fill=BLUSH, outline=None)


# ============================================================================
# arms
# ============================================================================
def draw_arm(d, t, ch, spec, side, hand_style='open', skin_only=False):
    sh, el, hd = arm_geom(spec, side)
    top = ch['top']
    top2 = ch['top2']
    skin = ch['skin']
    short = ch['sleeve'] == 'short'
    if short:
        # short sleeve: sleeve down to the elbow, bare forearm
        limb(d, t, [sh, el], 17, top)
        limb(d, t, [el, hd], 12.5, skin)
        c = ((el[0] + hd[0]) / 2, (el[1] + hd[1]) / 2)
        limb(d, t, [el, c], 14.5, top2, outline=None)
    elif ch['sleeve'] == 'puff':
        ell(d, t, (sh[0] - 15, sh[1] - 16, sh[0] + 15, sh[1] + 16), fill=top, outline=INK, ow=2.8)
        limb(d, t, [el, hd], 12.0, skin)
    else:
        limb(d, t, [sh, el], 17, top)
        limb(d, t, [el, hd], 13, top)
        limb(d, t, [el, el], 13, top, outline=None)
        cuff = (el[0] + (hd[0] - el[0]) * 0.86, el[1] + (hd[1] - el[1]) * 0.86)
        limb(d, t, [cuff, hd], 13.6, top2, outline=None)
    draw_hand(d, t, hd, side, skin, hand_style)


def draw_hand(d, t, pt, side, skin, style='open'):
    x, y = pt
    if style == 'fist':
        rrect(d, t, (x - 10, y - 10, x + 10, y + 10), 7, fill=skin, outline=INK, ow=3.0)
        arc(d, t, (x - 6, y - 8, x + 6, y + 2), 200, 340, fill=dark(skin, 0.22), width=2.0)
    elif style == 'flat':
        rrect(d, t, (x - 11, y - 8, x + 11, y + 9), 6, fill=skin, outline=INK, ow=3.0)
        for k in (-5, 0, 5):
            line(d, t, [(x + k, y - 6), (x + k, y + 7)], fill=dark(skin, 0.16), width=1.4)
    elif style == 'point':
        ell(d, t, (x - 9, y - 9, x + 9, y + 9), fill=skin, outline=INK, ow=3.0)
        limb(d, t, [(x + side * 6, y - 4), (x + side * 20, y - 8)], 5.5, skin)
    elif style == 'paw':
        ell(d, t, (x - 10, y - 10, x + 10, y + 11), fill=skin, outline=INK, ow=3.0)
        for k in (-4, 0, 4):
            ell(d, t, (x + k - 2, y - 8, x + k + 2, y - 2), fill=(255, 176, 190, 255), outline=None)
    elif style == 'grip':
        rrect(d, t, (x - 10, y - 8, x + 10, y + 8), 6, fill=skin, outline=INK, ow=3.0)
    else:
        ell(d, t, (x - 10, y - 10, x + 10, y + 11), fill=skin, outline=INK, ow=3.0)
        ell(d, t, (x + side * 9 - 4, y - 2, x + side * 9 + 4, y + 6), fill=skin, outline=INK, ow=2.4)


# ============================================================================
# props
# ============================================================================
def prop_chibi(d, t, spec, ch):
    """The small blanket-bundle figure the arms wrap around (the person you hug)."""
    x, y = spec.get('chibi', (CX, 200))
    tt = T(t.s, t.rot + spec.get('chibi_rot', 0.0), t.dx, t.dy)
    poly(d, tt, [(x - 30, y + 4), (x + 30, y + 4), (x + 34, y + 56), (x - 34, y + 56)],
         fill=(255, 236, 214, 255), outline=INK, ow=3.0)
    poly(d, tt, [(x + 6, y + 8), (x + 30, y + 4), (x + 34, y + 56), (x + 6, y + 56)],
         fill=SHADE_A, outline=None)
    ell(d, tt, (x - 24, y - 26, x + 24, y + 16), fill=(255, 232, 216, 255), outline=INK, ow=3.2)
    ell(d, tt, (x - 25, y - 32, x + 25, y - 11), fill=(96, 76, 66, 255), outline=INK, ow=2.8)
    ell(d, tt, (x - 14, y - 22, x + 4, y - 6), fill=(255, 255, 255, 40), outline=None)
    for s in (-1, 1):
        poly(d, tt, [(x + s * 8, y - 26), (x + s * 24, y - 22), (x + s * 20, y - 4)],
             fill=(226, 150, 120, 255), outline=None)
    for s in (-1, 1):
        arc(d, tt, (x + s * 12 - 8, y - 8, x + s * 12 + 8, y + 6), 200, 340, fill=INK, width=3.0)
    arc(d, tt, (x - 6, y - 2, x + 6, y + 8), 20, 160, fill=INK, width=3.0)
    for s in (-1, 1):
        ell(d, tt, (x + s * 10 - 3, y + 60, x + s * 10 + 3, y + 66), fill=INK, outline=None)


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
    """A hand belonging to the viewer, patting the character's head."""
    px, py = CX + 52, HEAD_CY - HEAD_RY - 22
    limb(d, t, [(px + 26, py - 46), (px, py)], 26, (255, 226, 208, 255))
    rrect(d, t, (px - 26, py - 16, px + 20, py + 12), 9, fill=(255, 214, 196, 255), outline=INK, ow=3.0)
    for k in range(3):
        limb(d, t, [(px - 22 + k * 15, py + 6), (px - 22 + k * 15, py + 18)], 9, (255, 214, 196, 255))


def prop_tap_hand(d, t, pt):
    x, y = pt
    ell(d, t, (x - 10, y - 10, x + 10, y + 11), fill=(255, 226, 208, 255), outline=INK, ow=3.0)
    for k in (-4, 1, 6):
        limb(d, t, [(x + k, y - 6), (x + k + 4, y - 16)], 4.0, (255, 216, 198, 255))


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
    """A coat draped over the character's shoulders."""
    col = (222, 172, 122, 255)
    for s in (-1, 1):
        poly(d, t, [(CX + s * 18, SHOULDER_Y - 20), (CX + s * 62, SHOULDER_Y - 6),
                    (CX + s * 66, 190), (CX + s * 30, 200)],
             fill=col, outline=INK, ow=3.2)
    for s in (-1, 1):
        poly(d, t, [(CX + s * 30, SHOULDER_Y - 16), (CX + s * 62, SHOULDER_Y - 4),
                    (CX + s * 64, 130), (CX + s * 30, 140)],
             fill=lighten(col, 0.14), outline=None)


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
         fill=(226, 216, 204, 255), outline=INK, ow=3.4)
    poly(d, t, [(x0, y0), (x1, y0), (x1, y0 + 11), (x0, y0 + 11)],
         fill=(248, 244, 238, 255), outline=None)
    line(d, t, [(x0 + 5, y0 + 11), (x1 - 5, y0 + 11)], fill=(204, 194, 184, 255), width=2.2)
    for i in range(3):
        x = x0 + 88 + i * 88
        line(d, t, [(x, y0 + 22), (x, y1)], fill=(219, 211, 202, 255), width=1.8)


def draw_body(d, t, ch):
    """Torso, legs and neck — everything between the hair and the chin."""
    draw_legs(d, t, ch)
    draw_torso(d, t, ch)
    draw_neck(d, t, ch)


def draw_arms(d, t, ch, spec):
    """Both arms, drawn in front of the torso (left first, then right)."""
    draw_arm(d, t, ch, spec['arms'][1], -1, spec['hand_style'])
    draw_arm(d, t, ch, spec['arms'][0], 1, spec['hand_style'])


def draw_face(d, t, ch, spec):
    """Brows, eyes, mouth and blush."""
    draw_brows(d, t, spec['brows'])
    draw_eyes(d, t, spec['eyes'], spec['look'])
    draw_mouth(d, t, spec['mouth'], ch['lip'])
    draw_blush(d, t, ch,
               hearts=('heart_blush' in spec['deco']) or spec['eyes'] in ('love', 'plead') or bool(ch['lip']))


def draw_prop(d, t, ch, spec, layer):
    """The pose's prop: layer='back' tucks it behind the arms, 'hand' puts it in the hand."""
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

    # 1. behind the body: the hair mass and the cat tail
    draw_hair_back(d, t, ch)
    if 'cat_tail' in ch['acc']:
        arc(d, t, (CX + 40, 210, CX + 124, 310), 200, 20, fill=ch['hair'], width=12.0)
        arc(d, t, (CX + 40, 210, CX + 124, 310), 200, 20, fill=INK, width=2.4)

    # 2. the body, then the props that sit behind the arms
    draw_body(d, t, ch)
    draw_prop(d, t, ch, spec, 'back')

    # 3. head and face
    draw_head(d, th, ch)
    draw_face(d, th, ch, spec)

    # 4. the ledge the character leans on: hides the lower body, hands rest on its rim
    if spec['ledge']:
        draw_ledge(d, t, spec['ledge'])

    # 5. arms in front of the torso, then whatever they hold
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
    d.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=r, fill=(52, 44, 42, 180))
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
        poly(d, t, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], fill=(226, 218, 208, 255), outline=INK, ow=3.4)
        for i in range(6):
            y = y0 + 20 + i * 48
            line(d, t, [(x0 + 8, y), (x1 - 8, y)], fill=(206, 196, 186, 255), width=2.4)
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