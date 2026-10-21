import { chromium } from "playwright-extra";
import type { Browser, BrowserContext, Page } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { getDb } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { hasUsableLinkedInState, hasSignedInLinkedInEvidence, isLinkedInLoginLanding, isSignInWall, LinkedInSessionUnavailableError, loginLocation, normalizeLegacyLinkedInState, savedLoginExpiry } from "@/lib/linkedin/session-state";
import { captureLoginDiagnostic } from "@/lib/linkedin/session-diagnostic";
import { existingContexts, ownIdentityInPage, OWN_IDENTITY_LIMIT, profileFromOwnIdentity, registerExistingPageOpener } from "@/lib/linkedin/readiness-session";

chromium.use(StealthPlugin());

let browser: Browser | null = null;
const contexts: Map<string, BrowserContext> = existingContexts;

const HEADLESS = process.env.HEADLESS !== "false";
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

/**
 * Shared browser-context fingerprint. Login and runtime MUST use the identical
 * options so the LinkedIn session is BORN under the exact fingerprint it will
 * later be used with — a mismatch (or a drift) triggers a forced re-auth.
 */
function contextOptions(storageState?: object) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: storageState as any,
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: ["clipboard-read", "clipboard-write"] as ("clipboard-read" | "clipboard-write")[],
  };
}

async function getBrowser(headless = HEADLESS): Promise<Browser> {
  // B1: if the cached browser is disconnected, CLOSE it before relaunching.
  // Without this, a dead-but-not-reaped chromium process tree is orphaned on
  // every relaunch (the leak behind the Jun 2026 zombie pile-up).
  if (browser && !browser.isConnected()) {
    try { await browser.close(); } catch { /* already gone */ }
    browser = null;
  }
  if (!browser) {
    browser = await chromium.launch({
      headless,
      executablePath: CHROMIUM_PATH,
      args: LAUNCH_ARGS,
    });
  }
  return browser;
}

async function getOrCreateContext(accountId: string): Promise<BrowserContext> {
  const db = getDb();
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
    | { cookies_json: string | null; email: string }
    | undefined;

  if (!account) throw new Error(`Account ${accountId} not found`);

  if (!contexts.has(accountId)) {
    let storageState: unknown;
    if (account.cookies_json) {
      try {
        storageState = normalizeLegacyLinkedInState(JSON.parse(decryptSecret(account.cookies_json)!));
      } catch {
        // Fail closed: never navigate with an empty context after decryption failure.
        throw new LinkedInSessionUnavailableError();
      }
    }

    if (!hasUsableLinkedInState(storageState)) throw new LinkedInSessionUnavailableError();
    const b = await getBrowser();
    const ctx = await b.newContext(contextOptions(storageState));

    // Auto-evict from map when context closes for any reason (crash, session expiry, etc.)
    ctx.on("close", () => { if (contexts.get(accountId) === ctx) contexts.delete(accountId); });

    contexts.set(accountId, ctx);
  }

  return contexts.get(accountId)!;
}

/** Returns the BrowserContext for an account (for API calls via ctx.request) */
export async function getSessionContext(accountId: string): Promise<BrowserContext> {
  try {
    return await getOrCreateContext(accountId);
  } catch (error) {
    if (error instanceof LinkedInSessionUnavailableError) throw error;
    // First attempt failed — evict and retry once with a fresh context
    contexts.delete(accountId);
    return getOrCreateContext(accountId);
  }
}

// B6 (Jul 2026 CPU-spike incident): closing a Playwright page doesn't mean the
// underlying Chromium renderer OS process has actually exited — under CPU
// contention on the 2-vCPU prod box, teardown was observed lagging 60-90s
// behind page.close(). If the runner loop (or a concurrent MCP/API call)
// opens its next page immediately after, two renderer processes end up alive
// at once, which is enough to peg both cores and starve sibling containers'
// healthchecks (NocoDB/Chatwoot flapping). Fix: serialize ALL page opens
// app-wide through one queue, and hold the queue for a teardown buffer after
// each page.close() before letting the next one through. PAGE_MAX_HOLD_MS is
// a safety valve so a caller that forgets to close its page can't wedge the
// whole app's browser access forever.
const PAGE_TEARDOWN_GAP_MS = 3000;
const PAGE_MAX_HOLD_MS = 120_000;
let pageQueueTail: Promise<void> = Promise.resolve();

