"use client";

import { useEffect, useCallback, useState, useRef } from "react";

interface LightboxPhoto {
  id: string;
  url: string;
  photographerName: string | null;
  name?: string;
}

interface LightboxProps {
  photos: LightboxPhoto[];
  index: number;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  onDownload?: (photoId: string) => Promise<string>;
  onDelete?: (photoId: string) => void;
}

export default function Lightbox({ photos, index, onClose, onNext, onPrev, onDownload, onDelete }: LightboxProps) {
  const photo = photos[index];
  const counter = `${index + 1} / ${photos.length}`;
  const [downloading, setDownloading] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const swipeHandled = useRef(false);

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
    swipeHandled.current = false;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(delta) > 50) {
      swipeHandled.current = true;
      if (delta < 0) onNext();
      else onPrev();
    }
    touchStartX.current = null;
  }

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onNext();
      else if (e.key === "ArrowLeft") onPrev();
    },
    [onClose, onNext, onPrev]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  async function handleDownload() {
    if (!onDownload || !photo) return;
    setDownloading(true);
    try {
      const url = await onDownload(photo.id);
      // S3 presigned URL sends Content-Disposition: attachment;
      // opening in a new tab triggers a download without leaving the page.
      window.open(url, "_blank");
    } catch {
      // ignore
    } finally {
      setDownloading(false);
    }
  }

  if (!photo) return null;

  return (
    <div
      onClick={() => { if (!swipeHandled.current) onClose(); }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(9,9,11,.92)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "pxFade .22s ease both",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          position: "absolute",
          top: 22,
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 24px",
          color: "#e4e4e7",
        }}
      >
        <span style={{ fontSize: 13.5, fontFamily: "'Geist Mono', monospace", color: "#a1a1aa" }}>
          {counter}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {onDownload && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDownload(); }}
              disabled={downloading}
              style={{
                height: 38,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,.15)",
                background: "rgba(255,255,255,.1)",
                color: "#fff",
                fontSize: 13.5,
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
                transition: "background .15s",
                opacity: downloading ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,.2)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,.1)"; }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              {downloading ? "Loading…" : "Download"}
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(photo.id); }}
              style={{
                height: 38,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,.15)",
                background: "rgba(255,255,255,.1)",
                color: "#fff",
                fontSize: 13.5,
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
                transition: "background .15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,.2)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,.1)"; }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              </svg>
              Delete
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              width: 38,
              height: 38,
              borderRadius: "50%",
              border: "none",
              background: "rgba(255,255,255,.1)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "background .15s",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Prev */}
      <button
        onClick={(e) => { e.stopPropagation(); onPrev(); }}
        style={{
          position: "absolute",
          left: 18,
          width: 44,
          height: 44,
          borderRadius: "50%",
          border: "none",
          background: "rgba(255,255,255,.1)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          transition: "background .15s",
          zIndex: 2,
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>

      {/* Image */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "min(88vw, 1180px)",
          maxHeight: "80vh",
          borderRadius: 8,
          boxShadow: "0 30px 80px -20px rgba(0,0,0,.7)",
          animation: "pxLbIn .28s cubic-bezier(.2,.7,.3,1) both",
          position: "relative",
          overflow: "hidden",
          background: "#18181b",
        }}
      >
        {photo.url ? (
          <img
            src={photo.url}
            alt={photo.photographerName || "Photo"}
            style={{
              maxWidth: "min(88vw, 1180px)",
              maxHeight: "80vh",
              objectFit: "contain",
              display: "block",
            }}
          />
        ) : (
          <div style={{ maxWidth: "min(88vw, 1180px)", maxHeight: "80vh", minWidth: 400, minHeight: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#52525b" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
          </div>
        )}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: 16,
            background: "linear-gradient(0deg,rgba(0,0,0,.4),transparent)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              background: "rgba(255,255,255,.25)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 600,
              color: "#fff",
            }}
          >
            {(photo.photographerName || "?").charAt(0)}
          </div>
          <span style={{ fontSize: 13, color: "rgba(255,255,255,.92)" }}>
            {photo.photographerName || "Anonymous"}
          </span>
        </div>
      </div>

      {/* Next */}
      <button
        onClick={(e) => { e.stopPropagation(); onNext(); }}
        style={{
          position: "absolute",
          right: 18,
          width: 44,
          height: 44,
          borderRadius: "50%",
          border: "none",
          background: "rgba(255,255,255,.1)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          transition: "background .15s",
          zIndex: 2,
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </div>
  );
}
