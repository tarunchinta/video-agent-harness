# Reel recreation

Rebuild a posted reel's structure with the user's footage: the same beats, timing,
text position and camera behavior, a new performance. Name the reference's styles in
the [style index](../README.md) and follow their packs for the craft; this pack covers
measuring and matching.

## Measure first

Public Instagram, TikTok and YouTube posts usually download without login; pass no
browser cookies.

```bash
uvx yt-dlp -o "refs/%(id)s.%(ext)s" --write-info-json URL      # info.json has likes, comments, caption
ffmpeg -i REF -vf "select='gt(scene,0.25)',showinfo" -f null - 2>&1 | grep -o 'pts_time:[0-9.]*'   # hard cuts
ffmpeg -i REF -af silencedetect=noise=-40dB:d=0.3 -f null - 2>&1 | grep silence_   # audio dips before a drop
ffmpeg -i REF -vf "fps=2,scale=360:-1,tile=8x4" -frames:v 1 sheet.jpg   # tile n = n/2 seconds
```

Lower the scene threshold to 0.05 when a known cut is missed. Measure text position
and size on one full-resolution frame; when `drawtext` is missing, count tile
positions instead of stamping timecodes.

Identify the music (unofficial Shazam client; needs network):

```bash
ffmpeg -i REF -vn -ac 1 -ar 44100 ref.wav
uv run --with shazamio python -c "import asyncio,sys;from shazamio import Shazam;t=asyncio.run(Shazam().recognize(sys.argv[1])).get('track') or {};print(t.get('title'),'|',t.get('subtitle'))" ref.wav
```

Edited meme sounds (a song cut into a clip's own audio) usually return nothing or only
the second half; try each half separately, and otherwise treat the reference's own
track as the sound.

Measure camera moves, speed changes and transitions with `scripts/ref_motion.py REF`
(the `uv` line is in its docstring) so the edit adds only what the reference does. A
dip to black shows as luma falling to near 0 over a few frames, and the shot table
splits there.

## Match

- Match cut times and duration; then the reference's sound lines up as-is, baked in or
  added in the app ("Use audio" on the reference, the export's original volume at 0).
  In-app keeps the credit and the link to the trending sound; a baked-in copy is
  self-contained but may be muted or limited if the platform flags the music. For a
  finished post, deliver the mix and, when asked, a music-free version.
- Keep the reference's words unless the user wants new copy. New copy keeps the
  structure and gesture and aims at the user's own life with a concrete detail; judge
  options rendered on the actual frame.
- When the recreation matches the reference's length, lift its handheld camera path
  frame for frame with `scripts/borrow_camera.py` (anchor on the evidence, such as a
  laptop screen).
- When the footage cannot support the structure (a five-location list shot in one
  room), say what is missing and give a shot list instead of faking variety with crops.
- Borrowing a creator's look for a speech edit takes layout, captions, pacing and
  entries from their clips, never their footage.

## Quality bar

A frame strip at the reference's cut times matches its framing and transitions; the
duration matches when its sound will be reused; `ref_motion.py` on the export shows
the intended moves and nothing extra.
