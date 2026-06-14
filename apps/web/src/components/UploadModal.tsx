"use client";

import { useRef, useState } from "react";
import UploadTray, { UploadItem, randomTint } from "./UploadTray";

interface UploadModalProps {
  galleryName: string;
  onClose: () => void;
  onUpload: (name: string, file: File) => Promise<void>;
}

export default function UploadModal({ galleryName, onClose, onUpload }: UploadModalProps) {
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const abortRef = useRef(false);

  const nameOk = name.trim().length > 0;
  const total = queue.length;
  const active = queue.some((q) => q.status === "queued" || q.status === "uploading");
  const allDone = total > 0 && !active && !queue.some((q) => q.status === "error");

  const submitLabel = submitted && allDone
    ? "Uploaded — thank you!"
    : total > 0
      ? `Upload ${total} photo${total === 1 ? "" : "s"}`
      : "Choose photos to upload";
  const submitBg = nameOk
    ? submitted && allDone
      ? "#16a34a"
      : "#2563eb"
    : "#a8c1f0";
  const submitCursor = nameOk ? "pointer" : "not-allowed";

  const fileMapRef = useRef<Map<string, File>>(new Map());

  function addFilesWithMap(fileList: FileList | null) {
    if (!fileList) return;
    const newItems: UploadItem[] = Array.from(fileList).map((f) => {
      const id = Math.random().toString(36).slice(2);
      fileMapRef.current.set(id, f);
      return {
        id,
        name: f.name,
        status: "queued" as const,
        progress: 0,
        tint: randomTint(),
      };
    });
    setQueue((prev) => [...prev, ...newItems]);
  }

  async function doUpload() {
    if (!nameOk || total === 0) return;
    abortRef.current = false;
    setSubmitted(true);

    const batchSize = 4;
    const items = queue.slice();
    let idx = 0;

    while (idx < items.length) {
      if (abortRef.current) break;
      const batch = items.slice(idx, idx + batchSize);
      const batchIds = new Set(batch.map((b) => b.id));

      setQueue((prev) =>
        prev.map((q) => (batchIds.has(q.id) ? { ...q, status: "uploading" as const, progress: 0 } : q))
      );

      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const file = fileMapRef.current.get(item.id);
          if (!file) throw new Error("File not found");
          try {
            await onUpload(name.trim(), file);
            setQueue((prev) =>
              prev.map((q) => (q.id === item.id ? { ...q, status: "done" as const, progress: 100 } : q))
            );
          } catch {
            setQueue((prev) =>
              prev.map((q) => (q.id === item.id ? { ...q, status: "error" as const, progress: 0 } : q))
            );
            throw new Error("Upload failed");
          }
        })
      );

      idx += batchSize;
    }
  }

  function handleCancel() {
    abortRef.current = true;
  }

  function handleClear() {
    setQueue([]);
    fileMapRef.current.clear();
    setSubmitted(false);
  }

  function handleRetry() {
    setQueue((prev) =>
      prev.map((q) => (q.status === "error" ? { ...q, status: "queued" as const, progress: 0 } : q))
    );
    setSubmitted(false);
    // Retry after state updates
    setTimeout(() => doUpload(), 0);
  }

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
            onMouseEnter={(e) => { e.currentTarget.style.background = "#e4e4e7"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "#f4f4f5"; }}
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
              onChange={(e) => addFilesWithMap(e.target.files)}
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

          {total > 0 && (
            <UploadTray
              queue={queue}
              showDetails={showDetails}
              onToggleDetails={() => setShowDetails((s) => !s)}
              onClear={handleClear}
              onCancel={handleCancel}
              onRetry={handleRetry}
              size="small"
            />
          )}

          <button
            onClick={doUpload}
            disabled={!nameOk || total === 0}
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
