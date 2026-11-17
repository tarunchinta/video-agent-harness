import type { ExecOptions, SandboxOptions } from "./options.ts";

/**
 * Pure builders for every `docker` argument list the driver uses. Keeping them free of I/O means the
 * security-relevant flags are checked by plain unit tests, with no Docker installed.
 */

/** The image and driver agree on scripts and paths through this number (label `harness.sandbox.api`). */
export const SANDBOX_API = "1";

export const LABEL_KIND = "harness.sandbox";
export const LABEL_RUN = "harness.run";
export const LABEL_API = "harness.sandbox.api";

export const PROXY_HOST = "egress";
export const PROXY_PORT = 3128;
export const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;
/** Addresses inside the container never go through the proxy (a dev server the run started, for example). */
const NO_PROXY = "localhost,127.0.0.1,::1";

/** Docker's own network with a route to the internet. Only the proxy joins it. */
const OUTSIDE_NETWORK = "bridge";

export const containerName = (runId: string): string => `harness-run-${runId}`;
export const proxyName = (runId: string): string => `harness-egress-${runId}`;
export const networkName = (runId: string): string => `harness-net-${runId}`;

/** One field of a `--mount` value, quoted the way Docker's CSV reader expects when it holds a comma or quote. */
function csvField(field: string): string {
  return /[",]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

export function bindMount(source: string, target: string, readOnly: boolean): string {
  const fields = ["type=bind", `src=${source}`, `dst=${target}`];
  if (readOnly) fields.push("readonly");
  return fields.map(csvField).join(",");
}

function envFlags(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}

/** Flags every container this driver starts gets: no capabilities, no way to gain any, a process reaper. */
const HARDENING = ["--init", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"] as const;

export type HostFacts = {
  /** CPUs and memory the Docker host has; requested limits are clamped to these. */
  cpus: number;
  memoryMb: number;
  /** "uid:gid" to run as on a Linux host, so files in /work belong to the person running the harness. */
  user?: string;
};

export function sandboxRunArgs(options: SandboxOptions, host: HostFacts): string[] {
  const memoryMb = Math.min(options.limits.memoryMb, host.memoryMb);
  const cpus = Math.min(options.limits.cpus, host.cpus);
  const shmMb = Math.min(options.limits.shmMb, memoryMb);
  const args = [
    "run", "--detach", ...HARDENING,
    "--name", containerName(options.runId),
    "--hostname", "sandbox",
    "--label", `${LABEL_KIND}=run`,
    "--label", `${LABEL_RUN}=${options.runId}`,
    "--network", options.network === "public" ? networkName(options.runId) : "none",
    "--memory", `${memoryMb}m`,
    "--memory-swap", `${memoryMb}m`,
    "--cpus", String(cpus),
    "--pids-limit", String(options.limits.pids),
    "--shm-size", `${shmMb}m`,
    "--ulimit", "core=0",
    "--workdir", "/work",
    "--mount", bindMount(options.workDir, "/work", false),
  ];
  if (host.user) args.push("--user", host.user);
  if (options.artifactsDir) args.push("--mount", bindMount(options.artifactsDir, "/artifacts", true));
  if (options.cacheVolume) {
    args.push(
      "--mount", `type=volume,src=${options.cacheVolume},dst=/cache`,
      ...envFlags({ NPM_CONFIG_CACHE: "/cache/npm", UV_CACHE_DIR: "/cache/uv", PIP_CACHE_DIR: "/cache/pip" }),
    );
  }
  if (options.network === "public") {
    args.push(
      ...envFlags({
        HTTP_PROXY: PROXY_URL, HTTPS_PROXY: PROXY_URL, http_proxy: PROXY_URL, https_proxy: PROXY_URL,
        NO_PROXY, no_proxy: NO_PROXY,
      }),
    );
  }
  args.push(...envFlags(options.env), options.image, "sleep", "infinity");
  return args;
}

/** The proxy starts on the outside network; `proxyConnectArgs` then adds it to the run's network. */
export function proxyRunArgs(options: SandboxOptions): string[] {
  return [
    "run", "--detach", ...HARDENING, "--read-only",
    "--name", proxyName(options.runId),
    "--label", `${LABEL_KIND}=egress`,
    "--label", `${LABEL_RUN}=${options.runId}`,
    "--network", OUTSIDE_NETWORK,
    "--user", "1000:1000",
    "--memory", "256m",
    "--memory-swap", "256m",
    "--pids-limit", "128",
    ...envFlags({ EGRESS_ALLOW_HOSTS: options.allowHosts.join(",") }),
    options.image, "node", "/opt/sandbox/egress-proxy.mjs",
  ];
}

/** An internal network has no route out: the only thing a sandbox can reach on it is the proxy. */
export function networkCreateArgs(runId: string): string[] {
  return [
    "network", "create", "--internal",
    "--label", `${LABEL_KIND}=network`,
    "--label", `${LABEL_RUN}=${runId}`,
    networkName(runId),
  ];
}

export function proxyConnectArgs(runId: string): string[] {
  return ["network", "connect", "--alias", PROXY_HOST, networkName(runId), proxyName(runId)];
}

export function proxyWaitArgs(runId: string): string[] {
  return ["exec", proxyName(runId), "node", "/opt/sandbox/egress-proxy.mjs", "--wait"];
}

/** Seconds added to the in-container backstop, so the driver's own timeout always fires first. */
const BACKSTOP_EXTRA_SECONDS = 30;

export function execArgs(runId: string, execId: string, command: readonly string[], options: ExecOptions): string[] {
  const backstop = Math.ceil(options.timeoutMs / 1000) + BACKSTOP_EXTRA_SECONDS;
  return [
    "exec",
    ...(options.input === undefined ? [] : ["--interactive"]),
    "--workdir", options.cwd,
    ...envFlags(options.env),
    containerName(runId),
    "sandbox-exec", execId, String(backstop),
    ...command,
  ];
}

export function killArgs(runId: string, execId: string): string[] {
  return ["exec", containerName(runId), "sandbox-kill", execId];
}

export function readFileArgs(runId: string, path: string): string[] {
  return ["exec", "--workdir", "/work", containerName(runId), "cat", "--", path];
}

export function writeFileArgs(runId: string, path: string): string[] {
  return [
    "exec", "--interactive", "--workdir", "/work", containerName(runId),
    "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path,
  ];
}
