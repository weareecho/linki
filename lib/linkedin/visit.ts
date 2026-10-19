import type { Page } from "playwright";

export function profileIdentity(raw: string): string | null {
  try {
    const url = new URL(raw, "https://www.linkedin.com");
    if (url.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(url.hostname) ||
        url.username || url.password || url.port || !/^\/in\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return null;
    return url.pathname.replace(/\/$/, "");
  } catch { return null; }
}

/** Read only the exact person's primary profile card. New LinkedIn layouts use
 * H2; sidebar message links and unknown/missing cards must never imply success. */
export async function visitProfile(page: Page, linkedinUrl: string, fullName?: string): Promise<{ isFirstDegree: boolean; messagingUrn: string | null }> {
  const expected = profileIdentity(linkedinUrl);
  if (!expected) throw new Error("An exact LinkedIn profile URL is required");
  const response = await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (!response || response.status() >= 400 || profileIdentity(page.url()) !== expected) {
    throw new Error("LinkedIn did not load the exact target profile");
  }
  const main = page.locator("main");
  const heading = fullName
    ? main.getByRole("heading", { name: fullName, exact: true }).filter({ visible: true })
    : main.locator("h1:visible");
  await heading.first().waitFor({ state: "visible", timeout: 10000 });
  if (await heading.count() !== 1) throw new Error("Target profile heading is ambiguous");
  const card = heading.locator("xpath=ancestor::section[1]");
  if (await card.count() !== 1 || !await card.isVisible() ||
      await card.locator("h1:visible,h2:visible").count() !== 1) {
    throw new Error("Target profile card is absent or ambiguous");
  }
  const isFirstDegree = await card.getByText("1st", { exact: true }).filter({ visible: true }).count() > 0 || /\b1st\b/.test(await card.innerText());
  if (!isFirstDegree) return { isFirstDegree: false, messagingUrn: null };
  const hrefs = await card.locator('a[href*="/messaging/compose"]:visible').evaluateAll(links => links.map(link => link.getAttribute("href") || ""));
  const urns = new Set<string>();
  for (const href of hrefs) {
    const url = new URL(href, "https://www.linkedin.com");
    const urn = url.searchParams.get("profileUrn");
    if (url.origin !== "https://www.linkedin.com" || url.pathname !== "/messaging/compose/" ||
        !urn || !/^urn:li:fsd_profile:[A-Za-z0-9_-]+$/.test(urn) ||
        (url.searchParams.has("recipient") && url.searchParams.get("recipient") !== urn.split(":").pop())) {
      throw new Error("Target Message link is invalid");
    }
    urns.add(urn);
  }
  if (urns.size > 1) throw new Error("Target Message links disagree");
  return { isFirstDegree: true, messagingUrn: [...urns][0] || null };
}
