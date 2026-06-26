"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
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
}

interface GalleryData {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  photos: GalleryPhoto[];
}

export default function GalleryViewPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [gallery, setGallery] = useState<GalleryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [layout, setLayout] = useState<"masonry" | "uniform">("masonry");
  const [lbIndex, setLbIndex] = useState(0);
  const [lbOpen, setLbOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

  const fetchGallery = useCallback(() => {
    fetch(`/api/gallery/${slug}`, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load gallery");
        return res.json();
      })
      .then((data) => {
        setGallery(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [slug]);

  useEffect(() => {
    fetchGallery();
  }, [fetchGallery]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#a1a1aa" }}>
        Loading...
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#dc2626" }}>
        {error}
      </div>
    );
  }
  if (!gallery) return null;

  const coverGradient = "linear-gradient(150deg,#3a4a6b 0%,#7c91b8 100%)";
  const photoCountLabel = `${gallery.photos.length} photos`;

  const layoutItems = [
    { key: "masonry" as const, label: "Masonry" },
    { key: "uniform" as const, label: "Grid" },
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
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(15,15,18,.05) 0%,rgba(15,15,18,.5) 100%)" }} />
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
            <div style={{ fontSize: 11.5, letterSpacing: ".2em", textTransform: "uppercase", color: "rgba(255,255,255,.85)", fontWeight: 500, marginBottom: 9 }}>
              Event
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
              {gallery.description || "A private photo collection"} · {photoCountLabel}
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
            onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-1px)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = ""; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17V3m0 0L7 8m5-5 5 5"></path>
              <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"></path>
            </svg>
            Upload your photos
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
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 13.5, color: "#52525b", fontWeight: 500 }}>{photoCountLabel}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <DownloadButton slug={slug} />
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontSize: 12.5, color: "#a1a1aa" }}>Layout</span>
          <div style={{ display: "flex", gap: 3, background: "#f4f4f5", border: "1px solid #ececee", borderRadius: 9, padding: 3 }}>
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
      </div>
      </div>

      {/* Photos */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "20px 24px 44px" }}>
        <PhotoGrid
          photos={gallery.photos.map((p) => ({
            id: p.id,
            thumbUrl: p.thumbUrl,
            displayUrl: p.displayUrl,
            photographerName: p.photographerName,
            status: p.status,
          }))}
          layout={layout}
          onPhotoClick={(p, i) => {
            setLbIndex(i);
            setLbOpen(true);
          }}
        />
      </div>

      {/* Lightbox */}
      {lbOpen && (
        <Lightbox
          photos={gallery.photos
            .filter((p) => p.status === "PROCESSED")
            .map((p) => ({ id: p.id, url: p.displayUrl, photographerName: p.photographerName }))}
          index={lbIndex}
          onClose={() => setLbOpen(false)}
          onNext={() => setLbIndex((i) => (i + 1) % gallery.photos.filter((p) => p.status === "PROCESSED").length)}
          onPrev={() => setLbIndex((i) => (i - 1 + gallery.photos.filter((p) => p.status === "PROCESSED").length) % gallery.photos.filter((p) => p.status === "PROCESSED").length)}
          onDownload={async (photoId) => {
            const res = await fetch(`/api/gallery/${slug}/photos/${photoId}/download`, { credentials: "include" });
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
          onClose={() => { setUploadModalOpen(false); fetchGallery(); }}
        />
      )}
    </div>
  );
}