/** Opens a page during this caller's turn in the app-wide page queue. */
async function openQueuedPage(open: () => Promise<Page>): Promise<Page> {
  let releaseTurn!: () => void;
  const myTurn = new Promise<void>(r => { releaseTurn = r; });
  const previousTail = pageQueueTail;
  pageQueueTail = myTurn;
  await previousTail;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseTurn();
  };
  const safetyTimer = setTimeout(release, PAGE_MAX_HOLD_MS);

  let page: Page;
  try {
    page = await open();
  } catch (err) {
    clearTimeout(safetyTimer);
    release();
    throw err;
  }

  const originalClose = page.close.bind(page);
  page.close = (async (options?: Parameters<Page["close"]>[0]) => {
    try {
      return await originalClose(options);
    } finally {
      clearTimeout(safetyTimer);
      setTimeout(release, PAGE_TEARDOWN_GAP_MS);
    }
  }) as Page["close"];

  return page;
}

/** Returns a new Page from the account's browser context */
export async function getSessionPage(accountId: string): Promise<Page> {
  return openQueuedPage(async () => {
    const ctx = await getOrCreateContext(accountId);
    try {
      return await ctx.newPage();
    } catch {
      // B2: context was dead — CLOSE it before recreating so its underlying
      // browser process isn't left orphaned, then retry once with a fresh one.
      try { await ctx.close(); } catch { /* already gone */ }
      contexts.delete(accountId);
      const freshCtx = await getOrCreateContext(accountId);
      return freshCtx.newPage();
    }
  });
}

/** Readiness only: a page in the account's EXISTING context, in the same queue.
 * Never launches a browser, creates/recreates a context or retries. */
export async function getExistingContextPage(accountId: string, context: BrowserContext): Promise<Page> {
  return openQueuedPage(async () => {
    if (contexts.get(accountId) !== context || !context.browser()?.isConnected()) {
      throw new LinkedInSessionUnavailableError();
    }
    return context.newPage();
  });
}
registerExistingPageOpener(getExistingContextPage);

export async function saveSessionState(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId);
  if (!ctx) return;
  const db = getDb();
  const state = await ctx.storageState();
  if (!hasUsableLinkedInState(state)) throw new LinkedInSessionUnavailableError();
  db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?").run(
    encryptSecret(JSON.stringify(state)),
    accountId
  );
}

export async function closeSession(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId);
  if (ctx) {
    await ctx.close();
    contexts.delete(accountId);
  }
}

export type SessionVerdict = "signed_in" | "signed_out" | "unknown";
export const SIGNED_IN_HOME_URL = "https://www.linkedin.com/feed/";

/**
 * Whether the SAVED login still works, decided by LinkedIn in the account's own
 * browser context (the same fingerprint, cookies and network stack as every
 * runner step): open the home feed once and read LinkedIn's first-party `me`
 * resource from inside that page. Never a password, a login, a cookie export or
 * a request from outside the browser. Only positive evidence counts:
 *   signed_out  no usable saved cookie, or the feed answers with a sign-in page
 *               or removes the login cookie
 *   signed_in   the feed loads and `me` names a member (or the signed-in
 *               navigation renders)
 *   unknown     anything else: network error, timeout, unrecognized page
 * A signed-in verdict saves the refreshed cookies, which also restores the
 * account's Auth flag after an earlier sign-in signal.
 */
