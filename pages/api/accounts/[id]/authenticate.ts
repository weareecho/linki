import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { createImportedLinkedInState, hasUsableLinkedInState } from "@/lib/linkedin/session-state";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const db = getDb();
  const id = req.query.id as string;

  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  if (!account) return res.status(404).json({ error: "Account not found" });

  const { li_at, document_cookie } = req.body as { li_at?: string; document_cookie?: string };
  if (typeof li_at !== "string" || !li_at.trim() ||
    (document_cookie !== undefined && typeof document_cookie !== "string")) {
    return res.status(400).json({ error: "A nonempty session cookie is required" });
  }
  // Preserve the supported owner import shape with explicit session expiry.
  // Saving credentials does not establish live access or the owner's identity.
  const storageState = createImportedLinkedInState(li_at, document_cookie);
  if (!hasUsableLinkedInState(storageState)) return res.status(400).json({ error: "Invalid saved session" });

  db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?").run(
    encryptSecret(JSON.stringify(storageState)),
    id
  );

  // Evict the cached browser context so next import uses the new cookies
  const { closeSession } = await import("@/lib/linkedin/session");
  await closeSession(id);

  return res.json({ ok: true });
}
