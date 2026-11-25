# Run sandbox

One Docker container per run. Agent-written code, the headless browser, ffmpeg and renders execute here.
Design and reasoning: [docs/plans/docker-sandbox.md](../../docs/plans/docker-sandbox.md).

## Build the image

```
docker build -t harness-sandbox:local packages/sandbox-docker/image
```

Rebuild after changing anything under `image/`. To change the Python baseline, edit `image/requirements.in`
and run `pnpm --filter @harness/sandbox-docker image:lock`. The packages that time a voiceover's words are in
`image/requirements-voice.in`, locked against the baseline with `image:lock:voice`. The speech model is fixed
at build time; `--build-arg WHISPER_MODEL=base.en` picks a smaller one.

## Use it

```ts
import { DockerSandbox } from "@harness/sandbox-docker";

const sandbox = await DockerSandbox.start({ runId, workDir, network: "public" });
const result = await sandbox.exec(["python", "plot.py"], { timeoutMs: 60_000 });
await sandbox.read("chart.png", "/abs/path/on/host/chart.png");
await sandbox.stop();
```

`listSandboxes()` and `removeSandbox(runId)` find and remove containers left behind by a crashed worker.

## Test it

`pnpm test` runs the unit tests, which need no Docker. The tests against real containers are opt-in:

| Variable | Adds |
|---|---|
| `HARNESS_SANDBOX_IT=1` | Tests that start containers from `harness-sandbox:local` |
| `HARNESS_SANDBOX_IT_NET=1` | Tests that reach the public internet through the egress proxy |