export async function confirmSignedIn(accountId: string): Promise<SessionVerdict> {
  let page: Page;
  try { page = await getSessionPage(accountId); }
  catch (error) { return error instanceof LinkedInSessionUnavailableError ? "signed_out" : "unknown"; }
  let verdict: SessionVerdict = "unknown";
  try {
    await page.goto(SIGNED_IN_HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    const signedOut = async () => isSignInWall(page.url()) || !hasUsableLinkedInState(await page.context().storageState());
    if (await signedOut()) verdict = "signed_out";
    else if (isLinkedInLoginLanding(page.url())) {
      const raw = await page.evaluate(ownIdentityInPage, OWN_IDENTITY_LIMIT).catch(() => null);
      if (typeof raw === "string" && profileFromOwnIdentity(raw)) verdict = "signed_in";
      // The navigation can hydrate after DOMContentLoaded; observe, never reload.
      const deadline = Date.now() + 10_000;
      while (verdict === "unknown" && Date.now() < deadline) {
        if (await signedOut()) verdict = "signed_out";
        else if (await hasSignedInLinkedInEvidence(page)) verdict = "signed_in";
        else await page.waitForTimeout(800);
      }
    }
  } catch { /* no evidence either way */ }
  finally { await page.close().catch(() => {}); }
  if (verdict === "signed_in") {
    try { await saveSessionState(accountId); } catch { return "unknown"; }
  }
  return verdict;
}

async function flagSignedOut(accountId: string): Promise<void> {
  getDb().prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(accountId);
  try { await closeSession(accountId); } catch { /* ignore */ }
  console.warn(`[session] account ${accountId} flagged needs-reauth (LinkedIn signed the saved login out)`);
}

/**
 * B4: flag an account as logged out / needing re-auth, but only once LinkedIn
 * confirms it (confirmSignedIn). Flagging stops every run and only a manual
 * login used to clear it, so a sign-in page seen by one step, a failed import or
 * a check that could not run keeps the saved login. Returns whether it flagged.
 */
export async function markNeedsReauth(accountId: string): Promise<boolean> {
  const verdict = await confirmSignedIn(accountId).catch((): SessionVerdict => "unknown");
  if (verdict !== "signed_out") {
    console.warn(`[session] account ${accountId} saw a sign-in signal; ${verdict === "signed_in"
      ? "LinkedIn confirms the saved login still works" : "the saved login could not be checked"} — keeping it`);
    return false;
  }
  await flagSignedOut(accountId);
  return true;
}

/** Re-checks a saved login (for example one flagged earlier) without logging in:
 * restores the account when LinkedIn confirms it, flags it when LinkedIn says it
 * ended, and leaves it unchanged when the check could not run. */
export async function recheckSavedLogin(accountId: string): Promise<SessionVerdict> {
  const verdict = await confirmSignedIn(accountId).catch((): SessionVerdict => "unknown");
  if (verdict === "signed_out") await flagSignedOut(accountId);
  return verdict;
}

/** When the saved login cookie lapses, as an ISO date-time ("session" for a
 * browser-session cookie), or null. A date only, never the cookie. */
export function savedLoginExpiresAt(accountId: string): string | null {
  const row = getDb().prepare("SELECT cookies_json FROM accounts WHERE id = ?").get(accountId) as
    | { cookies_json: string | null }
    | undefined;
  if (!row?.cookies_json) return null;
  try {
    const expiry = savedLoginExpiry(normalizeLegacyLinkedInState(JSON.parse(decryptSecret(row.cookies_json)!)));
    return expiry === null ? null : expiry === -1 ? "session" : new Date(expiry * 1000).toISOString();
  } catch { return null; }
}

/**
 * Opens a visible browser, navigates to LinkedIn login, and waits for the user
 * to complete login manually. Returns when the user reaches /feed.
 * Saves the full storage state to DB and marks account as authenticated.
 */
export async function authenticateAccount(accountId: string): Promise<void> {
  const db = getDb();
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
    | { email: string }
    | undefined;
  if (!account) throw new Error(`Account ${accountId} not found`);

  // Close any existing context for this account — start fresh
  await closeSession(accountId);

  // Always launch a VISIBLE browser for manual login
  const visibleBrowser = await chromium.launch({
    headless: false,
    executablePath: CHROMIUM_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const ctx = await visibleBrowser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    const page = await ctx.newPage();
    await page.goto("https://www.linkedin.com/login");

    // Pre-fill email to save the user a step
    try {
      await page.waitForSelector("input#username", { timeout: 5000 });
      await page.fill("input#username", account.email);
    } catch {
      // Input not found — page may have redirected already
    }

    // Wait up to 3 minutes for the user to complete login and reach /feed
    await page.waitForURL("**/feed/**", { timeout: 180_000 });

    // Save full storage state (cookies + localStorage) to DB
    const state = await ctx.storageState();
    if (!hasUsableLinkedInState(state) || !await hasSignedInLinkedInEvidence(page)) {
      throw new LinkedInSessionUnavailableError();
    }
    db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?").run(
      encryptSecret(JSON.stringify(state)),
      accountId
    );

    await ctx.close();
  } finally {
    await visibleBrowser.close();
  }
}

// ─── Server-side headless login ───────────────────────────────────────────────
// Logs in directly on the server (no screen) so the session is born under the
// SAME pinned Chromium fingerprint the runner uses, and so ALL cookies — incl.
// httpOnly ones like li_ep_auth_context (the Sales Nav seat cookie that
// document.cookie cannot read) — are captured. A login from a datacenter IP
// almost always triggers an email/SMS PIN, so it's a two-step flow: start
// (email+password) → maybe a challenge → verify (code).

export type LoginResult =
  | { status: "authenticated" }
  | { status: "challenge"; kind: "otp" | "app" | "captcha" | "unknown" | "session"; message: string }
  | { status: "error"; message: string };

type PendingLogin = { ctx: BrowserContext; page: Page; createdAt: number; expiryTimer: ReturnType<typeof setTimeout> };
const pendingLogins: Map<string, PendingLogin> = new Map();
const PENDING_TTL_MS = 10 * 60_000;

// PIN/verification-code input. Named ids first, then type-based fallbacks for
// LinkedIn's React checkpoint pages (which use dynamic ids). Safe: the login
// page itself has no tel/one-time-code input to misfire on.
const PIN_SELECTOR =
  "input[name='pin'], #input__email_verification_pin, input[autocomplete='one-time-code']:visible, input[type='tel']:visible";

async function clearPendingLogin(accountId: string): Promise<void> {
  const p = pendingLogins.get(accountId);
  if (p) {
    pendingLogins.delete(accountId);
    clearTimeout(p.expiryTimer);
    try { await p.ctx.close(); } catch { /* already gone */ }
  }
}

function retainPendingLogin(accountId: string, ctx: BrowserContext, page: Page): void {
  const previous = pendingLogins.get(accountId);
  if (previous) clearTimeout(previous.expiryTimer);
  const expiryTimer = setTimeout(() => { void clearPendingLogin(accountId); }, PENDING_TTL_MS);
  expiryTimer.unref();
  pendingLogins.set(accountId, { ctx, page, createdAt: Date.now(), expiryTimer });
}

function sweepPendingLogins(): void {
  const now = Date.now();
  for (const [id, p] of pendingLogins) {
    if (now - p.createdAt > PENDING_TTL_MS) void clearPendingLogin(id);
  }
}

/** Save the verified regular LinkedIn session before any optional Sales Nav access.
 * A Sales Nav seat is not required for ordinary connections; warming it during
 * login can replace usable regular cookies with a guest/challenge state.
 */
async function persistLogin(accountId: string, ctx: BrowserContext): Promise<void> {
  const db = getDb();
  const state = await ctx.storageState();
  if (!hasUsableLinkedInState(state)) throw new LinkedInSessionUnavailableError();
  db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?").run(
    encryptSecret(JSON.stringify(state)),
    accountId
  );
  // Drop any stale runtime context so the runner reloads the fresh cookies.
  await closeSession(accountId);
}

