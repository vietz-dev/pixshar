/**
 * Vitest globalSetup: signs in the admin once before any test file runs,
 * caches the cookie to a temp file. This avoids hitting BetterAuth's
 * rate limiter from parallel/sequential signInAdmin() calls across suites.
 */
import { writeFileSync } from "node:fs";
import { ADMIN_COOKIE_PATH } from "./helpers.js";

const SIGN_IN_URL = "http://localhost:3001/api/auth/sign-in/email";
const SIGN_IN_BODY = JSON.stringify({ email: "admin@example.com", password: "changeme" });
const SIGN_IN_HEADERS = { "Content-Type": "application/json", Origin: "http://localhost:3000" };

export async function setup() {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      // Back off: wait for BetterAuth's rate limit window to partly expire.
      const wait = attempt * 5_000;
      console.log(`[globalSetup] Rate limited, retrying in ${wait / 1000}s (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, wait));
    }

    const res = await fetch(SIGN_IN_URL, {
      method: "POST",
      headers: SIGN_IN_HEADERS,
      body: SIGN_IN_BODY,
    });

    if (res.ok) {
      const cookies = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      writeFileSync(ADMIN_COOKIE_PATH, cookies, "utf-8");
      return;
    }

    if (res.status !== 429) {
      throw new Error(`Global setup: admin sign-in failed with ${res.status}: ${await res.text()}`);
    }
  }
  throw new Error("Global setup: exhausted retries — BetterAuth rate limit persists");
}
