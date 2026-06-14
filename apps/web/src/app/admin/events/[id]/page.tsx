"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import PhotoGrid from "../../../../components/PhotoGrid";
import Lightbox from "../../../../components/Lightbox";

interface Photo {
  id: string;
  photographerName: string | null;
  originalKey: string;
  displayKey: string;
  thumbKey: string;
  thumbUrl: string;
  displayUrl: string;
  status: string;
  uploadedBy: string;
  createdAt: string;
}

interface EventDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  photos: Photo[];
}

interface UploadQueueItem {
  id: string;
  name: string;
  progress: number;
  tint: string;
}

const TINTS = ["#fde0c4", "#c9d4ea", "#f3d7d7", "#d2e3cf", "#e3dcee"];

function statusMeta(st: string) {
  return st === "READY"
    ? { statusLabel: "Ready", statusBg: "rgba(220,252,231,.92)", statusColor: "#16a34a" }
    : { statusLabel: "Processing", statusBg: "rgba(254,243,199,.92)", statusColor: "#d97706" };
}

export default function EventDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploadStatus, setUploadStatus] = useState({ pending: 0, processed: 0, failed: 0, total: 0 });
  const [uploading, setUploading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [lbIndex, setLbIndex] = useState(0);
  const [lbOpen, setLbOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchEvent = useCallback(() => {
    fetch(`/api/events/${id}`, { credentials: "include" })
      .then((res) => {
        if (res.status === 401) {
          router.push("/auth/login");
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (data) setEvent(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id, router]);

  useEffect(() => {
    fetchEvent();
  }, [fetchEvent]);

  useEffect(() => {
    if (!event) return;
    const interval = setInterval(() => {
      fetch(`/api/upload/events/${id}/photos/status`, { credentials: "include" })
        .then((res) => res.json())
        .then((status) => setUploadStatus(status))
        .catch(() => {});
    }, 2000);
    return () => clearInterval(interval);
  }, [id, event]);

  async function handleUpload(files: FileList | null) {
    if (!files || !files.length) return;
    setUploading(true);

    const items: UploadQueueItem[] = Array.from(files).map((f, i) => ({
      id: Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 6),
      name: f.name,
      progress: 0,
      tint: TINTS[i % TINTS.length],
    }));
    setUploadQueue((prev) => [...prev, ...items]);

    const allFiles = Array.from(files);
    const batchSize = 4;

    for (let i = 0; i < allFiles.length; i += batchSize) {
      const batch = allFiles.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (file, j) => {
          const itemId = items[i + j].id;
          const form = new FormData();
          form.append("files", file);
          try {
            const res = await fetch(`/api/upload/events/${id}/photos`, {
              method: "POST",
              body: form,
              credentials: "include",
            });
            if (!res.ok) throw new Error("Failed");
            setUploadQueue((prev) =>
              prev.map((it) => (it.id === itemId ? { ...it, progress: 100 } : it))
            );
          } catch {
            setUploadQueue((prev) =>
              prev.map((it) => (it.id === itemId ? { ...it, progress: 100 } : it))
            );
          }
        })
      );
    }

    setUploading(false);
    fetchEvent();
  }

  async function handleDelete() {
    if (!confirm("Delete this event and all photos?")) return;
    const res = await fetch(`/api/events/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      router.push("/admin");
    } else {
      setError("Failed to delete event");
    }
  }

  function copyLink() {
    if (!event) return;
    navigator.clipboard.writeText(`${window.location.origin}/gallery/${event.slug}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  if (loading) return <div style={{ minHeight: "100vh", background: "#fafafa", display: "flex", alignItems: "center", justifyContent: "center", color: "#a1a1aa" }}>Loading...</div>;
  if (!event) return null;

  const meta = statusMeta(event.status);
  const hasPending = uploadStatus.pending > 0;
  const shareLink = `${typeof window !== "undefined" ? window.location.origin : ""}/gallery/${event.slug}`;

  const gridPhotos = event.photos.map((p) => ({
    id: p.id,
    thumbUrl: p.thumbUrl,
    displayUrl: p.displayUrl,
    photographerName: p.photographerName,
    status: p.status,
    onOpen: () => {},
  }));

  const total = uploadStatus.pending + uploadStatus.processed;
  const progressPct = total ? Math.round((uploadStatus.processed / total) * 100) : 0;

  return (
    <div style={{ minHeight: "100vh", background: "#fafafa", animation: "pxFade .35s ease both" }}>
      <div style={{ maxWidth: 920, margin: "0 auto", padding: "30px 28px 48px" }}>
        <button
          onClick={() => router.push("/admin")}
          style={{ background: "none", border: "none", color: "#71717a", fontSize: 13.5, display: "inline-flex", alignItems: "center", gap: 6, padding: 0, marginBottom: 20, cursor: "pointer", transition: "color .15s" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#09090b"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "#71717a"; }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m15 18-6-6 6-6"></path>
          </svg>
          Back to events
        </button>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 22 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 11, flexWrap: "wrap" }}>
              <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-.025em", margin: 0 }}>{event.name}</h1>
              <div style={{ height: 24, padding: "0 10px", borderRadius: 999, display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 500, background: meta.statusBg, color: meta.statusColor }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.statusColor }}></span>
                {meta.statusLabel}
              </div>
            </div>
            <p style={{ fontSize: 14, color: "#71717a", margin: "7px 0 0" }}>
              Event · {new Date(event.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </p>
          </div>
          <div style={{ display: "flex", gap: 9 }}>
            <button
              onClick={() => router.push(`/gallery/${event.slug}`)}
              style={{ height: 38, padding: "0 14px", borderRadius: 8, border: "1px solid #e4e4e7", background: "#fff", color: "#18181b", fontSize: 13.5, fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", transition: "background .15s" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f4f4f5"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              Preview
            </button>
            <button
              onClick={handleDelete}
              style={{ height: 38, padding: "0 14px", borderRadius: 8, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontSize: 13.5, fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", transition: "background .15s" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#fef2f2"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
              </svg>
              Delete
            </button>
          </div>
        </div>

        {/* Share link */}
        <div style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 12, padding: "15px 16px", marginBottom: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: "#52525b", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"></path>
              <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"></path>
            </svg>
            Share this gallery
          </div>
          <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200, height: 38, display: "flex", alignItems: "center", padding: "0 12px", background: "#f4f4f5", borderRadius: 8, fontSize: 13, fontFamily: "'Geist Mono', monospace", color: "#3f3f46", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
              {shareLink}
            </div>
            <button
              onClick={copyLink}
              style={{ height: 38, padding: "0 14px", borderRadius: 8, border: "1px solid #e4e4e7", background: copied ? "#ecfdf5" : "#fff", color: copied ? "#16a34a" : "#18181b", fontSize: 13.5, fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", transition: "all .15s" }}
            >
              {copied ? "Copied!" : "Copy link"}
            </button>
          </div>
        </div>

        {/* Processing */}
        {hasPending && (
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "15px 16px", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11 }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "pxSpin 1s linear infinite" }}>
                <path d="M21 12a9 9 0 1 1-6.2-8.5"></path>
              </svg>
              <span style={{ fontSize: 13.5, fontWeight: 500, color: "#92400e" }}>
                Processing {uploadStatus.processed} of {total} photos
              </span>
            </div>
            <div style={{ height: 7, borderRadius: 999, background: "#fde68a", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${progressPct}%`, background: "#d97706", borderRadius: 999, transition: "width .6s ease" }} />
            </div>
          </div>
        )}

        {/* Upload zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          style={{ border: "1.5px dashed #d4d4d8", borderRadius: 12, background: "#fff", padding: "30px 20px", textAlign: "center", cursor: "pointer", transition: "border-color .15s, background .15s", marginBottom: 16 }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#2563eb"; e.currentTarget.style.background = "#f8faff"; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#d4d4d8"; e.currentTarget.style.background = "#fff"; }}
        >
          <input
            type="file"
            accept="image/*"
            multiple
            ref={fileInputRef}
            onChange={(e) => handleUpload(e.target.files)}
            style={{ display: "none" }}
          />
          <div style={{ width: 42, height: 42, borderRadius: 11, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17V3m0 0L7 8m5-5 5 5"></path>
              <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"></path>
            </svg>
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 500, marginBottom: 3 }}>
            Drop photos here, or <span style={{ color: "#2563eb" }}>browse</span>
          </div>
          <div style={{ fontSize: 12.5, color: "#a1a1aa" }}>JPEG, PNG or HEIC · up to 4 uploading at once</div>
        </div>

        {/* Upload queue */}
        {uploadQueue.length > 0 && (
          <div style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 12, padding: "8px 6px", marginBottom: 22 }}>
            {uploadQueue.map((u) => {
              const done = u.progress >= 100;
              return (
                <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 11px" }}>
                  <div style={{ width: 34, height: 34, borderRadius: 7, background: u.tint, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</span>
                      <span style={{ fontSize: 12, color: done ? "#16a34a" : "#71717a", flexShrink: 0 }}>
                        {done ? "Done" : Math.round(u.progress) + "%"}
                      </span>
                    </div>
                    <div style={{ height: 5, borderRadius: 999, background: "#f4f4f5", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.round(u.progress)}%`, background: done ? "#16a34a" : "#2563eb", borderRadius: 999, transition: "width .25s ease" }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Photos */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "6px 0 14px" }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Photos</h2>
          <span style={{ fontSize: 13, color: "#71717a" }}>{event.photos.length} total</span>
        </div>
        <PhotoGrid
          photos={gridPhotos}
          layout="uniform"
          onPhotoClick={(p, i) => {
            setLbIndex(i);
            setLbOpen(true);
          }}
        />

        {/* Lightbox */}
        {lbOpen && (
          <Lightbox
            photos={event.photos.map((p) => ({ id: p.id, url: p.displayUrl, photographerName: p.photographerName }))}
            index={lbIndex}
            onClose={() => setLbOpen(false)}
            onNext={() => setLbIndex((i) => (i + 1) % event.photos.length)}
            onPrev={() => setLbIndex((i) => (i - 1 + event.photos.length) % event.photos.length)}
          />
        )}
      </div>
    </div>
  );
}
