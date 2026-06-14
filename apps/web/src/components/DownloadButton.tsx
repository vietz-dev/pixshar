"use client";

import { useEffect, useState } from "react";

type DownloadStatus = "NONE" | "DEBOUNCING" | "BUILDING" | "READY" | "FAILED";

interface DownloadState {
  status: DownloadStatus;
  url?: string;
  sizeBytes?: number;
  photoCount?: number;
  processedPhotos?: number;
  uploadProgress?: number;
  message?: string;
  debounceUntil?: string;
}

export default function DownloadButton({ slug }: { slug: string }) {
  const [state, setState] = useState<DownloadState | null>(null);
  const [polling, setPolling] = useState(true);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;

    const poll = async () => {
      try {
        const res = await fetch(`/api/gallery/${slug}/download`, { credentials: "include" });
        const data = await res.json();
        setState(data);
        if (data.status === "READY" || data.status === "FAILED") {
          setPolling(false);
          clearInterval(interval);
        }
      } catch {
        setPolling(false);
        clearInterval(interval);
      }
    };

    poll();
    if (polling) {
      interval = setInterval(poll, 5000);
    }
    return () => clearInterval(interval);
  }, [slug, polling]);

  if (!state) {
    return (
      <button
        disabled
        style={{
          height: 38,
          padding: "0 14px",
          borderRadius: 8,
          border: "1px solid #e4e4e7",
          background: "#fff",
          color: "#a1a1aa",
          fontSize: 13.5,
          fontWeight: 500,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          cursor: "not-allowed",
          opacity: 0.7,
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Download all
      </button>
    );
  }

  if (state.status === "READY" && state.url) {
    const sizeLabel = state.sizeBytes
      ? ` (${formatBytes(state.sizeBytes)})`
      : "";
    return (
      <a
        href={state.url}
        download
        style={{
          height: 38,
          padding: "0 14px",
          borderRadius: 8,
          border: "1px solid #e4e4e7",
          background: "#fff",
          color: "#18181b",
          fontSize: 13.5,
          fontWeight: 500,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          textDecoration: "none",
          transition: "background .15s",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "#f4f4f5"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Download all{sizeLabel}
      </a>
    );
  }

  if (state.status === "BUILDING" && state.photoCount && state.photoCount > 0) {
    const isUploading = state.processedPhotos === -1;
    const pct = isUploading ? (state.uploadProgress ?? 0) : Math.round((state.processedPhotos ?? 0) / state.photoCount * 100);
    return (
      <button
        disabled
        style={{
          height: 38,
          padding: "0 14px",
          borderRadius: 8,
          border: "1px solid #e4e4e7",
          background: "#fff",
          color: "#71717a",
          fontSize: 13.5,
          fontWeight: 500,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          cursor: "default",
          opacity: 0.9,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div style={{
          position: "absolute",
          inset: 0,
          width: `${pct}%`,
          background: "rgba(37,99,235,.12)",
          transition: "width .5s ease",
        }} />
        <span style={{ position: "relative", zIndex: 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "pxSpin 1s linear infinite" }}>
            <path d="M21 12a9 9 0 1 1-6.2-8.5"></path>
          </svg>
          {isUploading ? `Uploading to S3… ${pct}%` : `Building archive… ${pct}%`}
        </span>
      </button>
    );
  }

  const label = labelFor(state.status);
  const isDisabled = state.status === "FAILED";

  return (
    <button
      disabled={isDisabled}
      style={{
        height: 38,
        padding: "0 14px",
        borderRadius: 8,
        border: "1px solid #e4e4e7",
        background: state.status === "FAILED" ? "#fef2f2" : "#fff",
        color: state.status === "FAILED" ? "#dc2626" : "#71717a",
        fontSize: 13.5,
        fontWeight: 500,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        transition: "background .15s",
        cursor: isDisabled ? "not-allowed" : "default",
        opacity: 0.8,
      }}
    >
      {state.status === "BUILDING" && (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "pxSpin 1s linear infinite" }}>
          <path d="M21 12a9 9 0 1 1-6.2-8.5"></path>
        </svg>
      )}
      {state.status !== "BUILDING" && (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
      )}
      {label}
    </button>
  );
}

function labelFor(status: DownloadStatus): string {
  switch (status) {
    case "NONE":
      return "Preparing download…";
    case "DEBOUNCING":
      return "Waiting for uploads to settle…";
    case "BUILDING":
      return "Building archive…";
    case "FAILED":
      return "Archive unavailable";
    default:
      return "Download all";
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
