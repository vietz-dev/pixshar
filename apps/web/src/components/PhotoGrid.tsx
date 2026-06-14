"use client";

interface GridPhoto {
  id: string;
  thumbUrl: string;
  displayUrl: string;
  photographerName: string | null;
  status?: string;
  onOpen?: () => void;
}

interface PhotoGridProps {
  photos: GridPhoto[];
  layout: "justified" | "masonry" | "uniform";
  onPhotoClick: (photo: GridPhoto, index: number) => void;
}

export default function PhotoGrid({ photos, layout, onPhotoClick }: PhotoGridProps) {
  if (photos.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px 20px", border: "1px solid #f4f4f5", borderRadius: 12, background: "#fff", color: "#a1a1aa", fontSize: 13.5 }}>
        No photos yet — upload some to get started.
      </div>
    );
  }

  const commonHover = {
    transform: "translateY(-3px)",
    boxShadow: "0 14px 28px -12px rgba(0,0,0,.32)",
    filter: "brightness(1.05)",
  };

  if (layout === "justified") {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {photos.map((p, i) => (
          <button
            key={p.id}
            onClick={() => onPhotoClick(p, i)}
            style={{
              flex: "1 1 200px",
              height: 200,
              minWidth: 90,
              border: "none",
              padding: 0,
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
            }}
            onMouseLeave={(e) => {
              const s = e.currentTarget.style;
              s.transform = "";
              s.boxShadow = "";
              s.filter = "";
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.thumbUrl}
              alt={p.photographerName || "Photo"}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              loading="lazy"
            />
            {p.status && p.status !== "PROCESSED" && (
              <div style={{ position: "absolute", bottom: 6, left: 6, height: 20, padding: "0 8px", borderRadius: 999, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 11, display: "flex", alignItems: "center" }}>
                {p.status === "PENDING" ? "Processing..." : "Failed"}
              </div>
            )}
          </button>
        ))}
      </div>
    );
  }

  if (layout === "masonry") {
    return (
      <div style={{ columnWidth: 230, columnGap: 8 }}>
        {photos.map((p, i) => (
          <button
            key={p.id}
            onClick={() => onPhotoClick(p, i)}
            style={{
              display: "block",
              width: "100%",
              margin: "0 0 8px",
              border: "none",
              padding: 0,
              borderRadius: 7,
              cursor: "pointer",
              overflow: "hidden",
              breakInside: "avoid",
              transition: "transform .2s, box-shadow .2s, filter .2s",
              position: "relative",
            }}
            onMouseEnter={(e) => {
              const s = e.currentTarget.style;
              s.transform = commonHover.transform;
              s.boxShadow = commonHover.boxShadow;
              s.filter = commonHover.filter;
            }}
            onMouseLeave={(e) => {
              const s = e.currentTarget.style;
              s.transform = "";
              s.boxShadow = "";
              s.filter = "";
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.thumbUrl}
              alt={p.photographerName || "Photo"}
              style={{ width: "100%", display: "block", borderRadius: 7 }}
              loading="lazy"
            />
            {p.status && p.status !== "PROCESSED" && (
              <div style={{ position: "absolute", bottom: 6, left: 6, height: 20, padding: "0 8px", borderRadius: 999, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 11, display: "flex", alignItems: "center" }}>
                {p.status === "PENDING" ? "Processing..." : "Failed"}
              </div>
            )}
          </button>
        ))}
      </div>
    );
  }

  // uniform
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
      {photos.map((p, i) => (
        <button
          key={p.id}
          onClick={() => onPhotoClick(p, i)}
          style={{
            aspectRatio: "1",
            border: "none",
            padding: 0,
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
          }}
          onMouseLeave={(e) => {
            const s = e.currentTarget.style;
            s.transform = "";
            s.boxShadow = "";
            s.filter = "";
          }}
        >
          {p.thumbUrl ? (
            <img
              src={p.thumbUrl}
              alt={p.photographerName || "Photo"}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              loading="lazy"
            />
          ) : (
            <div style={{ width: "100%", height: "100%", background: "#e4e4e7", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
            </div>
          )}
          {p.status && p.status !== "PROCESSED" && (
            <div style={{ position: "absolute", bottom: 6, left: 6, height: 20, padding: "0 8px", borderRadius: 999, background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 11, display: "flex", alignItems: "center" }}>
              {p.status === "PENDING" ? "Processing..." : "Failed"}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
