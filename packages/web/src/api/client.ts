import { CLIENT_HEADER, frameSchema, methods, resultSchema, type ApiError, type Frame, type InputOf, type MethodName, type OutputOf } from "./contract.ts";

/** Thrown when a call comes back with an error. The message is written for the creator to read. */
export class ApiCallError extends Error {
  constructor(readonly code: ApiError["code"], message: string) {
    super(message);
    this.name = "ApiCallError";
  }
}

/**
 * Calls the server. Every answer is checked against the contract before the caller sees it. `doFetch` is the
 * only thing that changes between the browser and a test.
 */
export class ApiClient {
  constructor(private readonly base = "", private readonly doFetch: typeof fetch = (...args) => fetch(...args)) {}

  async call<M extends MethodName>(method: M, input: InputOf<M>): Promise<OutputOf<M>> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.base}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", [CLIENT_HEADER]: "1" },
        body: JSON.stringify(input),
      });
    } catch {
      throw new ApiCallError("failed", "The harness server cannot be reached. Is `pnpm harness web` still running?");
    }
    const parsed = resultSchema(methods[method].output).safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new ApiCallError("failed", `The server's answer to ${method} was not in the expected shape.`);
    if (!parsed.data.ok) throw new ApiCallError(parsed.data.error.code, parsed.data.error.message);
    return parsed.data.value as OutputOf<M>;
  }

  /** Sends a file for a review, such as the voiceover. Returns the name to refer to it by. */
  async upload(runId: string, file: Blob, name: string): Promise<string> {
    const response = await this.doFetch(`${this.base}/api/upload?run=${encodeURIComponent(runId)}&name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", [CLIENT_HEADER]: "1" },
      body: file,
    });
    const body = (await response.json().catch(() => undefined)) as { ok?: boolean; value?: { name?: string }; error?: ApiError } | undefined;
    if (!body?.ok || typeof body.value?.name !== "string") throw new ApiCallError(body?.error?.code ?? "failed", body?.error?.message ?? "The upload did not go through.");
    return body.value.name;
  }
}

/** Parses one frame off the stream. A frame that does not match the contract is dropped. */
export function parseFrame(data: string): Frame | undefined {
  try {
    const parsed = frameSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Where the server serves a run's files and a project's files. */
export const runFileUrl = (runId: string, path: string) => `/files/runs/${encodeURIComponent(runId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
export const artifactUrl = (runId: string, sha256: string, mediaType: string) =>
  `/files/artifacts/${encodeURIComponent(runId)}/${sha256}.${mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : mediaType === "image/gif" ? "gif" : "jpg"}`;
export const projectFileUrl = (slug: string, path: string) => `/files/projects/${encodeURIComponent(slug)}/${path.split("/").map(encodeURIComponent).join("/")}`;
