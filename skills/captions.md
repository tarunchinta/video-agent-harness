# Skill: captions

## When to use
Writing the caption lines and caption styles of the film page in the edit stage.
This outranks the kit's own caption example.

## How to apply
1. Show only 1 to 3 words on screen at any time. Each entry in
   `captions.lines` is 1, 2 or 3 words, never more.
2. Break where the voice breaks: at commas, at full stops, between phrases.
   Keep a name or a number with the word it belongs to ("5% of", "2,000
   trips"), and never put the end of one sentence and the start of the next in
   the same entry.
3. Highlight the word being said by making its fill yellow (`#f5a800`). The
   other words stay `#f3eee2`.
4. Never put a yellow background, box or pill behind a word. The kit's starting
   page has one (`#captions .on { background: ... }`), so replace it:

```css
#captions { color: #f3eee2; }
#captions .on { color: #f5a800; background: none; }
```

5. Keep every entry on one line. With so few words the text can be large: start
   at 84px, and go smaller only if an entry does not fit the width.
6. Do not change a word's size or weight when it turns yellow, or the words
   beside it shift.
7. Every word of the voiceover appears, in order, exactly as it was said.

## Example
"So the 20 spreads backward, one state at a time" is four entries: "So the 20",
"spreads backward,", "one state", "at a time,". While "spreads" is said, only
"spreads backward," is on screen, with "spreads" in yellow and "backward," in
white.

## Anti-pattern
A whole sentence at the bottom of the frame with a yellow box jumping from word
to word. Viewers read ahead and stop watching the picture.
