import type { NextConfig } from "next";

// In Docker, WORKSPACE_ROOT=/app tells Turbopack where to find next/package.json.
// Locally, leaving it unset lets Next.js auto-detect the workspace root.
const workspaceRoot = process.env.WORKSPACE_ROOT;

const nextConfig: NextConfig = {
  ...(workspaceRoot ? { turbopack: { root: workspaceRoot } } : {}),
  // NOTE: do NOT inline API_URL via `env` here — that bakes the build-time value
  // into the bundle and defeats the runtime override. src/middleware.ts reads
  // process.env.API_URL at runtime (e.g. http://api:3001 in compose).
  output: "standalone",
  // API proxying is handled by src/middleware.ts for runtime env var support
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
