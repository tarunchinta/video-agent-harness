# Local media reference

## Probe and transcribe

```bash
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,sample_aspect_ratio,pix_fmt,sample_rate,channel_layout:stream_tags=rotate:stream_side_data=rotation:format=duration -of json IN
ffmpeg -v error -i IN -vn -ac 1 -ar 16000 audio.wav
# English on Apple silicon (Phonon-2):
uv run "SKILL_DIR/scripts/transcribe.py" audio.wav --output-dir .
# Unsupported language, or a concrete failure that survives Phonon retries:
uvx --from mlx-whisper mlx_whisper audio.wav --model mlx-community/whisper-large-v3-turbo --word-timestamps True --condition-on-previous-text False --output-format json --output-dir . --verbose False
# Other hosts (Intel macOS, Linux, Windows):
uvx whisper-ctranslate2 audio.wav --model large-v3-turbo --word_timestamps True --output_format json --output_dir . --verbose False
```

All three write `segments[].words[].{word,start,end}`, the caption helper's input;
`preflight.py` prints this host's default. Phonon re-decodes suspected omissions in
shorter windows and stops on gaps it cannot resolve: review those windows against the
audio and retry with context. An independent QA transcript is a fresh decode of the final audio into a separate file,
not a second model. Encoded width and height can describe a rotated source wrongly;
probe rotation and the displayed geometry.

ASR suppresses repeated words across adjacent takes, hallucinates over silence, misses
weak onsets, stretches timestamps over padding and misspells names. Keep the raw
transcript beside your corrections, and never repair a missing spoken word by editing
captions; recognition is not proof of an intact phoneme. For pause
candidates use `silencedetect=noise=-35dB:d=0.25`, adjusted to the noise floor, as a
search aid rather than a rule to delete every pause.

## Repeated-speech checks

`scripts/restart_scan.py` splits each selected segment at its pauses and flags speech
that repeats what came just before; it catches the restarts whole-clip ASR merges. Its
flags are candidates: confirm with the envelope and a listen.

- First survey of a long take-heavy recording: transcribe per speech island (split at
  silences) with previous-text conditioning off. Whole-file decoding with conditioning
  on has looped one sentence for ten minutes, and chunked decoding still merged restarts.
- A word with an implausibly long timestamp may hide repeated speech; inspect the audio.
- At each join, decode overlapping windows that contain the outgoing phrase, the join
  and the first phrase of the incoming clip. Words at clipped window edges are suspect.
  Tiny windows localize a repeat but can hallucinate too: reconcile conflicts against
  source context, waveform and listening, then verify the combined join again.

## Camera moves on still footage

`zoompan` rounds its crop to whole pixels and jitters on slow moves. Use `perspective`
with `eval=frame` and cubic interpolation for subpixel push-ins and drift. With zoom
`Z(t)` toward point (ax, ay) on a WxH frame, the source corners are `x0=ax*(1-1/Z)`,
`y0=ay*(1-1/Z)`, `x1=x0+W/Z`, `y2=y0+H/Z`; time is `in/FPS`. Quote each expression in
the filtergraph (`x0='…'`) because they contain commas. Ease with
`u=clip((t-start)/dur,0,1)`, `u*u*(3-2*u)`. For handheld drift, add two summed sines of
3–4 px at 0.3–0.8 Hz to x0 and y0, and start at zoom 1.02 so the edges never show. To
copy a reference reel's handheld path instead, use `scripts/borrow_camera.py`.

## Shell gotchas in build scripts

- Caption copy with an apostrophe breaks `${TEXT:-I can't…}` in bash. Assign it first:
  `CAPTION="I can't…"; TEXT=${TEXT:-$CAPTION}`.
- In zsh, `"$k[out]"` is an array subscript. Write `"${k}[out]"` when a variable holding
  a filter sits right before a filtergraph label.
- `bc` prints `.70` without a leading zero. FFmpeg accepts it, but integer millisecond
  delays need `$(echo "$T*1000/1" | bc)`.
- Overlay cues looked up by phrase (`at("company")`) match the first occurrence, and
  punctuation-blind matching makes "startup." equal an earlier "startup". When a phrase
  is said more than once, pass the occurrence, or make the lookup throw on ambiguity as
  the animated-video template's `cue()` does.
- Run full-length renders and transcription as background jobs at capped parallelism
  (Remotion `--concurrency`, transcription in chunks). A foreground job killed for
  memory (exit 137) can end the agent session with it; the same job at lower load
  usually finishes.

## Quiet external audio and separate recordings

Measure channels independently before mixing or adding gain: a stereo file can hold one
silent channel and usable speech on the other. Check speech level, noise and isolated
peaks across the recording; one peak near full scale does not mean the speech is loud
enough, and fixed gain can clip it. Recoverable speech is a reason to try salvage
(channel extraction, gentle filtering, adaptive gain) before suggesting a retake.

