/**
 * Unit tests for the pure idle-expiry decision (no live stack needed).
 */
import { describe, it, expect } from "vitest";
import {
  archiveExpiresAt,
  isExpired,
  type ExpiryCandidate,
} from "../../apps/api/src/services/downloadJob/expiry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-12T12:00:00.000Z");

const job = (over: Partial<ExpiryCandidate> = {}): ExpiryCandidate => ({
  status: "READY",
  lastDownloadedAt: null,
  readyAt: null,
  ...over,
});

const daysAgo = (days: number, offsetMs = 0) =>
  new Date(NOW.getTime() - days * DAY_MS + offsetMs);

describe("isExpired", () => {
  it("Given a READY job idle longer than the TTL, When deciding, Then it is expired", () => {
    expect(isExpired(job({ lastDownloadedAt: daysAgo(6) }), NOW, 5)).toBe(true);
  });

  it("Given a READY job idle less than the TTL, When deciding, Then it is not expired", () => {
    expect(isExpired(job({ lastDownloadedAt: daysAgo(4) }), NOW, 5)).toBe(false);
  });

  it("Given a job never downloaded, When deciding, Then the idle clock falls back to readyAt", () => {
    expect(isExpired(job({ readyAt: daysAgo(6) }), NOW, 5)).toBe(true);
    expect(isExpired(job({ readyAt: daysAgo(4) }), NOW, 5)).toBe(false);
  });

  it("Given a recent download over an old readyAt, When deciding, Then lastDownloadedAt wins", () => {
    expect(
      isExpired(job({ readyAt: daysAgo(30), lastDownloadedAt: daysAgo(1) }), NOW, 5)
    ).toBe(false);
  });

  it("Given ttlDays = 0, When deciding, Then nothing ever expires", () => {
    expect(isExpired(job({ lastDownloadedAt: daysAgo(365) }), NOW, 0)).toBe(false);
    expect(isExpired(job({ readyAt: daysAgo(365) }), NOW, 0)).toBe(false);
  });

  it("Given a job that is not READY, When deciding, Then it never expires", () => {
    for (const status of ["DEBOUNCING", "QUEUED", "BUILDING", "FAILED", "CANCELLED", "EXPIRED"] as const) {
      expect(isExpired(job({ status, lastDownloadedAt: daysAgo(365) }), NOW, 5)).toBe(false);
    }
  });

  it("Given idle exactly at the TTL, When deciding, Then it is not yet expired but one ms later it is", () => {
    expect(isExpired(job({ lastDownloadedAt: daysAgo(5) }), NOW, 5)).toBe(false);
    expect(isExpired(job({ lastDownloadedAt: daysAgo(5, -1) }), NOW, 5)).toBe(true);
  });

  it("Given a READY job with no idle clock at all, When deciding, Then it is not expired", () => {
    expect(isExpired(job(), NOW, 5)).toBe(false);
  });
});

// The countdown the admin panel shows ("expires in 3 days if nobody downloads").
// It is the SAME clock the reaper decides on — isExpired is defined in terms of
// it — so the two can never drift apart.
describe("archiveExpiresAt", () => {
  it("Given a READY job, When computing the countdown, Then it is TTL days after the last download", () => {
    expect(archiveExpiresAt(job({ lastDownloadedAt: daysAgo(1) }), 5)).toEqual(
      new Date(daysAgo(1).getTime() + 5 * DAY_MS)
    );
  });

  it("Given a job never downloaded, When computing the countdown, Then it runs from readyAt", () => {
    expect(archiveExpiresAt(job({ readyAt: daysAgo(2) }), 5)).toEqual(
      new Date(daysAgo(2).getTime() + 5 * DAY_MS)
    );
  });

  it("Given a recent download over an old readyAt, When computing the countdown, Then lastDownloadedAt wins", () => {
    expect(archiveExpiresAt(job({ readyAt: daysAgo(30), lastDownloadedAt: daysAgo(1) }), 5)).toEqual(
      new Date(daysAgo(1).getTime() + 5 * DAY_MS)
    );
  });

  it("Given ttlDays = 0, When computing the countdown, Then there is none (archives are permanent)", () => {
    expect(archiveExpiresAt(job({ readyAt: daysAgo(1) }), 0)).toBeNull();
  });

  it("Given a job that is not READY, When computing the countdown, Then there is none (no bytes to reclaim)", () => {
    for (const status of ["DEBOUNCING", "QUEUED", "BUILDING", "FAILED", "CANCELLED", "EXPIRED"] as const) {
      expect(archiveExpiresAt(job({ status, readyAt: daysAgo(1) }), 5)).toBeNull();
    }
  });

  it("Given a READY job with no idle clock at all, When computing the countdown, Then there is none", () => {
    expect(archiveExpiresAt(job(), 5)).toBeNull();
  });

  it("Given any job, When both are asked, Then isExpired agrees with the countdown exactly", () => {
    const cases: ExpiryCandidate[] = [
      job({ lastDownloadedAt: daysAgo(6) }),
      job({ lastDownloadedAt: daysAgo(4) }),
      job({ readyAt: daysAgo(5) }),
      job({ readyAt: daysAgo(5, -1) }),
      job({ status: "EXPIRED", readyAt: daysAgo(9) }),
      job(),
    ];
    for (const c of cases) {
      const expiresAt = archiveExpiresAt(c, 5);
      expect(isExpired(c, NOW, 5)).toBe(expiresAt !== null && NOW.getTime() > expiresAt.getTime());
    }
  });
});
