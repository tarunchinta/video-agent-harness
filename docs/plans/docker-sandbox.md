# Docker sandbox: architecture

The sandbox named in `VISION.md` ("Local Docker container per run: code execution, headless browser,
ffmpeg, renderer") and the `sandbox` seam in `PLUGIN_CONTRACT.md`. Research, demo capture and rendering all
run inside it.

Status: built and tested on Docker Desktop for Windows, and wired into runs: the agent loop starts it the first
time a tool asks and removes it whenever the run stops (see section 10 of [agent-loop.md](agent-loop.md)). The
plugin wrapper is `dockerSandboxPlugin` in `src/plugin.ts`. See [What exists today](#what-exists-today).

## Decisions in brief

| Question | Decision |
|---|---|
| Unit of isolation | One container per run, named `harness-run-<run id>`, plus one small egress proxy container when the run has network access. |
| Lifetime | The container lives only while a worker holds the run. It is removed at a gate, a pause, the end of the run or a crash, and a fresh one starts on resume. |
| What survives | Only `/work` (the run's `work/` folder on the host). Anything else in the container is thrown away. |
| How work gets in | `docker exec`. No daemon inside the container, no published ports, no Docker socket. |
| Trust boundary | The container. Everything inside is treated as possibly hostile: agent-written code, pages the browser loads, media ffmpeg parses. |
| Secrets | None, ever. Model and vendor calls happen in the host process. |
| Network | `none` by default. `public` gives HTTP and HTTPS to public addresses through the proxy; the host, the local network and other containers stay unreachable. |
| Browser | Chromium driven by Playwright inside the container, with Chromium's own sandbox off. The container is the boundary. |
| Docker access | The `docker` command line through one small interface. No vendor SDK. |

## Pieces

```
host                                      Docker
────────────────────────────────          ─────────────────────────────────────────────
harness process                           network harness-net-<run> (internal, per run)
  sandbox driver ── docker exec ───────►    harness-run-<run>      the sandbox
  runs/<run>/work  ◄── bind mount ─────►      /work (rw)  /artifacts (ro)
  runs/<run>/artifacts ── read-only ───►      node, python, ffmpeg, chromium
                                            harness-egress-<run>   the proxy
                                              also on `bridge` ───► public internet
```

- **Image** (`packages/sandbox-docker/image`): Node 24, Python 3.12 with a pinned baseline (numpy, pandas,
  matplotlib, duckdb, httpx), uv, static ffmpeg and ffprobe, Playwright with Chromium and its headless
  shell, Xvfb, fonts, and faster-whisper with one speech model (`small.en` unless the build says otherwise)
  for timing a voiceover's words. Built from its own folder so nothing else in the repo can enter the image. The build
  ends with `sandbox-selfcheck`, which encodes a clip, draws a chart and records a browser session, so a
  broken image fails at build time and not during a run.
- **Driver** (`packages/sandbox-docker/src`): starts, uses and removes the container. It has no dependency
  on the kernel, so it can become the `sandbox-docker` plugin with a thin wrapper once `contract` exists.
- **Egress proxy** (`image/egress-proxy.mjs`): the same image with a different command. No run code
  executes in it.

## Using the driver

```ts
import { DockerSandbox } from "@harness/sandbox-docker";

const sandbox = await DockerSandbox.start({
  runId,                                   // names the container, proxy and network
  workDir: "/abs/runs/<run id>/work",      // mounted at /work
  artifactsDir: "/abs/runs/<run id>/artifacts", // optional, read-only at /artifacts
  network: "public",                       // default is "none"
});

const result = await sandbox.exec(["python", "plot.py"], { timeoutMs: 60_000, signal });
const file = await sandbox.read("charts/views.png", "/abs/runs/<run id>/artifacts/views.png");
await sandbox.write("inputs/voiceover.wav", "/abs/path/voiceover.wav");
await sandbox.stop();
```

How this lines up with `SandboxSession` in `PLUGIN_CONTRACT.md`:

| Contract | Driver today | The plugin wrapper adds |
|---|---|---|
| `exec(cmd, opts)` | `exec`, returning exit code, output, `timedOut`, `durationMs` | `Metered` usage (`usd: 0`, `seconds`) |
| `read(path)` | `read(path, hostDestination)`, returning bytes and SHA-256 | Turning the copied file into an `ArtifactRef` |
| `write(path, file)` | `write(path, hostSource)` | Resolving the `ArtifactRef` to a host path |
| `browser()` | Not built. Playwright scripts run through `exec` | Milestone 5 |
| `run.effect(() => () => session.stop())` | `stop()` | Called from `ctx.onRun` |

## Container settings

| Setting | Value | Why |
|---|---|---|
| User | uid 1000, or the host user's uid on Linux | Never root; files in `/work` stay owned by the person running the harness |
| Capabilities | `--cap-drop ALL`, `--security-opt no-new-privileges` | Nothing run code does needs one |
| Limits | 4 GB memory with no swap, 4 CPUs, 2048 pids, 1 GB `/dev/shm`; clamped to what the Docker host has | Runaway code cannot starve the machine; Chromium needs the larger shared memory |
| Init | `--init` | Reaps the processes Chromium and ffmpeg leave behind |
| Mounts | `work/` at `/work` read-write, `artifacts/` at `/artifacts` read-only | Inputs such as voiceover and footage are readable without copying |
| Environment | Only what the run config lists, plus proxy variables | Host environment is never forwarded |
| Labels | `harness.sandbox`, `harness.run=<run id>` | Leftover containers and networks can be found and removed |
| Never | `--privileged`, the Docker socket, host networking, published ports | Each one is a way out |

The image carries a label, `harness.sandbox.api`. The driver refuses an image whose value differs from its
own, because the scripts in the image and the driver are one protocol.

## Running a command

`exec(cmd, options)` takes an argument array (no shell), a working directory, extra environment, optional
stdin text, a timeout and an output limit.

1. The driver runs `docker exec … sandbox-exec <id> <backstop> <cmd…>`.
2. `sandbox-exec` starts the command in its own session and records the process group.
3. On timeout or cancel, the driver runs `sandbox-kill <id>`, which stops the whole group: TERM, then KILL
   two seconds later. Killing only the local `docker exec` client would leave the command running.
4. A backstop timeout inside the container stops the command even if the harness process dies.

The result is the exit code, stdout and stderr (the first and last half of the limit, with a note of what
was dropped), whether it timed out, and the duration. A timeout is a result, since the partial output helps
the model. A cancel is an error (`aborted`).

Errors carry a code and a `retryable` flag, as the seam rules require: `docker_unavailable`,
`image_missing`, `image_incompatible`, `start_failed`, `not_running`, `invalid_request`, `aborted`,
`too_large`, `io`.

## Moving files

`read(path, destination)` and `write(path, source)` copy one file out of or into the sandbox by streaming
through `docker exec`, hashing as they go, and return bytes and SHA-256 for the `artifacts` table.

Files are not read through the host side of the bind mount. Run code can create a symlink in `/work` that
points anywhere, and a host process following it would read the host's own files. Resolving the path inside
the container removes that risk. The same rule applies to any host-side tool that touches `work/`
(`read_file`, `write_file`): it must not follow symlinks out of the folder.

## Network

Two modes, set per run.

- **`none`**: `--network none`.
- **`public`**: the sandbox joins a per-run internal network that has no route out. The proxy sits on that
  network and on Docker's `bridge`. `HTTP_PROXY` and `HTTPS_PROXY` in the sandbox point at it.

The proxy resolves each name itself, refuses private, loopback, link-local, carrier-NAT, multicast and
documentation ranges (IPv4 and IPv6), and connects to the address it checked, so a DNS answer cannot change
between the check and the connection. It tries IPv4 addresses first, because Docker networks usually have no
IPv6 route. An optional host allow-list narrows it further. Every decision is one JSON line on stdout, and
`egressLog()` returns them, which gives each run a record of the hosts it contacted.

curl, Python (httpx), Node's `fetch` and Chromium all pick the proxy up from the environment with no extra
settings. Anything that ignores those variables simply has no route out. UDP (QUIC, WebRTC) does not work.

A network per run means two runs cannot reach each other's local servers. Docker's default address pools
allow roughly 30 such networks at once.

Anything that fetches a URL the agent chose should do it from inside the sandbox, so it gets this
protection without extra code. The reel pipeline's `web_fetch` is the exception: it fetches from the host
process, behind its own check that the address is public.

## Lifecycle and the event log

| Moment | What happens | Event |
|---|---|---|
| A tool first asks for the sandbox | Remove leftovers with this run id, create network and proxy if needed, start the container | `sandbox.started` with the image and the container id |
| Gate, pause, end, failure | Remove container, proxy and network | `sandbox.completed` with the reason |
| Crash | Nothing at the time. The next start removes what was left | The next worker writes `sandbox.completed` with `interrupted` for the one left open |
| Resume | Fresh container, when a tool next asks. `work/` is still on the host. Restoring it from a checkpoint manifest is planned and not built | `sandbox.started` |

Consequence: packages installed outside `/work` disappear at a gate. Python extras go to
`/work/.packages` (already on `PYTHONPATH`) and Node projects keep `node_modules` under `/work`. An opt-in
named volume can hold npm, uv and pip download caches between runs; it is off by default because a shared
cache is something one run can leave behind for the next.

## How the three consumers use it

| Consumer | Uses |
|---|---|
| Research | `exec` for Python and Node experiments, DuckDB over public datasets, charts with matplotlib. Downloads from inside the sandbox need network `public`; the reel pipeline runs with `none` unless asked |
| Demo capture | Playwright scripts through `exec` today. The `BrowserHandle` in the plugin contract (navigate, act, record) is milestone 5 and gets its own plan |
| Rendering | The film kit (`packages/reel/kit`): headless Chromium draws each frame of an HTML page and ffmpeg encodes it, with fonts from the image and no network. faster-whisper times the voiceover's words |

Remotion is not in the image and is not used. The film kit needs nothing the image does not already have.

## What exists today

In `packages/sandbox-docker`:

| Part | Files |
|---|---|
| Image | `image/Dockerfile`, `image/requirements.in` and the pinned `requirements.txt` |
| In-container scripts | `image/bin/sandbox-exec`, `sandbox-kill`, `sandbox-selfcheck` |
| Egress proxy | `image/egress-proxy.mjs` |
| Driver | `src/sandbox.ts` (start, exec, read, write, stop, list, remove), `src/args.ts` (every `docker` argument list, as pure functions), `src/docker.ts`, `src/options.ts`, `src/errors.ts`, `src/output.ts` |
| Tests | `test/` |

Build the image once, and again after changing anything under `image/`:

```
docker build -t harness-sandbox:local packages/sandbox-docker/image
```

### What has been checked

Unit tests (75, no Docker needed, part of `pnpm test`): the container flags, start order and cleanup on
failure, timeout and cancel, error codes, file copies, and the proxy's address rules.

Integration tests (16, real containers), run on Docker Desktop 4.44 (engine 28.3) on Windows 11. They are
skipped unless asked for:

```
HARNESS_SANDBOX_IT=1 HARNESS_SANDBOX_IT_NET=1 pnpm test
```

The second variable adds the tests that reach `example.com` and PyPI. Together they confirm:

- The self-check passes in a locked-down container: ffmpeg encode, Python chart, Chromium screenshot and
  recording.
- The container is not root, has no capabilities and, by default, no network.
- A timeout or a cancel stops the whole process tree, and nothing is left running.
- Files copy in and out with matching hashes, and a planted symlink reads the container's file, not the
  host's.
- After a restart `/work` is intact and everything else is gone.
- With `network: "public"`, curl, Python, Node and Chromium reach public sites; the metadata address, the
  Docker host and private addresses are refused; a direct connection that skips the proxy fails.
- `uv pip install --target /work/.packages` works and the package is importable.
- The egress log lists the hosts that were allowed and refused.

Two live reel runs on 16 November 2026 also used it, with network `none`: they ran the agent's commands,
drew stills and rendered three cuts between them.

### Not done

- The `sandbox` seam's conformance kit (`testSandbox` in `@harness/contract/conformance`) exists but is not yet
  wired into this package's integration tests.
- The speech model has only been checked on English, with the one recording in `projects/`. Its words came
  back within a few hundredths of a second of the hand-made subtitle file, in about a third of the
  recording's length on four CPUs.
- `browser()`, as described above.
- Nothing has been run on a Linux or macOS host.

## Left open

- **Chromium's own sandbox.** Turning it on needs a custom seccomp profile that allows user namespaces. It
  would protect the run's files from a malicious page, not the host.
- **Linux hosts.** A service on the host bound to `0.0.0.0` may be reachable from an internal network
  through the bridge address. Only Docker Desktop has been tested. Bind local services to `127.0.0.1`.
- **Disk.** A bind mount cannot be given a size, so `limits.workDiskMb` (10 GB unless set) is held two ways: a
  file-size limit on every process (`--ulimit fsize`), so no single file outgrows it, and a measurement of
  `/work` after each command (`du -skx`). When the folder is over, the command's result carries `diskFull` and
  the agent is told to delete files first. Many files written by one command can still pass the limit before it
  is measured.
- **Screen capture.** The static ffmpeg has no `x11grab`, so recording a headed browser under Xvfb needs
  another ffmpeg build. Playwright's own recording works. The demo capture plan decides.
- **Image size.** Chromium and its headless shell are about 1 GB, static ffmpeg 270 MB, and the speech
  library with its model about 1.5 GB. The image is 4.6 GB in all.
- **The speech library and its audio decoder disagree.** The pinned faster-whisper cannot open a file through
  the pinned PyAV. The self-check and the harness therefore decode with ffmpeg and hand over samples, which
  avoids PyAV altogether. If a later pair agrees again, nothing needs to change.
- **Where the plugin wrapper lives.** The driver is in `packages/sandbox-docker`. `PLUGIN_CONTRACT.md` puts
  plugins in `plugins/<name>`; the wrapper can live there and import the driver, or sit next to it.
- **Default network.** The driver defaults to `none`. Research and demo capture need `public`, so the run
  config has to ask for it. Whether the plugin's own default should be `public` is undecided.
