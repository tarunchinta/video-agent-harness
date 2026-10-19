# Resolve workflow and recovery

Native assembly, speed revisions, render automation and console failures. Observed on
Resolve 21.1 for macOS in September 2026; check the installed SDK when methods differ.

## Set up

DaVinci Resolve is free from Blackmagic Design; the installer needs the user. How
scripts reach it depends on the edition:

- **Free Resolve** runs scripts only from inside the app (Workspace > Console, or the
  Workspace > Scripts menu). With the app running, the bundled `ResolvePython` and
  `fuscript` both got `None`/`nil` from the shell. Plan on driving the console
  ([below](#access-the-native-application)).
- **Resolve Studio** can also take scripts from the shell once the user sets
  Preferences > System > General > External scripting to Local (per the installed
  scripting README; not yet verified here). Run them with the bundled `ResolvePython`
  (macOS `…/DaVinci Resolve.app/Contents/Applications/ResolvePython`, Windows
  `…\DaVinci Resolve\ResolvePython\ResolvePython.exe`, Linux
  `/opt/resolve/bin/ResolvePython`) and check that `scriptapp('Resolve')` is not `None`.

Scripts under the user's `Fusion/Scripts/Utility` folder appear in Workspace > Scripts
after a restart (macOS `~/Library/Application Support/Blackmagic Design/DaVinci
Resolve/Fusion/Scripts`; Linux `~/.local/share/DaVinciResolve/Fusion/Scripts`; Windows
`%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts`). The SDK reference
is usually under `/Library/Application Support/Blackmagic Design/DaVinci
Resolve/Developer/Scripting/` on macOS; read its README before guessing methods.

## Access the native application

Use the supported computer-use API for UI controls. Open Workspace > Console from fresh
UI state, write a small local Lua file, and run `dofile('/absolute/path/script.lua')`
in the console. `io` was unavailable there; `dofile`, `print` and `dump` worked.
Focus the console input explicitly and replace only your command: user typing and focus
changes can leave partial text in it. Once the console works, batch deterministic edits
in one script with postcondition checks rather than many UI round trips.

Misleading behaviors that need explicit postcondition checks:

- `CreateCompoundClip` returned nil even though it created the compound. Check the
  timeline on the next call before retrying.
- A native-pipe error sometimes arrived after a script completed. Inspect console output
  and timeline state before running it again.
- Menu indices shift after page changes; a stale index opened Fairlight or Fusion. Read
  fresh UI state after every project, page or menu change and use the new identities.
- Timeline import sometimes hid the console, and reopening it from the menu did nothing.
  After one failed reopen and a state check, the fix was: save, quit Resolve normally,
  reopen, select the project in Project Manager, reopen the console. Keyboard selection
  worked where window coordinates failed. Do not restart routinely.

## Build one editable timeline

Keep the normal-speed cutlist in integer timeline frames, with source in/out positions
separate from record positions and final playback times. The source may be 60 fps while
the timeline is 30 fps; use the timebase the import format requires.

Mute the original camera audio when a mastered dialogue track replaces it. Keep caption
text and timing in JSON plus SRT even when transparent PNGs carry the compositing; PNG
text is not editable text.

A checked FCP7 XML imported through `MediaPool:ImportTimelineFromFile` placed clips
exactly. Direct still appends defaulted to five seconds despite the supplied duration.
Assert imported start, end, duration and track counts, and use non-overlapping integer
spans: a two-frame overlap shifted an appended clip's start.

## Speed and ripple corrections

Save the fully layered normal-speed XML and project, then make one compound so a single
speed change moves camera, overlays and captions together. Remove duplicate source audio
and duplicate stems from the delivery copy before compounding: regrouping can re-enable a
muted track. Afterwards, check there is one picture item and one linked master audio
item with the intended tracks enabled, and verify the exported mix, not item names. If
stem routing is uncertain, keep the stems in the layered timeline and deliver an explicit
premix.

```lua
local c=t:GetItemListInTrack('video',1)[1]
assert(c:SetSpeed({Percentage=110.0,PitchCorrection=true,RippleTimeline=true}))
```

Set speed once, relative to the normal-speed compound. Compare `GetSpeed().Percentage`
within a tolerance (`math.abs(actual-110)<0.001`); exact float equality failed even when
the printed value matched. Read the native duration after retiming: 1988 frames at 115%
became 1728, not the predicted 1729. Allow under one frame of rounding and use the
observed end for sidecars. If an assertion fails after the mutation, inspect
`GetSpeed()` and the duration, then resume from that state instead of reapplying.

For a source trim, remove the interval on the normal-speed timeline and ripple camera,
audio, captions and visuals together; derive final times from the native frame-rounded
result and clamp to its end. Check imported still in/out values separately from timeline
start/end. Never re-encode a prior lossy final to change speed: reuse the camera or
normalized source windows and the editable composition.

## Visual-only revisions

Duplicate the accepted timeline, remove only the replaced visual clips with
`DeleteClips(items, false)`, and append replacements at explicit integer frames;
assert the actual start, end and counts afterwards. Deliberate image overlaps can live
inside one transparent overlay clip with its source manifest. The camera stays natively
editable.

Reuse the approved PCM mix when sound and timing are unchanged, keeping the disabled
source stems. If only the previous export holds the accepted mix, decode it once to PCM
and note the lineage; keep a lossless mix master for future work. Trim to picture
duration in samples and import at unity on one enabled track. Do not rebuild pitch
correction for an imagery-only change: repeated native renders can differ in phase
without new speech. Compare decoded PCM (allowing for codec padding) before reusing
speech QA.

## Render and verify

Set the render format and codec explicitly after importing a timeline; the remembered
format was not reliably H.264.

```lua
assert(p:SetCurrentRenderFormatAndCodec('mp4','H264'))
assert(p:SetRenderSettings({
  SelectAllFrames=true, TargetDir=target, CustomName=name,
  FormatWidth=1080, FormatHeight=1920,
  ExportVideo=true, ExportAudio=true, VideoQuality=18000,
  AudioSampleRate=48000, NetworkOptimization=true
}))
assert(pm:SaveProject())
local job=p:AddRenderJob(); assert(job)
assert(p:StartRendering({job}))
```

Wait for `GetRenderJobStatus(job)` to say Complete, then check the file's picture and
audio duration and speed. Save the project and leave the Edit page open on the current
version.

FCP7 XML exported from an outer compound had an empty compound media path and could not
recreate it on reimport. Keep the layered normal-speed XML as well as the DRP, and call
an XML portable only after testing its reimport. These snippets illustrate single
operations, not a complete assembler; reuse operations, not old frame counts, paths or
UI indices.
