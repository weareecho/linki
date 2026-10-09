import { createHash } from "node:crypto";
import { canonicalProfile, type IdentityObservation } from "./readiness-session";

export type Scope = { account_id: string; workflow_id: string; list_id: string };
export type ReadinessRequest = Scope & { guard_revision: string; approval_manifest_digest: string; challenge: string };
export type ReadinessConfig = Scope & {
  account_profile_url: string; bridge_action_url: string; guard_revision: string;
  approval_manifest_path: string; approval_manifest_digest: string;
};
export type BlockReason = "configuration_unavailable" | "scope_mismatch" | "association_unavailable" |
  "unsupported_steps" | "guard_not_enforced" | "guard_artifact_unavailable" | "guard_revision_mismatch" |
  "bridge_url_mismatch" | "manifest_unavailable" | "manifest_changed" | "session_unavailable" |
  "session_stale" | "identity_mismatch" | "bridge_unavailable" | "bridge_mismatch" | "observation_timeout" |
  "runtime_changed";
export class ReadinessBlocked extends Error {
  constructor(public readonly reason: BlockReason) { super(reason); this.name = "ReadinessBlocked"; }
}
export const blocked: (reason: BlockReason) => never = (reason: BlockReason): never => { throw new ReadinessBlocked(reason); };
export const exactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
export function validScope(value: unknown): value is Scope {
  return exactKeys(value, ["account_id", "workflow_id", "list_id"]) &&
    Object.values(value).every(v => typeof v === "string" && v.length > 0 && v.length <= 256);
}
export function validRequest(value: unknown): value is ReadinessRequest {
  return exactKeys(value, ["account_id", "workflow_id", "list_id", "guard_revision", "approval_manifest_digest", "challenge"]) &&
    validScope({ account_id: value.account_id, workflow_id: value.workflow_id, list_id: value.list_id }) &&
    typeof value.guard_revision === "string" && /^sha256:[a-f0-9]{64}$/.test(value.guard_revision) &&
    typeof value.approval_manifest_digest === "string" && /^[a-f0-9]{64}$/.test(value.approval_manifest_digest) &&
    typeof value.challenge === "string" && /^[a-f0-9]{64}$/.test(value.challenge);
}

export function parseConfig(value: unknown): ReadinessConfig {
  const fields = ["account_id", "workflow_id", "list_id", "account_profile_url", "bridge_action_url",
    "guard_revision", "approval_manifest_path", "approval_manifest_digest"];
  if (!exactKeys(value, fields) || !Object.values(value).every(v => typeof v === "string" && v.length <= 4096) ||
      !validScope({ account_id: value.account_id, workflow_id: value.workflow_id, list_id: value.list_id }) ||
      !canonicalProfile(value.account_profile_url) || !/^sha256:[a-f0-9]{64}$/.test(String(value.guard_revision)) ||
      !/^[a-f0-9]{64}$/.test(String(value.approval_manifest_digest)) ||
      !String(value.approval_manifest_path).startsWith("/")) blocked("configuration_unavailable");
  return value as ReadinessConfig;
}

/** Python operations.batch.digest: sorted keys, compact separators, ensure_ascii.
 * Reviewed manifest values are strings, booleans, null and safe integers. Reject
 * floating/exponent number tokens instead of guessing Python float serialization. */
export function canonicalManifestDigest(raw: string): string {
  const tokens = raw.replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/-?\d+(?:\.\d+|[eE][+-]?\d+)/.test(tokens)) blocked("manifest_unavailable");
  const quote = (s: string) => JSON.stringify(s).replace(/[\u007f-\uffff]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const canonical = (v: unknown): string => {
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "string") return quote(v);
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) blocked("manifest_unavailable");
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object") {
      const row = v as Record<string, unknown>;
      const keys = Object.keys(row).sort((a, b) => {
        const left = Array.from(a), right = Array.from(b);
        for (let i = 0; i < Math.min(left.length, right.length); i++) {
          const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
          if (difference) return difference;
        }
        return left.length - right.length;
      });
      return `{${keys.map(k => `${quote(k)}:${canonical(row[k])}`).join(",")}}`;
    }
    return blocked("manifest_unavailable");
  };
  try {
    const manifest = JSON.parse(raw);
    if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > 1550) blocked("manifest_unavailable");
    return createHash("sha256").update(canonical(manifest)).digest("hex");
  } catch { return blocked("manifest_unavailable"); }
}

