#!/usr/bin/env python3
"""Render Reel overlay text to a transparent 1080x1920 PNG.

    text_overlay.py OUT.png "line one|*key words* 💀" --y 0.25 [--style outline|box|highlight] [--hang-emoji [--hide-emoji]]
        [--size 66] [--accent "#FFD23F"] [--accent-ink "#FFFFFF"] [--wrap 0.72] [--font PATH] [--index 5]

`|` forces a line break; long lines wrap at --wrap of frame width. `*...*` marks
accent words. Emoji (Apple Color Emoji) must be separated from words by spaces.
--y is the vertical center of the block as a fraction of frame height.

Styles mimic the in-app Instagram/TikTok text tool:
  outline  white text, black outline, accent words filled with --accent
  box      black text on white rounded line boxes that merge into one shape;
           accent words get their own --accent box (a fully accented line
           becomes one --accent box)
  highlight  white text with a soft shadow, no line boxes; accent words sit on
           a filled --accent box (a bold headline or cover look)

Text on an --accent box is --accent-ink, or black on light accents and white on
the rest when it is not given.
"""
import argparse
import re
from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920
FONT = "/System/Library/Fonts/Avenir Next Condensed.ttc"
EMOJI_FONT = "/System/Library/Fonts/Apple Color Emoji.ttc"
EMOJI = re.compile(r"^[←-⯿☀-➿\U0001F000-\U0001FAFF️‍]+$")


def parse_args(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("out")
    p.add_argument("text")
    p.add_argument("--y", type=float, default=0.25)
    p.add_argument("--style", choices=["outline", "box", "highlight"], default="outline")
    p.add_argument("--size", type=int, default=66)
    p.add_argument("--accent", default="#FFD23F")
    p.add_argument("--accent-ink", help="color of words on an --accent box (default: black or white by the accent)")
    p.add_argument("--hide-emoji", action="store_true", help="omit emoji (and their box space) for a pre-reveal layer; use with --hang-emoji")
    p.add_argument("--hang-emoji", action="store_true", help="center lines on their text so trailing emoji hang right and can appear without moving the text")
    p.add_argument("--font", default=FONT)
    p.add_argument("--wrap", type=float, default=0.72, help="max line width as a fraction of frame width")
    p.add_argument("--index", type=int, default=5, help="face index in a .ttc (Avenir Next Condensed 5 = Medium, 2 = Demi Bold, 0 = Bold, 8 = Heavy)")
    return p.parse_args(argv)


def words_of(chunk):
    """[(text, accent, emoji)] with `*` toggling accent across words."""
    out, accent = [], False
    for raw in chunk.split():
        start = raw.startswith("*")
        end = raw.endswith("*") and len(raw.strip("*")) > 0 and (len(raw) > 1)
        word = raw.strip("*")
        if start:
            accent = True
        out.append((word, accent, bool(EMOJI.match(word))))
        if end:
            accent = False
    return out


def on_accent(color):
    """Black on light accents (yellow, mint), white on the rest. Strict contrast math would put
    black on mid reds and blues, where white is the expected look."""
    r, g, b = ImageColor.getrgb(color)[:3]
    lum = lambda c: (c / 255 / 12.92) if c <= 10 else ((c / 255 + 0.055) / 1.055) ** 2.4
    return "black" if 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b) > 0.35 else "white"


