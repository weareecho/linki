import type { BrowserContext, Frame, Page } from "playwright";

export type LinkedInStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export class LinkedInSessionUnavailableError extends Error {
  constructor() {
    super("No usable saved LinkedIn session. Use Server login and complete LinkedIn's verification.");
    this.name = "LinkedInSessionUnavailableError";
  }
}

// Older supported import records omitted expiry. Treat only that omission as a
// session cookie; explicit invalid/expired values must still fail validation.
// Normalize in memory, leaving the encrypted record and its Auth flag untouched.
export function normalizeLegacyLinkedInState(state: unknown): unknown {
  if (!state || typeof state !== "object") return state;
  const value = state as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(value.cookies) || !Array.isArray(value.origins)) return state;
  return { ...value, cookies: value.cookies.map(cookie => {
    if (!cookie || typeof cookie !== "object" || cookie.expires !== undefined ||
      typeof cookie.name !== "string" || typeof cookie.value !== "string" ||
      ![".linkedin.com", "linkedin.com", ".www.linkedin.com", "www.linkedin.com"].includes(cookie.domain) || cookie.path !== "/") return cookie;
    return { httpOnly: false, secure: true, sameSite: "Lax", ...cookie, expires: -1 };
  }) };
}

export function createImportedLinkedInState(liAt: string, documentCookie = ""): LinkedInStorageState {
  const extras = documentCookie.split(";").flatMap(part => {
    const eq = part.indexOf("=");
    if (eq < 0) return [];
    const name = part.slice(0, eq).trim(), value = part.slice(eq + 1).trim();
    return name && value && name !== "li_at"
      ? [{ name, value, domain: ".linkedin.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" as const }] : [];
  });
  return { cookies: [{ name: "li_at", value: liAt.trim(), domain: ".linkedin.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" }, ...extras], origins: [] };
}

/** A LinkedIn page served instead of the requested one to a visitor who is not
 * signed in: sign-in, guest wall, sign-up or security check. Reaching one does
 * not by itself prove the saved login is gone; confirmSignedIn decides that. */
export class LinkedInSignedOutError extends Error {
  constructor() {
    super("LinkedIn showed a sign-in page instead of the requested page.");
    this.name = "LinkedInSignedOutError";
  }
}

const SIGN_IN_WALLS = ["/login", "/authwall", "/checkpoint", "/uas", "/signup"];

export function isSignInWall(url: string): boolean {
  try {
    const value = new URL(url);
    if (!["www.linkedin.com", "linkedin.com"].includes(value.hostname)) return false;
    return SIGN_IN_WALLS.some(prefix => value.pathname === prefix || value.pathname.startsWith(prefix + "/"));
  } catch { return false; }
}

/** Whether a page that a step just used shows LinkedIn's signed-out state: a
 * sign-in page, or a context whose login cookie LinkedIn has just removed (its
 * guest view keeps the requested URL). False when the page cannot be read. */
export async function pageIsSignedOut(page: Page): Promise<boolean> {
  try {
    return isSignInWall(page.url()) || !hasUsableLinkedInState(await page.context().storageState());
  } catch { return false; }
}

/** When the saved login cookie lapses (unix seconds); -1 for a browser-session
 * cookie and null when there is none. A date only, never the cookie. */
export function savedLoginExpiry(state: unknown, nowSeconds = Date.now() / 1000): number | null {
  if (!hasUsableLinkedInState(state, nowSeconds)) return null;
  const usable = state.cookies.filter(cookie => hasUsableLinkedInState({ cookies: [cookie], origins: [] }, nowSeconds));
  return usable.some(cookie => cookie.expires === -1) ? -1 : Math.max(...usable.map(cookie => cookie.expires));
}

