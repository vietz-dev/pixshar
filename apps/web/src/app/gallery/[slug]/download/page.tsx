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

interface DownloadPayload {
  status: string;
  parts?: ArchivePart[];
  partCount?: number;
  totalSizeBytes?: number;
  photoCount?: number;
  building?: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Keyed on the part's membership signature so a part that was rebuilt with a
// different photo set (e.g. after a deletion) correctly resets to "not
// downloaded", while a pure byte-rebuild keeps the guest's green tick.
function localStorageKey(slug: string, partIndex: number, sig: string): string {
  return `pixshar_dl_${slug}_part_${partIndex}_${sig}`;
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
  const [downloaded, setDownloaded] = useState<Record<number, boolean>>({});
  const initialLoaded = useRef(false);

  // Load per-part download state from localStorage (persists across tab close)
  const loadDownloadedState = useCallback(
    (parts: ArchivePart[]) => {
      const state: Record<number, boolean> = {};
      for (const p of parts) {
        try {
          state[p.index] = localStorage.getItem(localStorageKey(slug, p.index, p.membershipSig ?? "")) === "1";
        } catch {
          state[p.index] = false;
        }
      }
      setDownloaded(state);
    },
    [slug]
  );

  const apply = useCallback(
    (data: DownloadPayload) => {
      setPayload(data);
      if (data.parts) loadDownloadedState(data.parts);
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

  const markDownloaded = (partIndex: number, sig: string) => {
    try {
      localStorage.setItem(localStorageKey(slug, partIndex, sig), "1");
    } catch {
      // localStorage blocked (private mode etc.) — ignore, tick just won't persist
    }
    setDownloaded((prev) => ({ ...prev, [partIndex]: true }));
  };

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

  const parts = payload.parts ?? [];
  if (parts.length === 0) {
    const msg = payload.status === "BUILDING" || payload.status === "QUEUED" || payload.status === "DEBOUNCING"
      ? t("building")
      : t("noArchive");
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, background: "var(--bg, #fafaf9)" }}>
        <p style={{ color: "var(--text-muted, #71717a)", marginBottom: 16 }}>{msg}</p>
        <button onClick={() => router.push(`/gallery/${slug}/view`)} style={backBtnStyle}>
          {t("backToGallery")}
        </button>
      </div>
    );
  }

  const total = payload.totalSizeBytes ?? parts.reduce((s, p) => s + p.sizeBytes, 0);
  const n = parts.length;

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
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text, #18181b)", margin: "0 0 6px" }}>
          {t("title")}
        </h1>
        <p style={{ fontSize: 13.5, color: "var(--text-muted, #71717a)", margin: "0 0 8px" }}>
          {n === 1
            ? t("subtitleSingle", { size: formatBytes(total) })
            : t("subtitle", { count: n, size: formatBytes(total) })}
        </p>
        {n > 1 && (
          <p style={{ fontSize: 13, color: "var(--text-muted, #71717a)", margin: "0 0 20px", lineHeight: 1.5 }}>
            {t("instruction")}
          </p>
        )}
        {n === 1 && <div style={{ marginBottom: 20 }} />}

        {/* "More parts coming" banner */}
        {payload.building && (
          <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12.5, color: "#2563eb", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "10px 12px", marginBottom: 20 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "pxSpin 1s linear infinite", flexShrink: 0 }}>
              <path d="M21 12a9 9 0 1 1-6.2-8.5" />
            </svg>
            {t("buildingBanner")}
          </div>
        )}

        {/* Part list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {parts.map((part) => {
            const done = !!downloaded[part.index];
            const sig = part.membershipSig ?? "";
            return (
              <a
                key={part.index}
                href={part.url ?? undefined}
                download={part.url ? true : undefined}
                onClick={() => part.url && markDownloaded(part.index, sig)}
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
      </div>
    </div>
  );
}

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
