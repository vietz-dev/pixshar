"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  AbsoluteCenter,
  Box,
  Button,
  Flex,
  Progress,
  ProgressCircle,
  Text,
} from "@chakra-ui/react";

export interface UploadItem {
  id: string;
  name: string;
  status: "queued" | "uploading" | "done" | "error" | "skipped";
  progress: number;
  tint: string;
}

interface UploadTrayProps {
  queue: UploadItem[];
  showDetails: boolean;
  onToggleDetails: () => void;
  onClear: () => void;
  onCancel: () => void;
  onRetry: () => void;
  size?: "small" | "large";
}

export const TINTS = Array.from({ length: 10 }, (_, i) => `tint.${i + 1}`);

export function randomTint() {
  return TINTS[Math.floor(Math.random() * TINTS.length)];
}

const STATUS_COLOR: Record<UploadItem["status"], string> = {
  done: "success",
  error: "danger",
  uploading: "accent",
  skipped: "cyan.600",
  queued: "fgSubtle",
};

export default function UploadTray({
  queue,
  showDetails,
  onToggleDetails,
  onClear,
  onCancel,
  onRetry,
  size = "large",
}: UploadTrayProps) {
  const t = useTranslations("upload.tray");
  const isSmall = size === "small";

  const stats = useMemo(() => {
    let done = 0,
      err = 0,
      up = 0,
      queued = 0,
      skipped = 0,
      processed = 0;
    for (const it of queue) {
      if (it.status === "done") {
        done++;
        processed += 100;
      } else if (it.status === "skipped") {
        skipped++;
        processed += 100;
      } else if (it.status === "error") {
        err++;
        processed += 100;
      } else if (it.status === "uploading") {
        up++;
        processed += it.progress;
      } else {
        queued++;
      }
    }
    const total = queue.length;
    const active = queued + up > 0;
    const allDone = total > 0 && !active;
    const pct = total ? processed / (total * 100) : 0;
    return { done, err, up, queued, skipped, total, active, allDone, pct };
  }, [queue]);

  const { done, err, skipped, total, active, pct } = stats;
  const pctRounded = Math.round(pct * 100);
  const remaining = total - done - err - skipped;
  const etaSec = Math.max(1, Math.ceil(remaining / 4.2));
  const etaLabel = etaSec >= 60 ? Math.ceil(etaSec / 60) + " min" : etaSec + "s";
  const speed = (12.6 + (done % 6) * 0.35).toFixed(1);
  const fmt = (n: number) => n.toLocaleString();

  const title = active
    ? t("uploadingTitle", { done: fmt(done), total: fmt(total) })
    : err > 0
      ? t("uploadedWithFailedTitle", { done: fmt(done), failed: err })
      : t("allUploadedTitle", { total: fmt(total) });

  const subtitle = active
    ? t("speedSubtitle", { speed, eta: etaLabel })
    : err > 0
      ? t("retryNeededSubtitle")
      : skipped > 0
        ? t("alreadyInGallerySubtitle", { count: skipped })
        : t("addedNowSubtitle");

  const ringPalette = active ? "accent" : "green";

  const order: Record<string, number> = { error: 0, uploading: 1, queued: 2, done: 3, skipped: 4 };
  const CAP = 60;
  const sorted = useMemo(
    () => queue.slice().sort((a, b) => order[a.status] - order[b.status]),
    [queue],
  );
  const rows = sorted.slice(0, CAP);
  const overflow = total - rows.length;

  const ringSize = isSmall ? 34 : 40;
  const strokeW = isSmall ? 4.5 : 4;
  const ringFont = isSmall ? "10px" : "11px";
  const checkSize = isSmall ? 16 : 18;
  const padX = isSmall ? "12px" : "15px";
  const padY = isSmall ? "11px" : "14px";
  const titleSize = isSmall ? "12.5px" : "13.5px";
  const subSize = isSmall ? "11.5px" : "12px";
  const btnH = isSmall ? "27px" : "30px";
  const btnPad = isSmall ? "9px" : "11px";
  const btnFont = isSmall ? "11.5px" : "12.5px";
  const errPadX = isSmall ? "12px" : "15px";
  const errPadY = isSmall ? "9px" : "10px";
  const errFont = isSmall ? "11.5px" : "12.5px";
  const rowPadX = isSmall ? "12px" : "15px";
  const rowPadY = isSmall ? "7px" : "8px";
  const rowFont = isSmall ? "11.5px" : "12.5px";
  const thumbSize = isSmall ? "24px" : "28px";
  const thumbRadius = isSmall ? "5px" : "6px";
  const statusFont = isSmall ? "11px" : "11.5px";
  const ovFont = isSmall ? "11px" : "12px";
  const gap = isSmall ? "11px" : "13px";
  const maxH = isSmall ? "150px" : "228px";

  function statusLabel(status: UploadItem["status"], progress: number): string {
    switch (status) {
      case "done":
        return t("statusDone");
      case "error":
        return t("statusFailed");
      case "uploading":
        return `${Math.round(progress)}%`;
      case "skipped":
        return t("statusAlreadyUploaded");
      default:
        return t("statusQueued");
    }
  }

  return (
    <Box
      bg="surface"
      borderWidth="1px"
      borderColor="border"
      borderRadius="card"
      overflow="hidden"
      mb="22px"
      boxShadow="0 1px 3px rgba(0,0,0,.04)"
    >
      <Flex align="center" gap={gap} px={padX} py={padY}>
        {/* Ring */}
        <ProgressCircle.Root
          value={pctRounded}
          colorPalette={ringPalette}
          w={`${ringSize}px`}
          h={`${ringSize}px`}
          flexShrink={0}
        >
          <ProgressCircle.Circle css={{ "--size": `${ringSize}px`, "--thickness": `${strokeW}px` }}>
            <ProgressCircle.Track stroke="gray.100" />
            <ProgressCircle.Range strokeLinecap="round" />
          </ProgressCircle.Circle>
          <AbsoluteCenter>
            {active ? (
              <Text
                fontSize={ringFont}
                fontWeight="600"
                color="gray.700"
                fontVariantNumeric="tabular-nums"
              >
                {pctRounded}%
              </Text>
            ) : (
              <Box color="colorPalette.solid">
                <svg
                  width={checkSize}
                  height={checkSize}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </Box>
            )}
          </AbsoluteCenter>
        </ProgressCircle.Root>

        <Box flex="1" minW="0">
          <Text fontSize={titleSize} fontWeight="600" letterSpacing="-.01em">
            {title}
          </Text>
          <Text fontSize={subSize} color="fgMuted" mt="2px">
            {subtitle}
          </Text>
        </Box>

        <Button
          onClick={onToggleDetails}
          variant="outline"
          h={btnH}
          px={btnPad}
          borderRadius="7px"
          borderColor="border"
          bg="surface"
          color="gray.700"
          fontSize={btnFont}
          fontWeight="500"
          gap="5px"
          _hover={{ bg: "bg" }}
        >
          {showDetails ? "↑" : "↓"}
          <Box
            display="inline-flex"
            transform={showDetails ? "rotate(180deg)" : "none"}
            transition="transform .2s"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </Box>
        </Button>

        <Button
          onClick={active ? onCancel : onClear}
          variant="subtle"
          colorPalette={active ? "red" : "gray"}
          h={btnH}
          px="12px"
          borderRadius="7px"
          fontSize={btnFont}
          fontWeight="500"
        >
          {active ? t("cancelButton") : t("clearButton")}
        </Button>
      </Flex>

      {/* Progress bar */}
      <Progress.Root value={pctRounded} colorPalette={ringPalette} shape="square">
        <Progress.Track h="4px" bg="gray.100">
          <Progress.Range transition="width .3s ease, background-color .3s ease" />
        </Progress.Track>
      </Progress.Root>

      {/* Error banner */}
      {err > 0 && (
        <Flex
          align="center"
          gap="9px"
          px={errPadX}
          py={errPadY}
          bg="red.50"
          borderTopWidth="1px"
          borderTopColor="red.100"
          color="danger"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <Text flex="1" fontSize={errFont} fontWeight="500">
            {t("failedCount", { count: err })}
          </Text>
          <Button
            onClick={onRetry}
            variant="outline"
            h={isSmall ? "25px" : "27px"}
            px={isSmall ? "9px" : "11px"}
            borderRadius="6px"
            borderColor="red.200"
            bg="surface"
            color="danger"
            fontSize={isSmall ? "11px" : "12px"}
            fontWeight="600"
            _hover={{ bg: "red.50" }}
          >
            {t("retryButton")}
          </Button>
        </Flex>
      )}

      {/* Details rows */}
      {showDetails && (
        <Box
          className="pxscroll"
          maxH={maxH}
          overflowY="auto"
          borderTopWidth="1px"
          borderTopColor="gray.100"
        >
          {rows.map((u) => (
            <Flex
              key={u.id}
              align="center"
              gap={isSmall ? "9px" : "11px"}
              px={rowPadX}
              py={rowPadY}
              borderBottomWidth="1px"
              borderBottomColor="gray.50"
            >
              <Box
                w={thumbSize}
                h={thumbSize}
                borderRadius={thumbRadius}
                bg={u.tint}
                flexShrink={0}
                position="relative"
                overflow="hidden"
              >
                {u.status === "uploading" && (
                  <Box
                    position="absolute"
                    inset="0"
                    bgImage="linear-gradient(100deg,transparent 30%,rgba(255,255,255,.55) 50%,transparent 70%)"
                    backgroundSize="200% 100%"
                    animation="pxShimmer 1.1s linear infinite"
                  />
                )}
              </Box>
              <Text
                flex="1"
                minW="0"
                fontSize={rowFont}
                fontWeight="500"
                whiteSpace="nowrap"
                overflow="hidden"
                textOverflow="ellipsis"
              >
                {u.name}
              </Text>
              <Text
                fontSize={statusFont}
                fontWeight="500"
                color={STATUS_COLOR[u.status]}
                flexShrink={0}
                fontVariantNumeric="tabular-nums"
              >
                {statusLabel(u.status, u.progress)}
              </Text>
            </Flex>
          ))}
          {overflow > 0 && (
            <Text px={rowPadX} py={rowPadY} fontSize={ovFont} color="fgSubtle" textAlign="center">
              {t("overflow", { count: fmt(overflow) })}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
