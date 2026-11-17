// The only way out of a run's sandbox network. It runs in a second, tiny container next to the sandbox
// (same image, no run code), forwards HTTP and HTTPS to public addresses and refuses everything else:
// the host, the local network, link-local and cloud metadata addresses, other containers.
//
//   node egress-proxy.mjs            serve on 0.0.0.0:3128
//   node egress-proxy.mjs --wait     exit 0 once a proxy in this container accepts connections
//
// Environment:
//   EGRESS_ALLOW_HOSTS   optional comma-separated list. When set, only these hosts are reachable.
//                        "example.com" matches that host; ".example.com" matches it and its subdomains.
//
// Every decision is written to stdout as one JSON line, so a run's network activity can be kept as a trace.
// No dependencies: Node's standard library only.

import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";

export const PORT = 3128;
const CONNECT_TIMEOUT_MS = 15_000;
/** Addresses tried per name before giving up. */
const MAX_ADDRESSES = 4;

/** Addresses the sandbox must never reach. */
export const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private, Docker networks
  ["192.0.0.0", 24], // protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private, Docker Desktop host gateway
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 3], // multicast, reserved, broadcast
]) {
  blocked.addSubnet(address, prefix, "ipv4");
}
// IPv4-mapped addresses (::ffff:a.b.c.d) need no rule of their own: BlockList checks them against the IPv4
// rules above. A rule for ::ffff:0:0/96 would do the opposite and block every IPv4 address.
for (const [address, prefix] of [
  ["::", 127], // unspecified and loopback
  ["64:ff9b::", 96], // NAT64
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
]) {
  blocked.addSubnet(address, prefix, "ipv6");
}

/** True for an IP literal that is routable on the public internet. */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return !blocked.check(address, "ipv6");
  return false;
}

/** Parses EGRESS_ALLOW_HOSTS. An empty list means "any public host". */
export function parseAllowList(value) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function hostAllowed(host, allowList) {
  if (allowList.length === 0) return true;
  const name = host.toLowerCase().replace(/\.$/, "");
  return allowList.some((entry) =>
    entry.startsWith(".") ? name === entry.slice(1) || name.endsWith(entry) : name === entry,
  );
}

/** Splits "host:port" or "[v6]:port". Returns null when it is not a valid authority. */
export function parseAuthority(authority, defaultPort) {
  const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d{1,5}))?$/.exec(authority ?? "");
  if (!match) return null;
  const host = match[1] ?? match[2];
  const port = match[3] === undefined ? defaultPort : Number(match[3]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * Decides where a request may go. The name is resolved here and the caller connects to the returned addresses,
 * never to the name again, so a DNS answer cannot change between the check and the connection.
 * Addresses come back IPv4 first: most Docker networks have no IPv6 route.
 */
export async function resolveTarget(host, allowList, lookup = (name) => dns.lookup(name, { all: true })) {
  if (!hostAllowed(host, allowList)) return { ok: false, reason: "host is not on the allow list" };
  if (net.isIP(host)) {
    return isPublicAddress(host) ? { ok: true, addresses: [host] } : { ok: false, reason: "address is not public" };
  }
  let answers;
  try {
    answers = await lookup(host);
  } catch {
    return { ok: false, reason: "name does not resolve" };
  }
  const usable = answers.filter((answer) => isPublicAddress(answer.address));
  if (usable.length === 0) return { ok: false, reason: "name resolves to a non-public address" };
  const ordered = [...usable.filter((answer) => answer.family === 4), ...usable.filter((answer) => answer.family !== 4)];
  return { ok: true, addresses: ordered.slice(0, MAX_ADDRESSES).map((answer) => answer.address) };
}

/** Opens a TCP connection to the first address that accepts one. */
function connectToAny(addresses, port) {
  return new Promise((resolve, reject) => {
    const attempt = (index, lastError) => {
      if (index >= addresses.length) {
        reject(lastError ?? new Error("no address to connect to"));
        return;
      }
      const socket = net.connect({ host: addresses[index], port, timeout: CONNECT_TIMEOUT_MS });
      const fail = (error) => {
        socket.destroy();
        attempt(index + 1, error);
      };
      socket.once("error", fail);
      socket.once("timeout", () => fail(new Error("timed out")));
      socket.once("connect", () => {
        socket.removeListener("error", fail);
        socket.removeAllListeners("timeout");
        socket.setTimeout(0);
        resolve(socket);
      });
    };
    attempt(0);
  });
}

function log(entry) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer",
  "transfer-encoding", "upgrade",
]);

export function createProxy(allowList) {
  const server = http.createServer(async (req, res) => {
    // Plain HTTP through a proxy arrives with an absolute URL.
    let url;
    try {
      url = new URL(req.url ?? "");
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "http:") {
      res.writeHead(400, { "content-type": "text/plain" }).end("egress proxy: expected an absolute http:// URL\n");
      return;
    }
    const port = url.port === "" ? 80 : Number(url.port);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const target = await resolveTarget(host, allowList);
    if (!target.ok) {
      log({ method: req.method, host, port, decision: "deny", reason: target.reason });
      res.writeHead(403, { "content-type": "text/plain" }).end(`egress denied: ${target.reason}\n`);
      return;
    }
    log({ method: req.method, host, port, decision: "allow" });
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
    headers.host = url.host;
    const upstream = http.request(
      { host: target.addresses[0], port, method: req.method, path: `${url.pathname}${url.search}`, headers, timeout: CONNECT_TIMEOUT_MS },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("timed out")));
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`egress proxy: ${error.message}\n`);
    });
    req.pipe(upstream);
  });

  // HTTPS (and anything else that tunnels) arrives as CONNECT host:port.
  server.on("connect", async (req, client, head) => {
    client.on("error", () => {});
    const reply = (status, text) => client.end(`HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${text}\n`);
    const authority = parseAuthority(req.url, 443);
    if (!authority) {
      reply("400 Bad Request", "egress proxy: bad CONNECT target");
      return;
    }
    const { host, port } = authority;
    const target = await resolveTarget(host, allowList);
    if (!target.ok) {
      log({ method: "CONNECT", host, port, decision: "deny", reason: target.reason });
      reply("403 Forbidden", `egress denied: ${target.reason}`);
      return;
    }
    log({ method: "CONNECT", host, port, decision: "allow" });
    let upstream;
    try {
      upstream = await connectToAny(target.addresses, port);
    } catch (error) {
      reply("502 Bad Gateway", `egress proxy: ${error.message}`);
      return;
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });

  return server;
}

async function waitUntilListening() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const up = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: PORT });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (up) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

if (import.meta.main) {
  if (process.argv.includes("--wait")) {
    process.exit((await waitUntilListening()) ? 0 : 1);
  }
  const allowList = parseAllowList(process.env.EGRESS_ALLOW_HOSTS);
  const server = createProxy(allowList);
  server.listen(PORT, "0.0.0.0", () => log({ event: "listening", port: PORT, allowHosts: allowList }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
}