export function readinessBridgeURL(actual: string | undefined, expected: string): URL {
  try {
    if (!actual || actual !== expected) blocked("bridge_url_mismatch");
    const url = new URL(actual);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname) ||
        url.username || url.password || url.pathname !== "/echo/action" || url.search || url.hash)
      blocked("bridge_url_mismatch");
    url.pathname = "/echo/readiness";
    return url;
  } catch { return blocked("bridge_url_mismatch"); }
}

export type ReadinessDependencies = {
  config: () => ReadinessConfig;
  inspectScope: (scope: Scope) => string; // digest of the actual read-only scope snapshot
  manifest: (path: string) => string;
  revision: () => string | null;
  observe: (account: string) => Promise<IdentityObservation | null>;
  bridge: (url: URL, payload: Record<string, string>, signal: AbortSignal) => Promise<unknown>;
  guardURL: () => string | undefined;
  now?: () => number;
};

export async function produceReadiness(request: ReadinessRequest, deps: ReadinessDependencies) {
  if (!validRequest(request)) blocked("scope_mismatch");
  const scope: Scope = { account_id: request.account_id, workflow_id: request.workflow_id, list_id: request.list_id };
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const config = deps.config();
  if (Object.entries(scope).some(([key, value]) => config[key as keyof Scope] !== value)) blocked("scope_mismatch");
  if (request.guard_revision !== config.guard_revision || request.approval_manifest_digest !== config.approval_manifest_digest)
    blocked("scope_mismatch");
  const revision = deps.revision();
  if (!revision) blocked("guard_artifact_unavailable");
  if (revision !== config.guard_revision) blocked("guard_revision_mismatch");
  const scopeSnapshot = deps.inspectScope(scope);
  const url = readinessBridgeURL(deps.guardURL(), config.bridge_action_url);
  const digest = canonicalManifestDigest(deps.manifest(config.approval_manifest_path));
  if (digest !== config.approval_manifest_digest) blocked("manifest_changed");
  const signal = AbortSignal.timeout(7000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observe = async () => {
    const identity = await deps.observe(scope.account_id);
    if (signal.aborted) blocked("observation_timeout");
    if (!identity) blocked("session_unavailable");
    if (!Number.isFinite(identity.observedAt) || !Number.isFinite(identity.startedAt) ||
        identity.observedAt < startedAt || identity.observedAt > now() || identity.startedAt > identity.observedAt ||
        identity.startedAt < startedAt || identity.observedAt - identity.startedAt > 4000) blocked("session_stale");
    if (identity.profile !== canonicalProfile(config.account_profile_url)) blocked("identity_mismatch");
    const payload = { ...scope, challenge: request.challenge, guard_revision: revision!, approval_manifest_digest: digest };
    let response: unknown;
    try { response = await deps.bridge(url, payload, signal); }
    catch { return blocked("bridge_unavailable"); }
    if (!exactKeys(response, [...Object.keys(payload), "ready"]) || response.ready !== true ||
        Object.entries(payload).some(([key, value]) => response[key] !== value)) blocked("bridge_mismatch");
    // Re-read every local source after the asynchronous observations. No green
    // receipt if an owner edits config/workflow/manifest or runtime changes mid-call.
    if (JSON.stringify(deps.config()) !== JSON.stringify(config) || deps.revision() !== revision ||
        deps.inspectScope(scope) !== scopeSnapshot || deps.guardURL() !== config.bridge_action_url ||
        canonicalManifestDigest(deps.manifest(config.approval_manifest_path)) !== digest) blocked("runtime_changed");
    if (!identity.isCurrent()) blocked("runtime_changed");
    const checkedAt = now();
    if (checkedAt < startedAt || checkedAt - startedAt > 7000 || checkedAt - identity.observedAt > 7000)
      blocked("session_stale");
    return { ...payload,
      checked_at: new Date(checkedAt).toISOString(), guarded_owner_ready: true };
  };
  try {
    return await Promise.race([observe(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReadinessBlocked("observation_timeout")), 7000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
