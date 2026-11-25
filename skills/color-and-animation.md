# Skill: color-and-animation

## When to use
Building the film page in the edit stage: choosing the background, the palette
and how things move. Read it before writing `film/index.html`.

## Background
It's a dark radial gradient with a vignette: a near-black base with a soft,
low-saturation teal-blue glow in the center that fades to pure black at the
edges and corners.

Words to describe it:

- "Radial glow" or "center glow background"
- "Dark vignette" (the edges darken toward black)
- "Ambient glow" or "soft bloom"
- The color is closer to a deep teal / slate blue (around `#1a2a33`) than a
  bright blue, so "muted teal glow on black" is the most accurate description.

To recreate it in CSS:

```css
background: radial-gradient(
  ellipse at 50% 45%,
  #1c2c35 0%,
  #0f171c 45%,
  #050708 100%
);
```

Placing the center slightly above the middle (45%) puts the glow behind the main
content.

## Color
1. Give each color one meaning and keep it for the whole film. Write the
   meanings in a comment above the CSS variables.
2. Use one color for the thing the viewer follows. It is the brightest thing in
   the frame.
3. Start from these. Each has at least 4.5:1 contrast against every part of the
   background:

| Use | Color | Contrast at the center |
|---|---|---|
| Text | `#f3eee2` | 12.4 |
| Secondary text | `#9fb0b8` | 6.4 |
| The followed thing | `#f5a800` | 7.2 |
| Good, reward | `#4ade80` | 8.2 |
| Bad, penalty | `#ff6b6b` | 5.2 |
| A second subject | `#7cb0ff` | 6.5 |

4. Dark text goes only on a filled bright shape, such as a badge. Captions follow
   `captions.md`: the kit's default caption color is dark and disappears here.
5. Separate panels from the background with a thin light edge, for example
   `1px solid rgba(255, 255, 255, .12)`. Dark shadows do not show.
6. Never rely on color alone. Pair it with a sign, a label or a shape.

## Animation
1. Every move starts on the word that names it: `P(t, T.word, duration)`.
2. Choose the curve by what the move means: `E.out` for things arriving,
   `E.in` for things leaving, `E.inOut` for things travelling, `E.back` for one
   emphasis per beat, `E.lin` for counters and time passing.
3. Keep to these lengths: 0.2 to 0.35 s for text and labels, 0.4 to 0.7 s for a
   layout change, 1 s or more only for a journey the viewer follows.
4. Move one main thing at a time. Anything else moving stays quieter.
5. Morph, do not swap. When the same object appears in the next beat, move it
   there instead of cutting to a new one.
6. Fill a pause in the voiceover with the result playing out, never a still
   frame. Something changes at least every two or three seconds.
7. Draw everything from `t`. No CSS transitions, no keyframes, no
   `Math.random`: a frame must come out the same every time.

## Example
Q-learning reel: amber is the agent, meaning the taxi, its trail and its choices.
The +20 is green, and when it spreads backward the route turns green one
cell at a time, on "one state at a time". The pause after "led there" is filled
by the taxi driving that route.

## Anti-pattern
Colors picked per scene because they look nice, and everything fading in at
once. If a color means two things, or two things move at once with equal weight,
the viewer does not know where to look.
