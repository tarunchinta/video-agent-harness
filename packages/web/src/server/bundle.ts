import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Builds the browser client in memory when the server starts. No build step to remember and no `dist/` to go
 * stale: the page always matches the source it was started from. In dev mode it rebuilds on each page load.
 */

export type Bundle = { js: string; css: string; builtAt: string };

const ENTRY = fileURLToPath(new URL("../client/main.tsx", import.meta.url));

export async function bundleClient(options: { dev?: boolean } = {}): Promise<Bundle> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    jsx: "automatic",
    minify: !options.dev,
    sourcemap: options.dev ? "inline" : false,
    outdir: "out",
    legalComments: "none",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify(options.dev ? "development" : "production") },
  });
  const js = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
  const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  return { js, css, builtAt: new Date().toISOString() };
}

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Reel harness</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23e8590c'/%3E%3Cpath d='M12 9l11 7-11 7z' fill='white'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;
