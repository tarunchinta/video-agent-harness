import type { HarnessEvent } from "@harness/harness";

/**
 * What the run made for you to review: each script handed in and each cut rendered, with what the agent said
 * about it and how you answered. Script text comes from the log (the `write_file` call that last wrote it before
 * the hand-in), so every revision can be read even though the file on disk holds only the latest one.
 */

export type Review = { decision: string; notes: string[]; at: string; seq: number };

export type ScriptRevision = {
  n: number;
  seq: number;
  at: string;
  scriptPath: string;
  narrationPath: string;
  /** Text as the agent wrote it, when it was written with `write_file`. Otherwise read the file. */
  script?: string;
  narration?: string;
  words?: number;
  estimatedSeconds?: number;
  review?: Review;
  /** Still being written: the script stage is open and nothing has been handed in for this revision. */
  draft: boolean;
};

/** The critic's scores for a cut, out of 5 each, when the run has a critic. */
export type Critique = { passed: boolean; mean?: number; scores: Record<string, number>; summary?: string; path?: string };

export type Cut = {
  revision: number;
  path: string;
  /** Event where the render finished. */
  seq: number;
  at: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  megabytes?: number;
  voice?: boolean;
  /** The contact sheet the agent was shown, cut from the finished file. */
  sheet?: { sha256: string; mediaType: string };
  renderMs?: number;
  trigger?: string;
  /** Set when it was handed in for review. */
  submitted?: { seq: number; at: string; note?: string; sha256?: string; bytes?: number };
  review?: Review;
  critique?: Critique;
};

export type Deliverables = { scripts: ScriptRevision[]; cuts: Cut[]; voiceover?: { path: string; at: string; seq: number } };

type Payload = Record<string, unknown>;
const p = (e: HarnessEvent) => e.payload as Payload;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const norm = (path: string) => path.replace(/^\.\//, "").replaceAll("\\", "/");

const CRITIC = /The critic (passed|did not pass) cut (\d+) \(average ([\d.]+) of 5\)\.(?: Saved as (\S+?)\.?(?:\s|$))?/;

function critiqueOf(raw: unknown): Critique | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Payload;
  if (typeof r.passed !== "boolean") return undefined;
  const scores: Record<string, number> = {};
  if (typeof r.scores === "object" && r.scores !== null) for (const [k, v] of Object.entries(r.scores)) if (typeof v === "number") scores[k] = v;
  return { passed: r.passed, scores, ...(num(r.mean) !== undefined ? { mean: num(r.mean)! } : {}), ...(str(r.summary) ? { summary: str(r.summary)! } : {}), ...(str(r.path) ? { path: str(r.path)! } : {}) };
}

const RENDERED = /Rendered cut (\d+): ([\d.]+) seconds, (?:(\d+) by (\d+), )?([\d.]+) MB, (with the voiceover|with no voice)/;

