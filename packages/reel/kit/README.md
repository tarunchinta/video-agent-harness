# How to build the film

The film is one HTML page, `film/index.html`, that can draw any moment of itself. You write the page; the
`render_stills` and `render_film` tools turn it into pictures and a video. Nothing else is needed: no video
editor, no timeline file.

## The contract

```html
<div id="stage">            <!-- the frame: always 1080 x 1920 -->
  ...scenes...
  <div id="captions"></div>
</div>
<script src="words.js"></script>      <!-- the voiceover's words and their times -->
<script src="kit/film.js"></script>   <!-- the runtime: do not edit anything in film/kit -->
<script>
const { cue, cueEnd, P, E, lerp, clamp, rng, $, css, show, fmt, svgEl, words } = Film;
const T = { hook: cue("first words of the hook"), number: cue("400,000") };
T.end = cueEnd("the last words");
Film.define({
  fps: 30,
  duration: T.end + 1.5,
  T,                                   // named cue times; render_stills takes one still per cue
  captions: { lines: ["First line,", "then the next."] },
  events: [{ t: T.number, sfx: "impact", gain: -6 }],   // optional sound effects
  draw(t) { /* set every style from t */ },
});
</script>
```

`film/index.html` starts as a small working example. Replace its scenes, cues and captions.

## Rules that keep a render correct

- **Draw from `t` alone.** `draw(t)` is called for every frame, in any order, by several browsers at once. The
  same `t` must always give the same frame. No `Math.random` (use `rng(seed)`), no `Date`, no CSS animations or
  transitions, no state carried from one call to the next.
- **Time everything off the voiceover.** `cue("phrase")` is the second the phrase starts in `words.json`;
  `cueEnd("phrase")` is when it ends. Use `cue("phrase", 1)` for the second time a phrase is said. A phrase that
  is not in the voiceover stops the render with an error naming it.
- **Captions follow the recording word for word.** Each caption line is a sense unit, and all the lines together
  must be exactly the words in `words.json`, in order. Punctuation and capitals are yours. A line that does not
  match stops the render with an error that quotes what the voiceover says there.
- **No network.** Fonts in the sandbox: Inter, Noto Sans and Serif, Liberation, Noto Color Emoji. Draw
  everything with HTML, CSS, SVG or canvas. Do not link to anything on the internet and do not use footage,
  logos or photos you did not make.
- **Keep text readable on a phone.** Body text 44px or larger, labels 26px or larger. Keep important things out
  of the top 220px and the bottom 300px, where the platform draws its own interface.

## Helpers

| Helper | What it does |
|---|---|
| `P(t, start, dur, ease)` | Progress from 0 to 1 of a move that starts at `start` and takes `dur` seconds |
| `E.out`, `E.in`, `E.inOut`, `E.back`, `E.lin` | Easing curves |
| `lerp(a, b, p)`, `clamp(x, a, b)` | Mix two numbers; keep a number in range |
| `show(el, on)`, `css(el, {...})`, `$("id")` | Show or hide; set styles; get an element by id |
| `svgEl(tag, attrs, parent)` | Make an SVG element |
| `rng(seed)` | A random source that repeats |
| `fmt(n)` | `12,345` |
| `words` | The voiceover: `[{ w, s, e }]`, times in seconds |

A common shape: one `<div class="scene">` per beat, shown while `t` is between two cues, with the pieces
inside it moved by `P(t, T.something, 0.5)`.

## Sound effects

An event `{ t, sfx: "name", gain }` plays `film/sfx/name.flac` (or `.wav`, `.mp3`) at second `t`, with `gain`
in decibels. There are no sound files to start with. You can make simple ones with ffmpeg through
`run_command`, for example a short low thump:

```
ffmpeg -f lavfi -i "sine=frequency=60:duration=0.35" -af "afade=t=out:st=0.05:d=0.3" film/sfx/impact.wav
```

## Working order

1. Write the scenes and cues. Call `render_stills` and look at the contact sheet.
2. Fix what is wrong: overlapping text, things cut off, a beat that lands on the wrong word, empty frames.
   Ask for stills at exact seconds to look closely at one moment.
3. When the stills are right, call `render_film` once. It takes a few minutes and ends this revision.
