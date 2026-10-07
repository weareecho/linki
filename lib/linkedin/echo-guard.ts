// Echo only: reuse the existing internal secret, never send it to a public URL.
export class EchoEligibilityError extends Error {
  constructor() { super("Echo eligibility unavailable, revoked or uncertain; hold for owner review."); }
}

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
  try {
    const raw = process.env.ECHO_GUARD_URL;
    const secret = process.env.INTERNAL_API_SECRET;
    if (!raw || !secret) throw new EchoEligibilityError();
    const url = new URL(raw);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname)
        || url.username || url.password || url.pathname !== "/echo/action" || url.search || url.hash) throw new EchoEligibilityError();
    const response = await fetcher(url, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ ...scope, mode }),
    });
    if (!response.ok) throw new EchoEligibilityError();
    const result = await response.json();
    if (result?.allowed !== true) throw new EchoEligibilityError();
  } catch { throw new EchoEligibilityError(); }
}
