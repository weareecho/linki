import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { recheckSavedLogin, savedLoginExpiresAt } from "@/lib/linkedin/session";

// Re-checks the SAVED LinkedIn login in Linki's own browser, the way a person
// opens their feed, and restores the account when LinkedIn confirms it. Never
// logs in: a login LinkedIn really ended still needs Settings > Server login.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const accountId = req.query.id as string;
  const db = getDb();
  if (!db.prepare("SELECT id FROM accounts WHERE id = ?").get(accountId)) {
    return res.status(404).json({ error: "Account not found" });
  }
  const status = await recheckSavedLogin(accountId);
  const account = db.prepare("SELECT is_authenticated FROM accounts WHERE id = ?").get(accountId) as
    | { is_authenticated: number }
    | undefined;
  return res.json({ status, is_authenticated: account?.is_authenticated ?? 0, login_expires_at: savedLoginExpiresAt(accountId) });
}
