"""heard.srt (WhisperX, from scripts/transcription.py) -> ../audio_raw_v2.srt, words.json, words.js and vo.m4a."""
import json, re, subprocess

# What the recogniser heard -> what was said. Real departures from the script are left alone.
FIXES = [(["cue", "learning."], ["Q-learning."]), (["once", "day"], ["one", "state"]), (["move", "that", "led"], ["moves", "that", "led"]), (["action", "score"], ["action's", "score"])]
LEAD_IN = 0.25

sec = lambda x: (lambda h, m, s: int(h) * 3600 + int(m) * 60 + float(s.replace(",", ".")))(*x.split(":"))
words = [{"w": w, "s": sec(a), "e": sec(b)} for a, b, w in re.findall(r"(\S+) --> (\S+)\n(.+)\n", open("heard.srt", encoding="utf-8").read())]
for heard, said in FIXES:
    n = len(heard)
    hits = [i for i in range(len(words) - n + 1) if [w["w"] for w in words[i:i + n]] == heard]
    assert len(hits) == 1, (heard, hits)
    old = words[hits[0]:hits[0] + n]
    words[hits[0]:hits[0] + n] = [{"w": said[0], "s": old[0]["s"], "e": old[-1]["e"]}] if len(said) == 1 else [{**o, "w": w} for o, w in zip(old, said)]
stamp = lambda x: (lambda ms: f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}")(round(x * 1000))
with open("../audio_raw_v2.srt", "w", encoding="utf-8") as f:
    for i, w in enumerate(words, 1): f.write(f"{i}\n{stamp(w['s'])} --> {stamp(w['e'])}\n{w['w']}\n\n")

lead = max(0, words[0]["s"] - LEAD_IN)
shifted = [{"w": w["w"], "s": round(w["s"] - lead, 3), "e": round(w["e"] - lead, 3)} for w in words]
json.dump(shifted, open("words.json", "w", encoding="utf-8"), indent=0)
open("words.js", "w", encoding="utf-8").write(f"window.WORDS = {json.dumps(shifted)};\n")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{lead:.3f}", "-i", "../audio_raw_v2.m4a", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "vo.m4a"], check=True)
print(len(words), "words, lead cut", round(lead, 3), "last word ends", shifted[-1]["e"])
