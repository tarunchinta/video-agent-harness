export type SseEvent = { event: string; data: string };

/**
 * Reads a server-sent event stream. Handles what the wire can do to it: an event split across network chunks,
 * a multi-byte character split across chunks, `\r\n` line endings, comment lines and multi-line data.
 *
 * Aborting `signal` ends the stream at once, even when the transport underneath does not notice the abort
 * itself. The caller checks the signal afterwards to tell an abort from a normal end.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          // A blank line ends the event.
          if (data.length) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value_ = colon < 0 ? "" : line.slice(colon + 1);
        if (value_.startsWith(" ")) value_ = value_.slice(1);
        if (field === "event") event = value_;
        else if (field === "data") data.push(value_);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