export function buildDeliverables(events: readonly HarnessEvent[]): Deliverables {
  /** The latest content written to each path by a successful `write_file`, as of each point in the log. */
  const written = new Map<string, string>();
  const pendingWrites = new Map<string, { path: string; content: string }>();
  const toolOf = new Map<string, { tool: string; input: Payload; seq: number; at: string; spanId: string }>();
  const scripts: ScriptRevision[] = [];
  const cuts: Cut[] = [];
  let scriptStageOpen = false;
  let editTrigger: string | undefined;
  let voiceover: Deliverables["voiceover"];

  for (const e of events) {
    const payload = p(e);
    switch (e.type) {
      case "stage.started":
        if (payload.stage === "script") scriptStageOpen = true;
        if (payload.stage === "edit") editTrigger = str(payload.trigger);
        break;
      case "stage.completed":
      case "stage.failed":
        if (payload.stage === "script") scriptStageOpen = false;
        break;
      case "tool.call.started": {
        if (e.agentId !== "main") break;
        const input = (payload.input ?? {}) as Payload;
        const callId = str(payload.tool_call_id) ?? e.spanId;
        toolOf.set(callId, { tool: str(payload.tool) ?? "", input, seq: e.seq, at: e.occurredAt, spanId: e.spanId });
        if (payload.tool === "write_file" && typeof input.path === "string" && typeof input.content === "string") {
          pendingWrites.set(callId, { path: norm(input.path), content: input.content });
        }
        break;
      }
      case "tool.call.completed": {
        const callId = str(payload.tool_call_id) ?? "";
        const write = pendingWrites.get(callId);
        if (write) {
          written.set(write.path, write.content);
          pendingWrites.delete(callId);
        }
        const call = toolOf.get(callId);
        if (call?.tool === "render_film") {
          const match = RENDERED.exec(str(payload.output) ?? "");
          const images = Array.isArray(payload.images) ? (payload.images as Payload[]) : [];
          const sheet = images.find((i) => typeof i.sha256 === "string");
          const revision = match ? Number(match[1]) : cuts.length + 1;
          cuts.push({
            revision,
            path: `cuts/cut-${revision}.mp4`,
            seq: e.seq,
            at: e.occurredAt,
            ...(match ? { durationSeconds: Number(match[2]), megabytes: Number(match[5]), voice: match[6] === "with the voiceover" } : {}),
            ...(match?.[3] ? { width: Number(match[3]), height: Number(match[4]) } : {}),
            ...(sheet ? { sheet: { sha256: sheet.sha256 as string, mediaType: str(sheet.media_type) ?? "image/jpeg" } } : {}),
            ...(num(payload.duration_ms) !== undefined ? { renderMs: num(payload.duration_ms)! } : {}),
            ...(editTrigger ? { trigger: editTrigger } : {}),
          });
        }
        if (call?.tool === "review_cut") {
          const m = CRITIC.exec(str(payload.output) ?? "");
          const cut = m ? cuts.find((c) => c.revision === Number(m[2])) : undefined;
          if (m && cut) cut.critique = { passed: m[1] === "passed", mean: Number(m[3]), scores: {}, ...(m[4] ? { path: m[4] } : {}) };
        }
        if (call?.tool === "prepare_voiceover") voiceover = { path: "film/words.json", at: e.occurredAt, seq: e.seq };
        break;
      }
      case "tool.call.failed":
        pendingWrites.delete(str(payload.tool_call_id) ?? "");
        break;
      case "gate.opened": {
        const files = Array.isArray(payload.files) ? payload.files.filter((f): f is string => typeof f === "string").map(norm) : [];
        if (payload.gate === "script") {
          const scriptPath = files[0] ?? "script/script.md";
          const narrationPath = files[1] ?? "script/narration.txt";
          scripts.push({
            n: scripts.length + 1,
            seq: e.seq,
            at: e.occurredAt,
            scriptPath,
            narrationPath,
            ...(written.has(scriptPath) ? { script: written.get(scriptPath)! } : {}),
            ...(written.has(narrationPath) ? { narration: written.get(narrationPath)! } : {}),
            ...(num(payload.words) !== undefined ? { words: num(payload.words)! } : {}),
            ...(num(payload.estimated_seconds) !== undefined ? { estimatedSeconds: num(payload.estimated_seconds)! } : {}),
            draft: false,
          });
        }
        if (payload.gate === "final_cut") {
          const revision = num(payload.revision);
          const cut = cuts.findLast((c) => (revision === undefined ? true : c.revision === revision));
          if (cut) {
            const critique = critiqueOf(payload.review);
            if (critique) cut.critique = critique;
            cut.submitted = {
              seq: e.seq,
              at: e.occurredAt,
              ...(str(payload.note) ? { note: str(payload.note)! } : {}),
              ...(str(payload.sha256) ? { sha256: str(payload.sha256)! } : {}),
              ...(num(payload.bytes) !== undefined ? { bytes: num(payload.bytes)! } : {}),
            };
          }
        }
        break;
      }
      case "gate.decided": {
        const review: Review = {
          decision: str(payload.decision) ?? "approved",
          notes: Array.isArray(payload.notes) ? (payload.notes as Payload[]).map((n) => str(n.text)).filter((x): x is string => Boolean(x)) : [],
          at: e.occurredAt,
          seq: e.seq,
        };
        if (payload.gate === "script") {
          const last = scripts[scripts.length - 1];
          if (last && !last.review) last.review = review;
        }
        if (payload.gate === "final_cut") {
          const last = cuts.findLast((c) => c.submitted && !c.review);
          if (last) last.review = review;
        }
        break;
      }
      default:
        break;
    }
  }

  // A script being written right now, not yet handed in.
  if (scriptStageOpen) {
    const last = scripts[scripts.length - 1];
    const scriptPath = last?.scriptPath ?? "script/script.md";
    const narrationPath = last?.narrationPath ?? "script/narration.txt";
    const script = written.get(scriptPath);
    const narration = written.get(narrationPath);
    // Only a real draft: something written since the last hand-in, not the text already under review.
    const changed = !last || (script !== undefined && script !== last.script) || (narration !== undefined && narration !== last.narration);
    if ((script !== undefined || narration !== undefined) && changed) {
      const lastSeq = events.length ? events[events.length - 1]!.seq : 0;
      scripts.push({
        n: scripts.length + 1,
        seq: lastSeq,
        at: events[events.length - 1]?.occurredAt ?? "",
        scriptPath,
        narrationPath,
        ...(script !== undefined ? { script } : {}),
        ...(narration !== undefined ? { narration } : {}),
        draft: true,
      });
    }
  }
  return { scripts, cuts, ...(voiceover ? { voiceover } : {}) };
}

/** Narration lines with their word counts, as the script review checks them. */
export function narrationLines(narration: string): { text: string; words: number }[] {
  return narration
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ text, words: text.split(/\s+/).filter(Boolean).length }));
}

/** Word timings from `film/words.json`: `{ w, s, e }` per spoken word. Anything else is dropped. */
export type TimedWord = { w: string; s: number; e: number };

export function parseWords(raw: unknown): TimedWord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is TimedWord => typeof x === "object" && x !== null && typeof x.w === "string" && typeof x.s === "number" && typeof x.e === "number");
}

/** Index of the word being spoken at `time`, or of the last one before it. -1 before the first word. */
export function wordAt(words: readonly TimedWord[], time: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid]!.s <= time) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
