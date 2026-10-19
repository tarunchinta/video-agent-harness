import type { Platform } from "@attentionos/core";

/**
 * Social handles for setup: cleaning what the owner types or pastes (handles or profile links), matching them to the
 * accounts connected in the publishing service. Pure functions, safe in Studio
 * (imported through `@attentionos/module-onboarding/handles`) and in jobs.
 */

/** The platforms setup asks about, in the order the form shows them. */
export const SETUP_PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin", "x"] as const satisfies readonly Platform[];
export type SetupPlatform = (typeof SETUP_PLATFORMS)[number];

export const PLATFORM_NAMES: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  x: "X",
  facebook: "Facebook",
  threads: "Threads",
};

/** Which platforms each scraper choice can read public posts from (what the provider adapters implement). */
export const SCRAPER_PLATFORMS: Record<string, readonly Platform[]> = {
  apify: ["instagram", "tiktok", "youtube"],
  ytdlp: ["tiktok", "youtube"],
  iggraph: ["instagram"],
  none: [],
};

const HANDLE_RE = /^[\p{L}\p{N}._-]{1,80}$/u;

/**
 * "https://www.instagram.com/someone/?hl=en", "@someone" or "someone" → "@someone". LinkedIn keeps its path kind
 * ("in/someone", "company/someone") because personal and company pages differ; YouTube channel ids stay as
 * "channel/UC…". Returns "" when nothing usable is left.
 */
export function cleanHandle(platform: Platform, raw: string): string {
  let h = String(raw ?? "").trim();
  if (!h) return "";
  h = h.replace(/^https?:\/\//i, "").replace(/^(www\.|m\.|mobile\.)/i, "");
  const url = /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(h);
  if (url) h = h.slice(h.indexOf("/") + 1);
  h = h.replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (platform === "linkedin") {
    const m = /^(in|company|school)\/([^/]+)/i.exec(h);
    if (m) return HANDLE_RE.test(m[2]!) ? `${m[1]!.toLowerCase()}/${m[2]}` : "";
    const bare = h.replace(/^@/, "").split("/")[0]!;
    return HANDLE_RE.test(bare) ? `in/${bare}` : "";
  }
  if (platform === "youtube") {
    const ch = /^channel\/(UC[\w-]{10,40})/i.exec(h);
    if (ch) return `channel/${ch[1]}`;
    h = h.replace(/^(c|user)\//i, "");
  }
  if (url && platform === "tiktok") h = h.split("/")[0]!;
  const bare = h.replace(/^@/, "").split("/")[0]!;
  return HANDLE_RE.test(bare) ? `@${bare}` : "";
}

/** Lower-case handle without "@" or a LinkedIn path kind, for comparing. */
export function bareHandle(h: string): string {
  return String(h ?? "").trim().replace(/^@/, "").replace(/^(in|company|school|channel)\//i, "").toLowerCase();
}

/** Splits pasted text ("@a, @b\n@c", or profile links) into cleaned handles, de-duplicated, order kept. */
export function parseHandleList(platform: Platform, text: string): string[] {
  const out: string[] = [];
  for (const part of String(text ?? "").split(/[\s,;]+/)) {
    const h = cleanHandle(platform, part);
    if (h && !out.some((x) => bareHandle(x) === bareHandle(h))) out.push(h);
  }
  return out;
}

/** The owner's handles as a clean list, only platforms setup knows about. */
export function ownHandleList(handles: Partial<Record<Platform, string>>): { platform: Platform; handle: string }[] {
  const out: { platform: Platform; handle: string }[] = [];
  // Always in the form's order (stored JSON doesn't keep key order).
  for (const platform of Object.keys(PLATFORM_NAMES) as Platform[]) {
    const raw = handles?.[platform];
    if (!raw) continue;
    const handle = cleanHandle(platform, raw);
    if (handle) out.push({ platform, handle });
  }
  return out;
}

export type AccountLike = { platform: Platform; handle: string; status: "connected" | "expired" | "error" };

export type AccountMatch = {
  platform: Platform;
  /** The owner's handle for this platform ("" when they didn't give one). */
  handle: string;
  /**
   * connected: an account with this handle is connected. other: an account on this platform is connected, but with a
   * different handle. expired: the matching account needs reconnecting. missing: nothing on this platform yet.
   * extra: connected in the publishing service, but setup has no handle for it.
   */
  state: "connected" | "other" | "expired" | "missing" | "extra";
  account?: AccountLike;
};

/** Lines the owner's handles up with the accounts connected in the publishing service. */
export function matchAccounts(handles: Partial<Record<Platform, string>>, accounts: AccountLike[]): AccountMatch[] {
  const own = ownHandleList(handles);
  const used = new Set<AccountLike>();
  const out: AccountMatch[] = own.map(({ platform, handle }) => {
    const onPlatform = accounts.filter((a) => a.platform === platform);
    const same = onPlatform.find((a) => bareHandle(a.handle) === bareHandle(handle));
    const pick = same ?? onPlatform.find((a) => a.status === "connected") ?? onPlatform[0];
    if (!pick) return { platform, handle, state: "missing" };
    used.add(pick);
    if (pick.status !== "connected") return { platform, handle, state: "expired", account: pick };
    return { platform, handle, state: same ? "connected" : "other", account: pick };
  });
  for (const a of accounts) if (!used.has(a)) out.push({ platform: a.platform, handle: "", state: "extra", account: a });
  return out;
}
