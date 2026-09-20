"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, HStack, Progress, Spinner } from "@chakra-ui/react";

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

/** Shared chrome for every state of the button — only colors/cursor differ. */
const buttonBase = {
  variant: "outline",
  h: "38px",
  px: "14px",
  gap: "6px",
  borderRadius: "control",
  borderColor: "border",
  bg: "surface",
  fontSize: "13.5px",
  fontWeight: "500",
} as const;

function DownloadIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
  );
}

export default function DownloadButton({ slug }: { slug: string }) {
  const t = useTranslations("download.button");
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
      <Button {...buttonBase} disabled color="fgSubtle" opacity={0.7} cursor="not-allowed">
        <DownloadIcon />
        {t("downloadAll")}
      </Button>
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
      <Button
        {...buttonBase}
        onClick={() => router.push(`/gallery/${slug}/download`)}
        color="fg"
        transition="background .15s"
        _hover={{ bg: "bg" }}
      >
        <DownloadIcon />
        {label}
      </Button>
    );
  }

  if (state.status === "BUILDING" && state.photoCount && state.photoCount > 0) {
    const isUploading = state.processedPhotos === -1;
    const pct = isUploading
      ? (state.uploadProgress ?? 0)
      : Math.round(((state.processedPhotos ?? 0) / state.photoCount) * 100);
    const label = isUploading ? t("uploadingS3", { pct }) : t("buildingPct", { pct });
    return (
      <Button
        {...buttonBase}
        disabled
        color="fgMuted"
        opacity={0.9}
        cursor="default"
        position="relative"
        overflow="hidden"
      >
        <Progress.Root value={pct} position="absolute" inset="0" shape="square">
          <Progress.Track h="100%" bg="transparent">
            <Progress.Range bg="accent.50" transition="width .5s ease" />
          </Progress.Track>
        </Progress.Root>
        <HStack position="relative" zIndex={1} gap="6px">
          <Spinner size="sm" borderWidth="2.2px" color="currentColor" />
          {label}
        </HStack>
      </Button>
    );
  }

  const label = labelFor(t, state.status);
  const failed = state.status === "FAILED";

  return (
    <Button
      {...buttonBase}
      disabled={failed}
      bg={failed ? "red.50" : "surface"}
      color={failed ? "danger" : "fgMuted"}
      cursor={failed ? "not-allowed" : "default"}
      opacity={0.8}
      transition="background .15s"
    >
      {state.status === "BUILDING" ? (
        <Spinner size="sm" borderWidth="2.2px" color="currentColor" />
      ) : (
        <DownloadIcon />
      )}
      {label}
    </Button>
  );
}

function labelFor(
  t: ReturnType<typeof useTranslations<"download.button">>,
  status: DownloadStatus,
): string {
  switch (status) {
    case "NONE":
      return t("preparing");
    case "DEBOUNCING":
      return t("waitingUploads");
    case "BUILDING":
      return t("building");
    case "FAILED":
      return t("unavailable");
    default:
      return t("downloadAll");
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
