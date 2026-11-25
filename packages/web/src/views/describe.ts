/**
 * Plain-language names for what the agent did. The same wording as the terminal where the terminal has it
 * (apps/harness-cli/src/render.ts), so a run reads the same in both.
 */

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const hostOf = (url: string | undefined) => {
  if (!url) return "a page";
  try {
    return new URL(url).host;
  } catch {
    return "a page";
  }
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One line saying what a tool call does, from its name and input. */
export function toolTitle(tool: string, raw: unknown): string {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Input;
  const path = str(input.path);
  switch (tool) {
    case "read_file":
      return `Read ${path ?? "a file"}`;
    case "write_file":
      return `Wrote ${path ?? "a file"}`;
    case "list_files":
      return `Listed ${!path || path === "." ? "the working folder" : path}`;
    case "view_image":
      return `Looked at ${path ?? "a picture"}`;
    case "run_command": {
      const command = Array.isArray(input.command) ? input.command.filter((c): c is string => typeof c === "string").join(" ") : "";
      return command ? `Ran ${clip(command, 80)}` : "Ran a command";
    }
    case "start_stage":
      return `Started the ${str(input.stage) ?? "next"} stage`;
    case "web_fetch": {
      const question = str(input.question);
      return question ? `Read ${hostOf(str(input.url))}: ${clip(question, 90)}` : `Read ${hostOf(str(input.url))}`;
    }
    case "submit_script":
      return "Handed in the script for review";
    case "prepare_voiceover":
      return Array.isArray(input.corrections) && input.corrections.length ? "Corrected the voiceover timing" : "Timed the voiceover word by word";
    case "render_stills":
      return Array.isArray(input.times) && input.times.length ? `Drew ${input.times.length} stills` : "Drew a still at each cue";
    case "render_film":
      return "Rendered the film";
    case "submit_cut":
      return "Handed in the cut for review";
    case "review_cut":
      return "Had the critic watch the cut";
    case "finish":
      return "Finished the run";
    default:
      return tool.replaceAll("_", " ");
  }
}

/** A short tag for the kind of tool, used for its icon and colour. */
export type ToolFamily = "file" | "command" | "web" | "stage" | "review" | "render" | "voice" | "finish" | "other";

export function toolFamily(tool: string): ToolFamily {
  if (["read_file", "write_file", "list_files", "view_image"].includes(tool)) return "file";
  if (tool === "run_command") return "command";
  if (tool === "web_fetch") return "web";
  if (tool === "start_stage") return "stage";
  if (tool === "submit_script" || tool === "submit_cut" || tool === "review_cut") return "review";
  if (tool === "render_stills" || tool === "render_film") return "render";
  if (tool === "prepare_voiceover") return "voice";
  if (tool === "finish") return "finish";
  return "other";
}

const FIRST: Record<string, string> = {
  research: "Researching the topic",
  script: "Writing the script",
  assets: "Preparing the voiceover",
  edit: "Building the film",
};
const AGAIN: Record<string, string> = { script: "Revising the script", edit: "Revising the cut" };
const TRIGGER: Record<string, string> = { creator: "asked for by you", critique: "on the agent's own judgement", plan: "" };

export function stageLabel(stage: string, revision: number, trigger?: string): string {
  if (revision <= 1) return FIRST[stage] ?? `Started the ${stage} stage`;
  const why = trigger && TRIGGER[trigger] ? `, ${TRIGGER[trigger]}` : "";
  return `${AGAIN[stage] ?? `Working on the ${stage} stage again`} (revision ${revision}${why})`;
}

export const gateName = (gate: string) => (gate === "final_cut" ? "final cut" : gate.replaceAll("_", " "));

export function decisionPhrase(decision: string): string {
  if (decision === "approved") return "approved";
  if (decision === "changes_requested") return "asked for changes to";
  if (decision === "rejected") return "rejected";
  return decision.replaceAll("_", " ");
}

export function statusLabel(status: string, reason?: string, gate?: string): string {
  switch (status) {
    case "created":
      return "Not started";
    case "running":
      return "Working";
    case "waiting_gate":
      return `Waiting for your review of the ${gateName(gate ?? "work")}`;
    case "paused":
      if (reason?.startsWith("budget:")) return `Paused at the ${reason.slice(7).replaceAll("_", " ")} limit`;
      if (reason === "error:sandbox") return "Paused: the sandbox could not start";
      if (reason?.startsWith("error:")) return "Paused: the model could not be reached";
      return "Paused";
    case "succeeded":
      return "Done";
    case "failed":
      return "Stopped";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

export const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 2)}`;

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));

/** One line saying how the conversation was made smaller. */
export function compactedText(payload: Input): string {
  if (payload.mode === "summary") return "Summarised the conversation to save space. The creator's notes were kept word for word.";
  const n = Array.isArray(payload.cleared) ? payload.cleared.length : 0;
  return `Cleared ${n} old tool ${n === 1 ? "result" : "results"} to save space. The full text is kept in the run's files.`;
}
