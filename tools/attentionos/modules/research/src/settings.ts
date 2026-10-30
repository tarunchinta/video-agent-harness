import { z } from "zod";
import { moduleSettings, type WorkspaceContext } from "@attentionos/core";

/** `config.modules.research.settings`. Every field has a safe default. */
export const researchSettingsSchema = z.object({
  /** Job that transcribes a post in the research library (the editing module's media-py ASR). */
  transcribeJobId: z.string().default("editing.transcribe"),
  ownTeardowns: z.object({
    /** Own best posts torn down per own sync (their remix blueprints feed the Copywriter's voice and "do it again" remixes). 0 = off. */
    perSync: z.number().int().nonnegative().max(10).default(2),
  }).default({ perSync: 2 }),
  trendRadar: z.object({
    dayCap: z.number().int().nonnegative().default(6),
    perRun: z.number().int().nonnegative().default(1),
    perSourceLimit: z.number().int().positive().max(100).default(25),
    followUpFactor: z.number().min(1).default(2),
    /** News reels die after about two days; the kit carries this deadline. */
    filmWithinHours: z.number().positive().default(24),
    /** Trends not seen again for this long are expired. */
    expireAfterHours: z.number().positive().default(72),
    /** 0–1. Below this brand relevance a trend is never picked (0 = off). */
    minRelevance: z.number().min(0).max(1).default(0),
    heat: z.record(z.string(), z.object({
      weight: z.number().positive().optional(),
      bar: z.number().positive().optional(),
      floor: z.number().nonnegative().optional(),
      maxAgeHours: z.number().positive().optional(),
    })).default({}),
  }).default({ dayCap: 6, perRun: 1, perSourceLimit: 25, followUpFactor: 2, filmWithinHours: 24, expireAfterHours: 72, minRelevance: 0, heat: {} }),
  ownSync: z.object({
    /** Days of history re-read on a normal sync (covers the 30-day snapshot). */
    lookbackDays: z.number().int().positive().default(35),
  }).default({ lookbackDays: 35 }),
});

export type ResearchSettings = z.output<typeof researchSettingsSchema>;

export function researchSettings(ws: WorkspaceContext): ResearchSettings {
  return researchSettingsSchema.parse(moduleSettings(ws.config, "research").settings ?? {});
}
