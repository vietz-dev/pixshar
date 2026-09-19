/**
 * Unit tests for the pure multi-part archive planner (no live stack needed).
 */
import { describe, it, expect } from "vitest";
import {
  planArchiveParts,
  zipEntryBytes,
  ZIP_ENTRY_OVERHEAD_BYTES,
} from "../../apps/api/src/services/archivePlanner.js";

const MiB = 1024 * 1024;

const entry = (id: string, sizeBytes: number) => ({
  item: id,
  entryBytes: zipEntryBytes(sizeBytes, 40),
});

describe("planArchiveParts", () => {
  it("Given no photos, When planning, Then it returns no parts", () => {
    expect(planArchiveParts([], 2048 * MiB)).toEqual([]);
  });

  it("Given photos fitting one part, When planning, Then it returns a single part in order", () => {
    const parts = planArchiveParts(
      [entry("a", 5 * MiB), entry("b", 5 * MiB), entry("c", 5 * MiB)],
      2048 * MiB,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].items).toEqual(["a", "b", "c"]);
  });

  it("Given photos exceeding the limit, When planning, Then it rolls to new parts below the cap", () => {
    // 100 MiB limit → effective max is 90 MiB (10% margin) → 2×40 MiB per part
    const parts = planArchiveParts(
      [
        entry("a", 40 * MiB),
        entry("b", 40 * MiB),
        entry("c", 40 * MiB),
        entry("d", 40 * MiB),
        entry("e", 40 * MiB),
      ],
      100 * MiB,
    );
    expect(parts.map((p) => p.items)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    for (const part of parts) {
      expect(part.estimatedBytes).toBeLessThanOrEqual(100 * MiB);
    }
  });

  it("Given a single photo larger than the limit, When planning, Then it gets its own oversized part", () => {
    const parts = planArchiveParts(
      [entry("small", 10 * MiB), entry("huge", 300 * MiB), entry("small2", 10 * MiB)],
      100 * MiB,
    );
    expect(parts.map((p) => p.items)).toEqual([["small"], ["huge"], ["small2"]]);
  });

  it("Given the 2 GiB default limit, When photos sum to ~10 GB, Then every part stays under 2 GiB", () => {
    const limit = 2147483648;
    const photos = Array.from({ length: 2000 }, (_, i) => entry(`p${i}`, 5 * MiB)); // ~10 GB
    const parts = planArchiveParts(photos, limit);
    expect(parts.length).toBeGreaterThanOrEqual(5);
    for (const part of parts) {
      expect(part.estimatedBytes).toBeLessThanOrEqual(limit);
    }
    // No photo lost or duplicated
    expect(parts.flatMap((p) => p.items)).toHaveLength(2000);
  });

  it("zipEntryBytes over-estimates the raw file size", () => {
    expect(zipEntryBytes(1000, 20)).toBe(1000 + ZIP_ENTRY_OVERHEAD_BYTES + 40);
  });
});
