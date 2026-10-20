import type { Locator, Page } from "playwright";
import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export const INVITATION_UNKNOWN_PREFIX = "Invitation outcome unknown:";
function outcomeKeys(targetId: string, linkedinUrl?: string | null): string[] {
  const slug = linkedinUrl ? profileSlug(linkedinUrl) : null;
  return [`invitation-unknown:target:${targetId}`, ...(slug ? [`invitation-unknown:profile:${slug.toLowerCase()}`] : [])];
}
/** One local, private snapshot of a note-scoped invitation dialog that stopped
 * before Send: a screenshot plus button names and textbox/recipient counts, in
 * the private data directory. Nothing is returned, logged or retried. */
async function captureInviteDiagnostic(page: Page, fullName: string): Promise<void> {
  try {
    const directory = path.join(path.dirname(process.env.LINKI_DB_PATH || path.join(process.cwd(), "linki.db")), "invite-diagnostics");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const write = async (name: string, bytes: Buffer | string) => {
      const file = await open(path.join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { await file.chmod(0o600); await file.writeFile(bytes); } finally { await file.close(); }
    };
    const shot = await page.screenshot({ fullPage: false, timeout: 3000 });
    if (shot.length <= 5 * 1024 * 1024) await write("latest.png", shot);
    const dialogs = page.getByRole("dialog");
    const count = await dialogs.count();
    const details = [];
    for (let i = 0; i < Math.min(count, 3); i++) {
      const dialog = dialogs.nth(i);
      details.push({
        visible: await dialog.isVisible().catch(() => false),
        buttons: await dialog.getByRole("button").evaluateAll(elements => elements.slice(0, 20).map(element =>
          ((element.getAttribute("aria-label") || "") + " | " + (element.textContent || "")).replace(/\s+/g, " ").trim().slice(0, 80))),
        textboxes: await dialog.getByRole("textbox").count(),
        exactRecipient: await dialog.getByText(fullName, { exact: true }).count(),
        containsRecipient: (await dialog.innerText({ timeout: 1000 }).catch(() => "")).includes(fullName),
        sendExact: await dialog.getByRole("button", { name: /^Send$/ }).count(),
      });
    }
    let location = "unknown";
    try { location = new URL(page.url()).pathname; } catch { /* no URL details */ }
    await write("latest.json", JSON.stringify({ capturedAt: new Date().toISOString(), location, dialogs: count, details }, null, 2));
    console.warn("[invite-check] private_diagnostic_saved=true");
  } catch { /* Diagnostics must never turn a stopped invitation into a send. */ }
}
export function recordUnknownInvitationOutcome(db: Pick<Database.Database, "prepare">, targetId: string, linkedinUrl?: string | null): void {
  for (const key of outcomeKeys(targetId, linkedinUrl)) {
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, 'hold') ON CONFLICT(key) DO UPDATE SET value = 'hold'").run(key);
  }
}
export function clearConfirmedInvitationOutcome(db: Pick<Database.Database, "prepare">, targetId: string, linkedinUrl?: string | null): void {
  for (const key of outcomeKeys(targetId, linkedinUrl)) db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
}
export function hasUnresolvedInvitationOutcome(db: Pick<Database.Database, "prepare">, targetId: string, linkedinUrl?: string | null): boolean {
  if (outcomeKeys(targetId, linkedinUrl).some(key => Boolean(db.prepare("SELECT 1 FROM app_settings WHERE key = ? AND value = 'hold'").get(key)))) return true;
  return Boolean(db.prepare("SELECT 1 FROM logs WHERE target_id = ? AND message LIKE ? LIMIT 1")
    .get(targetId, INVITATION_UNKNOWN_PREFIX + "%"));
}

export class WeeklyLimitError extends Error {}
export class AlreadyConnectedError extends Error {}
export class PendingInviteError extends Error {}
export class TargetProfileMismatchError extends Error {}
/** LinkedIn will not offer a note-scoped invitation here (no invite dialog, no
 * "Add a note" or no note editor). Nothing was clicked or sent. It is a layout
 * or account condition, not about one person, so the runner pauses the run. */
