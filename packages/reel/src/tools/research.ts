import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
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

/** The eight 16-bit groups of an IPv6 address, or nothing if it is not one. Handles `::` and a dotted IPv4 tail. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1]!.split(".").map(Number);
    if (parts.some((n) => n > 255)) return undefined;
    text = `${text.slice(0, -dotted[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part ? part.split(":").map((g) => Number.parseInt(g, 16)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(Math.max(0, fill)).fill(0), ...tail];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  return groups;
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

const ipv4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * True for addresses that are not on the public internet: this machine, the local network, link-local,
 * reserved and documentation ranges. IPv6 forms that carry an IPv4 address inside them (mapped, compatible,
 * NAT64 and 6to4) are judged by the IPv4 address they carry, and Teredo, whose inner address is hidden, is refused.
 */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIPv4(address);
  if (isIP(address.split("%")[0]!) !== 6) return true;
  const g = ipv6Groups(address);
  if (!g) return true;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8) || (zeros(0, 7) && g[7] === 1)) return true; // :: and ::1
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateIPv4(ipv4Of(g[6]!, g[7]!)); // ::ffff:a.b.c.d, mapped
  if (zeros(0, 6)) return true; // ::a.b.c.d, the old compatible form, never routed
  if (g[0] === 0x64 && g[1] === 0xff9b) return zeros(2, 6) ? isPrivateIPv4(ipv4Of(g[6]!, g[7]!)) : true; // NAT64
  if (g[0] === 0x2002) return isPrivateIPv4(ipv4Of(g[1]!, g[2]!)); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && zeros(1, 4)) return true; // discard
  const first = g[0]!;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00; // unique local, link-local, multicast
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

/** Raised by the pinned lookup when a name resolves somewhere private at the moment of connecting. */
class PrivateAddressError extends Error {}

/**
 * A `fetch` for the public web only. The address is checked at the moment the connection is made, inside the
 * socket's own name lookup, and the connection goes to exactly the address that was checked. A name that
 * resolves to a public address for a first lookup and a private one for a second (DNS rebinding) therefore
 * cannot reach the private one.
 */
export function publicFetch(resolveAll: (host: string) => Promise<string[]> = defaultResolve): typeof fetch {
  const lookup: LookupFunction = (hostname, options, callback) => {
    resolveAll(hostname).then(
      (addresses) => {
        const usable = addresses.filter((a) => (options.family === 6 ? isIP(a) === 6 : options.family === 4 ? isIP(a) === 4 : true));
        if (!usable.length) return callback(Object.assign(new Error(`${hostname} could not be found.`), { code: "ENOTFOUND" }), "", 0);
        if (usable.some(isPrivateAddress)) return callback(new PrivateAddressError(`${hostname} is not on the public internet.`), "", 0);
        const address = usable[0]!;
        if (options.all) (callback as unknown as (err: null, all: { address: string; family: number }[]) => void)(null, [{ address, family: isIP(address) }]);
        else callback(null, address, isIP(address));
      },
      (err: Error) => callback(Object.assign(err, { code: "ENOTFOUND" }), "", 0),
    );
  };
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        { method: "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), lookup, ...(init.signal ? { signal: init.signal } : {}) },
        (res) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
          }
          const status = res.statusCode ?? 502;
          const empty = status === 204 || status === 304 || (status >= 100 && status < 200);
          if (empty) res.resume();
          resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers }));
        },
      );
      req.on("error", (err) => reject(err instanceof PrivateAddressError || (err as { cause?: unknown }).cause instanceof PrivateAddressError ? new PrivateAddressError(err.message) : err));
      req.end();
    });
  }) as typeof fetch;
}

const defaultResolve = async (host: string) => (await dnsLookup(host, { all: true })).map((entry) => entry.address);

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

/** `url` is the page that was read, after any redirects. `requested` is set when that differs from what was asked for. */
const outputSchema = pageSchema.extend({ url: z.string(), host: z.string(), requested: z.string().optional() });

/**
 * Reads one web page for one question. The page is text written by strangers, so it never reaches the agent:
 * it goes to a model call with no tools, and only that call's short, shape-checked answer comes back.
 */
export function webFetchTool(deps: WebFetchDeps = {}) {
  const resolve = deps.resolve ?? defaultResolve;
  // Tests hand in their own fetch. The real one connects only to the address it checked.
  const pinned = deps.fetch ?? publicFetch(resolve);
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
      const doFetch = pinned;
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
        } catch (err) {
          if (exec.signal.aborted) throw new ToolError("The fetch was stopped.");
          if (err instanceof PrivateAddressError) throw new ToolError(`${url.hostname} is not on the public internet, so it cannot be fetched.`);
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
      const read = url.toString();
      return { ...page, url: read, host: url.hostname, ...(read !== new URL(input.url).toString() ? { requested: input.url } : {}) };
    },
    render(_input, page) {
      const moved = page.requested ? ` (you asked for ${page.requested}; it redirected here)` : "";
      const head = `${page.title || page.host} (${page.url})${moved}${page.published ? `, dated ${page.published}` : ""}`;
      if (!page.answers_question || !page.facts.length) return `${head}\nThis page does not answer the question.`;
      const facts = page.facts.map((fact, i) => `${i + 1}. ${fact.claim}${fact.figure ? ` [${fact.figure}]` : ""}`);
      return `${head}\n${facts.join("\n")}\n\nThese are the page's claims, not checked facts. Cite ${page.url} with anything you use.`;
    },
  });
}
