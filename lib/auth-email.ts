// Canonicalize the identifier only. Passwords and invite codes remain exact.
export function normalizeLoginEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

// Support existing mixed-case/space-padded records without rewriting identities.
// LIMIT 2 lets login fail closed if legacy records share a canonical email.
export const LOGIN_EMAIL_LOOKUP_SQL =
  "SELECT id, email, password_hash FROM users WHERE lower(trim(email)) = ? LIMIT 2";