/**
 * Inspect the page after a login/verify submit and classify the outcome.
 * LinkedIn varies its challenge per attempt — email/SMS code OR device (app)
 * approval — so we detect both: a visible code input = otp; a checkpoint page
 * with no code input and no captcha = device approval.
 */
async function classifyLoginState(page: Page): Promise<LoginResult> {
  const start = Date.now();
  const deadline = start + 20_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (isLinkedInLoginLanding(url)) {
      if (await hasSignedInLinkedInEvidence(page)) return { status: "authenticated" };
      // DOMContentLoaded can precede signed-in navigation hydration. Observe
      // within this deadline without resubmitting login or navigating elsewhere.
    }
    if (loginLocation(url) === "/authwall") return { status: "error", message: "LinkedIn access requires verification. Stop and use LinkedIn's normal owner flow." };

    // Email/SMS PIN entry
    const pin = page.locator(PIN_SELECTOR).first();
    if ((await pin.count()) > 0 && (await pin.isVisible().catch(() => false))) {
      return {
        status: "challenge",
        kind: "otp",
        message: "LinkedIn sent you a verification code (email or SMS). Enter it below.",
      };
    }

    if (/checkpoint\/challenge/.test(url)) {
      // CAPTCHA (Arkose / FunCaptcha) — cannot be solved headlessly
      const cap = page.locator("iframe[src*='arkoselabs'], iframe[title*='captcha'], #captcha-internal");
      if ((await cap.count().catch(() => 0)) > 0) {
        return {
          status: "challenge",
          kind: "captcha",
          message: "LinkedIn requires a CAPTCHA. Stop automation and resolve it through LinkedIn's normal owner flow; do not transfer cookies to bypass it.",
        };
      }
      // Device/app approval: a settled checkpoint with no code input and no captcha
      if (Date.now() - start > 4_000) {
        return {
          status: "challenge",
          kind: "app",
          message: "LinkedIn sent a sign-in request to your LinkedIn mobile app. Approve it there, then click Continue.",
        };
      }
    }

    // Wrong credentials
    const wrongPw = await page
      .getByText(/that.?s not the right password|please enter a valid|couldn.?t find a linkedin account/i)
      .count()
      .catch(() => 0);
    if (wrongPw > 0) return { status: "error", message: "Wrong email or password." };

    await page.waitForTimeout(800);
  }

  if (isLinkedInLoginLanding(page.url())) {
    const usableCookie = hasUsableLinkedInState(await page.context().storageState());
    // Booleans/category only: never log cookies, HTML, account details or URLs.
    console.warn(`[login-check] location=${loginLocation(page.url())} usable_cookie=${usableCookie} signed_in_navigation=false`);
    if (usableCookie) {
      await captureLoginDiagnostic(page);
      return {
      status: "challenge", kind: "session",
      message: "LinkedIn reached your feed, but Linki could not verify the signed-in navigation yet. Your login is kept temporarily. Click Continue to check again without entering your password.",
      };
    }
    return { status: "error", message: "LinkedIn reached the feed without a usable login cookie. The session was not saved. Please sign in again through Server login." };
  }

  if (/checkpoint/.test(page.url())) {
    return {
      status: "challenge",
      kind: "unknown",
      message: "LinkedIn presented a security checkpoint. If you got a code enter it; if it's an app request, approve it and click Continue.",
    };
  }
  return { status: "error", message: "Login did not complete. Resolve any verification through LinkedIn before trying Server login again." };
}

