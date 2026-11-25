import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { definePlugin } from "@harness/contract";
import { DockerSandbox } from "./sandbox.ts";

/**
 * The Docker sandbox as a plugin: the `sandbox` seam's provider. Each run says how much network it gets; the
 * driver starts one container per run with that, the first time a tool asks.
 */
export const dockerSandboxPlugin = definePlugin({
  name: "sandbox-docker",
  version: "0.1.0",
  provides: ["sandbox"],
  config: z.object({
    image: z.string().min(1).default("harness-sandbox:local"),
    /** Most the run's working folder may hold, in megabytes. */
    workDiskMb: z.number().int().min(64).optional(),
  }),
  apply(ctx, config) {
    ctx.sandbox.provide(({ network }) => async ({ runId, workDir, artifactsDir }) => {
      await mkdir(artifactsDir, { recursive: true });
      return DockerSandbox.start({
        runId,
        workDir,
        artifactsDir,
        network,
        image: config.image,
        ...(config.workDiskMb ? { limits: { workDiskMb: config.workDiskMb } } : {}),
      });
    });
  },
});
