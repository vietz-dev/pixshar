import type { NextConfig } from "next";

// In Docker, WORKSPACE_ROOT=/app tells Turbopack where to find next/package.json.
// Locally, leaving it unset lets Next.js auto-detect the workspace root.
const workspaceRoot = process.env.WORKSPACE_ROOT;

const nextConfig: NextConfig = {
  ...(workspaceRoot ? { turbopack: { root: workspaceRoot } } : {}),
  env: {
    API_URL: process.env.API_URL ?? "http://pixshar-api:3001"
  },
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
