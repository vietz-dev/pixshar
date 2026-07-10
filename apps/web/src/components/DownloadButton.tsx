"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type DownloadStatus = "NONE" | "DEBOUNCING" | "BUILDING" | "READY" | "FAILED";

interface ArchivePart {
  index: number;
  url: string | null;
  sizeBytes: number;
}

interface DownloadState {
  status: DownloadStatus;
  parts?: ArchivePart[];
  partCount?: number;
  totalSizeBytes?: number;
  photoCount?: number;
  processedPhotos?: number;
  uploadProgress?: number;
  message?: string;
  debounceUntil?: string;
  building?: boolean;
}

export default function DownloadButton({ slug }: { slug: string }) {
  const t = useTranslations("download.button");
  const tView = useTranslations("gallery.view");
  const router = useRouter();
  const [state, setState] = useState<DownloadState | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/gallery/${slug}/download/stream`, { withCredentials: true });
    es.addEventListener("download-status", (e) => {
      const data = JSON.parse(e.data);
      setState(data);
      // Keep the stream open while more parts are still being built so newly
      // appended parts appear; only close once fully settled or failed.
      if ((data.status === "READY" && !data.building) || data.status === "FAILED") {
        es.close();
      }
    });
    // Auto-reconnect on transient drops; we still close on terminal status above.
    es.onerror = () => {};
    return () => es.close();
  }, [slug]);

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
        {t("downloadAll")}
      </button>
    );
  }

  // Route to the download page whenever an archive is available — even for a
  // single part. Every event now offers two variants (Kompakt / Original), so
  // the guest must reach the toggle page to choose. A direct <a download> here
  // would immediately grab one variant and rob the guest of that choice.
  if (state.status === "READY" && state.parts && state.parts.length >= 1) {
    const total = state.totalSizeBytes ?? state.parts.reduce((s, p) => s + p.sizeBytes, 0);
    const label =
      state.parts.length > 1
        ? t("multiPartTitle", { count: state.parts.length, size: formatBytes(total) })
        : total
          ? t("downloadAllSize", { size: formatBytes(total) })
          : t("downloadAll");
    return (
      <button
        onClick={() => router.push(`/gallery/${slug}/download`)}
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
          cursor: "pointer",
          transition: "background .15s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "#f4f4f5"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        {label}
      </button>
    );
  }

  if (state.status === "BUILDING" && state.photoCount && state.photoCount > 0) {
    const isUploading = state.processedPhotos === -1;
    const pct = isUploading ? (state.uploadProgress ?? 0) : Math.round((state.processedPhotos ?? 0) / state.photoCount * 100);
    const label = isUploading ? t("uploadingS3", { pct }) : t("buildingPct", { pct });
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
          {label}
        </span>
      </button>
    );
  }

  const label = labelFor(t, state.status);
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

function labelFor(t: ReturnType<typeof useTranslations<"download.button">>, status: DownloadStatus): string {
  switch (status) {
    case "NONE": return t("preparing");
    case "DEBOUNCING": return t("waitingUploads");
    case "BUILDING": return t("building");
    case "FAILED": return t("unavailable");
    default: return t("downloadAll");
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
