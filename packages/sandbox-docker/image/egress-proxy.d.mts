// Types for egress-proxy.mjs, so the tests can import it. The script itself stays plain JavaScript because it
// runs inside the image with no build step.
import type { Server } from "node:http";

export const PORT: number;
export function isPublicAddress(address: string): boolean;
export function parseAllowList(value: string | undefined): string[];
export function hostAllowed(host: string, allowList: string[]): boolean;
export function parseAuthority(authority: string | undefined, defaultPort: number): { host: string; port: number } | null;
export function resolveTarget(
  host: string,
  allowList: string[],
  lookup?: (name: string) => Promise<{ address: string; family: number }[]>,
): Promise<{ ok: true; addresses: string[] } | { ok: false; reason: string }>;
export function createProxy(allowList: string[]): Server;