export class NoteInvitationUnavailableError extends TargetProfileMismatchError {}

/** LinkedIn's own note-invitation page for an exact member (the href its
 * profile "Connect" links use). Opening it is a navigation, never a send. */
export function noteInvitationUrl(slug: string): string {
  return `https://www.linkedin.com/preload/custom-invite/?vanityName=${encodeURIComponent(slug)}`;
}
export class LinkedInAccessBlockedError extends Error {}
export class InvitationOutcomeUnknownError extends Error {
  constructor(public readonly sendAttempted: boolean) {
    super("Invitation outcome unknown: stop and reconcile the exact target; never retry automatically.");
    this.name = "InvitationOutcomeUnknownError";
  }
}

function profileSlug(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["www.linkedin.com", "linkedin.com"].includes(url.hostname)) return null;
    return url.pathname.match(/^\/in\/([^/]+)\/?$/)?.[1] ?? null;
  } catch { return null; }
}

function inviteMatchesTarget(value: string, slug: string): boolean {
  try {
    const url = new URL(value, "https://www.linkedin.com");
    if (url.protocol !== "https:" || !["www.linkedin.com", "linkedin.com"].includes(url.hostname)) return false;
    return (url.pathname === "/preload/custom-invite/" && url.searchParams.get("vanityName") === slug) ||
      url.pathname.replace(/\/$/, "") === `/in/${slug}/overlay/custom-invite`;
  } catch { return false; }
}

async function exactProfileCard(page: Page, slug: string, fullName?: string): Promise<Locator> {
  const heading = fullName ? page.locator("main").getByRole("heading", { name: fullName, exact: true }).filter({ visible: true }) : page.locator("main h1:visible");
  const card = heading.locator("xpath=ancestor::section[1]");
  const ready = await observeRendering(page, async () => {
    if (profileSlug(page.url()) !== slug) throw new TargetProfileMismatchError("Exact target profile was not reached; stop.");
    if (await heading.count() > 1 || await card.count() > 1) throw new TargetProfileMismatchError("Target profile is ambiguous; stop.");
    return await heading.count() === 1 && await card.count() === 1 &&
      await heading.isVisible() && (await heading.innerText()).trim().length > 0;
  });
  if (!ready) throw new TargetProfileMismatchError("Target profile card did not render; stop.");
  return card;
}

