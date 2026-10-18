---
name: humanize-writing
description: >
  Apply this skill whenever the user wants to humanize, naturalize, or clean up long-form writing — including technical design documents, think pieces, essays, blog posts, or any prose that sounds AI-generated, over-polished, or corporate. Triggers include: "humanize this", "make this sound more natural", "remove the AI feel", "clean up this essay", "make this less robotic", "edit my think piece", "polish this design doc", "rewrite this to sound like me", or any request to improve prose quality or remove AI-isms. Also apply proactively when writing original long-form content on behalf of the user, to avoid these patterns from the start.
---

# Humanize Writing

This skill governs how to write and edit long-form prose — essays, technical design documents, think pieces — so that it reads as written by a human author with a distinct voice, not by a language model optimizing for engagement or clarity signals.

The goal is never to impose a tone. It is to remove patterns that betray machine origin and let the author's existing voice come through undistorted.

---

## Core Principle

Do not fix what isn't broken. The job is subtraction, not transformation. Remove patterns that feel synthetic. Preserve sentence rhythm, vocabulary choices, and argumentative structure that belong to the author. When in doubt, leave it alone.

---

## Formatting Rules

These apply to all long-form prose unless the author explicitly requests otherwise.

- **No bullet points or numbered lists.** Ideas belong in sentences. If a list is truly necessary, write it inline: "three things: X, Y, and Z."
- **No bold text for emphasis.** If a sentence needs bolding to land, rewrite the sentence.
- **No section headers in flowing prose.** Headers are for reference documents and technical specs — not essays or design narratives. Use paragraph breaks and transitional sentences instead.
- **No em-dash overuse.** One or two per piece, maximum. Em-dashes used as a tic to inject drama must go.

---

## Language Anti-Patterns to Remove

These are patterns that appear with high frequency in AI-generated text and almost never in natural human writing at scale. Identify and eliminate them.

### 1. Negative Parallelism

The "It's not X — it's Y" construction. Also its variants: "not because X, but because Y", "The question isn't X. The question is Y." These reframe ordinary claims as surprise reveals. Real writers use negation sparingly and with purpose — not as a default argumentative structure.

> Remove: "This isn't just technical — it's a mindset change."
> Remove: "The question isn't whether to optimize. The question is when to stop."

### 2. Dramatic Negation Countdown

The "Not X. Not Y. Just Z." pattern. AI builds false tension by negating two things before the reveal. It performs depth without delivering it.

> Remove: "Not ambition. Not ego. Just a person who never learned to say enough."
> Remove: "Not a pivot. Not a rebrand. The same product with a different story."

### 3. False Ranges

"From X to Y" constructions where X and Y share no real spectrum. Legitimate use implies a meaningful continuum. AI uses it to list two loosely related concepts while implying comprehensiveness.

> Remove: "From innovation to cultural transformation."
> Remove: "From fundamental physics to medicine and neuroscience."

### 4. Self-Posed Rhetorical Questions

The "The result? Devastating." pattern — posing a question nobody asked, then answering it for dramatic effect. This is manufactured suspense, not argument.

> Remove: "The result? Devastating."
> Remove: "The worst part? Nobody saw it coming."
> Remove: "The scary part? This attack vector is perfect for developers."

### 5. Filler Transition Phrases

Phrases that introduce new points without connecting them to the prior argument. They signal nothing. Cut them entirely and let the sentence stand on its own.

> Remove: "It's worth noting that..."
> Remove: "It bears mentioning..."
> Remove: "Importantly,..." / "Interestingly,..." / "Notably,..."

### 6. Invented Concept Labels

Compound abstract labels appended to domain words to simulate analytical depth: "the supervision paradox", "acceleration trap", "workload creep", "the complexity divide". These name a thing instead of arguing about it. Multiple such labels in one piece is a strong signal of AI-generated analysis. Use them only if they are established terms in the field, and only if you can define them in context.

### 7. Ornate Filler Nouns

Grandiose nouns that replace simpler words without adding meaning.

> Replace "tapestry" with the thing it's actually describing
> Replace "landscape" with field, space, domain, or whatever is accurate
> Scrutinize: "paradigm", "ecosystem", "synergy", "framework" — use only when precise

### 8. Punchy Fragment Paragraphs

Very short sentences or fragments used as standalone paragraphs for manufactured emphasis. No real writer composes first drafts this way. It's an RLHF artifact trained toward readability signals, not natural thought.

> Remove: "He published this. Openly. In a book. As a priest."
> Remove: "Sleep is not a reward. It's not a treat. It's not laziness. It's the whole thing."

Consolidate these into full sentences. If the emphasis is real, it will survive the consolidation.

### 9. False Suspense Transitions

Phrases that promise a revelation but deliver an ordinary point. The buildup is disproportionate to what follows.

> Remove: "Here's the kicker."
> Remove: "Here's where it gets interesting."
> Remove: "Here's what most people miss about this."

### 10. Patronizing Analogies

"Think of it as..." and "It's like a..." — the model reaching into teacher mode unprompted. Use analogies only when the concept is genuinely abstract and the analogy is more precise than the original. Never use them as rhetorical warmth.

> Remove: "Think of it like a highway system for data."
> Remove: "Think of it as a Swiss Army knife for your workflow."

### 11. Asserting Simplicity Instead of Demonstrating It

Claiming a point is obvious or clear rather than actually making it. If the argument needs the label "simple" or "clear" to land, the argument isn't doing the job. Also covers the false-reveal variant: "but none of them is the real story. The real story is..."

> Remove: "The reality is simpler and less flattering."
> Remove: "The path forward is not complicated."
> Remove: "...but none of them is the real story. The real story is..."

### 12. Tacked-On "-ing" Analysis Phrases

Present participle phrases appended to a sentence to inject shallow analytical gloss. "Highlighting its importance", "reflecting broader trends", "contributing to the region's cultural heritage" — these assert significance without earning it. Cut them. If the significance is real, it belongs in its own sentence with an actual argument.

> Remove: "...contributing to the region's rich cultural heritage."
> Remove: "...underscoring its role as a dynamic hub of activity and culture."
> Remove: "...highlighting the enduring legacy of..."

---

## Workflow

**When editing existing prose:**
1. Read the full piece before touching anything. Build a sense of the author's voice.
2. Identify all instances of the above patterns and flag them.
3. Remove or rewrite flagged passages using the author's own vocabulary and rhythm — not a generic substitute.
4. Check formatting: strip bullets, bold, unnecessary headers.
5. Do not add new content unless asked. The output should be shorter or equal in length, never longer.

**When writing original long-form content:**
1. Draft without using any of the above patterns.
2. Write in continuous prose. Earn transitions rather than signaling them.
3. Let argument carry emphasis — not formatting, fragment rhythm, or rhetorical buildup.

---

## What Not to Change

- The author's sentence length preferences — short or long, both are fine
- Specific vocabulary choices that feel intentional, even if unusual
- Structural decisions (order of arguments, section choice) unless asked
- Technical terminology — do not simplify domain-specific language
- The author's stance or conclusions

The job is to remove the machine. Not to impose a different one.
