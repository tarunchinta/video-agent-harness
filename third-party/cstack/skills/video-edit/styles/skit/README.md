# Skits and memes

A short silent-acting reel where one line of on-screen text carries the joke, the
footage is the evidence, and a trending sound carries the energy. Nobody talks to the
camera, so the speech cut and the talking-head pack do not apply. What matters is
recognition ("that's literally me"), a payoff the viewer gets in under a second, and an
ending that loops. To match a specific posted reel, also read the
[recreation pack](../recreation/README.md).

Typical failure: a dead tripod shot, a hard cut and a small meme floating over a
backdrop.

## Why they spread

- **In-group recognition.** The caption names a specific pain of one audience
  (founders who never market, vibe-coded code nobody understands). Specific beats
  general: "3 AM", "another feature", "how our code works". Viewers share it to tag the
  person it describes, so these collect saves and sends relative to their length.
- **Self-deprecation, not advice.** The narrator is the butt of the joke. The post
  caption can add a second, lightly provocative line that invites replies.
- **Lo-fi but aspirational setting.** Real rooms (a hacker house, a coworking loft,
  friends around monitors), phone footage, natural light, no grade.
- **Instant read, then loop.** 6–16 s. The text is on screen from frame one so the
  joke lands before the viewer decides to scroll; the video ends on the payoff and
  restarts, so a second watch is nearly free.

## Patterns

| Pattern | Structure | Edit decisions |
| --- | --- | --- |
| Caption over one shot | A "Me at…"/"pov:" line over one held shot that shows the claim | No cuts. The picture proves the caption at a glance: screen visible, setting legible |
| Setup → meme cut | Real footage performs the setup; the subject mirrors a famous meme gesture to camera; cut to the meme doing the same | Leave the setup at the peak of the mirrored gesture, before the hand drops, on the sound's drop or beat. Setup about half the runtime. The caption stays through the transition and the meme |
| Time-stamp contrast | Two labeled lines that flip the claim ("9AM: …" / "10PM: …") over one shot of the second state, then a meme payoff | One take is enough; the second line is the joke and the footage shows it. Both lines on screen from frame one as separate boxes. The meme mirrors the action, not just a gesture (typing → a famous typing scene) |
| Numbered list | A persistent header ("5 phases of every startup") with one numbered line per shot, each shot a new location, lighting and mood | One 2.5–3.5 s static shot per item. Escalate, then break the pattern on the last item (drop the number, flip the mood) |

Other variants follow the same grammar: "nobody: / me:", a reaction cut-in,
before/after, or a dialogue-free POV with the camera as the other person.

## Text

Start from the platform's text-tool look (condensed grotesk, upper third) and make it
read instantly on a phone. Plain white outline text on a busy background reads as
unfinished; the in-app "background" style (black text on white rounded line boxes that
merge into one shape) fixes readability on its own, so it needs no colored highlight
on top. A closing emoji is optional.

- Size: about 3.5% of frame height per line, lines at most about 80% of frame width,
  centered, block center around 20–28% of height, above the subject's head. A list
  adds the item line in the lower third (around 74%).
- On screen from the first frame; change it only on a picture event (a list item swaps
  on its cut, an emoji lands on the meme cut). Keep the text in place when something is
  added (`--hang-emoji` with a `--hide-emoji` layer before the cut). The measured
  references used no word-by-word subtitles or animated type.
- Break lines where the comic pause falls.

`scripts/text_overlay.py` renders it (`--style box`); Resolve Text+ also works. The hardest frame is the busiest background or
the meme side of a cut.

## Sound

The sound is half the joke; find out what the reference uses before choosing.

- A fade into silence before a meme cut is the comic pause: keep it silent. Measure the
  reference's loudness envelope (RMS per 0.1 s) to find it. Boosted room tone or typing
  must fade out when the on-screen action stops, or it fills the pause with hiss.
