import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProxy, hostAllowed, isPublicAddress, parseAllowList, parseAuthority, resolveTarget } from "../image/egress-proxy.mjs";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "10.0.0.5", "172.17.0.1", "172.31.255.255", "192.168.65.254", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "not-an-address", "",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "104.20.23.154", "172.66.147.243", "172.32.0.1", "2606:4700:10::ac42:93f3", "::ffff:8.8.8.8"])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe("hostAllowed", () => {
  it("allows everything when the list is empty", () => {
    expect(hostAllowed("anything.example", [])).toBe(true);
  });

  it("matches exact hosts and, with a leading dot, subdomains", () => {
    const list = parseAllowList(" Registry.Example , .data.example ,");
    expect(list).toEqual(["registry.example", ".data.example"]);
    expect(hostAllowed("registry.example", list)).toBe(true);
    expect(hostAllowed("REGISTRY.example.", list)).toBe(true);
    expect(hostAllowed("evil-registry.example", list)).toBe(false);
    expect(hostAllowed("sub.registry.example", list)).toBe(false);
    expect(hostAllowed("data.example", list)).toBe(true);
    expect(hostAllowed("cdn.data.example", list)).toBe(true);
    expect(hostAllowed("notdata.example", list)).toBe(false);
  });
});

describe("parseAuthority", () => {
  it("reads host and port, with a default port", () => {
    expect(parseAuthority("site.example:8443", 443)).toEqual({ host: "site.example", port: 8443 });
    expect(parseAuthority("site.example", 443)).toEqual({ host: "site.example", port: 443 });
    expect(parseAuthority("[2606:4700::1]:443", 443)).toEqual({ host: "2606:4700::1", port: 443 });
  });

  it("rejects what is not an authority", () => {
    for (const bad of ["", "site.example:0", "site.example:70000", "a:b:c", undefined]) {
      expect(parseAuthority(bad, 443)).toBeNull();
    }
  });
});

describe("resolveTarget", () => {
  const lookup = (answers: { address: string; family: number }[]) => async () => answers;

  it("returns public addresses, IPv4 first", async () => {
    const target = await resolveTarget("site.example", [], lookup([
      { address: "2606:4700::1", family: 6 }, { address: "1.1.1.1", family: 4 }, { address: "8.8.8.8", family: 4 },
    ]));
    expect(target).toEqual({ ok: true, addresses: ["1.1.1.1", "8.8.8.8", "2606:4700::1"] });
  });

  it("drops private answers and refuses a name that has only private ones", async () => {
    expect(await resolveTarget("mixed.example", [], lookup([{ address: "10.0.0.1", family: 4 }, { address: "1.1.1.1", family: 4 }])))
      .toEqual({ ok: true, addresses: ["1.1.1.1"] });
    expect(await resolveTarget("internal.example", [], lookup([{ address: "192.168.1.10", family: 4 }])))
      .toEqual({ ok: false, reason: "name resolves to a non-public address" });
  });

  it("refuses private literals, unknown names and hosts off the allow list without resolving them", async () => {
    const never = async (): Promise<never> => {
      throw new Error("should not resolve");
    };
    expect(await resolveTarget("169.254.169.254", [], never)).toEqual({ ok: false, reason: "address is not public" });
    expect(await resolveTarget("other.example", ["site.example"], never)).toEqual({ ok: false, reason: "host is not on the allow list" });
    expect(await resolveTarget("gone.example", [], never)).toEqual({ ok: false, reason: "name does not resolve" });
  });
});

// The proxy itself, on loopback only: every target below is refused, so nothing leaves this machine.
describe("proxy", () => {
  const server = createProxy([]);
  let port = 0;
  const logged: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);

  beforeAll(async () => {
    process.stdout.write = ((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    process.stdout.write = realWrite;
    await new Promise((resolve) => server.close(resolve));
  });

  const request = (options: http.RequestOptions): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, agent: false, ...options });
      req.once("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.once("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once("error", reject);
      req.end();
    });

  it("refuses a tunnel to a private address", async () => {
    expect(await request({ method: "CONNECT", path: "127.0.0.1:5432" })).toBe(403);
    expect(await request({ method: "CONNECT", path: "localhost:5432" })).toBe(403);
  });

  it("refuses plain HTTP to the metadata address", async () => {
    expect(await request({ method: "GET", path: "http://169.254.169.254/latest/meta-data/" })).toBe(403);
  });

  it("answers 400 to a request that is not a proxy request", async () => {
    expect(await request({ method: "GET", path: "/" })).toBe(400);
  });

  it("logs each decision as a JSON line", () => {
    const entries = logged.map((line) => JSON.parse(line) as { host: string; decision: string });
    expect(entries).toContainEqual(expect.objectContaining({ host: "169.254.169.254", decision: "deny" }));
  });
});