export async function startHeadlessLogin(
  accountId: string,
  email: string,
  password: string
): Promise<LoginResult> {
  sweepPendingLogins();
  await clearPendingLogin(accountId);

  const b = await getBrowser(true);
  const ctx = await b.newContext(contextOptions());
  const page = await ctx.newPage();
  try {
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 30_000 });
    // LinkedIn's React login page uses dynamic ids — target by type+visibility
    // (old #username/#password kept as a fallback for the legacy layout).
    const emailInput = page.locator("input#username, input[type='email']:visible").first();
    await emailInput.waitFor({ state: "visible", timeout: 20_000 });
    await emailInput.fill(email);
    const passwordInput = page.locator("input#password, input[type='password']:visible").first();
    await passwordInput.fill(password);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      passwordInput.press("Enter"),
    ]);

    const result = await classifyLoginState(page);
    console.log(`[login] start account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} location=${loginLocation(page.url())}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx);
      await ctx.close();
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      retainPendingLogin(accountId, ctx, page);
      return result;
    }
    await ctx.close();
    return result;
  } catch {
    console.log(`[login] start account=${accountId} ERROR location=${loginLocation(page.url())}`);
    try { await ctx.close(); } catch { /* ignore */ }
    return { status: "error", message: "LinkedIn login failed. Complete any verification through LinkedIn before trying again." };
  }
}

export async function submitLoginChallenge(accountId: string, code: string): Promise<LoginResult> {
  sweepPendingLogins();
  const p = pendingLogins.get(accountId);
  if (!p) return { status: "error", message: "No login in progress (it may have timed out — start again)." };

  const { ctx, page } = p;
  try {
    const pin = page.locator(PIN_SELECTOR).first();
    await pin.waitFor({ state: "visible", timeout: 15_000 });
    await pin.fill(code);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      pin.press("Enter"),
    ]);

    const result = await classifyLoginState(page);
    console.log(`[login] verify account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} location=${loginLocation(page.url())}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx);
      await clearPendingLogin(accountId);
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      retainPendingLogin(accountId, ctx, page); // keep the session alive for another step
      return result;
    }
    await clearPendingLogin(accountId);
    return result.status === "error"
      ? result
      : { status: "error", message: "Code rejected or login failed." };
  } catch {
    await clearPendingLogin(accountId);
    return { status: "error", message: "LinkedIn login failed. Complete any verification through LinkedIn before trying again." };
  }
}

