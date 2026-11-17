import type { SandboxExecOptions, SandboxExecResult, SandboxFactory, SandboxSession } from "../sandbox.ts";

export type FakeCommand = { command: string[]; cwd?: string; input?: string };
export type FakeHandler = (call: FakeCommand, run: { runId: string; workDir: string }) => Partial<SandboxExecResult> | Promise<Partial<SandboxExecResult>>;

/**
 * A sandbox that runs nothing: each command goes to a handler, which says what it "printed" and may write
 * files into the working directory the way the real command would. Records every start, command and stop.
 */
export class FakeSandboxes {
  /** How many sandboxes were started, and how many of them were stopped. */
  started = 0;
  stopped = 0;
  readonly commands: FakeCommand[] = [];
  /** Set to make the next start fail, as when Docker is not running. */
  failWith: string | undefined;

  constructor(private readonly handler: FakeHandler = () => ({})) {}

  readonly factory: SandboxFactory = async (run) => {
    if (this.failWith) throw new Error(this.failWith);
    this.started += 1;
    const id = this.started;
    let stopped = false;
    const session: SandboxSession = {
      info: { image: "fake-sandbox:test", containerId: `fake-${id}` },
      exec: async (command: readonly string[], options: SandboxExecOptions = {}) => {
        if (stopped) throw new Error("this sandbox has been stopped");
        const call: FakeCommand = { command: [...command], ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.input !== undefined ? { input: options.input } : {}) };
        this.commands.push(call);
        const result = await this.handler(call, run);
        return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 5, ...result };
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.stopped += 1;
      },
    };
    return session;
  };
}
