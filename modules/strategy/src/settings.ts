import { z } from "zod";
import { moduleSettings, type WorkspaceContext } from "@attentionos/core";

const slots = z.object({
  news: z.number().int().nonnegative(),
  remix: z.number().int().nonnegative(),
  talking_head: z.number().int().nonnegative(),
  offer: z.number().int().nonnegative(),
});

/** `config.modules.strategy.settings`. */
export const strategySettingsSchema = z.object({
  /** The daily "Film today" slate. */
  daily: slots.default({ news: 2, remix: 2, talking_head: 2, offer: 1 }),
  /** Batch-day edition size; default comes from brand/knowledge/preset-cadence.yaml weeklyTarget.shortVideos. */
  batchSize: z.number().int().positive().optional(),
  /** Funnel mix is measured over this many recent pieces. */
  funnelWindow: z.number().int().positive().default(20),
  cooldowns: z.object({
    topicDays: z.number().int().positive().default(14),
    proofDays: z.number().int().positive().default(21),
    angleDays: z.number().int().nonnegative().default(3),
  }).default({ topicDays: 14, proofDays: 21, angleDays: 3 }),
  /**
   * Share of each slate that remakes one of your own breakouts. The rest is what the lanes require: the offer piece,
   * fresh news, and talking heads when there aren't enough breakouts to remake.
   */
  remixShare: z.number().min(0).max(1).default(0.7),
  /** Which of your own posts qualify as remix sources. */
  remixSources: z.object({
    /** Your own breakouts stay remixable this long ("do that again, new angle"). */
    ownMaxAgeDays: z.number().int().positive().default(365),
    /** Times your normal (median views) one of your own posts must reach. */
    ownMinX: z.number().positive().default(2),
    /** ...and the views it needs whatever your normal, so a small post that beat a tiny median isn't remade. 0 turns the bar off. */
    ownMinViews: z.number().int().nonnegative().default(10_000),
    /**
     * A remix whose source has no blueprint yet is queued to check back after this long; the teardown normally starts
     * it sooner. A remix is never written without its blueprint: the script keeps waiting (and asks for the teardown
     * again) until there is one.
     */
    waitForBlueprintMinutes: z.number().int().nonnegative().max(24 * 60).default(30),
  }).default({ ownMaxAgeDays: 365, ownMinX: 2, ownMinViews: 10_000, waitForBlueprintMinutes: 30 }),
  /** About one idea in three uses a story structure. */
  storyShare: z.number().min(0).max(1).default(1 / 3),
  filmBy: z.object({
    newsHours: z.number().positive().default(24),
    defaultHours: z.number().positive().default(72),
  }).default({ newsHours: 24, defaultHours: 72 }),
  /**
   * Legacy hand-off: one run of this job with `{ contentIds }` ten minutes after the brief. Empty (default) uses
   * `autoScripts` instead: one `scripting.write-script` per filmable idea.
   */
  scriptHandoffJobId: z.string().default(""),
  /** After a brief, ask the Copywriter for a script per filmable idea (news, remix, talking head, offer). */
  autoScripts: z.object({
    enabled: z.boolean().default(true),
    /** At most this many scripts are queued automatically per brief date (daily and batch editions share it). */
    maxPerDay: z.number().int().nonnegative().max(50).default(5),
    /** Give the Strategist's header and shoot-direction pass a head start before the Copywriter begins. */
    delayMinutes: z.number().int().nonnegative().max(24 * 60).default(10),
  }).default({ enabled: true, maxPerDay: 5, delayMinutes: 10 }),
});
export type StrategySettings = z.output<typeof strategySettingsSchema>;

export function strategySettings(ws: WorkspaceContext): StrategySettings {
  return strategySettingsSchema.parse(moduleSettings(ws.config, "strategy").settings ?? {});
}
