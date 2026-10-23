// Echo only: reuse the existing internal secret, never send it to a public URL.
import { BUILT_GUARD_REVISION } from "./readiness-artifact";
export const ECHO_GUARD_ARTIFACT_REVISION = BUILT_GUARD_REVISION;
// One request, never retried here (the runner may re-ask a failed pre-action
// check later, as a fresh check). Echo's bridge locks the contact and rechecks
// suppression, replies and every email/profile alias in its production DB on
// each call; measured ~10 s warm (two full alias scans), ~15 s after a DB
// reconnect. A shorter bound paused every managed run at its first step.
export const ECHO_GUARD_TIMEOUT_MS = 30_000;

export class EchoEligibilityError extends Error {
  // The bridge's own reason code (or a local one); never an identifier.
  readonly reason: string;
  constructor(reason = "uncertain") {
    super("Echo eligibility unavailable, revoked or uncertain; hold for owner review.");
    this.reason = reason;
  }
}
// The guard could not answer (unreachable, timed out, 5xx, unreadable, or the
// bridge's own DB check failed). Still a hold; only a pre-action check may
// treat it as retryable, because nothing has been claimed or done yet.
export class EchoGuardUnavailableError extends EchoEligibilityError {}

// Denials that are about this one person's own outreach state: they stop that
// person and say nothing about anyone else. Every other denial holds the run.
export const ECHO_PERSON_DENIALS = new Set(["reply_recorded", "opt_out_recorded", "terminal_or_suppressed"]);

export type EchoScope = {
  fingerprint: string; list_id: string; account_id: string; profile: string;
  full_name: string; company: string; note: string;
};

export function parseEchoScope(notes: string | null | undefined, data: Omit<EchoScope, "fingerprint" | "note">): EchoScope {
  const match = notes?.match(/^Echo reservation ([0-9a-f]{64}); approved connection note: ([\s\S]+)$/);
  if (!match || !data.list_id || !data.account_id || !data.full_name || !data.company || match[2].length > 200) {
    throw new EchoEligibilityError();
  }
  return { ...data, fingerprint: match[1], note: match[2] };
}

export async function assertEchoEligible(scope: EchoScope, mode: "check" | "claim" | "complete", fetcher = fetch): Promise<void> {
  // Every failure is an Echo hold; anything unexpected is "uncertain", never retryable.
  try { await askEchoGuard(scope, mode, fetcher); }
  catch (error) { throw error instanceof EchoEligibilityError ? error : new EchoEligibilityError("uncertain"); }
}

async function askEchoGuard(scope: EchoScope, mode: "check" | "claim" | "complete", fetcher: typeof fetch): Promise<void> {
  const raw = process.env.ECHO_GUARD_URL;
  const secret = process.env.INTERNAL_API_SECRET;
  let url: URL | null = null;
  try { url = raw ? new URL(raw) : null; } catch { url = null; }
  if (!url || !secret || url.protocol !== "http:" || !["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/echo/action" || url.search || url.hash) {
    throw new EchoEligibilityError("guard_misconfigured");
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(ECHO_GUARD_TIMEOUT_MS),
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ ...scope, mode }),
    });
  } catch { throw new EchoGuardUnavailableError("guard_unreachable"); }
  // Only a gateway/unavailable status is a blip; anything else (our own request
  // or secret refused, a server bug) is not something a retry fixes.
  if (!response.ok) {
    throw [502, 503, 504].includes(response.status) ? new EchoGuardUnavailableError("guard_http_unavailable") : new EchoEligibilityError("guard_http_refused");
  }
  let result: { allowed?: unknown; reason?: unknown };
  try { result = await response.json(); } catch { throw new EchoGuardUnavailableError("guard_unreadable"); }
  if (result?.allowed === true) return;
  const reason = typeof result?.reason === "string" && /^[a-z_]{1,64}$/.test(result.reason) ? result.reason : "denied";
  throw reason === "guard_unavailable_or_uncertain" ? new EchoGuardUnavailableError(reason) : new EchoEligibilityError(reason);
}
