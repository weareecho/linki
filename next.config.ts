import type { NextConfig } from "next";
import { existsSync } from "fs";
import { join } from "path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// Open-core: the hosted MCP + its OAuth routes are a commercial (ee/) feature. When ee/
// is stripped (public build), those routes don't exist, so the well-known rewrites below
// must NOT be emitted — otherwise they'd point at 404s. Gate them on ee/ being present.
const hasEE = existsSync(join(__dirname, "ee"));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep production builds reproducible within constrained memory.
  experimental: { cpus: 1 },
  serverExternalPackages: ["better-sqlite3", "playwright", "playwright-extra", "puppeteer-extra-plugin-stealth"],

  // OAuth discovery for the hosted MCP server must live at /.well-known/* (RFC 8414 / 9728).
  // Map those well-known paths to the pages-router API routes that serve the metadata.
  // Present only in the commercial build (see hasEE above).
  async rewrites() {
    if (!hasEE) return [];
    return [
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/oauth/metadata-authorization-server",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/oauth/metadata-protected-resource",
      },
      {
        // Clients probe the resource-scoped variant too.
        source: "/.well-known/oauth-protected-resource/api/mcp",
        destination: "/api/oauth/metadata-protected-resource",
      },
    ];
  },
};

export default function configuration(phase: string): NextConfig {
  // Build evidence covers the complete action implementation and readiness seam.
  // Framed filenames/content make this reproducible and unambiguous. Never use
  // a caller/runtime environment revision or Git HEAD as running-code evidence.
  const files = ["lib/linkedin/runner.ts", "lib/linkedin/echo-guard.ts",
    "lib/linkedin/connect.ts", "lib/linkedin/visit.ts", "lib/linkedin/session.ts",
    "lib/linkedin/readiness-artifact.ts", "lib/linkedin/readiness-session.ts",
    "lib/linkedin/readiness.ts", "lib/linkedin/readiness-store.ts", "pages/api/echo/readiness.ts", "next.config.ts"];
  const digest = createHash("sha256");
  if (phase === PHASE_PRODUCTION_BUILD) {
    for (const file of files) {
      const content = readFileSync(join(__dirname, file));
      digest.update(`${file}\0${content.length}\0`).update(content);
    }
  }
  return { ...nextConfig, env: { LINKI_BUILT_GUARD_REVISION:
    phase === PHASE_PRODUCTION_BUILD ? `sha256:${digest.digest("hex")}` : "" } };
}
