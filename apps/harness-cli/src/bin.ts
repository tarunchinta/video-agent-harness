#!/usr/bin/env node
import { existsSync } from "node:fs";
import { main } from "./main.ts";

// Variables already set in the shell win over the file.
if (existsSync(".env")) process.loadEnvFile(".env");

const controller = new AbortController();
process.once("SIGINT", () => {
  process.stderr.write("\nStopping after the current step. The run can be resumed.\n");
  controller.abort();
});

process.exitCode = await main(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
  cwd: process.cwd(),
  signal: controller.signal,
});
