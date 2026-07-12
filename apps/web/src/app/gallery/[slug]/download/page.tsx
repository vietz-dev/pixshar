"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface ArchivePart {
  index: number;
  url: string | null;
  sizeBytes: number;
  photoCount?: number;
  membershipSig?: string;
  rebuilding?: boolean;
}

interface VariantPayload {
  status: string;
  parts: ArchivePart[];
  partCount: number;
  totalSizeBytes: number;
  photoCount: number;
  building: boolean;
  message?: string;
}

type Quality = "DISPLAY" | "ORIGINAL";

interface DownloadPayload {
  defaultQuality: "DISPLAY";
  // back-compat: DISPLAY variant fields spread at top level
  status: string;
  parts?: ArchivePart[];
  partCount?: number;
  totalSizeBytes?: number;
  photoCount?: number;
  building?: boolean;
  variants: { DISPLAY: VariantPayload; ORIGINAL: VariantPayload };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Keyed on quality + the part's membership signature so:
//  - DISPLAY part-1 and ORIGINAL part-1 never collide, and
//  - a part rebuilt with a different photo set (e.g. after a deletion) correctly
//    resets to "not downloaded", while a pure byte-rebuild keeps the green tick.
function localStorageKey(slug: string, quality: Quality, partIndex: number, sig: string): string {
  return `pixshar_dl_${slug}_${quality}_part_${partIndex}_${sig}`;
}

function CheckIcon({ done }: { done: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        borderRadius: "50%",
        border: done ? "none" : "2px solid #d4d4d8",
        background: done ? "#22c55e" : "transparent",
        flexShrink: 0,
        transition: "all .2s",
      }}
    >
      {done && (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

export default function GalleryDownloadPage() {
  const t = useTranslations("gallery.downloadPage");
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [payload, setPayload] = useState<DownloadPayload | null>(null);
  const [error, setError] = useState("");
  // Which variant tab is active. Always lands on DISPLAY (Kompakt); only an
  // explicit user click ever changes this — SSE re-applies never touch it.
  const [quality, setQuality] = useState<Quality>("DISPLAY");
  // Per-variant per-part downloaded ticks: downloaded[quality][partIndex].
  const [downloaded, setDownloaded] = useState<Record<Quality, Record<number, boolean>>>({
    DISPLAY: {},
    ORIGINAL: {},
  });
  const initialLoaded = useRef(false);

  // Load per-part download state from localStorage for both variants.
  const loadDownloadedState = useCallback(
    (data: DownloadPayload) => {
      const next: Record<Quality, Record<number, boolean>> = { DISPLAY: {}, ORIGINAL: {} };
      for (const q of ["DISPLAY", "ORIGINAL"] as Quality[]) {
        for (const p of data.variants[q]?.parts ?? []) {
          try {
            next[q][p.index] =
              localStorage.getItem(localStorageKey(slug, q, p.index, p.membershipSig ?? "")) === "1";
          } catch {
            next[q][p.index] = false;
          }
        }
      }
      setDownloaded(next);
    },
    [slug]
  );

  const apply = useCallback(
    (data: DownloadPayload) => {
      setPayload(data);
      loadDownloadedState(data);
    },
    [loadDownloadedState]
  );

  // Initial fetch (handles auth redirect + first paint).
  useEffect(() => {
    fetch(`/api/gallery/${slug}/download`, { credentials: "include" })
      .then(async (res) => {
        if (res.status === 401 || res.status === 403) {
          router.replace(`/gallery/${slug}`);
          return;
        }
        if (!res.ok) throw new Error(await res.text());
        const data: DownloadPayload = await res.json();
        initialLoaded.current = true;
        apply(data);
      })
      .catch(() => setError(t("loadFailed")));
  }, [slug, router, t, apply]);

  // Live updates: new parts appear + rebuilt parts flip status without a reload.
  // The stream emits the full both-variants payload; we re-apply it and the
  // selected tab is preserved because `quality` is independent state.
  useEffect(() => {
    const es = new EventSource(`/api/gallery/${slug}/download/stream`, { withCredentials: true });
    es.addEventListener("download-status", (e) => {
      try {
        apply(JSON.parse((e as MessageEvent).data));
      } catch {
        // ignore malformed frame
      }
    });
    es.onerror = () => {};
    return () => es.close();
  }, [slug, apply]);

  const markDownloaded = (q: Quality, partIndex: number, sig: string) => {
    try {
      localStorage.setItem(localStorageKey(slug, q, partIndex, sig), "1");
    } catch {
      // localStorage blocked (private mode etc.) — ignore, tick just won't persist
    }
    setDownloaded((prev) => ({ ...prev, [q]: { ...prev[q], [partIndex]: true } }));
  };

  // Per-variant "request in flight" — disables the button for the tab that was
  // clicked without touching the other tab's own state.
  const [requesting, setRequesting] = useState<Record<Quality, boolean>>({
    DISPLAY: false,
    ORIGINAL: false,
  });

  // Ask the API to build (or repair) exactly the SELECTED variant — never both.
  // Idempotent server-side: NONE / EXPIRED / FAILED queue a build; a READY
  // variant with EXPIRED parts (the post-deletion partial case) queues a
  // targeted rebuild too; anything already building is a no-op. We merge the
  // response's status into just that variant so its tab flips to "building"
  // immediately, without waiting for the next SSE tick — the untouched
  // variant's own state is left completely alone.
  const requestArchive = useCallback(
    async (q: Quality) => {
      setRequesting((prev) => ({ ...prev, [q]: true }));
      try {
        const res = await fetch(`/api/gallery/${slug}/download/request?quality=${q}`, {
          method: "POST",
          credentials: "include",
        });
        if (res.ok) {
          const data = (await res.json()) as { status: string; queued: boolean };
          setPayload((prev) => {
            if (!prev) return prev;
            const variant: VariantPayload = {
              ...prev.variants[q],
              status: data.status,
              building: data.queued || prev.variants[q].building,
            };
            const variants = { ...prev.variants, [q]: variant };
            return prev.defaultQuality === q
              ? { ...prev, variants, status: variant.status, building: variant.building }
              : { ...prev, variants };
          });
        }
      } catch {
        // Best-effort optimistic update — the SSE stream reconciles the real
        // state regardless of whether this request succeeded.
      } finally {
        setRequesting((prev) => ({ ...prev, [q]: false }));
      }
    },
    [slug]
  );

  // ---- Render states -------------------------------------------------------

  if (error) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, background: "var(--bg, #fafaf9)" }}>
        <p style={{ color: "var(--danger, #ef4444)", marginBottom: 16 }}>{error}</p>
        <button onClick={() => router.push(`/gallery/${slug}/view`)} style={backBtnStyle}>
          {t("backToGallery")}
        </button>
      </div>
    );
  }

  if (!payload) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg, #fafaf9)" }}>
        <span style={{ color: "var(--text-muted, #71717a)", fontSize: 14 }}>…</span>
      </div>
    );
  }

  const displayVariant = payload.variants.DISPLAY;
  const originalVariant = payload.variants.ORIGINAL;
  const active = payload.variants[quality];

  const parts = active.parts ?? [];
  const total = active.totalSizeBytes ?? parts.reduce((s, p) => s + p.sizeBytes, 0);
  const n = parts.length;

  // A build is under way for the active variant: either the payload says so
  // (an active job status, or a STALE part being rebuilt), or we just clicked
  // "Archiv erstellen" and are waiting for the next SSE tick to confirm it.
  const isPending =
    active.building ||
    active.status === "BUILDING" ||
    active.status === "QUEUED" ||
    active.status === "DEBOUNCING";
  // No archive at all for this tab — never built, expired, or a failed build.
  // Needs an explicit "Archiv erstellen" action instead of a part list.
  const isAbsent = n === 0 && !isPending;
  // Post-deletion partial availability: some parts still hold bytes, others
  // don't (their object was reclaimed when a photo was deleted) — offer a
  // targeted rebuild without disturbing the parts that still work.
  const hasMissingParts = n > 0 && parts.some((p) => !p.url);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg, #fafaf9)", padding: "32px 16px" }}>
      <div style={{ maxWidth: 540, margin: "0 auto" }}>
        {/* Back link */}
        <button
          onClick={() => router.push(`/gallery/${slug}/view`)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted, #71717a)", fontSize: 13.5, display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 28, padding: 0 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {t("backToGallery")}
        </button>

        {/* Header */}
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text, #18181b)", margin: "0 0 16px" }}>
          {t("title")}
        </h1>

        {/* Variant toggle */}
        <div
          role="tablist"
          style={{
            display: "flex",
            gap: 6,
            padding: 4,
            borderRadius: 12,
            background: "var(--surface, #fff)",
            border: "1px solid var(--border, #e4e4e7)",
            marginBottom: 18,
          }}
        >
          <VariantTab
            testId="variant-toggle-kompakt"
            active={quality === "DISPLAY"}
            onClick={() => setQuality("DISPLAY")}
            label={t("tabKompakt")}
            hint={t("tabKompaktHint")}
            building={displayVariant.building}
          />
          <VariantTab
            testId="variant-toggle-original"
            active={quality === "ORIGINAL"}
            onClick={() => setQuality("ORIGINAL")}
            label={t("tabOriginal")}
            hint={t("tabOriginalHint")}
            building={originalVariant.building}
          />
        </div>

        {/* Active-variant summary */}
        <p style={{ fontSize: 13.5, color: "var(--text-muted, #71717a)", margin: "0 0 8px" }}>
          {active.partCount === 1
            ? t("variantSummarySingle", { size: formatBytes(active.totalSizeBytes) })
            : t("variantSummary", { count: active.partCount, size: formatBytes(active.totalSizeBytes) })}
        </p>
        {n > 1 && (
          <p style={{ fontSize: 13, color: "var(--text-muted, #71717a)", margin: "0 0 20px", lineHeight: 1.5 }}>
            {t("instruction")}
          </p>
        )}
        {n <= 1 && <div style={{ marginBottom: 20 }} />}

        {/* Build-in-progress banner for the ACTIVE variant */}
        {active.building && (
          <div
            data-testid="building-banner"
            style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5, color: "#2563eb", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "10px 12px", marginBottom: 20 }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "pxSpin 1s linear infinite", flexShrink: 0 }}>
              <path d="M21 12a9 9 0 1 1-6.2-8.5" />
            </svg>
            {t("buildingBanner")}
          </div>
        )}

        {/* Building, but no committed part yet for this tab */}
        {n === 0 && isPending && (
          <p style={{ fontSize: 13.5, color: "var(--text-muted, #71717a)", margin: "0 0 20px" }}>
            {t("variantBuildingEmpty")}
          </p>
        )}

        {/* Absent (never built), expired, or failed — no part list, just the
            explanatory line and a button that acts on THIS tab only. */}
        {isAbsent && (
          <div style={{ marginBottom: 20 }}>
            {active.status === "EXPIRED" && (
              <div
                data-testid="expired-banner"
                style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "10px 12px", marginBottom: 14 }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4M12 16h.01" />
                </svg>
                {t("expiredBanner")}
              </div>
            )}
            <p style={{ fontSize: 13.5, color: "var(--text-muted, #71717a)", margin: "0 0 14px" }}>
              {active.status === "EXPIRED" ? t("variantExpired") : t("variantNoArchive")}
            </p>
            <button
              data-testid="create-archive-button"
              onClick={() => requestArchive(quality)}
              disabled={requesting[quality]}
              style={createButtonStyle}
            >
              {requesting[quality] ? t("creatingButton") : t("createButton")}
            </button>
          </div>
        )}

        {/* Post-deletion partial availability: some parts unavailable, the rest
            still clickable — offer a targeted rebuild of just this tab. */}
        {hasMissingParts && !isPending && (
          <div
            data-testid="repair-banner"
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", fontSize: 12.5, color: "var(--text-muted, #71717a)", background: "var(--surface, #fff)", border: "1px solid var(--border, #e4e4e7)", borderRadius: 10, padding: "10px 12px", marginBottom: 16 }}
          >
            <span>{t("partsUnavailableHint")}</span>
            <button
              data-testid="repair-button"
              onClick={() => requestArchive(quality)}
              disabled={requesting[quality]}
              style={{ ...createButtonStyle, height: 32, padding: "0 12px", fontSize: 12.5 }}
            >
              {requesting[quality] ? t("creatingButton") : t("repairButton")}
            </button>
          </div>
        )}

        {/* Part list (active variant only — galleries can have 20+ parts).
            Rendered as soon as ANY part exists, even while later parts are
            still being committed — the builder finishes parts one at a time
            and each becomes clickable the moment it lands. */}
        {n > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {parts.map((part) => {
              const done = !!downloaded[quality]?.[part.index];
              const sig = part.membershipSig ?? "";
              const unavailable = !part.url && !part.rebuilding;
              return (
                <a
                  key={part.index}
                  href={part.url ?? undefined}
                  download={part.url ? true : undefined}
                  onClick={() => part.url && markDownloaded(quality, part.index, sig)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "16px 18px",
                    borderRadius: 12,
                    border: `1px solid ${done ? "#bbf7d0" : "var(--border, #e4e4e7)"}`,
                    background: done ? "#f0fdf4" : "var(--surface, #fff)",
                    textDecoration: "none",
                    transition: "background .15s, border-color .15s",
                    cursor: part.url ? "pointer" : "default",
                    opacity: unavailable ? 0.55 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!done && part.url) e.currentTarget.style.background = "#f9f9f8";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = done ? "#f0fdf4" : "var(--surface, #fff)";
                  }}
                >
                  <CheckIcon done={done} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text, #18181b)", marginBottom: 2 }}>
                      {n === 1 ? t("title") : t("partLabel", { index: part.index, total: n })}
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--text-muted, #71717a)" }}>
                      {t("partSize", { size: formatBytes(part.sizeBytes) })}
                      {done && (
                        <span style={{ marginLeft: 8, color: "#16a34a", fontWeight: 500 }}>
                          · {t("downloaded")}
                        </span>
                      )}
                      {part.rebuilding && (
                        <span style={{ marginLeft: 8, color: "#d97706", fontWeight: 500 }}>
                          · {t("rebuilding")}
                        </span>
                      )}
                      {unavailable && (
                        <span style={{ marginLeft: 8, color: "#a1a1aa", fontWeight: 500 }}>
                          · {t("unavailable")}
                        </span>
                      )}
                    </div>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted, #a1a1aa)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function VariantTab({
  testId,
  active,
  onClick,
  label,
  hint,
  building,
}: {
  testId: string;
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  building: boolean;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      data-testid={testId}
      onClick={onClick}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        padding: "8px 10px",
        borderRadius: 9,
        border: "none",
        cursor: "pointer",
        background: active ? "var(--accent, #18181b)" : "transparent",
        color: active ? "#fff" : "var(--text, #18181b)",
        transition: "background .15s, color .15s",
      }}
    >
      <span style={{ fontSize: 13.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>
        {label}
        {building && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            style={{ animation: "pxSpin 1s linear infinite", flexShrink: 0, opacity: 0.85 }}
          >
            <path d="M21 12a9 9 0 1 1-6.2-8.5" />
          </svg>
        )}
      </span>
      <span style={{ fontSize: 11, opacity: active ? 0.8 : 0.6 }}>{hint}</span>
    </button>
  );
}

const createButtonStyle: React.CSSProperties = {
  height: 40,
  padding: "0 18px",
  borderRadius: 10,
  border: "none",
  background: "var(--accent, #18181b)",
  color: "#fff",
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
};

const backBtnStyle: React.CSSProperties = {
  height: 36,
  padding: "0 14px",
  borderRadius: 8,
  border: "1px solid var(--border, #e4e4e7)",
  background: "var(--surface, #fff)",
  color: "var(--text, #18181b)",
  fontSize: 13.5,
  fontWeight: 500,
  cursor: "pointer",
};
