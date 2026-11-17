import { ModelError, type ModelCapabilities, type ModelProvider, type ModelRequest, type ModelStreamEvent, type Usage } from "@harness/harness";
import { MODELS, priceMicroUsd, type ModelInfo } from "./models.ts";
import { readSse } from "./sse.ts";
import { errorFromType, MessageAssembler, PROVIDER_ID, toWireRequest } from "./wire.ts";

export type ClaudeProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Sent as `anthropic-version`. */
  apiVersion?: string;
  /** Replaces the global `fetch`, for tests and proxies. */
  fetch?: typeof fetch;
  /** Extra or corrected models, merged over the built-in table. */
  models?: Record<string, ModelInfo>;
  /** `summarized` returns a readable account of the model's reasoning, at no extra charge. */
  thinkingDisplay?: "summarized" | "omitted";
  /** Effort when a run does not set one. */
  defaultEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Let the API answer a declined request with another model. On by default. */
  fallbacks?: boolean;
  /** Ask the API to reject any request whose earlier turns changed. For tests and CI. */
  strictHistory?: boolean;
  /** Longest silence allowed on an open stream before the call is given up. */
  idleTimeoutMs?: number;
};

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_API_VERSION = "2026-10-21";

/**
 * Claude over the Messages API, with plain HTTP: one streaming `POST /v1/messages` per call, read as
 * server-sent events. It makes exactly one attempt and reports what went wrong; retrying is the loop's job, so
 * every attempt is in the log and counts against the budget.
 */
export class ClaudeProvider implements ModelProvider {
  readonly id = PROVIDER_ID;
  private readonly models: Record<string, ModelInfo>;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: ClaudeProviderOptions) {
    if (!options.apiKey) throw new Error("The Claude provider needs an API key.");
    this.models = { ...MODELS, ...options.models };
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private info(model: string): ModelInfo {
    const info = this.models[model];
    if (!info) throw new Error(`The Claude provider has no entry for the model "${model}". Known models: ${Object.keys(this.models).join(", ")}.`);
    return info;
  }

  capabilities(model: string): ModelCapabilities {
    const { contextWindow, maxOutputTokens } = this.info(model);
    return { contextWindow, maxOutputTokens };
  }

  priceMicroUsd(model: string, usage: Usage): number {
    // A fallback can be answered by a model that is not in the table. Charge the dearest known rate, so a
    // budget is never under-counted.
    const info = this.models[model] ?? Object.values(this.models).reduce((a, b) => (b.output > a.output ? b : a));
    return priceMicroUsd(info, usage);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const info = this.info(request.model);
    const { body, betas } = toWireRequest(request, info, {
      thinkingDisplay: this.options.thinkingDisplay ?? "summarized",
      defaultEffort: this.options.defaultEffort ?? "high",
      fallbacks: this.options.fallbacks ?? true,
      strictHistory: this.options.strictHistory ?? false,
    });

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
        response = await this.fetch(`${this.options.baseUrl ?? DEFAULT_BASE_URL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.options.apiKey,
            "anthropic-version": this.options.apiVersion ?? DEFAULT_API_VERSION,
            ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        throw failure(err);
      }
      if (!response.ok) throw await httpError(response);
      if (!response.body) throw new ModelError("transport", "The API returned no response body.");

      const assembler = new MessageAssembler();
      try {
        for await (const event of readSse(response.body, controller.signal)) {
          watch();
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
  let type: string | undefined;
  let message = `The API answered ${response.status}.`;
  try {
    const parsed = (await response.json()) as { error?: { type?: string; message?: string } };
    type = parsed.error?.type;
    if (parsed.error?.message) message = parsed.error.message;
  } catch {
    // Not JSON: keep the status line.
  }
  const seconds = Number(response.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
  const { status } = response;

  // The API's own word on whether another attempt can help.
  if (response.headers.get("x-should-retry") === "false") {
    return status === 401 || status === 403 ? new ModelError("auth", message) : new ModelError("invalid_request", message);
  }
  if (status === 401 || status === 403) return new ModelError("auth", message);
  if (status === 429) return new ModelError("rate_limited", message, retryAfterMs);
  if (status === 408) return new ModelError("timeout", message);
  if (status >= 500) return new ModelError("upstream", message, retryAfterMs);
  // A prompt over the context window has no error type of its own; the API reports it as a plain 400 with
  // this wording. The loop also checks the size itself before every call, so this is the second line.
  if (status === 400 && /prompt is too long/i.test(message)) return new ModelError("context_overflow", message);
  return errorFromType(type, message, retryAfterMs);
}
