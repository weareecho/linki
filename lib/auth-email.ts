import type Database from "better-sqlite3";

// Canonicalize the identifier only. Passwords and invite codes remain exact.
export function normalizeLoginEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

// SQLite's built-in trim/lower differ from JavaScript for whitespace and Unicode.
// Use this same canonicalizer for persisted identifiers and supplied identifiers.
export function registerLoginEmailNormalizer(db: Pick<Database.Database, "function">): void {
  db.function("normalize_login_email", { deterministic: true }, normalizeLoginEmail);
}

// Support existing mixed-case/whitespace-padded records without rewriting identities.
// LIMIT 2 lets login fail closed if legacy records share a canonical email.
export const LOGIN_EMAIL_LOOKUP_SQL =
  "SELECT id, email, password_hash FROM users WHERE normalize_login_email(email) = ? LIMIT 2";
