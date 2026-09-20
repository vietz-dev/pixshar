"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { toaster } from "@/components/ui/toaster";
import { useTranslations } from "next-intl";
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  chakra,
  Dialog,
  Field,
  Flex,
  Heading,
  Input,
  Portal,
  Progress,
  Text,
} from "@chakra-ui/react";
import { EVENT_STATUS_PALETTE } from "../../page";
import { FilterChip, FilterChipCount } from "../../../../components/ui/filter-chip";
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
      toaster.create({ type: "success", title: t("deletePhoto.success") });
      fetchEvent();
    } else {
      toaster.create({ type: "error", title: t("deletePhoto.failed") });
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
        toaster.create({ type: "success", title: t("password.saved") });
        setEvent((prev) => (prev ? { ...prev, password: pwNewValue } : prev));
        setPwNewValue("");
        setPwChangeOpen(false);
        setPwVisible(false);
      } else {
        toaster.create({ type: "error", title: t("password.failed") });
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
      toaster.create({ type: "success", title: t("bulkDelete.success", { count: ids.length }) });
      exitSelection();
      fetchEvent();
    } catch {
      toaster.create({ type: "error", title: t("bulkDelete.failed") });
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
      toaster.create({ type: "success", title: t("bulkRename.success", { count: ids.length }) });
      setBulkRenameOpen(false);
      setBulkRenameName("");
      exitSelection();
    } catch {
      toaster.create({ type: "error", title: t("bulkRename.failed") });
    } finally {
      setBulkRenaming(false);
    }
  }

  if (loading)
    return (
      <Flex minH="100vh" bg="gray.50" align="center" justify="center" color="fgSubtle">
        {tCommon("loading")}
      </Flex>
    );
  if (!event) return null;

  const statusLabel = event.status === "READY" ? t("status.ready") : t("status.processing");
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
    <Box minH="100vh" bg="gray.50" animation="pxFade .35s ease both">
      <Box maxW="920px" mx="auto" px="28px" pt="30px" pb="48px">
        <Button
          onClick={() => router.push("/admin")}
          variant="plain"
          h="auto"
          p="0"
          mb="20px"
          gap="6px"
          fontSize="13.5px"
          fontWeight="400"
          color="fgMuted"
          transition="color .15s"
          _hover={{ color: "fg" }}
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
        </Button>

        <Flex justify="space-between" align="flex-start" gap="16px" wrap="wrap" mb="22px">
          <Box>
            <Flex align="center" gap="11px" wrap="wrap">
              <Heading as="h1" fontSize="26px" fontWeight="600" letterSpacing="-.025em" m="0">
                {event.name}
              </Heading>
              <Badge
                colorPalette={EVENT_STATUS_PALETTE[event.status] ?? "gray"}
                variant="subtle"
                h="24px"
                px="10px"
                gap="5px"
                borderRadius="pill"
                fontSize="11.5px"
                fontWeight="500"
              >
                <Box w="6px" h="6px" borderRadius="50%" bg="colorPalette.solid" />
                {statusLabel}
              </Badge>
            </Flex>
            <Text fontSize="14px" color="fgMuted" m="7px 0 0">
              {tEvents("eventDate", { date: eventDate })}
            </Text>
          </Box>
          <Flex gap="9px">
            <DownloadButton slug={event.slug} />
            <Button
              onClick={() => window.open(`/gallery/${event.slug}`, "_blank")}
              variant="outline"
              h="38px"
              px="14px"
              gap="6px"
              borderRadius="control"
              borderColor="border"
              bg="surface"
              color="fg"
              fontSize="13.5px"
              fontWeight="500"
              transition="background .15s"
              _hover={{ bg: "bg" }}
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
            </Button>
            <Button
              onClick={handleDeleteEvent}
              variant="outline"
              h="38px"
              px="14px"
              gap="6px"
              borderRadius="control"
              borderColor="red.200"
              bg="surface"
              color="danger"
              fontSize="13.5px"
              fontWeight="500"
              transition="background .15s"
              _hover={{ bg: "red.50" }}
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
            </Button>
          </Flex>
        </Flex>

        {/* Share link */}
        <Card.Root
          mb="16px"
          bg="surface"
          borderWidth="1px"
          borderColor="border"
          borderRadius="card"
        >
          <Card.Body px="16px" py="15px">
            <Flex
              align="center"
              gap="6px"
              mb="8px"
              fontSize="12.5px"
              fontWeight="500"
              color="gray.600"
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
            </Flex>
            <Flex gap="9px" align="center" wrap="wrap">
              <Flex
                flex="1"
                minW="200px"
                h="38px"
                align="center"
                px="12px"
                bg="bg"
                borderRadius="control"
                fontSize="13px"
                fontFamily="mono"
                color="gray.700"
                overflow="hidden"
                whiteSpace="nowrap"
                textOverflow="ellipsis"
              >
                {shareLink}
              </Flex>
              <Button
                onClick={copyLink}
                variant="outline"
                h="38px"
                px="14px"
                gap="6px"
                borderRadius="control"
                borderColor="border"
                bg={copied ? "green.50" : "surface"}
                color={copied ? "success" : "fg"}
                fontSize="13.5px"
                fontWeight="500"
                transition="all .15s"
              >
                {copied ? t("copied") : t("copyLink")}
              </Button>
            </Flex>
          </Card.Body>
        </Card.Root>

        {/* Password */}
        <Card.Root
          mb="16px"
          bg="surface"
          borderWidth="1px"
          borderColor="border"
          borderRadius="card"
        >
          <Card.Body px="16px" py="15px">
            <Flex
              align="center"
              gap="6px"
              mb="8px"
              fontSize="12.5px"
              fontWeight="500"
              color="gray.600"
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
            </Flex>
            <Flex gap="9px" align="center" wrap="wrap" mb={pwChangeOpen ? "12px" : "0"}>
              <Flex
                flex="1"
                minW="160px"
                h="38px"
                align="center"
                px="12px"
                bg="bg"
                borderRadius="control"
                fontSize="13px"
                fontFamily="mono"
                color="gray.700"
                overflow="hidden"
                whiteSpace="nowrap"
                textOverflow="ellipsis"
                letterSpacing={pwVisible ? undefined : "0.12em"}
              >
                {event.password == null ? (
                  <Text as="span" color="fgSubtle" fontFamily="inherit" letterSpacing="normal">
                    {t("password.notAvailable")}
                  </Text>
                ) : pwVisible ? (
                  event.password
                ) : (
                  "•".repeat(Math.max(event.password.length, 8))
                )}
              </Flex>
              {event.password != null && (
                <Button
                  onClick={() => setPwVisible((v) => !v)}
                  title={pwVisible ? t("password.hide") : t("password.show")}
                  variant="outline"
                  h="38px"
                  px="12px"
                  gap="5px"
                  borderRadius="control"
                  borderColor="border"
                  bg="surface"
                  color="gray.600"
                  fontSize="13px"
                  fontWeight="400"
                  _hover={{ bg: "bg" }}
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
                </Button>
              )}
              <Button
                onClick={() => {
                  setPwChangeOpen((o) => !o);
                  setPwNewValue("");
                }}
                variant="outline"
                h="38px"
                px="12px"
                gap="5px"
                borderRadius="control"
                borderColor="border"
                bg="surface"
                color="fg"
                fontSize="13px"
                fontWeight="500"
                _hover={{ bg: "bg" }}
              >
                {t("password.change")}
              </Button>
            </Flex>
            {pwChangeOpen && (
              <chakra.form
                onSubmit={handleChangePassword}
                display="flex"
                gap="8px"
                alignItems="center"
                flexWrap="wrap"
                pt="4px"
              >
                <Input
                  type="password"
                  value={pwNewValue}
                  onChange={(e) => setPwNewValue(e.target.value)}
                  placeholder={t("password.newPassword")}
                  required
                  autoFocus
                  flex="1"
                  minW="180px"
                  h="38px"
                  borderRadius="control"
                  fontSize="13px"
                />
                <Button
                  type="submit"
                  disabled={pwSaving || !pwNewValue.trim()}
                  h="38px"
                  px="16px"
                  borderRadius="control"
                  bg="fg"
                  color="surface"
                  fontSize="13px"
                  fontWeight="500"
                  _hover={{ bg: "gray.800" }}
                >
                  {pwSaving ? t("password.saving") : t("password.save")}
                </Button>
                <Button
                  type="button"
                  onClick={() => setPwChangeOpen(false)}
                  variant="outline"
                  h="38px"
                  px="12px"
                  borderRadius="control"
                  borderColor="border"
                  bg="surface"
                  color="gray.600"
                  fontSize="13px"
                  fontWeight="400"
                  _hover={{ bg: "bg" }}
                >
                  {tCommon("cancel")}
                </Button>
              </chakra.form>
            )}
          </Card.Body>
        </Card.Root>

        {/* Processing */}
        {hasPending && (
          <Alert.Root
            colorPalette="orange"
            variant="subtle"
            borderWidth="1px"
            borderColor="colorPalette.200"
            borderRadius="card"
            px="16px"
            py="15px"
            mb="16px"
            alignItems="stretch"
            flexDirection="column"
            gap="11px"
          >
            <Flex align="center" gap="10px">
              <chakra.svg
                width="17px"
                height="17px"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                color="colorPalette.solid"
                animation="pxSpin 1s linear infinite"
              >
                <path d="M21 12a9 9 0 1 1-6.2-8.5"></path>
              </chakra.svg>
              <Alert.Title fontSize="13.5px" fontWeight="500" color="colorPalette.700">
                {t("processing.banner", { processed: uploadStatus.processed, total })}
              </Alert.Title>
            </Flex>
            <Progress.Root value={progressPct} colorPalette="orange">
              <Progress.Track h="7px" borderRadius="pill" bg="colorPalette.200">
                <Progress.Range borderRadius="pill" transition="width .6s ease" />
              </Progress.Track>
            </Progress.Root>
          </Alert.Root>
        )}

        {/* Failed processing */}
        {uploadStatus.failed > 0 && (
          <Alert.Root
            colorPalette="red"
            variant="subtle"
            borderWidth="1px"
            borderColor="colorPalette.200"
            borderRadius="card"
            px="16px"
            py="13px"
            mb="16px"
            gap="12px"
            flexWrap="wrap"
            justifyContent="space-between"
            alignItems="center"
          >
            <Alert.Title fontSize="13.5px" fontWeight="500" color="colorPalette.700">
              {t("processing.failed", { count: uploadStatus.failed })}
            </Alert.Title>
            <Button
              onClick={handleRetryFailed}
              disabled={retryingFailed}
              variant="outline"
              h="32px"
              px="13px"
              borderRadius="7px"
              borderColor="colorPalette.200"
              bg="surface"
              color="danger"
              fontSize="12.5px"
              fontWeight="500"
            >
              {retryingFailed ? t("processing.retrying") : t("processing.retryFailed")}
            </Button>
          </Alert.Root>
        )}

        {/* Photographer name (optional) */}
        <Field.Root mb="10px">
          <Field.Label fontSize="13px" fontWeight="500" color="gray.600" mb="6px">
            {t("upload.photographerNameLabel")}
          </Field.Label>
          <Input
            value={uploaderName}
            onChange={(e) => setUploaderName(e.target.value)}
            placeholder={t("upload.photographerNamePlaceholder")}
            h="38px"
            borderRadius="control"
            fontSize="14px"
            bg="surface"
          />
        </Field.Root>

        {/* Upload zone */}
        <Box
          onClick={() => fileInputRef.current?.click()}
          borderWidth="1.5px"
          borderStyle="dashed"
          borderColor="gray.300"
          borderRadius="card"
          bg="surface"
          px="20px"
          py="30px"
          mb="16px"
          textAlign="center"
          cursor="pointer"
          transition="border-color .15s, background .15s"
          _hover={{ borderColor: "accent", bg: "accent.subtle" }}
        >
          <chakra.input
            type="file"
            accept="image/*"
            multiple
            ref={fileInputRef}
            onChange={(e) => handleUpload(e.target.files)}
            display="none"
          />
          <Flex
            w="42px"
            h="42px"
            borderRadius="11px"
            bg="accent.subtle"
            color="accent"
            align="center"
            justify="center"
            mx="auto"
            mb="12px"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 17V3m0 0L7 8m5-5 5 5"></path>
              <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"></path>
            </svg>
          </Flex>
          <Text fontSize="14.5px" fontWeight="500" mb="3px">
            {t("upload.dropzoneMain")}{" "}
            <Text as="span" color="accent">
              {t("upload.browse")}
            </Text>
          </Text>
          <Text fontSize="12.5px" color="fgSubtle">
            {t("upload.hint")}
          </Text>
        </Box>

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
        <Flex align="center" justify="space-between" m="6px 0 14px">
          <Heading as="h2" fontSize="16px" fontWeight="600" m="0">
            {t("downloadArchive")}
          </Heading>
        </Flex>
        <DownloadPanel eventId={event.id} slug={event.slug} />

        {/* Photos header + bulk-select toolbar */}
        <Flex align="center" justify="space-between" gap="10px" wrap="wrap" m="6px 0 14px">
          <Heading as="h2" fontSize="16px" fontWeight="600" m="0">
            {t("photos")}
          </Heading>

          {selectionMode ? (
            <Flex align="center" gap="7px" wrap="wrap">
              {/* Selected count */}
              <Text fontSize="13px" color="gray.600" fontWeight="500" minW="90px">
                {selectedIds.size > 0
                  ? t("bulkSelect.selected", { count: selectedIds.size })
                  : t("bulkSelect.noneSelected")}
              </Text>

              {/* Select all / Deselect all */}
              <Button
                onClick={
                  selectedIds.size === filteredPhotos.length
                    ? () => setSelectedIds(new Set())
                    : handleSelectAll
                }
                variant="outline"
                h="32px"
                px="11px"
                borderRadius="7px"
                borderColor="border"
                bg="surface"
                color="fg"
                fontSize="12.5px"
                fontWeight="500"
                _hover={{ bg: "bg" }}
              >
                {selectedIds.size === filteredPhotos.length
                  ? t("bulkSelect.deselectAll")
                  : t("bulkSelect.selectAll")}
              </Button>

              {/* Set photographer */}
              <Button
                onClick={() => {
                  setBulkRenameName("");
                  setBulkRenameOpen(true);
                }}
                disabled={selectedIds.size === 0}
                variant="outline"
                h="32px"
                px="11px"
                borderRadius="7px"
                borderColor="border"
                bg="surface"
                color="fg"
                fontSize="12.5px"
                fontWeight="500"
                _hover={{ bg: "bg" }}
                _disabled={{ bg: "bg", color: "fgSubtle", cursor: "not-allowed" }}
              >
                {t("bulkRename.button")}
              </Button>

              {/* Delete selected */}
              <Button
                onClick={() => setBulkDeleteOpen(true)}
                disabled={selectedIds.size === 0}
                variant="outline"
                h="32px"
                px="11px"
                borderRadius="7px"
                borderColor="red.200"
                bg="surface"
                color="danger"
                fontSize="12.5px"
                fontWeight="500"
                _hover={{ bg: "red.50" }}
                _disabled={{ borderColor: "border", color: "fgSubtle", cursor: "not-allowed" }}
              >
                {t("bulkDelete.button")}
                {selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
              </Button>

              {/* Cancel */}
              <Button
                onClick={exitSelection}
                variant="outline"
                h="32px"
                px="11px"
                borderRadius="7px"
                borderColor="border"
                bg="bg"
                color="gray.600"
                fontSize="12.5px"
                fontWeight="500"
                _hover={{ bg: "border" }}
              >
                {t("bulkSelect.cancel")}
              </Button>
            </Flex>
          ) : (
            <Flex align="center" gap="10px">
              <Text fontSize="13px" color="fgMuted">
                {t("totalPhotos", { count: event.photos.length })}
              </Text>
              {event.photos.some((p) => p.status === "PROCESSED") && (
                <Button
                  onClick={() => setSelectionMode(true)}
                  variant="outline"
                  h="30px"
                  px="11px"
                  borderRadius="7px"
                  borderColor="border"
                  bg="surface"
                  color="gray.600"
                  fontSize="12.5px"
                  fontWeight="500"
                  _hover={{ bg: "bg" }}
                >
                  {t("bulkSelect.select")}
                </Button>
              )}
            </Flex>
          )}
        </Flex>

        {/* Photographer filter chips */}
        {(photographers.length > 0 || anonymousCount > 0) && (
          <Flex gap="6px" wrap="wrap" mb="14px">
            {/* All */}
            <FilterChip
              active={!activePhotographer && !showAnonymous}
              onClick={() => {
                setActivePhotographer(null);
                setShowAnonymous(false);
              }}
            >
              {t("photoFilter.all")}
              <FilterChipCount>{processedPhotos.length}</FilterChipCount>
            </FilterChip>

            {/* Named photographers */}
            {photographers.map((name) => {
              const active = activePhotographer === name && !showAnonymous;
              return (
                <FilterChip
                  key={name}
                  active={active}
                  onClick={() => {
                    setShowAnonymous(false);
                    setActivePhotographer(active ? null : name);
                  }}
                >
                  {name}
                  <FilterChipCount>{photographerCounts.get(name)}</FilterChipCount>
                </FilterChip>
              );
            })}

            {/* Anonymous (no name set) — admin only */}
            {anonymousCount > 0 && (
              <FilterChip
                active={showAnonymous}
                bg={showAnonymous ? "fgMuted" : undefined}
                borderColor={showAnonymous ? "fgMuted" : undefined}
                color={showAnonymous ? "surface" : "fgMuted"}
                onClick={() => {
                  setActivePhotographer(null);
                  setShowAnonymous(!showAnonymous);
                }}
              >
                {tCommon("anonymous")}
                <FilterChipCount>{anonymousCount}</FilterChipCount>
              </FilterChip>
            )}
          </Flex>
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

        {error && (
          <Text fontSize="13px" color="danger" mt="12px">
            {error}
          </Text>
        )}

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
        <Dialog.Root
          open={bulkRenameOpen}
          placement="center"
          size="xs"
          onOpenChange={(e) => {
            if (!e.open) setBulkRenameOpen(false);
          }}
        >
          <Portal>
            <Dialog.Backdrop bg="rgba(9,9,11,.5)" backdropFilter="blur(3px)" />
            <Dialog.Positioner p="24px">
              <Dialog.Content
                maxW="400px"
                bg="surface"
                borderWidth="1px"
                borderColor="border"
                borderRadius="14px"
                boxShadow="0 20px 50px -12px rgba(0,0,0,.35)"
              >
                <chakra.form onSubmit={handleBulkRename}>
                  <Dialog.Header pt="24px" px="24px" pb="0" display="block">
                    <Dialog.Title
                      fontSize="17px"
                      fontWeight="600"
                      letterSpacing="-.01em"
                      color="fg"
                      mb="6px"
                    >
                      {t("bulkRename.title")}
                    </Dialog.Title>
                    <Dialog.Description fontSize="14px" color="fgMuted" lineHeight="1.5">
                      {t("bulkRename.description", { count: selectedIds.size })}
                    </Dialog.Description>
                  </Dialog.Header>
                  <Dialog.Body px="24px" pt="18px" pb="0">
                    <Field.Root>
                      <Field.Label fontSize="13px" fontWeight="500" color="gray.700" mb="7px">
                        {t("bulkRename.label")}
                      </Field.Label>
                      <Input
                        autoFocus
                        value={bulkRenameName}
                        onChange={(e) => setBulkRenameName(e.target.value)}
                        placeholder={t("bulkRename.placeholder")}
                        h="40px"
                        borderRadius="control"
                        fontSize="14px"
                      />
                    </Field.Root>
                  </Dialog.Body>
                  <Dialog.Footer px="24px" pt="20px" pb="20px" gap="10px">
                    <Dialog.ActionTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        h="36px"
                        px="14px"
                        borderRadius="control"
                        borderColor="border"
                        bg="surface"
                        color="gray.600"
                        fontSize="14px"
                        fontWeight="500"
                        _hover={{ bg: "bg" }}
                      >
                        {tCommon("cancel")}
                      </Button>
                    </Dialog.ActionTrigger>
                    <Button
                      type="submit"
                      disabled={bulkRenaming}
                      h="36px"
                      px="16px"
                      borderRadius="control"
                      bg="fg"
                      color="surface"
                      fontSize="14px"
                      fontWeight="500"
                      _hover={{ bg: "gray.800" }}
                    >
                      {bulkRenaming ? "…" : t("bulkRename.apply")}
                    </Button>
                  </Dialog.Footer>
                </chakra.form>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      </Box>
    </Box>
  );
}