// Observe asynchronous DOM rendering, never repeat a click/navigation. Provider
// rejection and ambiguity still stop immediately; expiration never means success.
async function observeRendering(page: Page, ready: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 5000;
  do {
    await assertNoProviderRejection(page);
    if (await ready()) return true;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return false;
}

async function isPending(card: Locator): Promise<boolean> {
  return /\bPending\b/.test(await card.innerText()) ||
    await card.getByRole("button", { name: /Pending/ }).count() > 0;
}

async function assertNoProviderRejection(page: Page): Promise<void> {
  if (await page.locator('div[class*="ip-fuse-limit-alert__warning"]:visible').count() > 0) {
    throw new WeeklyLimitError("Weekly connection limit reached; stop.");
  }
  if (await page.locator('div[data-test-artdeco-toast-item-type="error"]:visible').count() > 0) {
    throw new Error("LinkedIn rejected the invitation; reconcile before another attempt.");
  }
}

/** One no-note request, strictly scoped to the exact profile. Returns only on a
 * positive Pending state for that target. Never retries clicks or uncertain sends.
 * The caller must independently verify its authenticated account before invoking.
 */
export async function sendConnectionRequest(page: Page, linkedinUrl: string, beforeSend?: () => void | Promise<void>, approved?: { note: string; fullName: string }, fullName?: string): Promise<void> {
  const slug = profileSlug(linkedinUrl);
  if (!slug) throw new TargetProfileMismatchError("An exact HTTPS LinkedIn profile URL is required.");
  let sendAttempted = false;
  let fenced = false;
  const fence = async () => {
    if (!fenced) { await beforeSend?.(); fenced = true; }
  };
  try {
    const response = await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!response || response.status() >= 400) throw new LinkedInAccessBlockedError("LinkedIn access failed; stop without inviting.");
    const card = await exactProfileCard(page, slug, approved?.fullName || fullName);
    const name = (await card.locator("h1:visible,h2:visible").innerText()).trim();
    if (!name) throw new TargetProfileMismatchError("Target name is absent; stop.");
    if (approved && (name.toLocaleLowerCase() !== approved.fullName.trim().toLocaleLowerCase()
        || !approved.note.trim() || approved.note.length > 200)) throw new TargetProfileMismatchError("Approved recipient or note is not verified; stop.");
    if (/\b1st\b/.test(await card.innerText()) || await card.getByText("1st", { exact: true }).count() > 0) {
      throw new AlreadyConnectedError("Already connected");
    }
    if (await isPending(card)) throw new PendingInviteError("Invitation already pending");

    const direct = card.locator('a[aria-label*="Invite"][aria-label*="to connect"]:visible, a[href*="custom-invite"]:visible');
    if (await direct.count() > 0) {
      if (await direct.count() !== 1) throw new TargetProfileMismatchError("Ambiguous target Connect links; stop.");
      const href = await direct.getAttribute("href");
      if (!href || !inviteMatchesTarget(href, slug)) throw new TargetProfileMismatchError("Invitation link does not identify the exact target; stop.");
      const inviteResponse = await page.goto(new URL(href, "https://www.linkedin.com").href, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (!inviteResponse || inviteResponse.status() >= 400 || !inviteMatchesTarget(page.url(), slug)) {
        throw new LinkedInAccessBlockedError("Target invitation page unavailable; stop.");
      }
    } else if (approved) {
      // Button/menu layouts may invite immediately without a note, which
      // Echo's note-scoped approval cannot authorize, so they are never
      // clicked. Open the exact target's own invitation page instead; the
      // dialog, recipient, note and Send checks below all still apply.
      const inviteResponse = await page.goto(noteInvitationUrl(slug), { waitUntil: "domcontentloaded", timeout: 30000 });
      if (!inviteResponse || inviteResponse.status() >= 400 || !inviteMatchesTarget(page.url(), slug)) {
        throw new NoteInvitationUnavailableError("Target invitation page unavailable; stop.");
      }
    } else {
      const connect = card.getByRole("button", { name: /^(Connect|Invite .+ to connect)$/ });
      if (await connect.count() === 1) {
        const label = await connect.getAttribute("aria-label");
        if (label?.startsWith("Invite ") && label !== `Invite ${name} to connect`) {
          throw new TargetProfileMismatchError("Connect button identifies another recipient; stop.");
        }
        await fence();
        sendAttempted = true; // Some layouts send immediately from Connect.
        await connect.click();
      } else {
        const more = card.getByRole("button", { name: /^(More|More actions)$/ });
        if (await more.count() !== 1) throw new TargetProfileMismatchError("Target More menu is absent or ambiguous; stop.");
        const controls = await more.getAttribute("aria-controls");
        await more.click();
        const menu = controls && /^[a-zA-Z0-9:_-]+$/.test(controls)
          ? page.locator(`[id="${controls}"]`)
          : card.getByRole("menu");
        if (!await observeRendering(page, async () => {
          if (await menu.count() > 1) throw new TargetProfileMismatchError("Target menu is ambiguous; stop.");
          return await menu.count() === 1 && await menu.isVisible();
        })) throw new TargetProfileMismatchError("Cannot associate menu with the target; stop.");
        if (await menu.getByRole("menuitem", { name: /Pending/ }).count() > 0) throw new PendingInviteError("Invitation already pending");
        const item = menu.getByRole("menuitem", { name: "Connect", exact: true });
        if (await item.count() !== 1) throw new TargetProfileMismatchError("Target menu Connect action is absent or ambiguous; stop.");
        await fence();
        sendAttempted = true;
        await item.click();
      }
    }

    const dialogs = page.getByRole("dialog");
    if (!await observeRendering(page, async () => {
      if (await dialogs.count() > 1) throw new TargetProfileMismatchError("Ambiguous invitation dialogs; stop.");
      return await dialogs.count() === 1 && await dialogs.first().isVisible();
    })) {
      if (approved && !sendAttempted) throw new NoteInvitationUnavailableError("Invitation dialog did not open; stop.");
      throw new InvitationOutcomeUnknownError(sendAttempted);
    }
    const dialog = dialogs.first();
    // The explicit recipient name is mandatory before the final send click.
    const recipient = dialog.getByText(name, { exact: true });
    if (!await observeRendering(page, async () => {
      if (await dialogs.count() !== 1 || await recipient.count() > 1) throw new TargetProfileMismatchError("Ambiguous invitation recipient; stop.");
      return await recipient.count() === 1 && await recipient.isVisible();
    })) {
      throw new TargetProfileMismatchError("Invitation dialog recipient is not verified; stop.");
    }
    if (approved) {
      const add = dialog.getByRole("button", { name: "Add a note", exact: true });
      if (await add.count() !== 1) throw new NoteInvitationUnavailableError("Unique Add a note control absent; stop.");
      await add.click();
      const textbox = dialog.getByRole("textbox");
      if (!await observeRendering(page, async () => await textbox.count() === 1 && await textbox.isVisible())) {
        throw new NoteInvitationUnavailableError("Unique note editor absent; stop.");
      }
      await textbox.fill(approved.note);
      if (await textbox.inputValue() !== approved.note) throw new TargetProfileMismatchError("Invitation note changed; stop.");
    }
    const send = dialog.getByRole("button", { name: approved ? /^Send$/ : /^(Send without a note|Send now)$/ });
    if (!await observeRendering(page, async () => {
      if (await dialogs.count() !== 1 || await send.count() > 1 || await recipient.count() !== 1) throw new TargetProfileMismatchError("Invitation recipient or controls changed; stop.");
      return await send.count() === 1 && await send.isVisible() && await send.isEnabled();
    })) throw new InvitationOutcomeUnknownError(sendAttempted);
    await assertNoProviderRejection(page);
    if (await dialogs.count() !== 1 || await recipient.count() !== 1 || !await recipient.isVisible() || await send.count() !== 1) {
      throw new TargetProfileMismatchError("Invitation recipient or controls changed before Send; stop.");
    }
    await fence();
    if (await dialogs.count() !== 1 || await recipient.count() !== 1 || !await recipient.isVisible()
        || await send.count() !== 1 || !await send.isVisible() || !await send.isEnabled()) {
      throw new TargetProfileMismatchError("Invitation recipient or controls changed during eligibility check; stop.");
    }
    if (approved && await dialog.getByRole("textbox").inputValue() !== approved.note) throw new TargetProfileMismatchError("Invitation note changed before Send; stop.");
    sendAttempted = true; // Set before click: even a timeout may have sent it.
    await send.click();
    const closed = await dialog.waitFor({ state: "hidden", timeout: 10000 }).then(() => true).catch(() => false);
    await assertNoProviderRejection(page);
    if (!closed) throw new InvitationOutcomeUnknownError(true);

    // One normal read-only post-action check. Absence of a toast/dialog is not success.
    const observed = await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!observed || observed.status() >= 400) throw new InvitationOutcomeUnknownError(true);
    const observedCard = await exactProfileCard(page, slug, approved?.fullName || fullName);
    if (!await observeRendering(page, async () => {
      if (profileSlug(page.url()) !== slug) throw new TargetProfileMismatchError("Post-send profile changed; stop.");
      return await isPending(observedCard);
    })) throw new InvitationOutcomeUnknownError(true);
  } catch (error) {
    if (approved && !sendAttempted && error instanceof TargetProfileMismatchError) await captureInviteDiagnostic(page, approved.fullName);
    if (error instanceof WeeklyLimitError || error instanceof AlreadyConnectedError || error instanceof PendingInviteError || error instanceof InvitationOutcomeUnknownError) throw error;
    if (sendAttempted) throw new InvitationOutcomeUnknownError(true);
    throw error;
  }
}
