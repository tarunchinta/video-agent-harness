# STAND-IN word timings, built from SCRIPT.md before the real voiceover is aligned.
# usage: python3 standin_words.py  -> words.json  [{w, s, e}] (same shape as align.py)
#
# Each beat's words are spread across that beat's window from SCRIPT.md, weighted by
# spoken syllables (numbers are counted as they are said) with pauses at punctuation.
# Once the recording exists, replace words.json with real timings:
#   python3 align.py ../audio/New_Recording_266.m4a "Paxton, Cornyn, Talarico, Ty"
# (align.py is third-party/cstack/skills/animated-video/templates/remotion-film/align.py)
import json, re
from pathlib import Path

BEATS = [
    (0.15, 5.85, "Texas might turn blue in November, because 400,000 Republicans disappeared in May."),
    (6.15, 17.8, "Take one of them. March 3rd — he votes for John Cornyn. 910,000 Republicans do the same. "
                 "Cornyn beats Ken Paxton by a point: 42 to 40.5. Then May 26th, the runoff. He stays home."),
    (18.15, 34.8, "Paxton wins in a landslide: 64 to 36, 28 points. His count barely moved from 883,000. "
                  "Cornyn's fell by 400,000 — down 45 percent. Cornyn lost 400,000 votes, and Paxton gained none of them."),
    (35.15, 49.8, "A week before the runoff, Trump endorses Paxton. Cornyn's city vote collapses — Paxton's margin "
                  "swings 30 points in Houston, 40 in El Paso. The establishment stayed home, and the base took the party."),
    (50.15, 67.8, "Now zoom out. Last November, 11.4 million Texans voted. 400,000 is three and a half points of that — "
                  "about the lead Talarico holds in the polls right now. And midterms draw fewer voters, so those 400,000 count for even more."),
    (68.3, 75.6, "May already happened. November comes down to whether 400,000 Republicans show up."),
]

# Syllables as spoken, for tokens a vowel count gets wrong.
SPOKEN = {"400,000": 5, "910,000": 5, "883,000": 7, "3rd": 1, "26th": 4, "40.5": 4, "42": 3,
          "64": 3, "36": 3, "28": 3, "45": 3, "30": 2, "40": 2, "11.4": 4, "texas": 2, "texans": 2,
          "paxton": 2, "cornyn": 2, "talarico": 4, "establishment": 4, "runoff": 2, "landslide": 2}


def syllables(tok: str) -> float:
    k = re.sub(r"[^\w.,']", "", tok.lower()).strip(".,")
    if k in SPOKEN:
        return SPOKEN[k]
    return max(1, len(re.findall(r"[aeiouy]+", re.sub(r"e$", "", k))))


def pause(tok: str) -> float:
    if re.search(r"[.!?]$", tok):
        return 0.9
    if re.search(r"[,:]$", tok):
        return 0.45
    return 0.0


out = []
for start, end, text in BEATS:
    toks = [t for t in text.split() if t != "—"]
    # a dash is a pause on the word before it
    weights = []
    for t in text.split():
        if t == "—":
            weights[-1] = (weights[-1][0], weights[-1][1] + 0.6)
            continue
        weights.append((syllables(t), pause(t)))
    total = sum(s + p for s, p in weights)
    unit = (end - start) / total
    t = start
    for tok, (s, p) in zip(toks, weights):
        dur = s * unit
        out.append({"w": tok.strip("—"), "s": round(t, 3), "e": round(t + dur * 0.92, 3)})
        t += dur + p * unit

Path(__file__).with_name("words.json").write_text(json.dumps(out, indent=0))
print(f"{len(out)} words, last ends {out[-1]['e']}s  (STAND-IN timings)")
# words.js lets index.html load the timings from file:// as well as over http
Path(__file__).with_name("words.js").write_text("window.WORDS = " + json.dumps(out) + ";\n")
