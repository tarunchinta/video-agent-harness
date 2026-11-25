"""Cuts the empty space out of audio_raw_v2.m4a, drops the one-direction sentence, and re-times every word.

    python cut_audio.py      (run from this folder; needs ffmpeg and numpy)

Reads ../audio_raw_v2.srt. Writes ../audio_cut_v3.m4a, ../audio_cut_v3.srt, words.json, words.js and vo.m4a.
"""
import json
import re
import subprocess

import numpy as np

RATE = 48000
DROP = ("Your first approach is to go in one direction, but that fails quickly.", 0)
LEAD, TAIL = 0.25, 0.35          # kept before the first word and after the last
SENTENCE, COMMA, WORD = 0.24, 0.13, 0.07   # what is left of a pause after each kind of word
QUIET_DB, AFTER, BEFORE = -42, 0.05, 0.04  # below this is empty; breathing room left around a word
FADE = int(0.008 * RATE)


def seconds(stamp):
    h, m, s = stamp.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s.replace(",", "."))


srt = open("../audio_raw_v2.srt", encoding="utf-8").read()
words = [{"w": w, "s": seconds(a), "e": seconds(b)} for a, b, w in re.findall(r"(\S+) --> (\S+)\n(.+)\n", srt)]
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", "../audio_raw_v2.m4a", "-f", "f32le", "-ac", "2", "-ar", str(RATE), "-"], capture_output=True, check=True).stdout
audio = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2)

HOP = RATE // 100
mono = audio.mean(axis=1)
loud = np.array([20 * np.log10(np.sqrt(np.mean(mono[i : i + HOP] ** 2)) + 1e-9) for i in range(0, len(mono) - HOP, HOP)])
heard = lambda t: loud[min(len(loud) - 1, max(0, int(t * 100)))] > QUIET_DB


def sound_end(t, limit):  # the aligner can end a word early: follow the sound until it dies away
    while t < limit and heard(t):
        t += 0.01
    return t


def sound_start(t, limit):
    while t > limit and heard(t - 0.01):
        t -= 0.01
    return t


# The aligner cannot place digits exactly. Where a quiet stretch falls just before a number, or inside the end of the
# word before it, move both words to the edges of that stretch.
for a, b in zip(words, words[1:]):
    if not b["w"][0].isdigit():
        continue
    quiet = [i for i in range(int((a["s"] + 0.1) * 100), int(b["s"] * 100)) if loud[i] <= QUIET_DB]
    runs = np.split(quiet, np.where(np.diff(quiet) > 1)[0] + 1) if quiet else []
    longest = max(runs, key=len, default=[])
    if len(longest) >= 20:
        a["e"], b["s"] = round(longest[0] / 100, 3), round((longest[-1] + 1) / 100, 3)

# The sentence to leave out, found by its words.
gone = DROP[0].split()
at = [i for i in range(len(words)) if [w["w"] for w in words[i : i + len(gone)]] == gone]
assert len(at) == 1, at
dropped = set(range(at[0], at[0] + len(gone)))
keep = [i for i in range(len(words)) if i not in dropped]

# Pieces of the recording to keep, as [start, end], with the words each one holds.
pieces, first = [], keep[0]
start = max(0, words[first]["s"] - LEAD)
held = [first]
for a, b in zip(keep, keep[1:]):
    wa, wb = words[a], words[b]
    end = sound_end(wa["e"], min(wa["e"] + 0.35, words[a + 1]["s"])) + AFTER
    begin = sound_start(wb["s"], max(wb["s"] - 0.15, words[b - 1]["e"])) - BEFORE
    left = SENTENCE if wa["w"][-1] in ".?!" else COMMA if wa["w"][-1] == "," else WORD
    spare = (begin - end) - max(0, left - AFTER - BEFORE)
    if b != a + 1 or spare > 0.05:
        room = max(0, left - AFTER - BEFORE) / 2
        pieces.append((start, end + room, held))
        start, held = begin - room, []
    held.append(b)
last = words[keep[-1]]
pieces.append((start, min(len(audio) / RATE, sound_end(last["e"], last["e"] + 0.3) + TAIL), held))

# Join them, with a short crossfade so no join clicks.
out, timed = np.zeros((0, 2), dtype=np.float32), []
for s, e, ids in pieces:
    part = audio[int(s * RATE) : int(e * RATE)].copy()
    if len(out):
        ramp = np.linspace(0, 1, FADE, dtype=np.float32)[:, None]
        out[-FADE:] = out[-FADE:] * (1 - ramp) + part[:FADE] * ramp
        offset = (len(out) - FADE) / RATE - s
        out = np.concatenate([out, part[FADE:]])
    else:
        offset = -s
        out = part
    timed += [{"w": words[i]["w"], "s": round(words[i]["s"] + offset, 3), "e": round(words[i]["e"] + offset, 3)} for i in ids]

for target in ("../audio_cut_v3.m4a", "vo.m4a"):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", str(RATE), "-i", "-", "-c:a", "aac", "-b:a", "192k", target], input=out.tobytes(), check=True)


def stamp(x):
    ms = round(x * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


with open("../audio_cut_v3.srt", "w", encoding="utf-8") as f:
    for i, w in enumerate(timed, 1):
        f.write(f"{i}\n{stamp(w['s'])} --> {stamp(w['e'])}\n{w['w']}\n\n")
json.dump(timed, open("words.json", "w", encoding="utf-8"), indent=0)
open("words.js", "w", encoding="utf-8").write(f"window.WORDS = {json.dumps(timed)};\n")

print(f"{len(audio) / RATE:.1f} s -> {len(out) / RATE:.1f} s, {len(pieces)} pieces, {len(timed)} words")
gaps = [(round(b["s"] - a["e"], 2), a["w"], b["w"]) for a, b in zip(timed, timed[1:])]
print("longest gaps left:", sorted(gaps, reverse=True)[:8])