def emoji_image(text, height):
    font = ImageFont.truetype(EMOJI_FONT, 160)  # Apple Color Emoji only has fixed bitmap sizes
    img = Image.new("RGBA", (200 * len(text), 200), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((0, 0), text, font=font, embedded_color=True)
    img = img.crop(img.getbbox())
    return img.resize((round(img.width * height / img.height), height), Image.LANCZOS)


def render(a):
    font = ImageFont.truetype(a.font, a.size, index=a.index)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    space = font.getlength(" ")
    emoji_h = round(a.size * 0.95)
    width = lambda w: emoji_image(w[0], emoji_h).width if w[2] else font.getlength(w[0])
    line_w = lambda ws: sum(width(w) for w in ws) + space * (len(ws) - 1) if ws else 0

    def text_part(ws):  # words before any trailing emoji
        n = len(ws)
        while n and ws[n - 1][2]:
            n -= 1
        return ws[:n]

    center_w = lambda ws: line_w(text_part(ws)) if a.hang_emoji else line_w(ws)
    box_w = lambda ws: line_w(text_part(ws)) if a.hide_emoji else line_w(ws)

    lines = []
    for chunk in a.text.split("|"):
        cur = []
        for w in words_of(chunk):
            if cur and line_w(cur + [w]) > W * a.wrap:
                lines.append(cur)
                cur = [w]
            else:
                cur.append(w)
        lines.append(cur)

    _, top, _, bottom = font.getbbox("Hgy", anchor="ls")  # top < 0 above baseline
    box = a.style == "box"
    pad_x, pad_y = (a.size * 0.38, a.size * 0.2) if box else (0, 0)
    line_h = bottom - top + 2 * pad_y
    pitch = line_h - 1 if box else a.size * 1.18
    block_top = a.y * H - (pitch * (len(lines) - 1) + line_h) / 2
    stroke = max(2, a.size // 14)
    ink = a.accent_ink or on_accent(a.accent)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))  # highlight: soft shadow under the white words

    whole = lambda ws: box and all(w[1] or w[2] for w in ws) and any(w[1] for w in ws)
    if box:  # draw all line boxes first so they merge into one shape
        for i, ws in enumerate(lines):
            x0 = (W - center_w(ws)) / 2 - pad_x
            y0 = block_top + i * pitch
            d.rounded_rectangle((x0, y0, x0 + box_w(ws) + 2 * pad_x, y0 + line_h),
                                radius=a.size * 0.28, fill=a.accent if whole(ws) else "white")

    for i, ws in enumerate(lines):
        x = (W - center_w(ws)) / 2
        baseline = block_top + i * pitch + pad_y - top
        for w in ws:
            text, accent, emoji = w
            ww = width(w)
            if emoji and a.hide_emoji:
                pass
            elif emoji:
                e = emoji_image(text, emoji_h)
                img.alpha_composite(e, (round(x), round(baseline - emoji_h * 0.82)))
            elif box:
                if accent and not whole(ws):
                    d.rounded_rectangle((x - a.size * 0.12, baseline + top - pad_y * 0.5,
                                         x + ww + a.size * 0.12, baseline + bottom + pad_y * 0.5),
                                        radius=a.size * 0.18, fill=a.accent)
                d.text((x, baseline), text, font=font, anchor="ls", fill=ink if accent else "black")
            elif a.style == "highlight":
                if accent:
                    gap = space / 2 if any(o is not w and o[1] for o in ws) else a.size * 0.14
                    d.rectangle((x - gap, baseline + top - a.size * 0.06, x + ww + gap, baseline + bottom),
                                fill=a.accent)
                else:
                    ImageDraw.Draw(shadow).text((x, baseline + a.size * 0.04), text, font=font, anchor="ls",
                                                fill=(0, 0, 0, 200), stroke_width=stroke, stroke_fill=(0, 0, 0, 200))
                d.text((x, baseline), text, font=font, anchor="ls", fill=ink if accent else "white")
            else:
                d.text((x + 3, baseline + 4), text, font=font, anchor="ls", fill=(0, 0, 0, 110))
                d.text((x, baseline), text, font=font, anchor="ls", fill=a.accent if accent else "white",
                       stroke_width=stroke, stroke_fill="black")
            x += ww + space
    if a.style == "highlight":
        img = Image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(a.size * 0.12)), img)
    return img


if __name__ == "__main__":
    args = parse_args()
    render(args).save(args.out)
