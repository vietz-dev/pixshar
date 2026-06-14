"use client";

import { useEffect, useCallback } from "react";

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
}

export default function Lightbox({ photos, index, onClose, onNext, onPrev }: LightboxProps) {
  const photo = photos[index];
  const counter = `${index + 1} / ${photos.length}`;

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

  if (!photo) return null;

  return (
    <div
      onClick={onClose}
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
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
