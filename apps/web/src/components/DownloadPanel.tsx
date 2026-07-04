"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

interface AdminDownloadState {
  status: string;
  message: string;
  photoCount: number;
  processedPhotos: number;
  uploadProgress: number;
  totalPhotos: number;
  totalSizeBytes: number | null;
  partCount: number;
  debounceUntil: string | null;
  failureReason: string | null;
  updatedAt: string;
}

export default function DownloadPanel({ eventId, slug }: { eventId: string; slug: string }) {
  const t = useTranslations("download.panel");
  const [state, setState] = useState<AdminDownloadState | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const STATUS_META: Record<string, { label: string; bg: string; color: string; dot: string }> = {
    NONE:      { label: t("statusNone"),      bg: "#f4f4f5", color: "#71717a", dot: "#a1a1aa" },
    DEBOUNCING:{ label: t("statusWaiting"),   bg: "#fffbeb", color: "#d97706", dot: "#d97706" },
    QUEUED:    { label: t("statusQueued"),    bg: "#eff6ff", color: "#2563eb", dot: "#2563eb" },
    BUILDING:  { label: t("statusBuilding"),  bg: "#eff6ff", color: "#2563eb", dot: "#2563eb" },
    READY:     { label: t("statusReady"),     bg: "#ecfdf5", color: "#16a34a", dot: "#16a34a" },
    FAILED:    { label: t("statusFailed"),    bg: "#fef2f2", color: "#dc2626", dot: "#dc2626" },
    CANCELLED: { label: t("statusCancelled"), bg: "#fef2f2", color: "#dc2626", dot: "#dc2626" },
  };

  useEffect(() => {
    const es = new EventSource(`/api/events/${eventId}/download/status/stream`, { withCredentials: true });
    es.addEventListener("download-status", (e) => {
      setState(JSON.parse(e.data));
      setLoading(false);
    });
    // Don't close on error — let EventSource auto-reconnect after a transient
    // drop (the browser stops on its own for hard failures like 401/404).
    es.onerror = () => {
      setLoading(false);
    };
    return () => es.close();
  }, [eventId]);

  async function handleBuildNow() {
    setActionLoading("buildNow");
    try {
      await fetch(`/api/events/${eventId}/download/build-now`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRebuildAll() {
    setActionLoading("rebuildAll");
    try {
      await fetch(`/api/events/${eventId}/download/rebuild-all`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCancel() {
    if (!confirm(t("cancelConfirm"))) return;
    setActionLoading("cancel");
    try {
      await fetch(`/api/events/${eventId}/download/cancel`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <div style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: "#a1a1aa" }}>{t("loadingStatus")}</div>
      </div>
    );
  }

  if (!state) return null;

  const meta = STATUS_META[state.status] || STATUS_META.NONE;
  const isBuilding = state.status === "BUILDING" || state.status === "QUEUED";
  const canCancel = isBuilding || state.status === "DEBOUNCING";
  const canBuildNow = state.status === "DEBOUNCING";
  // "Rebuild all" regenerates every existing part from its stored membership.
  const canRebuildAll = state.status === "READY" || state.status === "FAILED" || state.status === "CANCELLED";
  const isUploading = state.status === "BUILDING" && state.processedPhotos === -1;
  const isZipping = state.status === "BUILDING" && state.processedPhotos >= 0;
  const zipPct = state.photoCount > 0 ? Math.round((state.processedPhotos / state.photoCount) * 100) : 0;
  const uploadPct = state.uploadProgress;

  return (
    <div style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 12, padding: "16px 18px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            height: 24,
            padding: "0 10px",
            borderRadius: 999,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            fontWeight: 500,
            background: meta.bg,
            color: meta.color,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.dot }} />
            {meta.label}
          </div>
          <span style={{ fontSize: 13, color: "#71717a" }}>{state.message}</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {canCancel && (
            <button
              onClick={handleCancel}
              disabled={actionLoading === "cancel"}
              style={{
                height: 32,
                padding: "0 12px",
                borderRadius: 7,
                border: "1px solid #fecaca",
                background: "#fff",
                color: "#dc2626",
                fontSize: 12.5,
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                cursor: "pointer",
                transition: "background .15s",
                opacity: actionLoading === "cancel" ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#fef2f2"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <circle cx="12" cy="12" r="10" />
                <path d="m15 9-6 6M9 9l6 6" />
              </svg>
              {actionLoading === "cancel" ? t("cancellingButton") : t("cancelButton")}
            </button>
          )}
          {canBuildNow && (
            <button
              onClick={handleBuildNow}
              disabled={actionLoading === "buildNow"}
              style={{
                height: 32,
                padding: "0 12px",
                borderRadius: 7,
                border: "1px solid #bfdbfe",
                background: "#fff",
                color: "#2563eb",
                fontSize: 12.5,
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                cursor: "pointer",
                transition: "background .15s",
                opacity: actionLoading === "buildNow" ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#eff6ff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              {actionLoading === "buildNow" ? t("buildingNowButton") : t("buildNowButton")}
            </button>
          )}
          {canRebuildAll && (
            <button
              onClick={handleRebuildAll}
              disabled={actionLoading === "rebuildAll"}
              style={{
                height: 32,
                padding: "0 12px",
                borderRadius: 7,
                border: "1px solid #e4e4e7",
                background: "#fff",
                color: "#18181b",
                fontSize: 12.5,
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                cursor: "pointer",
                transition: "background .15s",
                opacity: actionLoading === "rebuildAll" ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f4f4f5"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {actionLoading === "rebuildAll" ? t("rebuildingAllButton") : t("rebuildAllButton")}
            </button>
          )}
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: isZipping || isUploading ? 12 : 0 }}>
        <div>
          <div style={{ fontSize: 11.5, color: "#a1a1aa", marginBottom: 3 }}>{t("processedPhotos")}</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#18181b" }}>
            {state.processedPhotos} / {state.totalPhotos}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: "#a1a1aa", marginBottom: 3 }}>{t("archiveSize")}</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#18181b" }}>
            {state.totalSizeBytes ? formatBytes(state.totalSizeBytes) : "—"}
            {state.partCount > 1 && (
              <span style={{ fontSize: 11.5, fontWeight: 400, color: "#a1a1aa", marginLeft: 6 }}>
                {t("archiveParts", { count: state.partCount })}
              </span>
            )}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: "#a1a1aa", marginBottom: 3 }}>{t("lastUpdated")}</div>
          <div style={{ fontSize: 14, fontWeight: 500, color: "#18181b" }}>
            {state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : "—"}
          </div>
        </div>
        {state.debounceUntil && (
          <div>
            <div style={{ fontSize: 11.5, color: "#a1a1aa", marginBottom: 3 }}>{t("settlesAt")}</div>
            <div style={{ fontSize: 14, fontWeight: 500, color: "#18181b" }}>
              {new Date(state.debounceUntil).toLocaleTimeString()}
            </div>
          </div>
        )}
      </div>

      {/* Zipping progress bar */}
      {isZipping && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: "#52525b" }}>{t("zipping")}</span>
            <span style={{ fontSize: 12.5, color: "#71717a" }}>{zipPct}%</span>
          </div>
          <div style={{ height: 7, borderRadius: 999, background: "#f4f4f5", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${zipPct}%`, background: "#2563eb", borderRadius: 999, transition: "width .6s ease" }} />
          </div>
          <div style={{ fontSize: 12, color: "#a1a1aa", marginTop: 5 }}>
            {t("photosZipped", { processed: state.processedPhotos, total: state.photoCount })}
          </div>
        </div>
      )}

      {/* Uploading progress bar */}
      {isUploading && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: "#52525b" }}>{t("uploadingS3")}</span>
            <span style={{ fontSize: 12.5, color: "#71717a" }}>{uploadPct}%</span>
          </div>
          <div style={{ height: 7, borderRadius: 999, background: "#f4f4f5", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${uploadPct}%`, background: "#2563eb", borderRadius: 999, transition: "width .6s ease" }} />
          </div>
          <div style={{ fontSize: 12, color: "#a1a1aa", marginTop: 5 }}>
            {t("uploadingArchive", { total: state.photoCount })}
          </div>
        </div>
      )}

      {state.failureReason && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: "#dc2626", background: "#fef2f2", padding: "8px 10px", borderRadius: 7 }}>
          {state.failureReason}
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
