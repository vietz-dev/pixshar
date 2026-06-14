"use client";

import { useEffect } from "react";

interface AlertDialogProps {
  open: boolean;
  title: string;
  description: string;
  cancelLabel?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function AlertDialog({
  open,
  title,
  description,
  cancelLabel = "Cancel",
  confirmLabel = "Confirm",
  destructive = false,
  onCancel,
  onConfirm,
}: AlertDialogProps) {
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        animation: "pxFade .15s ease both",
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onCancel}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(9,9,11,.5)",
          backdropFilter: "blur(3px)",
        }}
      />

      {/* Dialog */}
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 400,
          background: "#fff",
          borderRadius: 14,
          border: "1px solid #e4e4e7",
          boxShadow: "0 20px 50px -12px rgba(0,0,0,.35)",
          padding: "24px 24px 20px",
          animation: "pxRise .22s ease both",
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-.01em", marginBottom: 8, color: "#18181b" }}>
          {title}
        </div>
        <div style={{ fontSize: 14, color: "#71717a", lineHeight: 1.5, marginBottom: 22 }}>
          {description}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            onClick={onCancel}
            style={{
              height: 36,
              padding: "0 14px",
              borderRadius: 8,
              border: "1px solid #e4e4e7",
              background: "#fff",
              color: "#18181b",
              fontSize: 13.5,
              fontWeight: 500,
              cursor: "pointer",
              transition: "background .15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#f4f4f5"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              height: 36,
              padding: "0 14px",
              borderRadius: 8,
              border: "none",
              background: destructive ? "#dc2626" : "#2563eb",
              color: "#fff",
              fontSize: 13.5,
              fontWeight: 500,
              cursor: "pointer",
              transition: "background .15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = destructive ? "#b91c1c" : "#1d4ed8";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = destructive ? "#dc2626" : "#2563eb";
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
