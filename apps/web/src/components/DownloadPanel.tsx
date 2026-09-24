"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  Heading,
  Progress,
  SimpleGrid,
  Text,
} from "@chakra-ui/react";
import type { DownloadStatus, Quality } from "@pixshar/contracts";
import { api } from "@/lib/rpc";
import AlertDialog from "./AlertDialog";

/** Status → Chakra colorPalette for the state badge. */
const STATUS_PALETTE: Record<string, string> = {
  NONE: "gray",
  DEBOUNCING: "orange",
  QUEUED: "accent",
  BUILDING: "accent",
  READY: "green",
  FAILED: "red",
  CANCELLED: "red",
};

/** Shared chrome for the three panel actions — only palette/colors differ. */
const actionBase = {
  variant: "outline",
  h: "32px",
  px: "12px",
  gap: "5px",
  borderRadius: "7px",
  bg: "surface",
  fontSize: "12.5px",
  fontWeight: "500",
  transition: "background .15s",
} as const;

export default function DownloadPanel({ eventId, slug: _slug }: { eventId: string; slug: string }) {
  const t = useTranslations("download.panel");
  return (
    <Box mb="16px">
      <Heading as="h3" fontSize="14px" fontWeight="600" color="fg" m="0 0 12px">
        {t("heading")}
      </Heading>
      <VariantPanel
        eventId={eventId}
        quality="DISPLAY"
        label={t("variantKompakt")}
        hint={t("variantKompaktHint")}
      />
      <VariantPanel
        eventId={eventId}
        quality="ORIGINAL"
        label={t("variantOriginal")}
        hint={t("variantOriginalHint")}
      />
    </Box>
  );
}

