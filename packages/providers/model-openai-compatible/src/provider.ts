import { ModelError, type ModelCapabilities, type ModelProvider, type ModelRequest, type ModelStreamEvent, type Usage } from "@harness/harness";
import { MODELS, PRICES_CHECKED_ON, priceMicroUsd, type ModelInfo } from "./models.ts";
import { readSse } from "./sse.ts";
import { ChunkAssembler, errorFromCode, PROVIDER_ID, toWireRequest } from "./wire.ts";

export type OpenAICompatibleProviderOptions = {
  apiKey: string;
  /** Everything before `/chat/completions`, such as `https://<resource>.services.ai.azure.com/openai/v1`. */
  baseUrl: string;
  /** Replaces the global `fetch`, for tests and proxies. */
  fetch?: typeof fetch;
  /** When the prices passed in `models` were checked, as YYYY-MM-DD. */
  pricesCheckedOn?: string;
  /** Extra or corrected models, merged over the built-in table. */
  models?: Record<string, ModelInfo>;
  /** Send the model's reasoning back on later turns. Off by default. */
  sendReasoning?: boolean;
  /** Longest silence allowed on an open stream before the call is given up. */
  idleTimeoutMs?: number;
};

/**
 * A model behind an OpenAI-style chat completions API, with plain HTTP: one streaming
 * `POST <baseUrl>/chat/completions` per call, read as server-sent events. It makes exactly one attempt and
 * reports what went wrong; retrying is the loop's job, so every attempt is in the log and counts against the budget.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = PROVIDER_ID;
  readonly pricesCheckedOn: string;
  private readonly models: Record<string, ModelInfo>;
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    if (!options.apiKey) throw new Error("The model provider needs an API key.");
    if (!options.baseUrl) throw new Error("The model provider needs the API's base URL.");
    this.models = { ...MODELS, ...options.models };
    this.pricesCheckedOn = options.pricesCheckedOn ?? PRICES_CHECKED_ON;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private info(model: string): ModelInfo {
    const info = this.models[model];
    if (!info) throw new Error(`The model provider has no entry for the model "${model}". Known models: ${Object.keys(this.models).join(", ")}.`);
    return info;
  }

  capabilities(model: string): ModelCapabilities {
    const { contextWindow, maxOutputTokens } = this.info(model);
    return { contextWindow, maxOutputTokens };
  }

  priceMicroUsd(model: string, usage: Usage): number {
    // The server can name the model differently from the deployment. Charge the dearest known rate, so a
    // budget is never under-counted.
    const info = this.models[model] ?? Object.values(this.models).reduce((a, b) => (b.output > a.output ? b : a));
    return priceMicroUsd(info, usage);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const info = this.info(request.model);
    const body = toWireRequest(request, info, { sendReasoning: this.options.sendReasoning ?? false });

    // One controller for the caller's cancel and for the idle watchdog.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const idleMs = this.options.idleTimeoutMs ?? 120_000;
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        controller.abort();
      }, idleMs);
    };

    const failure = (err: unknown): ModelError => {
      if (err instanceof ModelError) return err;
      if (signal.aborted) return new ModelError("aborted", "The call was cancelled.");
      if (idle) return new ModelError("timeout", `The model sent nothing for ${Math.round(idleMs / 1000)} seconds.`);
      return new ModelError("transport", err instanceof Error ? err.message : String(err));
    };

    try {
      watch();
      let response: Response;
      try {
        response = await this.fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        throw failure(err);
      }
      if (!response.ok) throw await httpError(response);
      if (!response.body) throw new ModelError("transport", "The API returned no response body.");

      const assembler = new ChunkAssembler();
      try {
        for await (const event of readSse(response.body, controller.signal)) {
          watch();
          if (event.data.trim() === "[DONE]") break;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(event.data) as Record<string, unknown>;
          } catch {
            throw new ModelError("transport", "The stream carried an event that was not valid JSON.");
          }
          const text = assembler.accept(parsed);
          if (text) yield { type: "text_delta", text };
        }
        // A cancelled or stalled stream ends quietly; say which it was instead of reporting a short answer.
        if (controller.signal.aborted) throw new Error("The stream was stopped.");
      } catch (err) {
        throw failure(err);
      }
      yield { type: "response", response: assembler.finish() };
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Turns a non-2xx response into the loop's error vocabulary. */
async function httpError(response: Response): Promise<ModelError> {
  let code: string | undefined;
  let message = `The API answered ${response.status}.`;
  try {
    const parsed = (await response.json()) as { error?: { code?: unknown; type?: unknown; message?: string } };
    if (parsed.error?.code !== undefined && parsed.error.code !== null) code = String(parsed.error.code);
    else if (typeof parsed.error?.type === "string") code = parsed.error.type;
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // Not JSON: keep the status line.
  }
  const ms = Number(response.headers.get("retry-after-ms"));
  const seconds = Number(response.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
  const { status } = response;

  if (status === 401 || status === 403) return new ModelError("auth", message);
  if (status === 429) return new ModelError("rate_limited", message, retryAfterMs);
  if (status === 408) return new ModelError("timeout", message);
  if (status >= 500) return new ModelError("upstream", message, retryAfterMs);
  if (status === 400 && (code === "context_length_exceeded" || /maximum context length|context window|too many tokens/i.test(message))) {
    return new ModelError("context_overflow", message);
  }
  return errorFromCode(code, message, retryAfterMs);
}
