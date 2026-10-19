#!/usr/bin/env python3
"""Render check for text_overlay.py: forced breaks, wrapping, and vertical placement."""
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

SCRIPT = Path(__file__).with_name("text_overlay.py")


def ink_rows(text, *args):
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "t.png"
        subprocess.run([sys.executable, str(SCRIPT), str(out), text, *args], check=True)
        alpha = np.asarray(Image.open(out))[:, :, 3]
    rows = np.where(alpha.max(1) > 0)[0]
    return rows, np.split(rows, np.where(np.diff(rows) > 1)[0] + 1)


rows, lines = ink_rows("MOMENT ONE|NOW TWO", "--y", "0.25")  # no descenders, so lines separate
assert len(lines) == 2, len(lines)
assert abs((rows.min() + rows.max()) / 2 - 0.25 * 1920) < 60
_, lines = ink_rows("ME AT THREE AM ADDING ANOTHER FEATURE INSTEAD OF TELLING ANYONE MY APP EXISTS")
assert len(lines) >= 3, len(lines)  # no forced breaks: wraps at 72% width
print("ok")

# A hidden-emoji layer and its revealed twin share text placement, and the emoji draws in color.
with tempfile.TemporaryDirectory() as tmp:
    base, full = Path(tmp) / "a.png", Path(tmp) / "b.png"
    args = ["MOMENT|*NOW* 🙏", "--style", "box", "--hang-emoji", "--accent", "#2F6BFF"]
    subprocess.run([sys.executable, str(SCRIPT), str(base), *args, "--hide-emoji"], check=True)
    subprocess.run([sys.executable, str(SCRIPT), str(full), *args], check=True)
    a, b = (np.asarray(Image.open(f)).astype(int) for f in (base, full))
    changed = np.where((a != b).any(2).any(0))[0]
    word = np.where((a[:, :, :3] == [255, 255, 255]).all(2) & (a[:, :, 3] > 0))[1]
    assert changed.min() > 540, changed.min()  # only the right side (emoji) changes
    assert ((b[:, :, 0] > 200) & (b[:, :, 1] > 120) & (b[:, :, 2] < 90)).sum() > 50  # yellow emoji pixels
print("ok reveal")

# Highlight: white words, accent words on a filled box; black ink on a light accent, white on red,
# and --accent-ink overrides both.
with tempfile.TemporaryDirectory() as tmp:
    for accent, ink, extra in (("#FFD23F", (0, 0, 0), []), ("#E5322D", (255, 255, 255), []),
                               ("#FFD23F", (20, 40, 160), ["--accent-ink", "#1428A0"])):
        out = Path(tmp) / "h.png"
        subprocess.run([sys.executable, str(SCRIPT), str(out), "PLAIN *KEY*", "--style", "highlight",
                        "--accent", accent, *extra], check=True)
        px = np.asarray(Image.open(out)).astype(int)
        rgb = tuple(int(accent[i:i + 2], 16) for i in (1, 3, 5))
        fill = (np.abs(px[:, :, :3] - rgb).sum(2) < 6) & (px[:, :, 3] == 255)
        cols = np.where(fill.any(0))[0]
        assert cols.min() > 540, cols.min()  # the box sits on the second word only
        inside = px[fill.any(1)][:, cols.min():cols.max() + 1]
        assert (np.abs(inside[:, :, :3] - ink).sum(2) < 30).sum() > 200, (accent, extra)  # legible ink in the box
        left = px[:, :cols.min() - 20]
        assert ((left[:, :, :3] > 240).all(2) & (left[:, :, 3] == 255)).sum() > 200  # white plain word
print("ok highlight")
