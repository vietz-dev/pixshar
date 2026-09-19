"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import PhotoGrid from "../../../../components/PhotoGrid";
import Lightbox from "../../../../components/Lightbox";
import UploadModal from "../../../../components/UploadModal";
import DownloadButton from "../../../../components/DownloadButton";

interface GalleryPhoto {
  id: string;
  photographerName: string | null;
  thumbUrl: string;
  displayUrl: string;
  status: string;
  placeholderDataUrl: string | null;
}

interface GalleryData {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  photos: GalleryPhoto[];
}

export default function GalleryViewPage() {
  const t = useTranslations("gallery.view");
  const tCommon = useTranslations("common");
  const params = useParams();
  const slug = params.slug as string;
  const [gallery, setGallery] = useState<GalleryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [layout, setLayout] = useState<"masonry" | "uniform">("masonry");
  const [isMobile, setIsMobile] = useState(false);
  const [lbIndex, setLbIndex] = useState(0);
  const [lbOpen, setLbOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [activePhotographer, setActivePhotographer] = useState<string | null>(null);

  const CACHE_TTL = 30 * 60 * 1000;
  const cacheKey = `gallery_cache_${slug}`;

  const fetchGallery = useCallback(() => {
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const { data, ts } = JSON.parse(raw) as { data: GalleryData; ts: number };
        if (Date.now() - ts < CACHE_TTL) {
          setGallery(data);
          setLoading(false);
          return;
        }
      }
    } catch {
      // ignore sessionStorage errors
    }

    fetch(`/api/gallery/${slug}`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(t("loadFailed"));
        return res.json();
      })
      .then((data: GalleryData) => {
        setGallery(data);
        setLoading(false);
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() }));
        } catch {
          // ignore sessionStorage quota errors
        }
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [slug, t, cacheKey]);

  useEffect(() => {
    fetchGallery();
  }, [fetchGallery]);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Live feed: new photos (from any guest's upload) appear without a refresh.
  const galleryLoaded = !!gallery;
  useEffect(() => {
    if (!galleryLoaded) return;
    const es = new EventSource(`/api/gallery/${slug}/photos/stream`, { withCredentials: true });
    es.addEventListener("photo-new", (e) => {
      const p = JSON.parse(e.data) as {
        id: string;
        thumbUrl: string;
        displayUrl: string;
        photographerName: string | null;
        placeholderDataUrl: string | null;
      };
      setGallery((prev) => {
        if (!prev || prev.photos.some((x) => x.id === p.id)) return prev;
        const photo: GalleryPhoto = {
          id: p.id,
          photographerName: p.photographerName,
          thumbUrl: p.thumbUrl,
          displayUrl: p.displayUrl,
          status: "PROCESSED",
          placeholderDataUrl: p.placeholderDataUrl ?? null,
        };
        const updated = { ...prev, photos: [photo, ...prev.photos] };
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ data: updated, ts: Date.now() }));
        } catch {
          // ignore
        }
        return updated;
      });
    });
    es.onerror = () => {};
    return () => es.close();
  }, [slug, galleryLoaded]);

  const processedPhotos = useMemo(
    () => (gallery?.photos ?? []).filter((p) => p.status === "PROCESSED"),
    [gallery],
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

  const filteredPhotos = useMemo(
    () =>
      activePhotographer
        ? processedPhotos.filter((p) => p.photographerName === activePhotographer)
        : processedPhotos,
    [processedPhotos, activePhotographer],
  );

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#a1a1aa",
        }}
      >
        {tCommon("loading")}
      </div>
    );
  }
  if (error) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#dc2626",
        }}
      >
        {error}
      </div>
    );
  }
  if (!gallery) return null;

  const coverGradient = "linear-gradient(150deg,#3a4a6b 0%,#7c91b8 100%)";

  const photoCountLabel = activePhotographer
    ? t("photoCountFiltered", { filtered: filteredPhotos.length, total: processedPhotos.length })
    : t("photoCount", { count: processedPhotos.length });

  const layoutItems = [
    { key: "masonry" as const, label: t("masonry") },
    { key: "uniform" as const, label: t("grid") },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#fff", animation: "pxFade .35s ease both" }}>
      {/* Hero */}
      <div
        style={{
          position: "relative",
          height: 300,
          background: coverGradient,
          display: "flex",
          alignItems: "flex-end",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(180deg,rgba(15,15,18,.05) 0%,rgba(15,15,18,.5) 100%)",
          }}
        />
        <div
          style={{
            position: "relative",
            width: "100%",
            maxWidth: 1100,
            margin: "0 auto",
            padding: "0 28px 26px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11.5,
                letterSpacing: ".2em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,.85)",
                fontWeight: 500,
                marginBottom: 9,
              }}
            >
              {t("eventLabel")}
            </div>
            <h1
              style={{
                fontFamily: "'Newsreader', serif",
                fontWeight: 300,
                fontSize: 40,
                lineHeight: 1.06,
                color: "#fff",
                margin: 0,
                letterSpacing: "-.01em",
                textShadow: "0 2px 18px rgba(0,0,0,.3)",
              }}
            >
              {gallery.name}
            </h1>
            <div style={{ fontSize: 13.5, color: "rgba(255,255,255,.85)", marginTop: 13 }}>
              {gallery.description || t("descriptionFallback")} · {photoCountLabel}
            </div>
          </div>
          <button
            onClick={() => setUploadModalOpen(true)}
            style={{
              height: 40,
              padding: "0 16px",
              borderRadius: 9,
              border: "none",
              background: "#fff",
              color: "#18181b",
              fontSize: 13.5,
              fontWeight: 500,
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              boxShadow: "0 4px 14px -4px rgba(0,0,0,.3)",
              transition: "transform .15s",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "";
            }}
          >
            <svg
              width="16"
              height="16"
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
            {t("uploadButton")}
          </button>
        </div>
      </div>

      {/* Sticky toolbar */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 9,
          background: "rgba(255,255,255,.9)",
          backdropFilter: "blur(10px)",
          borderBottom: "1px solid #ececee",
          padding: "11px 28px",
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
      >
        {/* Row 1: count + controls */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13.5, color: "#52525b", fontWeight: 500 }}>
            {photoCountLabel}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <DownloadButton slug={slug} />
            {!isMobile && (
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ fontSize: 12.5, color: "#a1a1aa" }}>{t("layout")}</span>
                <div
                  style={{
                    display: "flex",
                    gap: 3,
                    background: "#f4f4f5",
                    border: "1px solid #ececee",
                    borderRadius: 9,
                    padding: 3,
                  }}
                >
                  {layoutItems.map((l) => {
                    const active = layout === l.key;
                    return (
                      <button
                        key={l.key}
                        onClick={() => setLayout(l.key)}
                        style={{
                          height: 28,
                          padding: "0 11px",
                          borderRadius: 7,
                          border: "none",
                          fontSize: 12.5,
                          fontWeight: 500,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          background: active ? "#fff" : "transparent",
                          color: active ? "#18181b" : "#71717a",
                          boxShadow: active ? "0 1px 2px rgba(0,0,0,.1)" : "none",
                          transition: "all .15s",
                          cursor: "pointer",
                        }}
                      >
                        {l.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Row 2: photographer filter chips */}
        {photographers.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              paddingTop: 9,
              marginTop: 9,
              borderTop: "1px solid #f0f0f2",
            }}
          >
            <button
              onClick={() => setActivePhotographer(null)}
              style={{
                height: 28,
                padding: "0 11px",
                borderRadius: 999,
                border: activePhotographer === null ? "none" : "1px solid #e4e4e7",
                background: activePhotographer === null ? "#18181b" : "#fff",
                color: activePhotographer === null ? "#fff" : "#52525b",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "background .15s, color .15s, border .15s",
              }}
            >
              {t("filterAll")}
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
            {photographers.map((name) => {
              const active = activePhotographer === name;
              return (
                <button
                  key={name}
                  onClick={() => setActivePhotographer(active ? null : name)}
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
          </div>
        )}
      </div>

      {/* Photos */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "20px 24px 44px" }}>
        <PhotoGrid
          photos={filteredPhotos.map((p) => ({
            id: p.id,
            thumbUrl: p.thumbUrl,
            displayUrl: p.displayUrl,
            photographerName: p.photographerName,
            status: p.status,
            placeholderDataUrl: p.placeholderDataUrl,
          }))}
          layout={isMobile ? "uniform" : layout}
          onPhotoClick={(_, i) => {
            setLbIndex(i);
            setLbOpen(true);
          }}
        />
      </div>

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
          onPrev={() => setLbIndex((i) => (i - 1 + filteredPhotos.length) % filteredPhotos.length)}
          onDownload={async (photoId) => {
            const res = await fetch(`/api/gallery/${slug}/photos/${photoId}/download`, {
              credentials: "include",
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Download failed");
            return data.url;
          }}
        />
      )}

      {/* Upload modal */}
      {uploadModalOpen && (
        <UploadModal
          galleryName={gallery.name}
          slug={slug}
          onClose={() => {
            setUploadModalOpen(false);
            fetchGallery();
          }}
        />
      )}
    </div>
  );
}
