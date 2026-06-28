import { describe, it, expect } from "vitest";
import { API } from "./helpers.js";

describe("Health Check", () => {
  describe("Given the API server is running", () => {
    describe("When requesting GET /health", () => {
      it("Then it returns 200 with status ok", async () => {
        const res = await fetch(`${API}/health`);
        expect(res.status).toBe(200);

        const body = await res.json() as { status: string };
        expect(body.status).toBe("ok");
      });
    });
  });
});
