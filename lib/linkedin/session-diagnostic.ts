import type { Page } from "playwright";
import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** One local, private screenshot of an unrecognized signed-in landing. No
 * cookies, headers, HTML or image bytes are returned by the API or logged. */
export async function captureLoginDiagnostic(page: Page): Promise<void> {
  try {
    const bytes = await page.screenshot({ fullPage: false, timeout: 3000 });
    if (bytes.length > 5 * 1024 * 1024) return;
    const directory = path.join(path.dirname(process.env.LINKI_DB_PATH || path.join(process.cwd(), "linki.db")), "login-diagnostics");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(path.join(directory, "latest.png"), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await file.chmod(0o600); await file.writeFile(bytes); }
    finally { await file.close(); }
    console.warn("[login-check] private_diagnostic_saved=true");
  } catch { /* Diagnostics must never turn a failed verification into success. */ }
}
