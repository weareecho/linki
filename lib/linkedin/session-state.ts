import type { BrowserContext, Page } from "playwright";

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
      ![".linkedin.com", "linkedin.com", "www.linkedin.com"].includes(cookie.domain) || cookie.path !== "/") return cookie;
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

// This proves usable saved credentials, not live access or the account's identity.
export function hasUsableLinkedInState(state: unknown, nowSeconds = Date.now() / 1000): state is LinkedInStorageState {
  if (!state || typeof state !== "object") return false;
  const value = state as { cookies?: unknown; origins?: unknown };
  if (!Array.isArray(value.cookies) || !Array.isArray(value.origins)) return false;
  return value.cookies.some(cookie => cookie && typeof cookie === "object" &&
    cookie.name === "li_at" && typeof cookie.value === "string" && cookie.value.trim().length > 0 &&
    [".linkedin.com", "linkedin.com", "www.linkedin.com"].includes(cookie.domain) &&
    typeof cookie.expires === "number" && Number.isFinite(cookie.expires) &&
    (cookie.expires === -1 || cookie.expires > nowSeconds));
}

export function isLinkedInLoginLanding(url: string): boolean {
  try {
    const value = new URL(url);
    return value.protocol === "https:" && ["www.linkedin.com", "linkedin.com"].includes(value.hostname) &&
      (value.pathname.startsWith("/feed/") || value.pathname.startsWith("/sales/"));
  } catch { return false; }
}

export async function hasSignedInLinkedInEvidence(page: Page): Promise<boolean> {
  if (!isLinkedInLoginLanding(page.url())) return false;
  if (!hasUsableLinkedInState(await page.context().storageState())) return false;
  // A guest marketing page/redirect URL alone is insufficient evidence.
  return page.locator('nav .global-nav__me-photo, nav a[href^="/in/"], a[data-control-name="identity_profile_photo"][href*="/in/"]').first()
    .isVisible().catch(() => false);
}

// Do not log provider URLs: checkpoint paths and query strings can contain secrets.
export function loginLocation(url: string): string {
  try {
    const path = new URL(url).pathname;
    for (const prefix of ["/feed", "/sales", "/checkpoint", "/authwall", "/login"]) {
      if (path === prefix || path.startsWith(prefix + "/")) return prefix;
    }
  } catch { /* no URL details */ }
  return "other";
}
