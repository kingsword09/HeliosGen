import path from "node:path";
import type { NextConfig } from "next";

// The packaged desktop (MyGo) build runs `next build` with DESKTOP_BUILD=1 and
// ships the self-contained `next-desktop/standalone` server as a bundled sidecar. Plain
// `next dev` / `next build` (local development) leave it unset.
const DESKTOP_BUILD = process.env.DESKTOP_BUILD === "1";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.64.2"],
  ...(DESKTOP_BUILD ? { output: "standalone" as const, distDir: "next-desktop" } : {}),
  turbopack: {
    root: path.join(__dirname),
  },
  experimental: {
    proxyClientMaxBodySize: '30mb',
  },
  serverExternalPackages: ["undici"],
  // `sharp` is a native module; the file tracer misses its platform binaries
  // unless we point at them explicitly for the standalone bundle.
  outputFileTracingIncludes: {
    "/**": ["node_modules/sharp/**/*", "node_modules/@img/**/*"],
  },
  // Never trace the MyGo desktop staging area into the standalone output.
  outputFileTracingExcludes: {
    "/**": [
      "desktop/**/*",
      "build/**/*",
      ".mygo/**/*",
      "data/**/*",
      "public/generated/**/*",
      ".env*",
      ".git/**/*",
      ".job-store.json",
      ".codex-login-store.json",
    ],
  },
  images: {
    remotePatterns: [
      // Read-only public bucket holding the bundled workflow-template sample media
      // (lib/templates.ts). Not app storage — just an image CDN allow-list entry.
      { protocol: "https", hostname: "*.r2.dev" },
      { protocol: "https", hostname: "*.replicate.delivery" },
      { protocol: "https", hostname: "pbxt.replicate.delivery" },
      { protocol: "https", hostname: "*.replicate.com" },
      { protocol: "https", hostname: "*.aiquickdraw.com" },
    ],
  },
};

export default nextConfig;
