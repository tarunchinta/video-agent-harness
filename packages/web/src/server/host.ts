import type { HarnessEvent, RunOutcome, RunStore } from "@harness/harness";
import type { ParsedInputOf } from "../api/contract.ts";
import type { RunFiles } from "./run-files.ts";
import type { UploadStore } from "./uploads.ts";

/**
 * What the web server is given by the application that starts it (`harness web` in the CLI). The server knows
 * the log and the contract; how a run is created and driven (providers, tools, the sandbox) is injected here,
 * so this package never imports a provider or the Docker driver.
 */
export type RunHost = {
  /** The JSON-lines or the Postgres store. The server reads runs only through it. */
  store: RunStore;
  /** Folder holding one folder of files per run (work, renders, uploads), whichever store holds the logs. */
  runsDir: string;
  /** Folder holding the creator's projects, one folder each. */
  projectsDir: string;
  cwd: string;
  defaultModel: string;
  models: string[];
  /** Where uploads go. Without one, each run's `uploads/` folder under `runsDir`. */
  uploads?: UploadStore;
  /**
   * Where run files (the working folder, renders, pictures) are read from. Without one, each run's folder under
   * `runsDir`. A web server apart from the worker reads the copies the worker put in blob storage.
   */
  files?: RunFiles;
  /** Creates a reel run. `notesDir` is a project folder whose notes the run should be given. Does not drive it. */
  createReel(input: ParsedInputOf<"runs.createReel"> & { notesDir?: string }): Promise<string>;
  createTask(input: ParsedInputOf<"runs.createTask">): Promise<string>;
  /**
   * Drives a run until it finishes, pauses or waits for a review. Without it the server only writes what the
   * creator asks for, and a worker elsewhere (`harness worker`) picks the runs up from the store.
   */
  drive?(runId: string, hooks: { signal: AbortSignal; onEvent: (event: HarnessEvent) => void; onText: (delta: string) => void }): Promise<RunOutcome>;
  /**
   * Hands the creator's recording to a reel and returns the sentence that goes with the script approval.
   * `upload` names a file already saved to `uploads`.
   */
  voiceover(runId: string, choice: { kind: "upload"; name: string } | { kind: "none" } | { kind: "keep" }): Promise<string>;
  /** True when an error's message is written for the creator (a usage problem), not a crash. */
  isUserError?: (err: unknown) => boolean;
};
