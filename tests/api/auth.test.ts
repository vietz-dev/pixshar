import { describe, it, expect } from "vitest";
import { API, ADMIN_EMAIL, ADMIN_PASSWORD, ORIGIN_HEADERS } from "./helpers.js";

describe("Authentication", () => {
  describe("Given valid admin credentials", () => {
    describe("When signing in via POST /api/auth/sign-in/email", () => {
      it("Then it returns 200 with user data and a session cookie", async () => {
        const res = await fetch(`${API}/api/auth/sign-in/email`, {
          method: "POST",
          headers: ORIGIN_HEADERS,
          body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
        });

        expect(res.status).toBe(200);

        const body = await res.json() as { user: { email: string } };
        expect(body.user.email).toBe(ADMIN_EMAIL);

        const cookies = res.headers.getSetCookie();
        const hasSessionCookie = cookies.some((c) => c.startsWith("better-auth.session_token"));
        expect(hasSessionCookie).toBe(true);
      });
    });
  });

  describe("Given wrong credentials", () => {
    describe("When signing in with a bad password", () => {
      it("Then it returns 401", async () => {
        const res = await fetch(`${API}/api/auth/sign-in/email`, {
          method: "POST",
          headers: ORIGIN_HEADERS,
          body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong-password" }),
        });

        // BetterAuth rate-limits repeated failures; accept either 401 or 429 here.
        expect([401, 429]).toContain(res.status);
      });
    });

    describe("When signing in with an unknown email", () => {
      it("Then it returns 401 or 429 (rate-limited after prior failures)", async () => {
        const res = await fetch(`${API}/api/auth/sign-in/email`, {
          method: "POST",
          headers: ORIGIN_HEADERS,
          body: JSON.stringify({ email: "nobody@example.com", password: "any" }),
        });

        expect([401, 429]).toContain(res.status);
      });
    });
  });

  describe("Given no session cookie", () => {
    describe("When requesting an admin-only route", () => {
      it("Then it returns 401 Unauthorized", async () => {
        const res = await fetch(`${API}/api/events`);
        expect(res.status).toBe(401);
      });
    });
  });
});
