"use client";

import { useRef, useState, useLayoutEffect, useEffect } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useTranslations } from "next-intl";
import { Box, chakra, Flex } from "@chakra-ui/react";
import LazyImage from "./LazyImage";

interface GridPhoto {
  id: string;
  thumbUrl: string;
  displayUrl: string;
  photographerName: string | null;
  status?: string;
  onOpen?: () => void;
  placeholderDataUrl?: string | null;
}

interface PhotoGridProps {
  photos: GridPhoto[];
  layout: "justified" | "masonry" | "uniform";
  onPhotoClick: (photo: GridPhoto, index: number) => void;
  onDelete?: (photoId: string) => void;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
}

const GAP = 8;

function getLayoutParams(
  layout: string,
  containerWidth: number,
): { cols: number; itemW: number; rowH: number } {
  if (layout === "uniform") {
    const minW = 150;
    const cols = Math.max(1, Math.floor((containerWidth + GAP) / (minW + GAP)));
    const itemW = (containerWidth - (cols - 1) * GAP) / cols;
    return { cols, itemW, rowH: itemW };
  }
  if (layout === "justified") {
    const minW = 200;
    const cols = Math.max(1, Math.floor((containerWidth + GAP) / (minW + GAP)));
    const itemW = (containerWidth - (cols - 1) * GAP) / cols;
    return { cols, itemW, rowH: 200 };
  }
  // masonry → virtual square grid
  const minW = 200;
  const cols = Math.max(1, Math.floor((containerWidth + GAP) / (minW + GAP)));
  const itemW = (containerWidth - (cols - 1) * GAP) / cols;
  return { cols, itemW, rowH: itemW };
}

export default function PhotoGrid({
  photos,
  layout,
  onPhotoClick,
  onDelete,
  selectable,
  selectedIds,
  onToggleSelect,
}: PhotoGridProps) {
  const t = useTranslations("photoGrid");
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setContainerWidth(el.getBoundingClientRect().width);
      setScrollMargin(el.getBoundingClientRect().top + window.scrollY);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { cols, itemW, rowH } = getLayoutParams(layout, containerWidth);

  const rows: GridPhoto[][] = [];
  for (let i = 0; i < photos.length; i += cols) {
    rows.push(photos.slice(i, i + cols));
  }

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => rowH + GAP,
    overscan: 3,
    scrollMargin,
  });

  // Re-estimate all row sizes when the layout type or column count changes
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, cols]);

  const commonHover = {
    transform: "translateY(-3px)",
    boxShadow: "0 14px 28px -12px rgba(0,0,0,.32)",
    filter: "brightness(1.05)",
  };

  const selectCheckbox = (photoId: string) => {
    const isSelected = selectedIds?.has(photoId) ?? false;
    return (
      <Flex
        position="absolute"
        top="8px"
        left="8px"
        w="22px"
        h="22px"
        borderRadius="6px"
        borderWidth={isSelected ? "0" : "2px"}
        borderColor="rgba(255,255,255,.9)"
        bg={isSelected ? "accent" : "rgba(0,0,0,.35)"}
        align="center"
        justify="center"
        color="white"
        zIndex={2}
        transition="background .12s, border .12s"
        pointerEvents="none"
      >
        {isSelected && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </Flex>
    );
  };

  const deleteBtn = (photoId: string) => (
    <chakra.button
      data-del
      onClick={(e) => {
        e.stopPropagation();
        onDelete?.(photoId);
      }}
      position="absolute"
      top="8px"
      right="8px"
      w="28px"
      h="28px"
      borderRadius="6px"
      bg="rgba(220,38,38,.85)"
      color="white"
      display="flex"
      alignItems="center"
      justifyContent="center"
      cursor="pointer"
      opacity="0"
      transition="opacity .15s"
      zIndex={2}
      _hover={{ bg: "rgba(185,28,28,.9)" }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
      >
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      </svg>
    </chakra.button>
  );

  const imgOrPlaceholder = (p: GridPhoto) => {
    if (p.thumbUrl) {
      return (
        <LazyImage
          src={p.thumbUrl}
          placeholderDataUrl={p.placeholderDataUrl ?? null}
          alt={p.photographerName || ""}
          objectFit="cover"
        />
      );
    }
    return (
      <Flex w="100%" h="100%" bg="bg" color="fgSubtle" align="center" justify="center">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      </Flex>
    );
  };

  const statusBadge = (p: GridPhoto) =>
    p.status && p.status !== "PROCESSED" ? (
      <Flex
        position="absolute"
        bottom="6px"
        left="6px"
        h="20px"
        px="8px"
        borderRadius="pill"
        bg="rgba(0,0,0,.6)"
        color="white"
        fontSize="11px"
        align="center"
      >
        {p.status === "PENDING" ? t("statusProcessing") : t("statusFailed")}
      </Flex>
    ) : null;

  if (photos.length === 0) {
    return (
      <Box
        ref={containerRef}
        textAlign="center"
        px="20px"
        py="40px"
        borderWidth="1px"
        borderColor="bg"
        borderRadius="card"
        bg="surface"
        color="fgSubtle"
        fontSize="13.5px"
      >
        {t("noPhotos")}
      </Box>
    );
  }

  const isJustified = layout === "justified";

  return (
    <div ref={containerRef}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const rowPhotos = rows[vRow.index];
          return (
            <div
              key={vRow.key}
              style={{
                position: "absolute",
                top: 0,
                transform: `translateY(${vRow.start - scrollMargin}px)`,
                left: 0,
                right: 0,
                display: "flex",
                gap: GAP,
              }}
            >
              {rowPhotos.map((p, col) => {
                const globalIndex = vRow.index * cols + col;
                return (
                  <div
                    key={p.id}
                    style={{
                      ...(isJustified
                        ? { flex: "1 1 200px", minWidth: 90, height: rowH }
                        : { width: itemW, height: rowH, flexShrink: 0 }),
                      borderRadius: 7,
                      cursor: "pointer",
                      overflow: "hidden",
                      transition: "transform .2s, box-shadow .2s, filter .2s, outline .12s",
                      position: "relative",
                      outline:
                        selectable && selectedIds?.has(p.id) ? "2.5px solid #2563eb" : "none",
                      outlineOffset: -2,
                    }}
                    onMouseEnter={(e) => {
                      if (!selectable) {
                        const s = e.currentTarget.style;
                        s.transform = commonHover.transform;
                        s.boxShadow = commonHover.boxShadow;
                        s.filter = commonHover.filter;
                      }
                      const btn = e.currentTarget.querySelector("[data-del]") as HTMLElement;
                      if (btn) btn.style.opacity = "1";
                    }}
                    onMouseLeave={(e) => {
                      const s = e.currentTarget.style;
                      s.transform = "";
                      s.boxShadow = "";
                      s.filter = "";
                      const btn = e.currentTarget.querySelector("[data-del]") as HTMLElement;
                      if (btn) btn.style.opacity = "0";
                    }}
                  >
                    <div
                      onClick={() =>
                        selectable && onToggleSelect
                          ? onToggleSelect(p.id)
                          : onPhotoClick(p, globalIndex)
                      }
                      style={{ width: "100%", height: "100%" }}
                    >
                      {imgOrPlaceholder(p)}
                      {statusBadge(p)}
                      {selectable && selectCheckbox(p.id)}
                    </div>
                    {!selectable && onDelete && deleteBtn(p.id)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
