"""Times every word of a voiceover. Runs inside the sandbox, with the model that is built into the image.

    python kit/align.py <audio file> <words.json> [--vocabulary "Name One, Name Two"]

Writes a list of {"w": word, "s": start, "e": end} in seconds, and prints one JSON object on the last line:
{"ok": true, "words": 212, "duration": 71.4, "language": "en"} or {"ok": false, "error": "..."}.
"""

import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("out")
    parser.add_argument("--vocabulary", default="")
    args = parser.parse_args()

    model_dir = os.environ.get("HARNESS_WHISPER_MODEL", "")
    if not model_dir or not os.path.isdir(model_dir):
        print(json.dumps({"ok": False, "error": "the sandbox image has no speech model; rebuild it with: docker build -t harness-sandbox:local packages/sandbox-docker/image"}))
        return 1

    from faster_whisper import WhisperModel

    model = WhisperModel(model_dir, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        args.audio,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
        # Names and terms the recording uses, so they are spelled the way the script spells them.
        hotwords=args.vocabulary or None,
    )
    words = []
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if text:
                words.append({"w": text, "s": round(float(word.start), 3), "e": round(float(word.end), 3)})
    if not words:
        print(json.dumps({"ok": False, "error": "no speech was found in the recording"}))
        return 1

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(words, handle, ensure_ascii=False, indent=0)
    print(json.dumps({"ok": True, "words": len(words), "duration": round(float(info.duration), 3), "language": info.language}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # the caller reads the last line, so always leave one
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"[:1500]}))
        sys.exit(1)
