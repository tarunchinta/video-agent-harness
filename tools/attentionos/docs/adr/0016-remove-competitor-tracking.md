# ADR-16: Remove competitor tracking; ideas come from the owner's own breakouts, teardowns and trends

- **Status:** Proposed
- **Date:** 2026-10-16
- **Deciders:** Maintainers

## Context

Research tracked a list of other creators (`brand/competitors.yaml`), scanned them on a daily rotation, scored their posts against each creator's normal and fed the outliers into the daily brief, the remix pool, a competitor hook bank, cross-creator trends, competitor benchmarks in analytics and a competitor prior in the Strategist's weights. It also meant setup asked for competitors, Studio had a Competitors page, and most of the scraping budget went on other people's posts.

## Decision

- Competitor tracking is removed: no `competitors.yaml`, no `research.competitor-scan`, no outlier scoring of other creators, no cross-creator trends, no competitor hook bank (and no `scripting.classify-hooks`), no competitor benchmarks, no competitor prior in `getWeights`, no competitor suggestions or step in setup, and no Competitors page in Studio.
- Ideas come from the owner's own breakouts (remixed from their checked teardowns), the trend radar, and teardowns of any public post the owner pastes in by URL.
- Own-sync tears down the owner's best transcribed posts (`research.ownTeardowns.perSync`), which the competitor scan used to do.
- The learned weights start neutral and move toward the owner's own lifts as their posts come in (`blendWeights` shrinks toward 1 until `fullTrustAt` own posts).
- `tracked_creators` only holds the owner's own accounts. Migration `20261025000000_drop_competitor_tracking.sql` deletes competitor data in existing workspaces and drops the columns only it used.

## Consequences

- A new workspace has fewer remix sources until the owner has posts that beat their normal; slots without one are filled with talking heads, as before.
- Scraping is limited to the owner's own accounts and pasted URLs, so the scraping notice and the budget guard stay.
- Hook origin `competitor` is replaced by `remix` (a hook taken from a pasted post being remade).
- Existing competitor data is deleted by the migration and can't be recovered from the database.

## Alternatives considered

- **Keep tracking for analytics only.** Benchmarks without the remix pool. Rejected: the scraping cost and setup step stay for a number few owners act on.
- **Leave the schema alone.** Rejected in favour of a cleanup migration, so no dead competitor rows or columns linger.
