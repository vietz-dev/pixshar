import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/api/**/*.test.ts"],
    environment: "node",
    globals: true,
    // Signs in once; reads cookie from file; prevents BetterAuth rate limits.
    globalSetup: ["tests/api/globalSetup.ts"],
    // Run files serially — tests share a live DB; parallel forks trigger rate limits.
    fileParallelism: false,
    pool: "forks",
    // Allow time for network calls to Docker stack.
    // photo-lifecycle.test.ts waits up to 60s for the image-processor; hooks need headroom.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Pretty reporter with verbose output for GWT readability.
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["apps/api/src/**/*.ts"],
    },
  },
});