- Downmix stereo by averaging (`pan=mono|c0=0.5*c0+0.5*c1`). Summing raises identical
  channels by 6 dB and `-ac 1` by about 3 dB (measured); either clips a voice that
  peaked near full scale.
- Process in floating point and write integer PCM once, at the end; a filter applied to
  an already clipped 16-bit file clips again. Check the edited voice for full-scale
  samples and flat-topped runs before mixing, and measure the encoded copy as well as
  the PCM master: AAC overshoot can need more headroom.

Sync to camera reference audio with a coarse offset from speech envelopes, refined on
waveform windows. Check several positions per recording for drift, and never carry one
offset across unrelated camera files; encoder start timestamps and decoded sample
positions differ. With silent video, match distinctive mouth movements and reactions to
the transcript and audio, record the uncertainty, and ask the user for an anchor only
when the evidence cannot resolve it. Transcript similarity alone cannot prove sync.

## Source color and storage

After a storage failure, resume only the failed stage and reuse finished transcripts
and surveys; never delete originals or unrelated files to make room.

iPhone HLG and Dolby Vision turn washed out through the wrong transform. Compare a short
export against the source before finishing. One checked workflow normalized the
selected full-resolution windows (half-second handles) with:

```text
zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:peak=10:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p
```

encoded upright 1080x1920/60 fps with H.264 VideoToolbox at 40 Mbps tagged BT.709, then
used an unmanaged Rec.709 Gamma 2.4 Resolve timeline (`davinciYRGB`) to avoid a second
HDR transform. That worked for one source; it is not a universal LUT. Some
FFmpeg builds lack `zscale` and `drawtext` (check `ffmpeg -filters`). On macOS,
`avconvert -s IN -p Preset1920x1080 -o OUT --start S --duration D` gives upright BT.709
SDR with Apple's tone mapping, matched to the source by eye once; its trims land tens
of milliseconds off, so re-sync each window by audio cross-correlation. Keep the
original HDR media, and reuse normalized windows for revisions that stay inside their
handles.

## Cut and render

For synchronized cuts, write an FFmpeg filter file from the cutlist:

```text
[0:v]trim=start=A:end=B,setpts=PTS-STARTPTS[v0];
[0:a]atrim=start=A:end=B,asetpts=PTS-STARTPTS,afade=t=in:d=0.005,afade=t=out:st=DUR_MINUS_008:d=0.008[a0];
...
[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]
```

Snap `A` and `B` to frame boundaries (multiples of 1/fps) so each segment's picture and
audio have the same length. Micro-fades reduce clicks; keep them short enough to keep
consonants. For split edits, concatenate each track separately and check that the
totals match. Match fps, dimensions, SAR, audio layout and sample rate across
concatenated sources.

Starting settings for final social delivery (current FFmpeg reads a filter file with `-/filter_complex`; newer builds
dropped `-filter_complex_script`):

```bash
ffmpeg -i IN -/filter_complex filters.txt -map '[vout]' -map '[aout]' -c:v libx264 -crf 19 -preset medium -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart master.mp4
```

An upload copy can use CRF 23 and AAC 128k. Make every variant from the same
high-quality source rather than chaining lossy transcodes.

Speed changes apply to video, audio, captions and overlays alike; source seconds are not
output seconds afterwards. Stretchers differ audibly on speech: in one measured case at
1.15x, `atempo` kept 95% of the transient energy over a speed-up-and-back round trip,
against 86% for rubberband R3 and 69% for R2. That was one source; yours may differ.

## Voice, loudness and mixing

Process a voice as little as it needs: a high-pass, one gain per take so lines sit
level, and a linear loudness pass. Compression lifts quiet syllables, breaths and room
tone, so add it only when the raw needs it. Before delivery, play the processed voice
beside the raw at matched loudness; people notice when their own voice sounds worse.

Start near -14 LUFS with peak headroom, e.g.
`highpass=f=70,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000`. On a quiet source whose
true peak already sits near the ceiling, `loudnorm` cannot reach the target linearly and
silently switches to dynamic mode: measure first (`loudnorm=print_format=json`) and, if
so, apply gentle compression and a limiter before a final linear pass. `alimiter` delays
its output by its lookahead (5 ms) unless `latency=1`, and its `level` option defaults
to auto-level, which raises the output after limiting; use `level=0:latency=1` when the
mix is muxed against picture. Measure the actual final export.

Place effects with `adelay` and mix without auto-normalizing:

```text
[1:a]volume=-10dB,adelay=500|500[s1];
[2:a]volume=-13dB,adelay=2400|2400[s2];
[speech][s1][s2]amix=inputs=3:normalize=0:duration=first[mix]
```

Delays are milliseconds in final output time; gains are starting points. For a bed the
user cannot hear, compare the stem, the intended mix and the export in matching speech
and pause windows. For brief effects, whole-clip RMS hides a strong transient: compare
~50 ms active windows with speech at the same instant. Native pitch correction can change
PCM between renders, so a hash mismatch alone does not locate a mix fault.

