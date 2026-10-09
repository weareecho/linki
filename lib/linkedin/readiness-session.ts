import type { BrowserContext } from "playwright";
import { Parser } from "htmlparser2";

// Shared with the actual session owner even when Next emits separate route chunks.
const state = globalThis as typeof globalThis & { __linkiExistingContexts?: Map<string, BrowserContext> };
export const existingContexts = state.__linkiExistingContexts ??= new Map<string, BrowserContext>();

export type IdentityObservation = { profile: string; observedAt: number; startedAt: number; isCurrent: () => boolean };

export function canonicalProfile(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "www.linkedin.com" || url.port ||
        url.username || url.password || url.search || url.hash ||
        !/^\/in\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
    return `https://www.linkedin.com${url.pathname.replace(/\/$/, "")}`;
  } catch { return null; }
}

// The parser is already locked through mailparser. Parse only markup delivered
// by a fresh first-party own-feed GET; never execute scripts or inspect arbitrary
// prospect links. Missing SSR identity evidence is a blocked state, not success.
export function profileFromOwnFeed(html: string): string | null {
  const stack: { tag: string; ignored: boolean; navigation: boolean }[] = [];
  const profiles: string[] = [];
  let hasMe = false;
  const parser = new Parser({
    onopentag(tag, attrs) {
      const parent = stack[stack.length - 1];
      const ignored = Boolean(parent?.ignored || ["script", "style", "template", "noscript"].includes(tag) ||
        "hidden" in attrs || attrs["aria-hidden"] === "true");
      const navigation = Boolean(parent?.navigation || tag === "nav");
      stack.push({ tag, ignored, navigation });
      if (ignored) return;
      if (navigation && (attrs.class || "").split(/\s+/).includes("global-nav__me-photo")) hasMe = true;
      if (tag === "a" && attrs["data-control-name"] === "identity_profile_photo" && attrs.href) {
        try {
          const profile = canonicalProfile(new URL(attrs.href, "https://www.linkedin.com").href);
          if (profile) profiles.push(profile);
        } catch { /* no provider content in errors */ }
      }
    },
    onclosetag() { stack.pop(); },
  }, { decodeEntities: true });
  parser.end(html);
  return hasMe && profiles.length === 1 ? profiles[0] : null;
}

/** Fresh read-only own-account observation through an existing authenticated
 * BrowserContext. No browser/page creation, action-page navigation, login,
 * cookie extraction, explicit cookie writes, account store writes or retries.
 * BrowserContext.request supplies its normal credentials for this fixed GET. */
export async function observeExistingIdentity(accountId: string): Promise<IdentityObservation | null> {
  const context = existingContexts.get(accountId);
  const isCurrent = () => existingContexts.get(accountId) === context && Boolean(context?.browser()?.isConnected());
  if (!context || !isCurrent()) return null;
  const startedAt = Date.now();
  let response: Awaited<ReturnType<BrowserContext["request"]["get"]>> | undefined;
  try {
    response = await context.request.get("https://www.linkedin.com/feed/", {
      timeout: 4000, maxRedirects: 0, maxRetries: 0,
      headers: { "cache-control": "no-cache, no-store", pragma: "no-cache", accept: "text/html" },
    });
    if (response.status() !== 200 || response.url() !== "https://www.linkedin.com/feed/" || !isCurrent()) return null;
    const headers = response.headers();
    if (!headers["content-type"]?.toLowerCase().startsWith("text/html") ||
        (headers["content-length"] && (!/^\d+$/.test(headers["content-length"]) || Number(headers["content-length"]) > 2 * 1024 * 1024))) return null;
    const bytes = await response.body();
    if (bytes.length > 2 * 1024 * 1024 || !isCurrent()) return null;
    const profile = profileFromOwnFeed(bytes.toString("utf8"));
    return profile ? { profile, observedAt: Date.now(), startedAt, isCurrent } : null;
  } catch { return null; }
  finally { await response?.dispose().catch(() => {}); }
}
