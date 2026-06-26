"use client";

import { useEffect, useState } from "react";

interface AdminDownloadState {
  status: string;
  message: string;
  photoCount: number;
  processedPhotos: number;
  uploadProgress: number;
  totalPhotos: number;
  zipSizeBytes: number | null;
  debounceUntil: string | null;
  failureReason: string | null;
  updatedAt: string;
}

const STATUS_META: Record<string, { label: string; bg: string; color: string; dot: string }> = {
  NONE: { label: "None", bg: "#f4f4f5", color: "#71717a", dot: "#a1a1aa" },
  DEBOUNCING: { label: "Waiting", bg: "#fffbeb", color: "#d97706", dot: "#d97706" },
  QUEUED: { label: "Queued", bg: "#eff6ff", color: "#2563eb", dot: "#2563eb" },
  BUILDING: { label: "Building", bg: "#eff6ff", color: "#2563eb", dot: "#2563eb" },
  READY: { label: "Ready", bg: "#ecfdf5", color: "#16a34a", dot: "#16a34a" },
  FAILED: { label: "Failed", bg: "#fef2f2", color: "#dc2626", dot: "#dc2626" },
  CANCELLED: { label: "Cancelled", bg: "#fef2f2", color: "#dc2626", dot: "#dc2626" },
};

export default function DownloadPanel({ eventId, slug }: { eventId: string; slug: string }) {
  const [state, setState] = useState<AdminDownloadState | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/events/${eventId}/download/status/stream`, { withCredentials: true });
    es.addEventListener("download-status", (e) => {
      setState(JSON.parse(e.data));
      setLoading(false);
    });
    es.onerror = () => {
      setLoading(false);
      es.close();
    };
    return () => es.close();
  }, [eventId]);

  async function handleBuild() {
    setActionLoading("build");
    try {
      await fetch(`/api/events/${eventId}/download/build`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCancel() {
    if (!confirm("Cancel the current archive build?")) return;
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
        <div style={{ fontSize: 13, color: "#a1a1aa" }}>Loading archive status…</div>
      </div>
    );
  }

  if (!state) return null;

  const meta = STATUS_META[state.status] || STATUS_META.NONE;
  const isBuilding = state.status === "BUILDING" || state.status === "QUEUED";
  const isTerminal = state.status === "READY" || state.status === "FAILED" || state.status === "CANCELLED" || state.status === "NONE";
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
          {isBuilding && (
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
              {actionLoading === "cancel" ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {isTerminal && (
            <button
              onClick={handleBuild}
              disabled={actionLoading === "build"}
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
                opacity: actionLoading === "build" ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f4f4f5"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {actionLoading === "build" ? "Starting…" : "Rebuild archive"}
            </button>
          )}
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: isZipping || isUploading ? 12 : 0 }}>
        <div>
          <div style={{ fontSize: 11.5, color: "#a1a1aa", marginBottom: 3 }}>Processed photos</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#18181b" }}>
            {state.processedPhotos} / {state.totalPhotos}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: "#a1a1aa", marginBottom: 3 }}>Archive size</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#18181b" }}>
            {state.zipSizeBytes ? formatBytes(state.zipSizeBytes) : "—"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: "#a1a1aa", marginBottom: 3 }}>Last updated</div>
          <div style={{ fontSize: 14, fontWeight: 500, color: "#18181b" }}>
            {state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : "—"}
          </div>
        </div>
        {state.debounceUntil && (
          <div>
            <div style={{ fontSize: 11.5, color: "#a1a1aa", marginBottom: 3 }}>Settles at</div>
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
            <span style={{ fontSize: 12.5, fontWeight: 500, color: "#52525b" }}>Zipping photos</span>
            <span style={{ fontSize: 12.5, color: "#71717a" }}>{zipPct}%</span>
          </div>
          <div style={{ height: 7, borderRadius: 999, background: "#f4f4f5", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${zipPct}%`, background: "#2563eb", borderRadius: 999, transition: "width .6s ease" }} />
          </div>
          <div style={{ fontSize: 12, color: "#a1a1aa", marginTop: 5 }}>
            {state.processedPhotos} of {state.photoCount} photos zipped
          </div>
        </div>
      )}

      {/* Uploading progress bar */}
      {isUploading && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: "#52525b" }}>Uploading to S3</span>
            <span style={{ fontSize: 12.5, color: "#71717a" }}>{uploadPct}%</span>
          </div>
          <div style={{ height: 7, borderRadius: 999, background: "#f4f4f5", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${uploadPct}%`, background: "#2563eb", borderRadius: 999, transition: "width .6s ease" }} />
          </div>
          <div style={{ fontSize: 12, color: "#a1a1aa", marginTop: 5 }}>
            {state.photoCount} photos zipped — uploading archive to S3
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
