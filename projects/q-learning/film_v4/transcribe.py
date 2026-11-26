"""audio_raw_v3.wav -> heard.srt, one word per cue, with WhisperX (the same model and aligner as scripts/transcription.py).

    python transcribe.py      (run from this folder; needs whisperx and ffmpeg)
"""
import whisperx

audio = whisperx.load_audio("../audio_raw_v3.wav")
model = whisperx.load_model("medium", device="cpu", compute_type="int8", language="en")
result = model.transcribe(audio, batch_size=8, language="en")
align, meta = whisperx.load_align_model(language_code="en", device="cpu")
segments = whisperx.align(result["segments"], align, meta, audio, "cpu", return_char_alignments=False)["segments"]


def stamp(x):
    ms = round(x * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


words = [w for seg in segments for w in seg.get("words") or [] if (w.get("word") or "").strip()]
# A word the aligner could not place (usually a digit) borrows the edges of its neighbours.
for i, w in enumerate(words):
    if "start" not in w:
        w["start"] = words[i - 1]["end"] if i else 0.0
        w["end"] = next((x["start"] for x in words[i + 1 :] if "start" in x), w["start"] + 0.3)
with open("heard.srt", "w", encoding="utf-8") as f:
    for i, w in enumerate(words, 1):
        f.write(f"{i}\n{stamp(w['start'])} --> {stamp(w['end'])}\n{w['word'].strip()}\n\n")
print(len(words), "words")
print(" ".join(w["word"].strip() for w in words))
