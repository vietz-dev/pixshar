// Pure part-planning for multi-part gallery archives. No I/O — unit-testable.

// ZIP bookkeeping overhead per entry in store mode: local file header (30 B)
// + data descriptor (up to 24 B with zip64) + central directory entry (46 B),
// each plus the entry name, plus zip64 extra fields. 512 B + 2×name is a
// comfortable over-estimate.
export const ZIP_ENTRY_OVERHEAD_BYTES = 512;

// Reserve room below the configured cap (central directory + end records,
// estimate slack) so a part can't end up over the limit.
export const ZIP_PART_SAFETY_MARGIN_BYTES = 4 * 1024 * 1024;

export interface PlannedEntry<T> {
  item: T;
  entryBytes: number;
}

export interface PlannedPart<T> {
  items: T[];
  estimatedBytes: number;
}

export function zipEntryBytes(fileSizeBytes: number, entryNameLength: number): number {
  return fileSizeBytes + ZIP_ENTRY_OVERHEAD_BYTES + 2 * entryNameLength;
}

// Greedy fill in input order: start a new part when the next entry would push
// the current one past the effective limit. A single entry larger than the
// limit still gets its own (oversized) part — a file can't be split.
export function planArchiveParts<T>(
  entries: PlannedEntry<T>[],
  maxPartBytes: number,
): PlannedPart<T>[] {
  const safetyMargin = Math.min(ZIP_PART_SAFETY_MARGIN_BYTES, Math.floor(maxPartBytes * 0.1));
  const effectiveMax = maxPartBytes - safetyMargin;

  const parts: PlannedPart<T>[] = [];
  let current: PlannedPart<T> = { items: [], estimatedBytes: 0 };
  for (const { item, entryBytes } of entries) {
    if (current.items.length > 0 && current.estimatedBytes + entryBytes > effectiveMax) {
      parts.push(current);
      current = { items: [], estimatedBytes: 0 };
    }
    current.items.push(item);
    current.estimatedBytes += entryBytes;
  }
  if (current.items.length > 0) parts.push(current);
  return parts;
}
