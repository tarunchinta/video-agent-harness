# cstack

These are the skills that I use almost every day. I am always adding more skills here. The skills here have saved me hours on on workflows. lmk your experiences with them and drop any feedback! These skills are also refined quite often.

## Skills

| Skill | What it does |
| --- | --- |
| [reflect](skills/reflect/SKILL.md) | Reviews outcomes and efficiency, shows findings before asking for feedback, and proposes improvements for approval. Works with completed, incomplete, and unsuccessful sessions. |
| [rsi](skills/rsi/SKILL.md) | Tests changes to agent skills, instructions, tools, and working processes against the current version, with bounded runs and evidence for keeping or rejecting each change. |
| [video-edit](skills/video-edit/SKILL.md) | Edits talking-head videos, reels, skits, recreations, demos, and screen recordings. Covers audio recovery, take selection, supporting visuals, captions, Resolve or FFmpeg edits, and final-export checks, with optional style packs per format. |
| [animated-video](skills/animated-video/SKILL.md) | Makes animated videos in code with Remotion, in 2D or 3D: explainers, character stories, motion graphics, kinetic type, and animated infographics. Finds inventive pictures with a separate brainstorm and picker, picks a visual style from side-by-side style frames (optional style packs give head starts), gets a key-frame board approved, times everything from the voiceover, animates in parallel with sound cued to picture events, and reviews renders by frames and audio measurements. |
| [video-script](skills/video-script/SKILL.md) | Brainstorms short-form video ideas and writes scripts from the creator's own analytics: who has a stake, a hook that lands in 3 seconds, a second sentence that keeps viewers, and proof on screen. Also turns posted-video insights into lessons, with a script that reads retention curves from screenshots. |
| [asset-library](skills/asset-library/SKILL.md) | Keeps one local library of reusable footage, images, music, sound effects, characters, animation code and 3D sets across projects. Agents search it before sourcing or building, register something as a versioned bundle when another project is about to reuse it, and can record which version a delivered cut used. |

Each skill lives in its own directory under `skills/` and can be installed separately.

## The video skills together

video-script writes the script and stops. video-edit makes edits of camera footage;
animated-video makes films drawn in code. The deliverable decides which of the two owns the
final timeline: an edit with animated shots is video-edit's, and animated-video builds the
shots to its brief; an animated film is animated-video's, even with one camera insert.
asset-library is shared by both.

Every one works alone. Without asset-library, video-edit and animated-video keep a manifest
in the project instead of a shared library, and nothing else changes. Install all four to get
reuse across projects.

## Install

Clone the repository:

```sh
git clone https://github.com/goodnight000/cstack.git
cd cstack
```

Choose a skill, then link it into your agent's skills directory. Run the appropriate commands from the repository root.

```sh
skill_name=reflect  # or rsi, video-edit, animated-video, video-script, asset-library
```

To install the video skills together, run either block below once per name in
`video-script video-edit animated-video asset-library`, or wrap it in
`for skill_name in video-script video-edit animated-video asset-library; do … done`.

For Codex:

```sh
mkdir -p "$HOME/.codex/skills"
test ! -e "$HOME/.codex/skills/$skill_name" && \
  ln -s "$PWD/skills/$skill_name" "$HOME/.codex/skills/$skill_name"
```

For Claude Code:

```sh
mkdir -p "$HOME/.claude/skills"
test ! -e "$HOME/.claude/skills/$skill_name" && \
  ln -s "$PWD/skills/$skill_name" "$HOME/.claude/skills/$skill_name"
```

If the selected skill is already installed, compare and back up that version before replacing it. If both agents share a skills directory, install once. You can copy the folder instead of linking it; a linked installation follows changes in this checkout. Reload your agent session after installation if needed.

## Use Reflect

Ask your agent:

```text
Use the reflect skill to review this session, including the result and any avoidable effort.
Show me the findings and proposed changes before editing reusable instructions.
```

You can also name other threads and a time window when your agent has access to their history. Reflect does not provide its own history connector.

The review separates consequential findings from changes worth adding to reusable guidance. It can report an inefficiency without recommending another rule. It asks for approval before editing instructions and does not authorize publication, memory changes, or resuming the reviewed task.

## Use RSI

```text
Use the rsi skill to test one improvement to this agent workflow.
Reuse our Reflect findings, compare with the current version, and state a bounded
experiment plan. Keep installed instructions unchanged until I approve adoption.
```

RSI uses the project's existing runners and checks. It can reuse Reflect when installed,
or reconstruct the necessary evidence directly. It adds no background service or test
platform. Give it the task, experiment budget, and adoption scope; it preserves those
bounds across the work. A successful local comparison is evidence for the tested scope,
not proof of unlimited recursive improvement.

## Use Video Edit

```text
Use the video-edit skill to edit the footage in this project.
Start from the latest accepted version and the brief. Preserve complete takes,
use supporting visuals that match the spoken claims, and check the actual export.
```

