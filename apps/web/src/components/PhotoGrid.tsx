"use client";

import { useRef, useState, useLayoutEffect, useEffect } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useTranslations } from "next-intl";
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
}

const GAP = 8;

function getLayoutParams(layout: string, containerWidth: number): { cols: number; itemW: number; rowH: number } {
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

export default function PhotoGrid({ photos, layout, onPhotoClick, onDelete }: PhotoGridProps) {
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

  const deleteBtn = (photoId: string) => (
    <button
      data-del
      onClick={(e) => { e.stopPropagation(); onDelete?.(photoId); }}
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        width: 28,
        height: 28,
        borderRadius: 6,
        border: "none",
        background: "rgba(220,38,38,.85)",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        opacity: 0,
        transition: "opacity .15s",
        zIndex: 2,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      </svg>
    </button>
  );

  const imgOrPlaceholder = (p: GridPhoto) => {
    if (p.thumbUrl) {
      return (
        <LazyImage
          src={p.thumbUrl}
          placeholderDataUrl={p.placeholderDataUrl ?? null}
          alt={p.photographerName || ""}
          objectFit="cover"
          style={{ width: "100%", height: "100%" }}
        />
      );
    }
    return (
      <div style={{ width: "100%", height: "100%", background: "#f4f4f5", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      </div>
    );
  };

  const statusBadge = (p: GridPhoto) => (
    p.status && p.status !== "PROCESSED" ? (
      <div style={{ position: "absolute", bottom: 6, left: 6, height: 20, padding: "0 8px", borderRadius: 999, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 11, display: "flex", alignItems: "center" }}>
        {p.status === "PENDING" ? t("statusProcessing") : t("statusFailed")}
      </div>
    ) : null
  );

  if (photos.length === 0) {
    return (
      <div ref={containerRef} style={{ textAlign: "center", padding: "40px 20px", border: "1px solid #f4f4f5", borderRadius: 12, background: "#fff", color: "#a1a1aa", fontSize: 13.5 }}>
        {t("noPhotos")}
      </div>
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
                      transition: "transform .2s, box-shadow .2s, filter .2s",
                      position: "relative",
                    }}
                    onMouseEnter={(e) => {
                      const s = e.currentTarget.style;
                      s.transform = commonHover.transform;
                      s.boxShadow = commonHover.boxShadow;
                      s.filter = commonHover.filter;
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
                    <div onClick={() => onPhotoClick(p, globalIndex)} style={{ width: "100%", height: "100%" }}>
                      {imgOrPlaceholder(p)}
                      {statusBadge(p)}
                    </div>
                    {onDelete && deleteBtn(p.id)}
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
