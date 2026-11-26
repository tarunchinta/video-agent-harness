# Letter embeddings: idea

Status: exploring. This file records our back-and-forth. No script, no film and no project code yet.

## What we want to show

A computer starts out knowing nothing about the alphabet. Each of the 26 letters is dropped at a random point on a 2D map. We train on words from a public dictionary, and the letters move. At the end, the map has structure nobody programmed in.

The viewer should leave understanding two things:

1. How a machine stores relationships in text: as positions.
2. How a tiny embedding model is trained, using data anyone can download.

2D is the point. Real embeddings have hundreds or thousands of dimensions and have to be squashed to be drawn. Here the picture is the model's actual memory of each letter.

## The original hypothesis (Tarun)

1. Vowels end up on one side, consonants on the other.
2. Among consonants, popular ones sit at the center of the bubble.
3. Rare consonants like Z sit on the outskirts.

## First check (2026-11-25)

Quick throwaway experiments, to see whether the story is true before writing it. The code is not in the repo.

**Data:** `words_alpha.txt` from dwyl/english-words (369,652 words of 3+ letters, 3.5M letters). Also a 20,000-word list: the most frequent of those words, ranked by Norvig's web counts. Each word counts once in both.

**Main model:** read one letter, predict the next. Letter → 2 numbers → a score for each of 27 options (26 letters plus "word ends"). 5 random starts per setup. Y is counted as a consonant.

| Claim | Result |
|---|---|
| Vowels vs consonants | **Holds.** A straight line separated a, e, i, o, u from the rest in 5 of 5 starts, on both word lists |
| Popular consonants at the center, rare ones outside | **Does not hold.** Rank correlation between distance from the consonant center and log frequency: −0.11 (dictionary), −0.21 (common words). The expected direction, but weak |
| Z on the outskirts | **Partly.** Z is often near the edge, but Q, V, J and Y stand out more |

Counterexamples to the rarity claim:
- K (0.77% of letters), W (0.64%) and usually X (0.30%) are rare and sit inside the cluster.
- V (0.95%) is more common than all three and is one of the furthest letters out.
- N and S are common and still drift toward the edge, especially on the common-word list.

### What seems to explain the edge: oddness, not rarity

"Oddness" here is how different a letter's next-letter pattern is from the average consonant's (KL divergence, in bits). On the dictionary list, the rank correlation with distance from the center is +0.64 to +0.69 with SGD and +0.38 to +0.48 with Adam. With common words it is about +0.54 to +0.65. Frequency reaches −0.25 at most in the same runs. Oddness is the better explanation, though not a complete one.

- **Q:** followed by U 98% of the time. Oddness 3.31, the highest by far.
- **V:** followed by E 54% of the time.
- **Y:** ends the word 52% of the time. It often lands near the boundary between vowels and consonants.

Rarity and oddness are related (−0.42 on the dictionary list), which is why the original guess is tempting.

Proposed restatement: **letters that keep the same company end up together, and letters with strange habits end up alone.**

### Things the script must not get wrong

- **Closeness does not mean two letters appear together.** It means they are followed by similar letters. Q is almost always followed by U, and they end up far apart.
- **The model is never told what a vowel is.** Coloring the vowels is for the viewer. Say so.
- **Only the pattern is meaningful.** Left, right, up, down and the axes mean nothing, and different starts give rotated or stretched maps. Because this model is linear, stretching the map can be undone by the output layer, so exact distances are soft evidence. That applies to both the rarity and oddness numbers above.
- **The setup matters.** With one shared table for input and output, vowels never separated (0 of 5), and common letters were pushed far from the origin (+0.92 to +0.95 with frequency). Guessing a letter from its two neighbors also failed on the dictionary list (0 of 5), but worked on common words (5 of 5).
- **Training was on all the data at once each step.** We have not yet tested updating word by word, which is how we'd probably narrate it.
- **Two numbers per letter is limiting.** Loss on the dictionary: 3.30 for a blind guess over 27 options, 2.95 knowing only letter frequency, 2.69 for our 2D model, 2.54 at best for any model that sees just one letter.

## Possible spine (for discussion)

1. **Drop:** 26 letters scattered at random. The machine sees only positions.
2. **The game:** cover the next letter in a word, guess, get it wrong.
3. **The nudge:** each mistake moves a letter slightly. One word, slowly, so the mechanism is clear.
4. **Speed up:** thousands of words. Vowels peel away from consonants.
5. **The surprise:** you'd expect the loners to be the rarest letters. K, W and X are rare and fit right in. V is more common and stands alone. What matters is the company a letter keeps.
6. **Zoom out:** the same game with words in place of letters and many more dimensions is how language models get their embeddings.

Possible object to follow: **Q**. Its journey to the edge shows the mechanism in one letter. Y is the alternative, since it lands between the two groups.

## Open questions

1. **The turn.** Do we use the failed rarity guess as the surprise, or keep the video to vowels vs consonants only?
2. **The takeaway.** Is this mainly "how machines store meaning as positions" or "how to train an embedding model yourself"? The first makes a stronger short. The second needs more code on screen.
3. **Which letter do we follow?** Q, Y, or all 26?
4. **Word list.** Full dictionary (simple to explain, has odd words) or the 20,000 most common (familiar words, wider vowel gap: +0.58 vs +0.27)?
5. **Which game?** Predict the next letter (simplest, matches how LLMs are described), or fill in the blank from both sides (two letters per side gave tight vowel clusters on common words)?
6. **Honesty of the random start.** Show one start, or a quick montage of several to prove it wasn't luck?
7. **Length and format.** Same as the taxi reel (about a minute, vertical, code lines on screen)?

## Decisions

None yet.

## Conversation log

- **2026-11-25, Tarun:** original idea and hypothesis, above.
- **2026-11-25, Claude:** checked it. Vowels separate. Rarity is a weak explanation for the outskirts, oddness a better one. Suggested making that the turn of the video.