- Match the reference's loudness (about -14 LUFS) and measure the export; limiter
  settings are in [technical.md](../../references/technical.md#voice-loudness-and-mixing).
- When the meme clip carries its own dialogue, the music plays under the setup and
  stops on the cut. Make the setup a whole number of bars so the cut lands on a
  downbeat, and level each half from its own measured loudness: a full-scale track next
  to raw film dialogue makes the punchline sound like a volume drop.
- When no sound is demonstrably trending for the format, say so and pick by meaning
  (for example the score from the meme's own film) rather than presenting a guess as a
  trend.
- Effects were rare in the measured references. One that marks the cut (a short bass
  hit on the cut frame, slightly ahead of the sound's attack) earns its place; whooshes
  or meme sounds over a sound that already carries the beat compete with it. When the
  user wants effects, tie each to a picture beat:
  - Explosion wipe: a fireball scaled to fill the frame hides the cut. Start it ~0.6 s
    before the cut so it covers the frame on the cut frame, play it at 2x so it clears
    before the meme's first line, and add a decaying shake.
  - Vine boom: a snap punch-in (~1.25x over two frames) on a reaction shot.
  - Key fire and other bright effects with `colorkey` (RGB distance). `chromakey`
    compares chroma only, so it leaves a white-hot core see-through, and `despill`
    turns it grey.
  - The effect's own sound fades out before the next line of dialogue.

## Camera and pace

Three viral references measured on 2026-10-07 used no speed ramps, digital zoom
punches, shakes, flashes, glitches or transitions beyond one dip to black. Their energy
came from the people and a handheld phone.

- Real speed. Repeated frames in those references came only from 30 fps sources in a
  60 fps file or a dim shot's variable frame rate. Speed up only dead time the
  reference doesn't have.
- Handheld, not locked off: the phone drifts slightly and pushes in about 6% over
  ~1.2 s as the subjects turn to the lens; one list item was a walking pan. A tripod
  shot looks dead beside that. Borrow a reference's path with `scripts/borrow_camera.py`
  ([recreation](../recreation/README.md)), or add a slow 3–4 px drift and an eased
  8–10% push toward the face on the turn-to-lens beat
  ([camera moves](../../references/technical.md#camera-moves-on-still-footage)).
- Setup → meme transition in the references: a dip through black (fade out ~0.25 s,
  about one black frame with the caption still showing, fade in ~0.25 s), timed to the
  sound's pause and its drop.
- The meme fills the frame. Crop the clip (or scale the keyed subject) until the face
  sits just under the caption and the body runs off the bottom edge; keep the source's
  own slow push and lower third. A small cutout floating over a backdrop reads as a
  sticker.

## Footage

- Pick the committed performance: a deadpan face at the meme moment, the gesture fully
  extended, no laughing or glancing at the phone; trim before any break of character.
  Glances are small at phone scale; an eye-region crop sheet shows them.
- Recognizers stall on room tone, typing and murmur, so choose takes visually; dense
  contact sheets (4–5 fps) around each gesture work.
- Keep the camera's natural color; HDR still needs the technical SDR conversion.
- Meme clips: prefer the studio's or official clip channel's upload (yt-dlp
  `ytsearch`), at least 720p, without burned-in captions; a green-screen copy keys over
  a blurred frame from the original event rather than a flat color. Find lines by
  transcription, since the score usually runs under the scene and silencedetect finds
  nothing. Crop inside the letterbox and any channel watermark. Use shots whose faces
  sit below the caption block; an off-camera repeat of a line can replace an on-camera
  shot the caption would cover. End the payoff on a line (a "Yes.") before the next
  action begins, unless that action is the joke. Record the source in the manifest.

## Quality bar

As a viewer: the joke reads in under a second, the text never covers the face or the
gesture, the cut lands on the gesture's peak, any push is smooth (`ref_motion.py` on
the export shows steady zoom per frame), and the last frame loops cleanly into the
first.
