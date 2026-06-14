"use client";

import { useRef, useState } from "react";

interface UploadModalProps {
  galleryName: string;
  onClose: () => void;
  onSubmit: (name: string, files: FileList) => void;
}

export default function UploadModal({ galleryName, onClose, onSubmit }: UploadModalProps) {
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileList | null>(null);

  const nameOk = name.trim().length > 0;
  const hasFiles = files !== null && files.length > 0;

  function handleSubmit() {
    if (!nameOk || !hasFiles) return;
    onSubmit(name.trim(), files);
  }

  const submitLabel = hasFiles
    ? `Upload ${files.length} photo${files.length === 1 ? "" : "s"}`
    : "Choose photos to upload";
  const submitBg = nameOk ? "#2563eb" : "#a8c1f0";
  const submitCursor = nameOk ? "pointer" : "not-allowed";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 85,
        background: "rgba(9,9,11,.5)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        animation: "pxFade .2s ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 460,
          background: "#fff",
          borderRadius: 16,
          boxShadow: "0 30px 70px -20px rgba(0,0,0,.5)",
          overflow: "hidden",
          animation: "pxLbIn .26s cubic-bezier(.2,.7,.3,1) both",
        }}
      >
        <div style={{ padding: "20px 22px 0", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-.01em", margin: 0 }}>Share your photos</h2>
            <p style={{ fontSize: 13.5, color: "#71717a", margin: "5px 0 0" }}>
              Add your shots to <span style={{ fontWeight: 500, color: "#3f3f46" }}>{galleryName}</span>.
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              border: "none",
              background: "#f4f4f5",
              color: "#52525b",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "background .15s",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div style={{ padding: "18px 22px 22px" }}>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 7 }}>
            Your name <span style={{ color: "#dc2626" }}>*</span>
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="So we know whose photos these are"
            style={{
              height: 40,
              width: "100%",
              padding: "0 12px",
              border: "1px solid #e4e4e7",
              borderRadius: 8,
              fontSize: 14,
              background: "#fff",
              outline: "none",
              marginBottom: 16,
              transition: "border-color .15s, box-shadow .15s",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "#2563eb";
              e.currentTarget.style.boxShadow = "0 0 0 3px rgba(37,99,235,.16)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "#e4e4e7";
              e.currentTarget.style.boxShadow = "none";
            }}
          />

          <div
            onClick={() => fileRef.current?.click()}
            style={{
              border: "1.5px dashed #d4d4d8",
              borderRadius: 11,
              background: "#fafafa",
              padding: "24px 18px",
              textAlign: "center",
              cursor: "pointer",
              transition: "all .15s",
              marginBottom: 14,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "#2563eb";
              e.currentTarget.style.background = "#f8faff";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "#d4d4d8";
              e.currentTarget.style.background = "#fafafa";
            }}
          >
            <input
              type="file"
              multiple
              ref={fileRef}
              onChange={(e) => setFiles(e.target.files)}
              style={{ display: "none" }}
            />
            <div style={{ width: 40, height: 40, borderRadius: 10, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 11px" }}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17V3m0 0L7 8m5-5 5 5" />
                <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
              </svg>
            </div>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>Tap to choose photos</div>
            <div style={{ fontSize: 12, color: "#a1a1aa" }}>or drag them here</div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={!nameOk}
            style={{
              height: 42,
              width: "100%",
              borderRadius: 9,
              border: "none",
              background: submitBg,
              color: "#fff",
              fontSize: 14,
              fontWeight: 500,
              marginTop: 10,
              transition: "background .15s",
              cursor: submitCursor,
            }}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
