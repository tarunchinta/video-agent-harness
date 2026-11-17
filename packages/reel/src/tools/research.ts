import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { defineTool, inStage, ToolError } from "@harness/harness";

const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 60_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 25_000;

export type WebFetchDeps = {
  /** Replaces the global `fetch`, for tests. */
  fetch?: typeof fetch;
  /** Resolves a host name to its addresses. Replaced in tests. */
  resolve?: (host: string) => Promise<string[]>;
};

/** True for addresses that are not on the public internet: this machine, the local network, link-local, reserved. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1]! : address;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("::ffff:");
  }
  return true;
}

async function assertPublic(url: URL, resolve: (host: string) => Promise<string[]>): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ToolError("Only http and https addresses can be fetched.");
  if (url.username || url.password) throw new ToolError("Addresses with a user name or password in them cannot be fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new ToolError(`The site ${host} could not be found.`, "Check the address.");
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new ToolError(`${host} is not on the public internet, so it cannot be fetched.`);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

/** The readable text of an HTML page: no scripts, styles or markup, one block per line. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|li|ul|ol|tr|table|h[1-6]|br|blockquote|pre|figure|figcaption|title)\b[^>]*>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => safeChar(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeChar(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const safeChar = (code: number) => (code > 31 && code < 0x110000 ? String.fromCodePoint(code) : " ");

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    if (total >= MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

const pageSchema = z.object({
  title: z.string().max(200),
  answers_question: z.boolean(),
  facts: z.array(z.object({ claim: z.string().max(280), figure: z.string().max(80).optional() })).max(12),
  published: z.string().max(40).optional(),
});

const outputSchema = pageSchema.extend({ url: z.string(), host: z.string() });

/**
 * Reads one web page for one question. The page is text written by strangers, so it never reaches the agent:
 * it goes to a model call with no tools, and only that call's short, shape-checked answer comes back.
 */
export function webFetchTool(deps: WebFetchDeps = {}) {
  const resolve = deps.resolve ?? (async (host: string) => (await dnsLookup(host, { all: true })).map((entry) => entry.address));
  return defineTool({
    name: "web_fetch",
    description:
      "Read one public web page and get back what it says about one question, as a short list of facts with their figures. " +
      "You get the facts, not the page's text. Ask one specific question per call, and fetch the page again with another question if you need more from it. " +
      "Works on pages of text (articles, reports, reference pages, JSON). It cannot read PDFs, videos or pages that need a login.",
    input: z.object({
      url: z.string().url().max(2000).describe("The page's full address, starting with https://."),
      question: z.string().min(8).max(400).describe("What you want to learn from this page."),
    }),
    output: outputSchema,
    untrusted: true,
    readOnly: true,
    idempotent: true,
    parallelSafe: true,
    requires: [inStage("research", "script")],
    timeoutMs: 120_000,
    async execute(input, exec) {
      const doFetch = deps.fetch ?? globalThis.fetch;
      let url = new URL(input.url);
      let response: Response | undefined;
      const timeout = AbortSignal.any([exec.signal, AbortSignal.timeout(TIMEOUT_MS)]);
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        // Checked on every hop: a public page must not be able to send the fetch somewhere private.
        await assertPublic(url, resolve);
        try {
          response = await doFetch(url, {
            redirect: "manual",
            signal: timeout,
            headers: { "user-agent": "research-fetch/0.1", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
          });
        } catch {
          if (exec.signal.aborted) throw new ToolError("The fetch was stopped.");
          throw new ToolError(`${url.hostname} did not answer.`, "Try again, or use another source.");
        }
        const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
        if (!location) break;
        await response.body?.cancel().catch(() => {});
        url = new URL(location, url);
        response = undefined;
      }
      if (!response) throw new ToolError("The page redirected too many times.", "Use another source.");
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ToolError(`${url.hostname} answered with an error (${response.status}).`, "Check the address, or use another source.");
      }
      const type = (response.headers.get("content-type") ?? "text/html").split(";")[0]!.trim().toLowerCase();
      if (!/^text\/|^application\/(json|xhtml\+xml|xml|ld\+json)$/.test(type)) {
        await response.body?.cancel().catch(() => {});
        throw new ToolError(`That address holds a ${type} file, not a page of text.`, "Look for an HTML version of the same source.");
      }
      const raw = await readCapped(response);
      const text = (type.includes("html") || type.includes("xml") ? htmlToText(raw) : raw).slice(0, MAX_TEXT_CHARS);
      if (text.length < 40) throw new ToolError("The page has almost no text. It may need JavaScript or a login.", "Use another source.");

      const page = await exec.extract({
        instructions:
          `Read this web page and report what it says about this question: ${JSON.stringify(input.question)}. ` +
          "Give only facts the page itself states, each as one short plain sentence, with the exact figure, unit and date when there is one. " +
          "Do not add anything from your own knowledge. If the page does not address the question, set answers_question to false and give no facts. " +
          "`published` is the page's own date, if it shows one.",
        untrusted: text,
        schema: pageSchema,
      });
      return { ...page, url: input.url, host: url.hostname };
    },
    render(_input, page) {
      const head = `${page.title || page.host} (${page.url})${page.published ? `, dated ${page.published}` : ""}`;
      if (!page.answers_question || !page.facts.length) return `${head}\nThis page does not answer the question.`;
      const facts = page.facts.map((fact, i) => `${i + 1}. ${fact.claim}${fact.figure ? ` [${fact.figure}]` : ""}`);
      return `${head}\n${facts.join("\n")}\n\nThese are the page's claims, not checked facts. Cite the address with anything you use.`;
    },
  });
}