## Captions

For an FFmpeg/ASS path, use [make_captions.py](../scripts/make_captions.py); its
docstring defines the cutlist schema and the chunking rules.

```bash
python3 SKILL_DIR/scripts/make_captions.py audio.json cutlist.json captions.ass --expected expected.txt
python3 SKILL_DIR/scripts/test_make_captions.py   # dependency-free self-check
```

- Its sample margins are not a safe area: measure the face, the content and the
  destination's interface.
- Review every word it reports as clamped or lowercased. Its overlap warning does not
  fail the exit code; read the count and repair timing before burning.
- It shifts source time by each segment's offset but does not scale time: after a speed
  change, supply word timings in output time.
- Emphasis is not automatic: add ASS override tags to the chosen lines, and review text
  containing ASS control characters.
- Check that the last selected word survives the cutlist's boundary filter, and burn
  from a working directory where the subtitle paths resolve. Keep the uncaptioned render.

When overlays move, inspect captions at entry and exit boundaries as well as settled
frames: a caption that starts just before a layout change can run into the next visual.
Override that phrase's position rather than moving the whole track. Fit product crops
with contain when the whole silhouette matters.

## Visual geometry and evidence

For punch-ins, derive even crop dimensions from the zoom factor, anchor the crop on the
content, and recompute caption and overlay bounds afterwards. In a split edit the
picture join is not the audio join; inspect frames at the picture join.

When the brief limits reuse or coverage, count original identities across crops and
renames, and compute coverage as the complement of the union of visible overlay
intervals from 0 to the final duration, treating fades conservatively.

For a reported freeze, compare consecutive frames around the transition; for a reported
pause, inspect the audio around the join. Duplicate-frame and silence tests alone cannot
certify natural pacing.

## Delivery checks and caching

```bash
ffmpeg -v error -i OUT -f null -
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate:format=duration,size -of json OUT
```

Keep the final-audio QA transcript separate from caption inputs so a new ASR error
cannot rewrite checked captions. Reuse transcripts and caption timing after a
picture-only change only when the audio is proven unchanged (same artifact, identical
decoded PCM); a filename proves nothing.

Render only changed overlay scenes. A cache is valid when its source identity, timing
and layout inputs are unchanged, not because an output file exists: invalidate the
affected render after its manifest changes. Generate review sheets after their
full-size frames are ready (a stale thumbnail once caused a false subtitle report), and
confirm a suspected defect on the current full-size frame before rerendering. Sample
each delayed layer entry, not one frame per scene; stills never prove animation or
listening quality.

## Reusable media library

With the asset-library skill installed, its library is the index and its steps cover
search, ingest, registration, declarations and delivery. Without it, use the project's
existing index, or a small manifest beside the edit that records each asset's original
identity, source and licence, and where the cut uses it.

- Count source works separately from useful variants (one recording in source, extended
  and ducked forms). Exact hashes find identical files; audio duplicates need aligned,
  gain-normalized waveform comparison, and similar whooshes are not automatically
  duplicates.
- In sound compilations, inspect each onset and tail for neighboring sounds or
  truncation; mark uncertain effects provisional.
- Keep rejected candidates out of active selections while preserving files older
  projects use. Source provenance is not publication permission.

## Extending a short music recording

Find a musically matching phrase return and crossfade there instead of restarting the
track at its end. Preserve pitch for a small tempo fit, align intro and outro to the
final timeline, duck under speech, and keep a requested music-free hook silent in the
music stem. Loop length and crossfade depend on the recording; listen to the seam.

When ducking with `sidechaincompress`, pad the speech key with `apad` and trim the output
to the final duration with `atrim`: the filter stops when the key ends, silently dropping
the bed's tail and any fade scheduled there. Before mixing, confirm every stem is as
long as the picture.

## Cutting under a finished composition

When animation, cards and captions are already cued to the old timeline, a span removed
from the camera, cutout and dialogue can leave every layer untouched: map the composition
frame to the old ("story") frame (`story = f < CUT ? f : f + N`), pass that to the
layers, map effect cues back, and drop cues inside the removed span. Correct the word
timings ASR merged across the removed span first. Check the join's picture as well as
its audio: elements whose entrances fell inside the span appear already in place.

## Frame-rounded timing

Keep source positions, normal-speed record frames and final output frames separate. Edit
in integer frames and round only at conversions. After a removal, map every dependent
layer through the same interval; after a speed change, compare the predicted duration
with the native result and use the observed one. Read one current speed rather than
carrying per-item values from a previous version.

For final manifests, assert `0 <= start < end <= exported_duration`, caption bounds with
no unintended overlap, and matching picture and audio end frames. Leave a small margin
inside the brief's timing limits.
