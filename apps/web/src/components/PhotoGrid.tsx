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
  onDelete?: (photoId: string) => void;
}

export default function PhotoGrid({ photos, layout, onPhotoClick, onDelete }: PhotoGridProps) {
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

  const deleteBtn = (photoId: string) => (
    <button
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

  const imgOrPlaceholder = (p: GridPhoto, fill: boolean) => {
    if (p.thumbUrl) {
      return (
        <img
          src={p.thumbUrl}
          alt={p.photographerName || "Photo"}
          style={fill ? { width: "100%", height: "100%", objectFit: "cover", display: "block" } : { width: "100%", display: "block", borderRadius: 7 }}
          loading="lazy"
        />
      );
    }
    return fill ? (
      <div style={{ width: "100%", height: "100%", background: "#e4e4e7", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      </div>
    ) : (
      <div style={{ width: "100%", aspectRatio: "4/3", background: "#e4e4e7", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center" }}>
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
        {p.status === "PENDING" ? "Processing..." : "Failed"}
      </div>
    ) : null
  );

  if (layout === "justified") {
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {photos.map((p, i) => (
          <div
            key={p.id}
            style={{
              flex: "1 1 200px",
              height: 200,
              minWidth: 90,
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
            <div onClick={() => onPhotoClick(p, i)} style={{ width: "100%", height: "100%" }}>
              {imgOrPlaceholder(p, true)}
              {statusBadge(p)}
            </div>
            {onDelete && (
              <div data-del style={{ opacity: 0, transition: "opacity .15s" }}>
                {deleteBtn(p.id)}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (layout === "masonry") {
    return (
      <div style={{ columnWidth: 230, columnGap: 8 }}>
        {photos.map((p, i) => (
          <div
            key={p.id}
            style={{
              display: "block",
              width: "100%",
              margin: "0 0 8px",
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
            <div onClick={() => onPhotoClick(p, i)} style={{ width: "100%" }}>
              {imgOrPlaceholder(p, false)}
              {statusBadge(p)}
            </div>
            {onDelete && (
              <div data-del style={{ opacity: 0, transition: "opacity .15s" }}>
                {deleteBtn(p.id)}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  // uniform
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
      {photos.map((p, i) => (
        <div
          key={p.id}
          style={{
            aspectRatio: "1",
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
          <div onClick={() => onPhotoClick(p, i)} style={{ width: "100%", height: "100%" }}>
            {imgOrPlaceholder(p, true)}
            {statusBadge(p)}
          </div>
          {onDelete && (
            <div data-del style={{ opacity: 0, transition: "opacity .15s" }}>
              {deleteBtn(p.id)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
