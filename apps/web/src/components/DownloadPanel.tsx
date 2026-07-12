"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

type Quality = "DISPLAY" | "ORIGINAL";

interface AdminDownloadState {
  quality: Quality;
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
  lastDownloadedAt: string | null;
  readyAt: string | null;
  expiredAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
}

export default function DownloadPanel({ eventId, slug: _slug }: { eventId: string; slug: string }) {
  const t = useTranslations("download.panel");
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: "#18181b", margin: "0 0 12px" }}>
        {t("heading")}
      </h3>
      <VariantPanel
        eventId={eventId}
        quality="DISPLAY"
        label={t("variantKompakt")}
        hint={t("variantKompaktHint")}
      />
      <VariantPanel
        eventId={eventId}
        quality="ORIGINAL"
        label={t("variantOriginal")}
        hint={t("variantOriginalHint")}
      />
    </div>
  );
}

function VariantPanel({
  eventId,
  quality,
  label,
  hint,
}: {
  eventId: string;
  quality: Quality;
  label: string;
  hint: string;
}) {
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
    EXPIRED:   { label: t("statusExpired"),   bg: "#f4f4f5", color: "#71717a", dot: "#a1a1aa" },
  };

  useEffect(() => {
    const es = new EventSource(
      `/api/events/${eventId}/download/status/stream?quality=${quality}`,
      { withCredentials: true },
    );
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
  }, [eventId, quality]);

  async function handleBuildNow() {
    setActionLoading("buildNow");
    try {
      await fetch(`/api/events/${eventId}/download/build-now?quality=${quality}`, {
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
      await fetch(`/api/events/${eventId}/download/rebuild-all?quality=${quality}`, {
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
      await fetch(`/api/events/${eventId}/download/cancel?quality=${quality}`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setActionLoading(null);
    }
  }

  // Reclaims this variant's S3 objects right now (the endpoint Ticket 3
  // built); membership survives so the next build reproduces the same parts.
  async function handleRelease() {
    if (!confirm(t("releaseConfirm"))) return;
    setActionLoading("release");
    try {
      await fetch(`/api/events/${eventId}/download/release?quality=${quality}`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setActionLoading(null);
    }
  }

  const titleBlock = (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#18181b" }}>{label}</div>
      <div style={{ fontSize: 12, color: "#a1a1aa", marginTop: 2 }}>{hint}</div>
    </div>
  );

  if (loading) {
    return (
      <div
        data-testid={`download-panel-${quality}`}
        style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 12, padding: 16, marginBottom: 12 }}
      >
        {titleBlock}
        <div style={{ fontSize: 13, color: "#a1a1aa" }}>{t("loadingStatus")}</div>
      </div>
    );
  }

  if (!state) {
    return (
      <div
        data-testid={`download-panel-${quality}`}
        style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 12, padding: 16, marginBottom: 12 }}
      >
        {titleBlock}
      </div>
    );
  }

  const meta = STATUS_META[state.status] || STATUS_META.NONE;
  const isBuilding = state.status === "BUILDING" || state.status === "QUEUED";
  const canCancel = isBuilding || state.status === "DEBOUNCING";
  // Pre-warm (PIXSHAR-8): "Jetzt bauen" also works from the empty (NONE) and
  // expired (EXPIRED) state, not only to skip an already-running debounce —
  // that's the whole point of letting the admin warm a variant before
  // sharing the link.
  const canBuildNow = state.status === "DEBOUNCING" || state.status === "NONE" || state.status === "EXPIRED";
  // "Rebuild all" regenerates every existing part from its stored membership.
  const canRebuildAll = state.status === "READY" || state.status === "FAILED" || state.status === "CANCELLED";
  // "Archiv freigeben" only has bytes to reclaim while READY.
  const canRelease = state.status === "READY";
  const isUploading = state.status === "BUILDING" && state.processedPhotos === -1;
  const isZipping = state.status === "BUILDING" && state.processedPhotos >= 0;
  const zipPct = state.photoCount > 0 ? Math.round((state.processedPhotos / state.photoCount) * 100) : 0;
  const uploadPct = state.uploadProgress;

  // The remaining-lifetime line: "läuft in 3 Tagen ab, wenn niemand lädt" for
  // a READY archive with a countdown, "läuft nie ab" when TTL is disabled
  // (expiresAt null but the job is READY), and a plain expiry note once the
  // bytes are gone — the membership (and a rebuild) is still one click away.
  let expiryLine: string | null = null;
  if (state.status === "READY") {
    expiryLine = state.expiresAt
      ? t("expiresInDays", { days: Math.max(0, Math.ceil((new Date(state.expiresAt).getTime() - Date.now()) / 86_400_000)) })
      : t("expiresNever");
  } else if (state.status === "EXPIRED") {
    expiryLine = t("expiredHint");
  }

  return (
    <div
      data-testid={`download-panel-${quality}`}
      style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 12, padding: "16px 18px", marginBottom: 12 }}
    >
      {titleBlock}
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
          <span style={{ fontSize: 13, color: "#71717a" }}>
            {state.message}
            {expiryLine ? ` · ${expiryLine}` : ""}
          </span>
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
          {canRelease && (
            <button
              onClick={handleRelease}
              disabled={actionLoading === "release"}
              style={{
                height: 32,
                padding: "0 12px",
                borderRadius: 7,
                border: "1px solid #e4e4e7",
                background: "#fff",
                color: "#52525b",
                fontSize: 12.5,
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                cursor: "pointer",
                transition: "background .15s",
                opacity: actionLoading === "release" ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f4f4f5"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
              </svg>
              {actionLoading === "release" ? t("releasingButton") : t("releaseButton")}
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
