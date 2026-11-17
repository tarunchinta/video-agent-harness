import type { DockerCli, DockerResult, DockerRunOptions } from "../src/docker.ts";

export type Call = { args: string[]; options: DockerRunOptions };
export type Reply = Partial<DockerResult> | undefined;
export type Handler = (args: string[], options: DockerRunOptions) => Reply | Promise<Reply>;

const OK: DockerResult = { code: 0, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, truncated: false };

/** What a healthy Docker host with a built image answers. A test's handler overrides any of it. */
function defaults(args: string[]): Reply {
  if (args[0] === "info") return { stdout: "8 16777216000\n" };
  if (args[0] === "image" && args[1] === "inspect") return { stdout: "sha256:feedface 1\n" };
  if (args[0] === "run") return { stdout: "c0ffee\n" };
  return {};
}

/**
 * A stand-in for the docker command line: records every call and answers from `handler`, falling back to
 * the defaults above when the handler returns undefined.
 */
export function fakeDocker(handler: Handler = () => undefined): DockerCli & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(args, options = {}) {
      const list = [...args];
      calls.push({ args: list, options });
      const reply = (await handler(list, options)) ?? defaults(list);
      return { ...OK, ...reply };
    },
  };
}

/** The first words of each call, enough to assert on the order things happened in. */
export function verbs(calls: Call[]): string[] {
  return calls.map(({ args }) => (args[0] === "network" || args[0] === "image" ? `${args[0]} ${args[1]}` : args[0]!));
}
