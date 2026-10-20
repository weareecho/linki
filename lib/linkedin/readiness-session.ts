import type { BrowserContext, Page } from "playwright";

// Shared with the actual session owner even when Next emits separate route chunks.
type ExistingPageOpener = (accountId: string, context: BrowserContext) => Promise<Page>;
const state = globalThis as typeof globalThis & {
  __linkiExistingContexts?: Map<string, BrowserContext>;
  __linkiExistingPageOpener?: ExistingPageOpener;
};
export const existingContexts = state.__linkiExistingContexts ??= new Map<string, BrowserContext>();

/** The session owner registers how to open a page in an EXISTING context through
 * its app-wide page queue. Readiness never creates a browser or context itself. */
export function registerExistingPageOpener(open: ExistingPageOpener): void {
  state.__linkiExistingPageOpener = open;
}

export type IdentityObservation = { profile: string; observedAt: number; startedAt: number; isCurrent: () => boolean };

export const OWN_IDENTITY_ORIGIN_URL = "https://www.linkedin.com/robots.txt";
export const OWN_IDENTITY_LIMIT = 64 * 1024;

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

/** The signed-in member's own profile from LinkedIn's first-party `me` resource.
 * Accept only the documented top-level miniProfile identity of a bounded JSON
 * object; identifiers elsewhere in the payload are never evidence. */
export function profileFromOwnIdentity(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > OWN_IDENTITY_LIMIT) return null;
  try {
    const value = JSON.parse(raw) as { miniProfile?: { publicIdentifier?: unknown; entityUrn?: unknown } } | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const mini = value.miniProfile;
    if (!mini || typeof mini !== "object" || Array.isArray(mini)) return null;
    const id = mini.publicIdentifier;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return null;
    if (typeof mini.entityUrn !== "string" || !mini.entityUrn.startsWith("urn:li:fs_miniProfile:")) return null;
    return canonicalProfile(`https://www.linkedin.com/in/${id}`);
  } catch { return null; }
}

/** Runs INSIDE the existing page (Playwright serializes this source): the first-party
 * `me` request uses the browser's own network stack, cookies and fingerprint. A
 * separate Node HTTP client replaying the saved cookies can get the session signed
 * out, so readiness never issues one. No redirects, retries or provider writes. */
export async function ownIdentityInPage(limit: number): Promise<string | null> {
  const jsession = document.cookie.split("; ").find(part => part.startsWith("JSESSIONID="));
  const csrf = (jsession ? jsession.slice("JSESSIONID=".length) : "").replace(/"/g, "");
  if (!csrf) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch("/voyager/api/me", {
      method: "GET", credentials: "include", redirect: "error", cache: "no-store", signal: controller.signal,
      headers: { "csrf-token": csrf, accept: "application/json", "x-restli-protocol-version": "2.0.0" },
    });
    if (response.status !== 200 || response.url !== "https://www.linkedin.com/voyager/api/me" ||
        !(response.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return null;
    const text = await response.text();
    return text.length <= limit ? text : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** Fresh read-only own-account observation through an existing authenticated
 * BrowserContext. No browser/context creation, login, cookie extraction, explicit
 * cookie or account-store writes, prospect pages or retries. The page opens on a
 * static first-party document only so the in-page request is same-origin. */
export async function observeExistingIdentity(accountId: string): Promise<IdentityObservation | null> {
  const context = existingContexts.get(accountId);
  const isCurrent = () => existingContexts.get(accountId) === context && Boolean(context?.browser()?.isConnected());
  const open = state.__linkiExistingPageOpener;
  if (!context || !open || !isCurrent()) return null;
  let page: Page | undefined;
  try {
    page = await open(accountId, context);
    const startedAt = Date.now();
    if (!isCurrent()) return null;
    const response = await page.goto(OWN_IDENTITY_ORIGIN_URL, { waitUntil: "domcontentloaded", timeout: 3000 });
    if (!response || response.status() !== 200 || page.url() !== OWN_IDENTITY_ORIGIN_URL || !isCurrent()) return null;
    const raw = await page.evaluate(ownIdentityInPage, OWN_IDENTITY_LIMIT);
    if (typeof raw !== "string" || !isCurrent()) return null;
    const profile = profileFromOwnIdentity(raw);
    return profile ? { profile, observedAt: Date.now(), startedAt, isCurrent } : null;
  } catch { return null; }
  finally { await page?.close().catch(() => {}); }
}