function VariantPanel({
  eventId,
  quality,
  label,
  hint,
}: {
  eventId: string;
  quality: Quality;
  label: string;
  hint: string;
}) {
  const t = useTranslations("download.panel");
  const tCommon = useTranslations("common");
  const [state, setState] = useState<DownloadStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  const STATUS_LABEL: Record<string, string> = {
    NONE: t("statusNone"),
    DEBOUNCING: t("statusWaiting"),
    QUEUED: t("statusQueued"),
    BUILDING: t("statusBuilding"),
    READY: t("statusReady"),
    FAILED: t("statusFailed"),
    CANCELLED: t("statusCancelled"),
  };

  useEffect(() => {
    const es = new EventSource(`/api/events/${eventId}/download/status/stream?quality=${quality}`, {
      withCredentials: true,
    });
    es.addEventListener("download-status", (e) => {
      setState(JSON.parse(e.data) as DownloadStatus);
      setLoading(false);
    });
    // Don't close on error — let EventSource auto-reconnect after a transient
    // drop (the browser stops on its own for hard failures like 401/404).
    es.onerror = () => {
      setLoading(false);
    };
    return () => es.close();
  }, [eventId, quality]);

  async function handleBuildNow() {
    setActionLoading("buildNow");
    try {
      await api.events.download.buildNow({ id: eventId, quality });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRebuildAll() {
    setActionLoading("rebuildAll");
    try {
      await api.events.download.rebuildAll({ id: eventId, quality });
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCancel() {
    setCancelOpen(false);
    setActionLoading("cancel");
    try {
      await api.events.download.cancel({ id: eventId, quality });
    } finally {
      setActionLoading(null);
    }
  }

  const titleBlock = (
    <Box mb="12px">
      <Text fontSize="13px" fontWeight="600" color="fg">
        {label}
      </Text>
      <Text fontSize="12px" color="fgSubtle" mt="2px">
        {hint}
      </Text>
    </Box>
  );

  const panelProps = {
    "data-testid": `download-panel-${quality}`,
    bg: "surface",
    borderWidth: "1px",
    borderColor: "border",
    borderRadius: "card",
    mb: "12px",
  } as const;

  if (loading) {
    return (
      <Card.Root {...panelProps}>
        <Card.Body p="16px">
          {titleBlock}
          <Text fontSize="13px" color="fgSubtle">
            {t("loadingStatus")}
          </Text>
        </Card.Body>
      </Card.Root>
    );
  }

  if (!state) {
    return (
      <Card.Root {...panelProps}>
        <Card.Body p="16px">{titleBlock}</Card.Body>
      </Card.Root>
    );
  }

  const statusLabel = STATUS_LABEL[state.status] ?? STATUS_LABEL.NONE;
  const statusPalette = STATUS_PALETTE[state.status] ?? STATUS_PALETTE.NONE;
  const isBuilding = state.status === "BUILDING" || state.status === "QUEUED";
  const canCancel = isBuilding || state.status === "DEBOUNCING";
  const canBuildNow = state.status === "DEBOUNCING";
  // "Rebuild all" regenerates every existing part from its stored membership.
  const canRebuildAll =
    state.status === "READY" || state.status === "FAILED" || state.status === "CANCELLED";
  const isUploading = state.status === "BUILDING" && state.processedPhotos === -1;
  const isZipping = state.status === "BUILDING" && state.processedPhotos >= 0;
  const zipPct =
    state.photoCount > 0 ? Math.round((state.processedPhotos / state.photoCount) * 100) : 0;
  const uploadPct = state.uploadProgress;

  return (
    <Card.Root {...panelProps}>
      <Card.Body p="16px 18px">
        {titleBlock}
        <Flex align="center" justify="space-between" gap="12px" wrap="wrap" mb="12px">
          <Flex align="center" gap="8px">
            <Badge
              colorPalette={statusPalette}
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
            <Text fontSize="13px" color="fgMuted">
              {state.message}
            </Text>
          </Flex>
          <Flex gap="8px">
            {canCancel && (
              <Button
                {...actionBase}
                onClick={() => setCancelOpen(true)}
                disabled={actionLoading === "cancel"}
                borderColor="red.200"
                color="danger"
                opacity={actionLoading === "cancel" ? 0.6 : 1}
                _hover={{ bg: "red.50" }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="m15 9-6 6M9 9l6 6" />
                </svg>
                {actionLoading === "cancel" ? t("cancellingButton") : t("cancelButton")}
              </Button>
            )}
            {canBuildNow && (
              <Button
                {...actionBase}
                onClick={handleBuildNow}
                disabled={actionLoading === "buildNow"}
                borderColor="accent.200"
                color="accent"
                opacity={actionLoading === "buildNow" ? 0.6 : 1}
                _hover={{ bg: "accent.50" }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                {actionLoading === "buildNow" ? t("buildingNowButton") : t("buildNowButton")}
              </Button>
            )}
            {canRebuildAll && (
              <Button
                {...actionBase}
                onClick={handleRebuildAll}
                disabled={actionLoading === "rebuildAll"}
                borderColor="border"
                color="fg"
                opacity={actionLoading === "rebuildAll" ? 0.6 : 1}
                _hover={{ bg: "bg" }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                {actionLoading === "rebuildAll" ? t("rebuildingAllButton") : t("rebuildAllButton")}
              </Button>
            )}
          </Flex>
        </Flex>

        {/* Stats grid */}
        <SimpleGrid minChildWidth="140px" gap="12px" mb={isZipping || isUploading ? "12px" : "0"}>
          <Box>
            <Text fontSize="11.5px" color="fgSubtle" mb="3px">
              {t("processedPhotos")}
            </Text>
            <Text fontSize="14px" fontWeight="600" color="fg">
              {state.processedPhotos} / {state.totalPhotos}
            </Text>
          </Box>
          <Box>
            <Text fontSize="11.5px" color="fgSubtle" mb="3px">
              {t("archiveSize")}
            </Text>
            <Text fontSize="14px" fontWeight="600" color="fg">
              {state.totalSizeBytes ? formatBytes(state.totalSizeBytes) : "—"}
              {state.partCount > 1 && (
                <Text as="span" fontSize="11.5px" fontWeight="400" color="fgSubtle" ml="6px">
                  {t("archiveParts", { count: state.partCount })}
                </Text>
              )}
            </Text>
          </Box>
          <Box>
            <Text fontSize="11.5px" color="fgSubtle" mb="3px">
              {t("lastUpdated")}
            </Text>
            <Text fontSize="14px" fontWeight="500" color="fg">
              {state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : "—"}
            </Text>
          </Box>
          {state.debounceUntil && (
            <Box>
              <Text fontSize="11.5px" color="fgSubtle" mb="3px">
                {t("settlesAt")}
              </Text>
              <Text fontSize="14px" fontWeight="500" color="fg">
                {new Date(state.debounceUntil).toLocaleTimeString()}
              </Text>
            </Box>
          )}
        </SimpleGrid>

        {/* Zipping progress bar */}
        {isZipping && (
          <ProgressBlock
            label={t("zipping")}
            pct={zipPct}
            caption={t("photosZipped", {
              processed: state.processedPhotos,
              total: state.photoCount,
            })}
          />
        )}

        {/* Uploading progress bar */}
        {isUploading && (
          <ProgressBlock
            label={t("uploadingS3")}
            pct={uploadPct}
            caption={t("uploadingArchive", { total: state.photoCount })}
          />
        )}

        {state.failureReason && (
          <Box
            mt="10px"
            fontSize="12.5px"
            color="danger"
            bg="red.50"
            px="10px"
            py="8px"
            borderRadius="7px"
          >
            {state.failureReason}
          </Box>
        )}
      </Card.Body>

      <AlertDialog
        open={cancelOpen}
        title={t("cancelButton")}
        description={t("cancelConfirm")}
        cancelLabel={tCommon("close")}
        confirmLabel={t("cancelButton")}
        destructive
        onCancel={() => setCancelOpen(false)}
        onConfirm={handleCancel}
      />
    </Card.Root>
  );
}

function ProgressBlock({ label, pct, caption }: { label: string; pct: number; caption: string }) {
  return (
    <Progress.Root value={pct} colorPalette="accent">
      <Flex justify="space-between" gap="8px" mb="6px">
        <Progress.Label fontSize="12.5px" fontWeight="500" color="gray.600">
          {label}
        </Progress.Label>
        <Progress.ValueText fontSize="12.5px" color="fgMuted" />
      </Flex>
      <Progress.Track h="7px" borderRadius="pill" bg="bg">
        <Progress.Range borderRadius="pill" transition="width .6s ease" />
      </Progress.Track>
      <Text fontSize="12px" color="fgSubtle" mt="5px">
        {caption}
      </Text>
    </Progress.Root>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