/**
 * Wait for a device/app-approval challenge to clear. Called after the user
 * approves the sign-in in their LinkedIn mobile app — the checkpoint page then
 * auto-advances to the feed. Also dismisses a possible "remember this browser?"
 * interstitial. If still pending, returns the challenge so the user can retry.
 */
export async function awaitLoginApproval(accountId: string): Promise<LoginResult> {
  sweepPendingLogins();
  const p = pendingLogins.get(accountId);
  if (!p) return { status: "error", message: "No login in progress (it may have timed out — start again)." };

  const { ctx, page } = p;
  retainPendingLogin(accountId, ctx, page);
  try {
    const reachedFeed = await page
      .waitForURL(url => isLinkedInLoginLanding(url.href), { timeout: 50_000 })
      .then(() => true)
      .catch(() => false);

    if (!reachedFeed) {
      // Possible post-approval interstitial (e.g. "remember this browser?")
      const btn = page
        .locator("button[type=submit]:visible, button:has-text('Yes'):visible, button:has-text('Ja'):visible")
        .first();
      if ((await btn.count().catch(() => 0)) > 0) {
        await btn.click().catch(() => {});
        await page.waitForURL(url => isLinkedInLoginLanding(url.href), { timeout: 20_000 }).catch(() => {});
      }
    }

    const result = await classifyLoginState(page);
    console.log(`[login] await account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} location=${loginLocation(page.url())}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx);
      await clearPendingLogin(accountId);
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      retainPendingLogin(accountId, ctx, page);
      return result;
    }
    await clearPendingLogin(accountId);
    return result;
  } catch {
    await clearPendingLogin(accountId);
    return { status: "error", message: "LinkedIn login failed. Complete any verification through LinkedIn before trying again." };
  }
}
