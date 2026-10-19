import type { Page } from "playwright";
import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { isVisibleLinkedInFrame, loginLocation } from "@/lib/linkedin/session-state";

/** One local, private screenshot of an unrecognized signed-in landing. No
 * cookies, headers, HTML or image bytes are returned by the API or logged. */
export async function captureLoginDiagnostic(page: Page): Promise<void> {
  try {
    const bytes = await page.screenshot({ fullPage: false, timeout: 3000 });
    if (bytes.length > 5 * 1024 * 1024) return;
    const directory = path.join(path.dirname(process.env.LINKI_DB_PATH || path.join(process.cwd(), "linki.db")), "login-diagnostics");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writePrivateFile(path.join(directory, "latest.png"), bytes);
    // Fixed labels and booleans only, never personal text, raw URLs or HTML.
    const frames = await Promise.all(page.frames().slice(0, 20).map(async frame => {
      const trustedVisible = await isVisibleLinkedInFrame(frame, page);
      if (!trustedVisible) return { trustedVisible };
      const labels = ["Home", "My Network", "Jobs", "Messaging", "Notifications", "Me", "Start a post"];
      const matches = await Promise.all(labels.map(async label => ({ label,
        visible: await frame.getByText(label, { exact: true }).filter({ visible: true }).first().isVisible().catch(() => false),
      })));
      return { trustedVisible, location: loginLocation(frame.url()), labels: matches };
    }));
    await writePrivateFile(path.join(directory, "latest.json"), JSON.stringify({ capturedAt: new Date().toISOString(), frames }, null, 2));
    console.warn("[login-check] private_diagnostic_saved=true");
  } catch { /* Diagnostics must never turn a failed verification into success. */ }
}

async function writePrivateFile(filename: string, bytes: Buffer | string): Promise<void> {
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(bytes); }
  finally { await file.close(); }
}