On first use the skill runs `scripts/preflight.py`, which checks for FFmpeg,
Python 3, and [uv](https://docs.astral.sh/uv/), which runs local transcription
(Phonon on Apple silicon, Whisper elsewhere).
It shows the install command for anything missing and runs it only if you agree.
[DaVinci Resolve](https://www.blackmagicdesign.com/products/davinciresolve) (free)
is recommended for a native, editable project; without it the skill renders with
FFmpeg. Browser research and publishing need browser tools and your accounts.

With no brief, the skill asks where the video will be posted, how long it should
be, and whether you want music, sound effects, or a hook headline, then follows
its [talking-head style pack](skills/video-edit/styles/talking-head/README.md). To keep
your own defaults across updates, put them in `~/.video-edit/profile.md`.

Of the bundled [sound effects](skills/video-edit/assets/sfx/README.md), 33 are
CC0 Freesound recordings; the other 28 are not covered by the MIT license and
their sources and unverified rights status are listed in their catalog.

## Use Animated Video

```text
Use the animated-video skill to turn this script into an animated video.
Confirm the format and show me one style frame before building the full piece.
```

For the best results, run it with the strongest model you have at high effort. Short
pieces take one agent; longer films can animate in parallel, with fresh agents judging
the cut and a mute test before you see it.

The skill needs a shell, Node.js with Remotion, FFmpeg/ffprobe, and Python 3
with faster-whisper for word timings. Voiceover comes from the user or a
separate tool. Music and effects come from the user's files, on-disk samples
such as the video-edit sound library, or sound synthesized in code. The template holds style-neutral
infrastructure only (timing, camera, still and render scripts, synthesis helpers). Optional
parts from past films (a globe with a cable web, an iPhone running iMessage, synthesised sound
effects) sit beside it to copy and restyle. Characters, art direction, and creative defaults are
designed per project or supplied by you.

For photoreal or physically detailed worlds, the skill reads its realistic-3D style pack for scale,
materials, light and motion, chooses between three.js in Remotion and an optional
[Blender](https://www.blender.org/) render, and gets one moving test shot accepted before the
full build. For the three.js route it starts from a tested realism kit in `templates/parts/`:
sky and sun with environment lighting and haze, shadows that hold still under a moving camera,
seeded grass, trees and stone, frame-driven wind, and cause-driven weathering. A runnable outdoor
example shot ([examples/realistic-3d](examples/realistic-3d/README.md)) renders at under half a
second per 720p frame and checks that re-rendered frames are identical. It is a detailed 3D
starting point that still reads as CGI, not photographic quality.

Asked by video-edit (or by you) for a single animated or 3D shot inside a camera edit, it skips
the story steps, works to the edit's frames and returns the clip with its sound events.

## Use Asset Library

```text
Use the asset-library skill to set up a library for my video projects.
Before sourcing anything for this edit, search it, and register anything another project will reuse.
```

The library is one SQLite database plus your files, under one folder you choose, driven by
`scripts/library.py` (Python 3, FFmpeg for probing and previews). There is no server. Media is
versioned by content hash; characters, code and 3D sets are snapshotted as bundles with their
files, dependencies, an example, a preview and a validation command, so a cut recorded with a
version can always find what it used. When you want the record, the producing skill declares which
library entries a delivered cut used, and the check confirms each has a use for that cut and version;
whether an asset was worth keeping stays your call. Put the library's location and
your reuse rules in `~/.asset-library/profile.md`.

## Use Video Script

```text
Use the video-script skill to brainstorm ideas for my next video.
Rank them by who has a stake, and give each a hook, a second sentence, and what we'll show.
```

It works best with a library of your past videos and their analytics: one Markdown
file per video plus an index, in the [library format](skills/video-script/references/library.md).
Point the skill at it, and at your voice and pace, in `~/.video-script/profile.md`.
To review a posted video, give it the insights screenshots; it reads the retention
curve with `scripts/retention_curve.py` (Python 3 with Pillow and numpy) and
checks the reading against the app's average watch time.

## Evaluation

[Reflect's evaluation cases](skills/reflect/evals/evals.json) cover feedback, constructive pushback, unnecessary repeat checks, necessary investigation, findings that warrant no instruction changes, and keeping one project's output from becoming a default when it seeds a new skill.

[Animated Video's evaluation cases](skills/animated-video/evals/evals.json) cover locking the format before building, treating a past film as evidence rather than a template, and making an explainer without a reference video.

[RSI's evaluation cases](skills/rsi/evals/evals.json) cover missed skill discovery, exposed final tests, altered graders, authorized local adoption, creative judgment, and unproven improvement of the improvement process.

To assess behavior, give an independent agent `SKILL.md`, a case's request and session evidence, then its feedback at the appropriate point. Keep the case's `checks` hidden until reviewing the response. These are evaluation scenarios, not an automated test suite or a guarantee of future performance.

Run Video Edit's caption-helper check with Python 3:

```sh
python3 skills/video-edit/scripts/test_make_captions.py
```

This checks caption generation, time mapping, raw transcript preservation, and
known warning/error behavior. It does not validate a Resolve installation,
listening quality, visual taste, or an end-to-end video edit on your machine.

Run Asset Library's check, which builds a throwaway library in a temporary folder:

```sh
python3 skills/asset-library/scripts/test_library.py
```

It checks ingest and duplicate detection, bundle versions and their publishing, use recording,
the project check against a cut declaration, and that an older database is backed up and
migrated without losing rows. It says nothing about
whether the assets in your library are any good.

## Icons

[Charade](icons/README.md) is a set of line icons that act out what they mean. Each one plays a short
animation of its own verb when its button or link is hovered or focused: the lock unlocks, the
bell swings, the trash eats a crumb. There are 203 icons in plain SVG and CSS, with no
dependencies. Open `icons/index.html` from a local server to browse them.

## Contributing

Keep each skill self-contained and focused on a recurring need. Include examples or evaluation cases that expose meaningful mistakes. Keep transcripts, credentials, personal project history, and machine-specific paths out of published skills. For third-party contributions, preserve attribution and confirm license compatibility.

Skills stay general; personalization lives outside the repo, in each skill's `~/.<skill>/profile.md` and the files it points to. Before changing a skill, ask whether the change would be right for a stranger making their own videos. If so, write it here generically. If it is right only for you (your audience, taste, numbers, machine or accounts), put it in your profile. When it is both, split it: the general rule here, your value and the evidence behind it in your profile. Bundle only assets whose license allows redistribution, and keep the creator's own footage, likeness and personal media out.

## License

[MIT](LICENSE).
