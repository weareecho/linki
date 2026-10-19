import type { Page } from "playwright";
import { visitProfile, profileIdentity } from "./visit";

export class NotConnectedError extends Error {}
export class MessageOutcomeUnknownError extends Error {
  constructor() { super("Message outcome unknown. Reconcile the exact conversation before retrying."); }
}
export interface SendMessageResult { messagingUrn: string | null; isFirstDegree: boolean; }

/** Resolve the recipient from their live profile every time, then verify the
 * composer. Never use cached recipients or a name-search fallback for sends. */
export async function sendMessage(page: Page, fullName: string, text: string, linkedinUrl: string,
  _cachedMessagingUrn?: string | null, beforeSend?: () => void | Promise<void>): Promise<SendMessageResult> {
  const resolved = await visitProfile(page, linkedinUrl, fullName);
  if (!resolved.isFirstDegree) throw new NotConnectedError(`${fullName} is not a 1st-degree connection`);
  if (!resolved.messagingUrn) throw new Error("Exact recipient Message link is unavailable; no message sent");
  const urn = resolved.messagingUrn;
  const composeUrl = `https://www.linkedin.com/messaging/compose/?profileUrn=${encodeURIComponent(urn)}&recipient=${encodeURIComponent(urn.split(":").pop()!)}`;
  await page.goto(composeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const input = page.locator("div.msg-form__contenteditable:visible");
  await input.first().waitFor({ state: "visible", timeout: 10000 });
  await assertRecipient(page, fullName, linkedinUrl);
  if (await input.count() !== 1) throw new Error("Composer is ambiguous; no message sent");
  const draft = (await input.innerText()).trim();
  if (draft && draft !== text.trim()) throw new Error("Composer contains another draft; no message sent");
  await input.fill(text);
  if ((await input.innerText()).trim() !== text.trim()) throw new Error("Message text was not entered correctly");
  const button = page.locator("button.msg-form__send-button:visible");
  const readyBy = Date.now() + 8000;
  while (Date.now() < readyBy && (await button.count() === 0 || (await button.count() === 1 && !await button.isEnabled()))) {
    await page.waitForTimeout(100);
  }
  if (await button.count() !== 1 || !await button.isEnabled()) throw new Error("Send button is unavailable or ambiguous");
  await assertRecipient(page, fullName, linkedinUrl);
  const matches = () => page.locator(".msg-s-event-listitem__body:visible").filter({ hasText: text });
  const before = await matches().count();
  // The runner records a durable fence before the one Send click. Any ambiguous
  // outcome stays fenced, including process termination, until reconciled.
  await beforeSend?.();
  try {
    await button.click({ timeout: 5000 });
    await page.waitForURL(url => url.origin === "https://www.linkedin.com" && /^\/messaging\/thread\/[^/]+\/?$/.test(url.pathname), { timeout: 15000 });
    await matches().nth(before).waitFor({ state: "visible", timeout: 10000 });
    // Confirm provider persistence, not only an optimistic local render.
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await matches().first().waitFor({ state: "visible", timeout: 10000 });
    if (await matches().count() <= before) throw new MessageOutcomeUnknownError();
    return resolved;
  } catch { throw new MessageOutcomeUnknownError(); }
}

async function assertRecipient(page: Page, fullName: string, linkedinUrl: string): Promise<void> {
  const expected = profileIdentity(linkedinUrl);
  const links = page.locator("a.profile-card-one-to-one__profile-link:visible");
  const hrefs = await links.evaluateAll(elements => elements.map(el => el.getAttribute("href") || ""));
  const pills = page.locator('button[aria-label^="Remove "]:visible');
  if (!expected || !hrefs.length || hrefs.some(href => profileIdentity(href) !== expected) ||
      await pills.count() !== 1 || await pills.getAttribute("aria-label") !== `Remove ${fullName}`) {
    throw new Error("Composer does not identify the exact single recipient; no message sent");
  }
}