// This proves usable saved credentials, not live access or the account's identity.
export function hasUsableLinkedInState(state: unknown, nowSeconds = Date.now() / 1000): state is LinkedInStorageState {
  if (!state || typeof state !== "object") return false;
  const value = state as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(value.cookies) || !Array.isArray(value.origins)) return false;
  return value.cookies.some(cookie => cookie && typeof cookie === "object" &&
    cookie.name === "li_at" && typeof cookie.value === "string" && cookie.value.trim().length > 0 &&
    [".linkedin.com", "linkedin.com", ".www.linkedin.com", "www.linkedin.com"].includes(cookie.domain) &&
    typeof cookie.expires === "number" && Number.isFinite(cookie.expires) &&
    (cookie.expires === -1 || cookie.expires > nowSeconds));
}

export function isLinkedInLoginLanding(url: string): boolean {
  try {
    const value = new URL(url);
    return value.protocol === "https:" && ["www.linkedin.com", "linkedin.com"].includes(value.hostname) &&
      !value.username && !value.password && !value.port &&
      /^\/(feed|sales)(?:\/|$)/.test(value.pathname);
  } catch { return false; }
}

export async function hasSignedInLinkedInEvidence(page: Page): Promise<boolean> {
  if (!isLinkedInLoginLanding(page.url())) return false;
  if (!hasUsableLinkedInState(await page.context().storageState())) return false;
  for (const frame of page.frames()) {
    if (!await isVisibleLinkedInFrame(frame, page)) continue;
    if (await hasSignedInFrameEvidence(frame)) return true;
  }
  return false;
}

// The provider can render its application in a same-origin frame. Ignore
// hidden frames, third-party frames and frames nested under an untrusted host.
export async function isVisibleLinkedInFrame(frame: Frame, page: Page): Promise<boolean> {
  if (frame === page.mainFrame()) return true;
  try {
    if (new URL(frame.url()).origin !== new URL(page.url()).origin) return false;
    const parent = frame.parentFrame();
    if (!parent || !await isVisibleLinkedInFrame(parent, page)) return false;
    const element = await frame.frameElement();
    try { return await element.isVisible(); }
    finally { await element.dispose(); }
  } catch { return false; }
}

async function hasSignedInFrameEvidence(frame: Frame): Promise<boolean> {
  // Filter visibility before selecting the first match: responsive layouts may
  // keep a hidden desktop navigation before the visible mobile navigation.
  const legacyNavigation = await frame.locator('nav .global-nav__me-photo:visible, nav a[href^="/in/"]:visible, a[data-control-name="identity_profile_photo"][href*="/in/"]:visible').first()
    .isVisible().catch(() => false);
  if (legacyNavigation) return true;
  const hrefs = await frame.locator('a[href]:visible').evaluateAll(links =>
    links.map(link => link.getAttribute('href') || '')).catch(() => []);
  if (hasAccountNavigation(hrefs)) return true;
  // The observed signed-in feed uses these labels, but links, button roles and
  // destinations vary between layouts. Require the personal post composer AND
  // all account navigation labels in the same visible, trusted frame.
  const labels = ["Home", "My Network", "Jobs", "Messaging", "Notifications", "Me", "Start a post"];
  const visible = await Promise.all(labels.map(label => frame.getByText(label, { exact: true })
    .filter({ visible: true }).first().isVisible().catch(() => false)));
  return visible.every(Boolean);
}

export function hasAccountNavigation(hrefs: string[]): boolean {
  const paths = new Set<string>();
  for (const href of hrefs) {
    try {
      const url = new URL(href, "https://www.linkedin.com");
      if (url.protocol === "https:" && ["www.linkedin.com", "linkedin.com"].includes(url.hostname) &&
          !url.username && !url.password && !url.port) paths.add(url.pathname.replace(/\/$/, ""));
    } catch { /* malformed links provide no evidence */ }
  }
  return ["/feed", "/mynetwork", "/jobs", "/messaging", "/notifications"].every(path => paths.has(path));
}

// Do not log provider URLs: checkpoint paths and query strings can contain secrets.
export function loginLocation(url: string): string {
  try {
    const path = new URL(url).pathname;
    for (const prefix of ["/feed", "/sales", "/checkpoint", "/authwall", "/login", "/uas", "/signup"]) {
      if (path === prefix || path.startsWith(prefix + "/")) return prefix;
    }
  } catch { /* no URL details */ }
  return "other";
}
