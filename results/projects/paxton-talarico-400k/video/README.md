# "The 400,000 Missing Votes": HTML video, first pass

A 9:16, 30 fps film built as one HTML page (`index.html`). Every frame is drawn from a time `t`,
and every beat's timing comes from a word in the voiceover through `cue("phrase")`. Swapping in new
word timings re-times the whole film.

**Timing comes from the real voiceover.** `vo.m4a` is `talarico draft recording.m4a` from the project folder with
its leading 4 s of silence cut (it starts at 3.99 s, so the first word lands at 0.25 s). `words.json` / `words.js` come
from `talarico-draft-recording.srt`, shifted by the same 3.99 s; cues that held two words ("Ken Paxton",
"Houston,40") are split, with the time divided by length. The recording says "fewer votes" where the script says
"fewer voters", so the cue and caption follow the recording.

## Commands

```sh
npm install                      # playwright-core only; uses the pre-installed Chromium
python3 standin_words.py         # regenerate the stand-in words.json + words.js
node render.mjs --stills         # one still per cue -> out/stills/sheet.png (the key-frame board)
node render.mjs --stills 3 12.5  # stills at given seconds
node render.mjs                  # full film -> out/film.mp4 (sound effects, plus vo.m4a if present)
node render.mjs --mute           # no captions, no sound, for the mute test
```

Preview: serve this folder (`npx serve .` or `python3 -m http.server`) and open `index.html`.
It has play and scrub controls and plays `vo.m4a` in sync when the file is there.

## Swapping in the real voiceover

1. Copy the recording here as `vo.m4a`.
2. Align it with the animated-video skill's `align.py` (faster-whisper), which writes `src/words.json`:
   `python align.py vo.m4a "Paxton, Cornyn, Talarico"`. Move the result to `words.json` here.
   Fix whisper's merges by hand (numbers such as "400,000" and "40.5" must stay one token each).
3. Regenerate `words.js`: `python3 -c "import json;open('words.js','w').write('window.WORDS = '+json.dumps(json.load(open('words.json')))+';\n')"`.
4. Load `index.html`. A cue phrase or caption line that no longer matches the recording throws an
   error naming it. Fix `LINES` / `T` in `index.html`, then delete the `#standin` badge and re-render.

## Colour code (one meaning each, for the whole film)

- **Amber:** the 400,000, meaning Cornyn's March voters and the one voter we follow. Brightest thing in frame.
- **Crimson:** Paxton. **Blue:** Talarico / Texas turning blue. Ink and paper carry everything else.

## Open items

- **Headline clipping (beat 4) is a placeholder**, drawn in code with no outlet name. Swap in the
  sourced screenshot of the endorsement coverage.
- **Midterm shrink (beat 5) is illustrative.** No 2026 turnout number is shown or implied.
- The Texas outline is a simplified hand-plotted polygon. Swap in a proper vector if it needs to be exact.
- `fluid-chart` and `headline-screenshot` skills named in `VISUALS.md` aren't in the repo; bars
  morph with eased interpolation instead.
- Sound effects are CC0 (see `sfx/CREDITS.md`). There's no music bed yet.
