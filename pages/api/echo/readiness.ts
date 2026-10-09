import type { NextApiRequest, NextApiResponse } from "next";
import { createHash, timingSafeEqual } from "node:crypto";
import { produceReadiness, ReadinessBlocked, validRequest, blocked } from "@/lib/linkedin/readiness";
import { inspectReadOnlyScope, loadReadinessConfig, readBoundedFile } from "@/lib/linkedin/readiness-store";
import { runningGuardRevision } from "@/lib/linkedin/readiness-artifact";
import { observeExistingIdentity } from "@/lib/linkedin/readiness-session";

// Authenticate before reading a body (including malformed/oversized requests).
export const config = { api: { bodyParser: false, responseLimit: "2kb" } };
let observationInProgress = false;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  const supplied = req.headers["x-internal-secret"];
  const expected = process.env.INTERNAL_API_SECRET;
  const hash = (v: string) => createHash("sha256").update(v).digest();
  if (!expected || typeof supplied !== "string" || supplied.length > 4096 ||
      !timingSafeEqual(hash(supplied), hash(expected))) return res.status(401).json({ error: "unauthorized" });
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "method_not_allowed" }); }
  if (observationInProgress) return res.status(409).json({ guarded_owner_ready: false, reason: "observation_busy" });
  if (req.headers["content-type"] !== "application/json") return res.status(400).json({ error: "invalid_request" });
  let body: unknown;
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    const read = async () => {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 8192) throw new Error("invalid_request");
        chunks.push(buffer);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      body = await Promise.race([read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("invalid_request")), 1000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  } catch { return res.status(400).json({ error: "invalid_request" }); }
  if (!validRequest(body)) return res.status(400).json({ error: "invalid_request" });
  observationInProgress = true;
  try {
    const result = await produceReadiness(body, {
      config: loadReadinessConfig, inspectScope: inspectReadOnlyScope,
      manifest: filename => {
        try { return readBoundedFile(filename, 4 * 1024 * 1024); }
        catch { return blocked("manifest_unavailable"); }
      },
      revision: runningGuardRevision, observe: observeExistingIdentity,
      guardURL: () => process.env.ECHO_GUARD_URL,
      bridge: async (url, payload, signal) => {
        const response = await fetch(url, { method: "POST", redirect: "error", cache: "no-store", signal,
          headers: { "content-type": "application/json", "x-internal-secret": expected }, body: JSON.stringify(payload) });
        if (!response.ok || !response.body) return blocked("bridge_unavailable");
        const reader = response.body.getReader();
        let length = 0;
        const chunks: Buffer[] = [];
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 4096) return blocked("bridge_unavailable");
            chunks.push(Buffer.from(value));
          }
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } finally { await reader.cancel().catch(() => {}); }
      },
    });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(409).json({ guarded_owner_ready: false,
      reason: error instanceof ReadinessBlocked ? error.reason : "observation_unavailable" });
  } finally { observationInProgress = false; }
}
