import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // serial — tests share a live DB and auth state
  reporter: [["list"], ["html", { open: "never", outputFolder: "tests/e2e/report" }]],
  globalSetup: "./tests/e2e/global-setup.ts",

  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // All tests start pre-authenticated as admin.
    // Tests that need a guest context call page.context().clearCookies().
    storageState: "tests/e2e/.auth/admin.json",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: undefined,
});
