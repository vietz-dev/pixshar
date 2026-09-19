"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import PhotoGrid from "../../../../components/PhotoGrid";
import Lightbox from "../../../../components/Lightbox";
import DownloadButton from "../../../../components/DownloadButton";
import DownloadPanel from "../../../../components/DownloadPanel";
import AlertDialog from "../../../../components/AlertDialog";
import UploadTray, { UploadItem, randomTint } from "../../../../components/UploadTray";
import { presignedUpload } from "../../../../lib/uploadClient";

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
  placeholderDataUrl: string | null;
}

interface EventDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  password: string | null;
  status: string;
  createdAt: string;
  photos: Photo[];
}

export default function EventDetailPage() {
  const t = useTranslations("admin.eventDetail");
  const tEvents = useTranslations("admin.events");
  const tCommon = useTranslations("common");
  const params = useParams();
  const id = params.id as string;
  const router = useRouter();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploadStatus, setUploadStatus] = useState({
    pending: 0,
    processed: 0,
    failed: 0,
    total: 0,
  });
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [lbIndex, setLbIndex] = useState(0);
  const [lbOpen, setLbOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pwVisible, setPwVisible] = useState(false);
  const [pwChangeOpen, setPwChangeOpen] = useState(false);
  const [pwNewValue, setPwNewValue] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [showUpDetails, setShowUpDetails] = useState(false);
  const [uploaderName, setUploaderName] = useState("");
  const fileMapRef = useRef<Map<string, File>>(new Map());
  const abortRef = useRef(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkRenameOpen, setBulkRenameOpen] = useState(false);
  const [bulkRenameName, setBulkRenameName] = useState("");
  const [bulkRenaming, setBulkRenaming] = useState(false);
  const [activePhotographer, setActivePhotographer] = useState<string | null>(null);
  const [showAnonymous, setShowAnonymous] = useState(false);

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

  const eventLoaded = !!event;
  useEffect(() => {
    if (!eventLoaded) return;
    const es = new EventSource(`/api/upload/events/${id}/photos/status/stream`, {
      withCredentials: true,
    });
    es.addEventListener("photo-status", (e) => {
      setUploadStatus(JSON.parse(e.data));
    });
    es.addEventListener("photo-new", (e) => {
      const p = JSON.parse(e.data) as {
        id: string;
        thumbUrl: string;
        displayUrl: string;
        photographerName: string | null;
        placeholderDataUrl: string | null;
      };
      setEvent((prev) => {
        if (!prev || prev.photos.some((x) => x.id === p.id)) return prev;
        const photo: Photo = {
          id: p.id,
          photographerName: p.photographerName,
          originalKey: "",
          displayKey: "",
          thumbKey: "",
          thumbUrl: p.thumbUrl,
          displayUrl: p.displayUrl,
          status: "PROCESSED",
          uploadedBy: "ADMIN",
          createdAt: new Date().toISOString(),
          placeholderDataUrl: p.placeholderDataUrl ?? null,
        };
        return { ...prev, photos: [photo, ...prev.photos] };
      });
    });
    // Let EventSource auto-reconnect on transient drops (don't close here).
    es.onerror = () => {};
    return () => es.close();
  }, [id, eventLoaded]);

  // Backfill safety net: photo-new events can be missed across an SSE reconnect
  // (no replay). Whenever the processed count rises — including the snapshot the
  // stream pushes on (re)connect — refetch the event so the grid catches up.
  const prevProcessed = useRef(0);
  useEffect(() => {
    if (uploadStatus.processed > prevProcessed.current) {
      prevProcessed.current = uploadStatus.processed;
      fetchEvent();
    }
  }, [uploadStatus.processed, fetchEvent]);

  async function handleUpload(files: FileList | null) {
    if (!files || !files.length) return;

    const newItems: UploadItem[] = Array.from(files).map((f) => {
      const uid = Math.random().toString(36).slice(2);
      fileMapRef.current.set(uid, f);
      return {
        id: uid,
        name: f.name,
        status: "queued" as const,
        progress: 0,
        tint: randomTint(),
      };
    });
    setQueue((prev) => [...prev, ...newItems]);
    setShowUpDetails(false);
    abortRef.current = false;

    // Start upload after a tick so state is updated
    setTimeout(() => runUploadBatch(newItems), 0);
  }

  async function runUploadBatch(items: UploadItem[]) {
    const uploadItems = items
      .map((it) => {
        const file = fileMapRef.current.get(it.id);
        return file ? { uid: it.id, file } : null;
      })
      .filter((x): x is { uid: string; file: File } => x !== null);

    try {
      await presignedUpload({
        items: uploadItems,
        initUrl: `/api/upload/events/${id}/photos/init`,
        completeUrl: `/api/upload/events/${id}/photos/complete`,
        photographerName: uploaderName.trim() || undefined,
        shouldAbort: () => abortRef.current,
        onStatus: (uid, status, progress) => {
          setQueue((prev) =>
            prev.map((q) =>
              q.id === uid
                ? {
                    ...q,
                    status,
                    progress:
                      progress ?? (status === "done" || status === "skipped" ? 100 : q.progress),
                  }
                : q,
            ),
          );
        },
      });
    } catch {
      // Hard failure (e.g. init rejected / insecure context) — mark anything
      // still pending as errored so the user can retry.
      setQueue((prev) =>
        prev.map((q) =>
          q.status === "queued" || q.status === "uploading"
            ? { ...q, status: "error" as const, progress: 0 }
            : q,
        ),
      );
    }

    fetchEvent();
  }

  function handleCancelUpload() {
    abortRef.current = true;
  }

  async function handleRetryFailed() {
    setRetryingFailed(true);
    try {
      await fetch(`/api/events/${id}/photos/retry`, { method: "POST", credentials: "include" });
      // Progress + new thumbnails arrive via the SSE stream.
    } finally {
      setRetryingFailed(false);
    }
  }

  function handleClearUpload() {
    setQueue([]);
    fileMapRef.current.clear();
  }

  function handleRetryUpload() {
    const retryItems = queue.filter((q) => q.status === "error");
    if (retryItems.length === 0) return;
    setQueue((prev) =>
      prev.map((q) =>
        q.status === "error" ? { ...q, status: "queued" as const, progress: 0 } : q,
      ),
    );
    abortRef.current = false;
    setTimeout(() => runUploadBatch(retryItems), 0);
  }

  async function handleDeleteEvent() {
    const res = await fetch(`/api/events/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      router.push("/admin");
    } else {
      setError(t("deleteEvent.failed"));
    }
  }

  async function handleDeletePhoto(photoId: string) {
    const res = await fetch(`/api/events/${id}/photos/${photoId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      toast.success(t("deletePhoto.success"));
      fetchEvent();
    } else {
      toast.error(t("deletePhoto.failed"));
    }
  }

  function copyLink() {
    if (!event) return;
    navigator.clipboard.writeText(`${window.location.origin}/gallery/${event.slug}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!pwNewValue.trim()) return;
    setPwSaving(true);
    try {
      const res = await fetch(`/api/events/${id}/password`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwNewValue }),
      });
      if (res.ok) {
        toast.success(t("password.saved"));
        setEvent((prev) => (prev ? { ...prev, password: pwNewValue } : prev));
        setPwNewValue("");
        setPwChangeOpen(false);
        setPwVisible(false);
      } else {
        toast.error(t("password.failed"));
      }
    } finally {
      setPwSaving(false);
    }
  }

  const processedPhotos = useMemo(
    () => (event?.photos ?? []).filter((p) => p.status === "PROCESSED"),
    [event],
  );

  const photographers = useMemo(() => {
    const names = new Set<string>();
    for (const p of processedPhotos) {
      if (p.photographerName) names.add(p.photographerName);
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [processedPhotos]);

  const photographerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of processedPhotos) {
      if (p.photographerName) m.set(p.photographerName, (m.get(p.photographerName) ?? 0) + 1);
    }
    return m;
  }, [processedPhotos]);

  const anonymousCount = useMemo(
    () => processedPhotos.filter((p) => !p.photographerName).length,
    [processedPhotos],
  );

  const filteredPhotos = useMemo(() => {
    if (showAnonymous) return processedPhotos.filter((p) => !p.photographerName);
    if (activePhotographer)
      return processedPhotos.filter((p) => p.photographerName === activePhotographer);
    return processedPhotos;
  }, [processedPhotos, activePhotographer, showAnonymous]);

  useEffect(() => {
    if (activePhotographer && !photographers.includes(activePhotographer)) {
      setActivePhotographer(null);
    }
  }, [photographers, activePhotographer]);

  function exitSelection() {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  function handleToggleSelect(photoId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  function handleSelectAll() {
    setSelectedIds(new Set(filteredPhotos.map((p) => p.id)));
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    const ids = [...selectedIds];
    try {
      const res = await fetch(`/api/events/${id}/photos`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photoIds: ids }),
      });
      if (!res.ok) throw new Error();
      toast.success(t("bulkDelete.success", { count: ids.length }));
      exitSelection();
      fetchEvent();
    } catch {
      toast.error(t("bulkDelete.failed"));
    } finally {
      setBulkDeleting(false);
      setBulkDeleteOpen(false);
    }
  }

  async function handleBulkRename(e: React.FormEvent) {
    e.preventDefault();
    setBulkRenaming(true);
    const ids = [...selectedIds];
    const name = bulkRenameName;
    try {
      const res = await fetch(`/api/events/${id}/photos`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photoIds: ids, photographerName: name }),
      });
      if (!res.ok) throw new Error();
      setEvent((prev) =>
        prev
          ? {
              ...prev,
              photos: prev.photos.map((p) =>
                selectedIds.has(p.id) ? { ...p, photographerName: name.trim() || null } : p,
              ),
            }
          : prev,
      );
      toast.success(t("bulkRename.success", { count: ids.length }));
      setBulkRenameOpen(false);
      setBulkRenameName("");
      exitSelection();
    } catch {
      toast.error(t("bulkRename.failed"));
    } finally {
      setBulkRenaming(false);
    }
  }

  function statusMeta(st: string) {
    return st === "READY"
      ? {
          statusLabel: t("status.ready"),
          statusBg: "rgba(220,252,231,.92)",
          statusColor: "#16a34a",
        }
      : {
          statusLabel: t("status.processing"),
          statusBg: "rgba(254,243,199,.92)",
          statusColor: "#d97706",
        };
  }

  if (loading)
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#fafafa",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#a1a1aa",
        }}
      >
        {tCommon("loading")}
      </div>
    );
  if (!event) return null;

  const meta = statusMeta(event.status);
  const hasPending = uploadStatus.pending > 0;
  const shareLink = `${typeof window !== "undefined" ? window.location.origin : ""}/gallery/${event.slug}`;

  const gridPhotos = filteredPhotos.map((p) => ({
    id: p.id,
    thumbUrl: p.thumbUrl,
    displayUrl: p.displayUrl,
    photographerName: p.photographerName,
    status: p.status,
    placeholderDataUrl: p.placeholderDataUrl,
    onOpen: () => {},
  }));

  const total = uploadStatus.pending + uploadStatus.processed;
  const progressPct = total ? Math.round((uploadStatus.processed / total) * 100) : 0;

  const eventDate = new Date(event.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#fafafa", animation: "pxFade .35s ease both" }}>
      <div style={{ maxWidth: 920, margin: "0 auto", padding: "30px 28px 48px" }}>
        <button
          onClick={() => router.push("/admin")}
          style={{
            background: "none",
            border: "none",
            color: "#71717a",
            fontSize: 13.5,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: 0,
            marginBottom: 20,
            cursor: "pointer",
            transition: "color .15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#09090b";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#71717a";
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m15 18-6-6 6-6"></path>
          </svg>
          {t("backToEvents")}
        </button>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 22,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 11, flexWrap: "wrap" }}>
              <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-.025em", margin: 0 }}>
                {event.name}
              </h1>
              <div
                style={{
                  height: 24,
                  padding: "0 10px",
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 11.5,
                  fontWeight: 500,
                  background: meta.statusBg,
                  color: meta.statusColor,
                }}
              >
                <span
                  style={{ width: 6, height: 6, borderRadius: "50%", background: meta.statusColor }}
                ></span>
                {meta.statusLabel}
              </div>
            </div>
            <p style={{ fontSize: 14, color: "#71717a", margin: "7px 0 0" }}>
              {tEvents("eventDate", { date: eventDate })}
            </p>
          </div>
          <div style={{ display: "flex", gap: 9 }}>
            <DownloadButton slug={event.slug} />
            <button
              onClick={() => window.open(`/gallery/${event.slug}`, "_blank")}
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
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#f4f4f5";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#fff";
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              {t("preview")}
            </button>
            <button
              onClick={handleDeleteEvent}
              style={{
                height: 38,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid #fecaca",
                background: "#fff",
                color: "#dc2626",
                fontSize: 13.5,
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
                transition: "background .15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#fef2f2";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "#fff";
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
              </svg>
              {tCommon("delete")}
            </button>
          </div>
        </div>

        {/* Share link */}
        <div
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 12,
            padding: "15px 16px",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              color: "#52525b",
              marginBottom: 8,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"></path>
              <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"></path>
            </svg>
            {t("shareGallery")}
          </div>
          <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
            <div
              style={{
                flex: 1,
                minWidth: 200,
                height: 38,
                display: "flex",
                alignItems: "center",
                padding: "0 12px",
                background: "#f4f4f5",
                borderRadius: 8,
                fontSize: 13,
                fontFamily: "'Geist Mono', monospace",
                color: "#3f3f46",
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
              }}
            >
              {shareLink}
            </div>
            <button
              onClick={copyLink}
              style={{
                height: 38,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid #e4e4e7",
                background: copied ? "#ecfdf5" : "#fff",
                color: copied ? "#16a34a" : "#18181b",
                fontSize: 13.5,
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
                transition: "all .15s",
              }}
            >
              {copied ? t("copied") : t("copyLink")}
            </button>
          </div>
        </div>

        {/* Password */}
        <div
          style={{
            background: "#fff",
            border: "1px solid #e4e4e7",
            borderRadius: 12,
            padding: "15px 16px",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              color: "#52525b",
              marginBottom: 8,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            {t("password.label")}
          </div>
          <div
            style={{
              display: "flex",
              gap: 9,
              alignItems: "center",
              flexWrap: "wrap",
              marginBottom: pwChangeOpen ? 12 : 0,
            }}
          >
            <div
              style={{
                flex: 1,
                minWidth: 160,
                height: 38,
                display: "flex",
                alignItems: "center",
                padding: "0 12px",
                background: "#f4f4f5",
                borderRadius: 8,
                fontSize: 13,
                fontFamily: "'Geist Mono', monospace",
                color: "#3f3f46",
                overflow: "hidden",
                whiteSpace: "nowrap",
                textOverflow: "ellipsis",
                letterSpacing: pwVisible ? undefined : "0.12em",
              }}
            >
              {event.password == null ? (
                <span style={{ color: "#a1a1aa", fontFamily: "inherit", letterSpacing: "normal" }}>
                  {t("password.notAvailable")}
                </span>
              ) : pwVisible ? (
                event.password
              ) : (
                "•".repeat(Math.max(event.password.length, 8))
              )}
            </div>
            {event.password != null && (
              <button
                onClick={() => setPwVisible((v) => !v)}
                title={pwVisible ? t("password.hide") : t("password.show")}
                style={{
                  height: 38,
                  padding: "0 12px",
                  borderRadius: 8,
                  border: "1px solid #e4e4e7",
                  background: "#fff",
                  color: "#52525b",
                  fontSize: 13,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  cursor: "pointer",
                }}
              >
                {pwVisible ? (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                  </svg>
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                )}
                {pwVisible ? t("password.hide") : t("password.show")}
              </button>
            )}
            <button
              onClick={() => {
                setPwChangeOpen((o) => !o);
                setPwNewValue("");
              }}
              style={{
                height: 38,
                padding: "0 12px",
                borderRadius: 8,
                border: "1px solid #e4e4e7",
                background: "#fff",
                color: "#18181b",
                fontSize: 13,
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                cursor: "pointer",
              }}
            >
              {t("password.change")}
            </button>
          </div>
          {pwChangeOpen && (
            <form
              onSubmit={handleChangePassword}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
                paddingTop: 4,
              }}
            >
              <input
                type="password"
                value={pwNewValue}
                onChange={(e) => setPwNewValue(e.target.value)}
                placeholder={t("password.newPassword")}
                required
                autoFocus
                style={{
                  flex: 1,
                  minWidth: 180,
                  height: 38,
                  padding: "0 12px",
                  borderRadius: 8,
                  border: "1px solid #e4e4e7",
                  fontSize: 13,
                  outline: "none",
                  fontFamily: "inherit",
                }}
              />
              <button
                type="submit"
                disabled={pwSaving || !pwNewValue.trim()}
                style={{
                  height: 38,
                  padding: "0 16px",
                  borderRadius: 8,
                  border: "none",
                  background: "#18181b",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: pwSaving ? "not-allowed" : "pointer",
                  opacity: pwSaving || !pwNewValue.trim() ? 0.6 : 1,
                }}
              >
                {pwSaving ? t("password.saving") : t("password.save")}
              </button>
              <button
                type="button"
                onClick={() => setPwChangeOpen(false)}
                style={{
                  height: 38,
                  padding: "0 12px",
                  borderRadius: 8,
                  border: "1px solid #e4e4e7",
                  background: "#fff",
                  color: "#52525b",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {tCommon("cancel")}
              </button>
            </form>
          )}
        </div>

        {/* Processing */}
        {hasPending && (
          <div
            style={{
              background: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 12,
              padding: "15px 16px",
              marginBottom: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11 }}>
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#d97706"
                strokeWidth="2.4"
                strokeLinecap="round"
                style={{ animation: "pxSpin 1s linear infinite" }}
              >
                <path d="M21 12a9 9 0 1 1-6.2-8.5"></path>
              </svg>
              <span style={{ fontSize: 13.5, fontWeight: 500, color: "#92400e" }}>
                {t("processing.banner", { processed: uploadStatus.processed, total })}
              </span>
            </div>
            <div
              style={{ height: 7, borderRadius: 999, background: "#fde68a", overflow: "hidden" }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${progressPct}%`,
                  background: "#d97706",
                  borderRadius: 999,
                  transition: "width .6s ease",
                }}
              />
            </div>
          </div>
        )}

        {/* Failed processing */}
        {uploadStatus.failed > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 12,
              padding: "13px 16px",
              marginBottom: 16,
            }}
          >
            <span style={{ fontSize: 13.5, fontWeight: 500, color: "#b91c1c" }}>
              {t("processing.failed", { count: uploadStatus.failed })}
            </span>
            <button
              onClick={handleRetryFailed}
              disabled={retryingFailed}
              style={{
                height: 32,
                padding: "0 13px",
                borderRadius: 7,
                border: "1px solid #fecaca",
                background: "#fff",
                color: "#dc2626",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                opacity: retryingFailed ? 0.6 : 1,
              }}
            >
              {retryingFailed ? t("processing.retrying") : t("processing.retryFailed")}
            </button>
          </div>
        )}

        {/* Photographer name (optional) */}
        <div style={{ marginBottom: 10 }}>
          <label
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 500,
              color: "#52525b",
              marginBottom: 6,
            }}
          >
            {t("upload.photographerNameLabel")}
          </label>
          <input
            value={uploaderName}
            onChange={(e) => setUploaderName(e.target.value)}
            placeholder={t("upload.photographerNamePlaceholder")}
            style={{
              height: 38,
              width: "100%",
              padding: "0 12px",
              border: "1px solid #e4e4e7",
              borderRadius: 8,
              fontSize: 14,
              background: "#fff",
              outline: "none",
              boxSizing: "border-box",
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
        </div>

        {/* Upload zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: "1.5px dashed #d4d4d8",
            borderRadius: 12,
            background: "#fff",
            padding: "30px 20px",
            textAlign: "center",
            cursor: "pointer",
            transition: "border-color .15s, background .15s",
            marginBottom: 16,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "#2563eb";
            e.currentTarget.style.background = "#f8faff";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "#d4d4d8";
            e.currentTarget.style.background = "#fff";
          }}
        >
          <input
            type="file"
            accept="image/*"
            multiple
            ref={fileInputRef}
            onChange={(e) => handleUpload(e.target.files)}
            style={{ display: "none" }}
          />
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 11,
              background: "#eff6ff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 12px",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#2563eb"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 17V3m0 0L7 8m5-5 5 5"></path>
              <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"></path>
            </svg>
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 500, marginBottom: 3 }}>
            {t("upload.dropzoneMain")}{" "}
            <span style={{ color: "#2563eb" }}>{t("upload.browse")}</span>
          </div>
          <div style={{ fontSize: 12.5, color: "#a1a1aa" }}>{t("upload.hint")}</div>
        </div>

        {/* Upload tray */}
        {queue.length > 0 && (
          <UploadTray
            queue={queue}
            showDetails={showUpDetails}
            onToggleDetails={() => setShowUpDetails((s) => !s)}
            onClear={handleClearUpload}
            onCancel={handleCancelUpload}
            onRetry={handleRetryUpload}
            size="large"
          />
        )}

        {/* Download archive */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            margin: "6px 0 14px",
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{t("downloadArchive")}</h2>
        </div>
        <DownloadPanel eventId={event.id} slug={event.slug} />

        {/* Photos header + bulk-select toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            margin: "6px 0 14px",
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{t("photos")}</h2>

          {selectionMode ? (
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              {/* Selected count */}
              <span style={{ fontSize: 13, color: "#52525b", fontWeight: 500, minWidth: 90 }}>
                {selectedIds.size > 0
                  ? t("bulkSelect.selected", { count: selectedIds.size })
                  : t("bulkSelect.noneSelected")}
              </span>

              {/* Select all / Deselect all */}
              <button
                onClick={
                  selectedIds.size === filteredPhotos.length
                    ? () => setSelectedIds(new Set())
                    : handleSelectAll
                }
                style={{
                  height: 32,
                  padding: "0 11px",
                  borderRadius: 7,
                  border: "1px solid #e4e4e7",
                  background: "#fff",
                  color: "#18181b",
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {selectedIds.size === filteredPhotos.length
                  ? t("bulkSelect.deselectAll")
                  : t("bulkSelect.selectAll")}
              </button>

              {/* Set photographer */}
              <button
                onClick={() => {
                  setBulkRenameName("");
                  setBulkRenameOpen(true);
                }}
                disabled={selectedIds.size === 0}
                style={{
                  height: 32,
                  padding: "0 11px",
                  borderRadius: 7,
                  border: "1px solid #e4e4e7",
                  background: selectedIds.size > 0 ? "#fff" : "#f4f4f5",
                  color: selectedIds.size > 0 ? "#18181b" : "#a1a1aa",
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: selectedIds.size > 0 ? "pointer" : "not-allowed",
                }}
              >
                {t("bulkRename.button")}
              </button>

              {/* Delete selected */}
              <button
                onClick={() => setBulkDeleteOpen(true)}
                disabled={selectedIds.size === 0}
                style={{
                  height: 32,
                  padding: "0 11px",
                  borderRadius: 7,
                  border: selectedIds.size > 0 ? "1px solid #fecaca" : "1px solid #e4e4e7",
                  background: "#fff",
                  color: selectedIds.size > 0 ? "#dc2626" : "#a1a1aa",
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: selectedIds.size > 0 ? "pointer" : "not-allowed",
                }}
              >
                {t("bulkDelete.button")}
                {selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
              </button>

              {/* Cancel */}
              <button
                onClick={exitSelection}
                style={{
                  height: 32,
                  padding: "0 11px",
                  borderRadius: 7,
                  border: "1px solid #e4e4e7",
                  background: "#f4f4f5",
                  color: "#52525b",
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {t("bulkSelect.cancel")}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, color: "#71717a" }}>
                {t("totalPhotos", { count: event.photos.length })}
              </span>
              {event.photos.some((p) => p.status === "PROCESSED") && (
                <button
                  onClick={() => setSelectionMode(true)}
                  style={{
                    height: 30,
                    padding: "0 11px",
                    borderRadius: 7,
                    border: "1px solid #e4e4e7",
                    background: "#fff",
                    color: "#52525b",
                    fontSize: 12.5,
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  {t("bulkSelect.select")}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Photographer filter chips */}
        {(photographers.length > 0 || anonymousCount > 0) && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {/* All */}
            <button
              onClick={() => {
                setActivePhotographer(null);
                setShowAnonymous(false);
              }}
              style={{
                height: 28,
                padding: "0 11px",
                borderRadius: 999,
                border: !activePhotographer && !showAnonymous ? "none" : "1px solid #e4e4e7",
                background: !activePhotographer && !showAnonymous ? "#18181b" : "#fff",
                color: !activePhotographer && !showAnonymous ? "#fff" : "#52525b",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "background .15s, color .15s, border .15s",
              }}
            >
              {t("photoFilter.all")}
              <span
                style={{
                  marginLeft: 5,
                  opacity: 0.6,
                  fontSize: 11.5,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {processedPhotos.length}
              </span>
            </button>

            {/* Named photographers */}
            {photographers.map((name) => {
              const active = activePhotographer === name && !showAnonymous;
              return (
                <button
                  key={name}
                  onClick={() => {
                    setShowAnonymous(false);
                    setActivePhotographer(active ? null : name);
                  }}
                  style={{
                    height: 28,
                    padding: "0 11px",
                    borderRadius: 999,
                    border: active ? "none" : "1px solid #e4e4e7",
                    background: active ? "#18181b" : "#fff",
                    color: active ? "#fff" : "#52525b",
                    fontSize: 12.5,
                    fontWeight: 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    transition: "background .15s, color .15s, border .15s",
                  }}
                >
                  {name}
                  <span
                    style={{
                      marginLeft: 5,
                      opacity: 0.6,
                      fontSize: 11.5,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {photographerCounts.get(name)}
                  </span>
                </button>
              );
            })}

            {/* Anonymous (no name set) — admin only */}
            {anonymousCount > 0 && (
              <button
                onClick={() => {
                  setActivePhotographer(null);
                  setShowAnonymous(!showAnonymous);
                }}
                style={{
                  height: 28,
                  padding: "0 11px",
                  borderRadius: 999,
                  border: showAnonymous ? "none" : "1px solid #e4e4e7",
                  background: showAnonymous ? "#71717a" : "#fff",
                  color: showAnonymous ? "#fff" : "#71717a",
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  transition: "background .15s, color .15s, border .15s",
                }}
              >
                {tCommon("anonymous")}
                <span
                  style={{
                    marginLeft: 5,
                    opacity: 0.6,
                    fontSize: 11.5,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {anonymousCount}
                </span>
              </button>
            )}
          </div>
        )}

        <PhotoGrid
          photos={gridPhotos}
          layout="uniform"
          onPhotoClick={(_, i) => {
            if (selectionMode) return;
            setLbIndex(i);
            setLbOpen(true);
          }}
          onDelete={selectionMode ? undefined : (photoId) => setDeleteTarget(photoId)}
          selectable={selectionMode}
          selectedIds={selectedIds}
          onToggleSelect={handleToggleSelect}
        />

        {/* Lightbox */}
        {lbOpen && (
          <Lightbox
            photos={filteredPhotos.map((p) => ({
              id: p.id,
              url: p.displayUrl,
              photographerName: p.photographerName,
              placeholderDataUrl: p.placeholderDataUrl ?? null,
            }))}
            index={lbIndex}
            onClose={() => setLbOpen(false)}
            onNext={() => setLbIndex((i) => (i + 1) % filteredPhotos.length)}
            onPrev={() =>
              setLbIndex((i) => (i - 1 + filteredPhotos.length) % filteredPhotos.length)
            }
            onDownload={async (photoId) => {
              const res = await fetch(`/api/events/${id}/photos/${photoId}/download`, {
                credentials: "include",
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Download failed");
              return data.url;
            }}
            onDelete={(photoId) => setDeleteTarget(photoId)}
          />
        )}

        {error && <div style={{ fontSize: 13, color: "#dc2626", marginTop: 12 }}>{error}</div>}

        {/* Delete single photo confirmation dialog */}
        <AlertDialog
          open={deleteTarget !== null}
          title={t("deletePhoto.title")}
          description={t("deletePhoto.description")}
          cancelLabel={tCommon("cancel")}
          confirmLabel={t("deletePhoto.deleteButton")}
          destructive
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            if (deleteTarget) {
              handleDeletePhoto(deleteTarget);
              setDeleteTarget(null);
            }
          }}
        />

        {/* Bulk delete confirmation dialog */}
        <AlertDialog
          open={bulkDeleteOpen}
          title={t("bulkDelete.title", { count: selectedIds.size })}
          description={t("bulkDelete.description", { count: selectedIds.size })}
          cancelLabel={tCommon("cancel")}
          confirmLabel={bulkDeleting ? "…" : t("bulkDelete.confirm", { count: selectedIds.size })}
          destructive
          onCancel={() => setBulkDeleteOpen(false)}
          onConfirm={handleBulkDelete}
        />

        {/* Bulk rename dialog */}
        {bulkRenameOpen && (
          <div
            onClick={() => setBulkRenameOpen(false)}
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
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(9,9,11,.5)",
                backdropFilter: "blur(3px)",
              }}
            />
            <form
              onClick={(e) => e.stopPropagation()}
              onSubmit={handleBulkRename}
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
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 600,
                  letterSpacing: "-.01em",
                  marginBottom: 6,
                  color: "#18181b",
                }}
              >
                {t("bulkRename.title")}
              </div>
              <div style={{ fontSize: 14, color: "#71717a", lineHeight: 1.5, marginBottom: 18 }}>
                {t("bulkRename.description", { count: selectedIds.size })}
              </div>
              <label
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 500,
                  marginBottom: 7,
                  color: "#374151",
                }}
              >
                {t("bulkRename.label")}
              </label>
              <input
                autoFocus
                value={bulkRenameName}
                onChange={(e) => setBulkRenameName(e.target.value)}
                placeholder={t("bulkRename.placeholder")}
                style={{
                  width: "100%",
                  height: 40,
                  padding: "0 12px",
                  borderRadius: 8,
                  border: "1px solid #e4e4e7",
                  fontSize: 14,
                  outline: "none",
                  marginBottom: 20,
                  boxSizing: "border-box",
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
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setBulkRenameOpen(false)}
                  style={{
                    height: 36,
                    padding: "0 14px",
                    borderRadius: 8,
                    border: "1px solid #e4e4e7",
                    background: "#fff",
                    color: "#52525b",
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  {tCommon("cancel")}
                </button>
                <button
                  type="submit"
                  disabled={bulkRenaming}
                  style={{
                    height: 36,
                    padding: "0 16px",
                    borderRadius: 8,
                    border: "none",
                    background: "#18181b",
                    color: "#fff",
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: bulkRenaming ? "not-allowed" : "pointer",
                    opacity: bulkRenaming ? 0.6 : 1,
                  }}
                >
                  {bulkRenaming ? "…" : t("bulkRename.apply")}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
