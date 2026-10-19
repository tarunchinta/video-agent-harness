# Research

The Analyst's research module answers one question every day: **what is working right now, for you and for your niche?**

| | |
|---|---|
| Agent | Analyst (`An`) |
| Tier | Core (always on) |
| Setup level | [Level 1](../setup/level-1.md) |
| Needs | A database; your publish provider's analytics for your own posts; a scraper (Apify, Instagram Graph API or yt-dlp) to read public posts and pasted URLs |
| Brand Kit files | `brand/sources.yaml` |

## What it does

### Your own posts

- Imports your posts and their numbers from your publisher's analytics (Zernio by default), and keeps snapshots over time.
- Can backfill your full Instagram history through the Instagram Graph API.
- Collapses trial-reel variants of the same video into one, using the transcript.
- Accepts a CSV import for numbers no API exposes, such as Instagram skip rate.

### Your breakouts

- Every one of your posts is scored as `x` against your own normal (the Learn module does the maths), so the team knows which ones to do again.
- Your best transcribed posts are torn down automatically on each own-posts sync (`ownTeardowns.perSync`, default 2), so most of your breakouts are ready to remix by the time the Strategist plans the day.
- **The spoken hook:** imported videos are transcribed so the hook you study is what was *said*, not just the caption. The most-liked comments ("comment gold") are kept too.
- **Budget guard:** scraping spend is checked **before** reading public posts. If a read would go over budget, you get an alert instead of a bill.

### Trend radar

- Sources are set per niche in `brand/sources.yaml`: RSS feeds, Google News searches, Reddit, Hacker News, GitHub, and (planned) X through Apify.
- Each item gets a **heat** score from how fast it is gaining attention, with a bonus for small accounts and decay with age. Daily and per-run caps stop it flooding you; a follow-up fires if a story's velocity doubles.
- Scraped text is **untrusted**. It only ever goes to a model call with no tools, and the output passes a deterministic validator before it is saved.
- The result is a **filmable kit**: a header, beats matched to screenshots or clips, a caption and a keyword.

### Teardowns

On request, the Analyst breaks down any post, yours or one you paste in by URL: transcript, frames, the hook frame by frame, pacing, caption style, the creator's signature move, and a clear "what's theirs, don't copy" section. After three or more teardowns of one creator, it writes a style fingerprint.

Every teardown also writes a **remix blueprint**: the opening line exactly as said, every beat in order with rough timing and what it does, the format and look, how the ending asks for action, why it worked, and everything that belongs to the creator (names, handles, brands, products, catchphrases, their numbers and stories). It's what the Copywriter remakes the post from, so it never has to read someone else's transcript. Code checks each blueprint before it's saved: the hook line must really be in the post, and no field may carry a link, a handle or anything that reads like an instruction. A teardown whose answer misses the expected format is retried, and a remix waiting on it asks for it again, so one bad answer never leaves a remix without its blueprint.

## What you'll see

- Your breakouts and hot trends in the morning brief.
- `/attention:research` in Claude Code for what's working, or to request a teardown of a post URL.

## Approvals

Research only reads; it never posts. Adding a trend source changes your Brand Kit, which you approve.

## Settings

Set under `modules.research.settings` in `config/attentionos.config.ts`. Typical settings include how many of your best posts are torn down per sync and the trend caps. Schedules can be overridden under `modules.research.schedules`.

## Limits and notices

- **Platform terms.** Reading public posts through a third-party service may conflict with a platform's terms. You acknowledge this once before the first read. AttentionOS never logs in as you and never automates a browser.
- Instagram Graph API only reads business and creator accounts.
- Numbers from scraped posts are snapshots; they change after they are read.
