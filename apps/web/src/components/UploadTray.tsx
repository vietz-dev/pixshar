"use client";

import { useMemo } from "react";

export interface UploadItem {
  id: string;
  name: string;
  status: "queued" | "uploading" | "done" | "error";
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

export const TINTS = [
  "#fecaca", "#bfdbfe", "#bbf7d0", "#fde68a", "#ddd6fe",
  "#fbcfe8", "#99f6e4", "#fed7aa", "#c7d2fe", "#e9d5ff",
];

export function randomTint() {
  return TINTS[Math.floor(Math.random() * TINTS.length)];
}

export default function UploadTray({
  queue,
  showDetails,
  onToggleDetails,
  onClear,
  onCancel,
  onRetry,
  size = "large",
}: UploadTrayProps) {
  const isSmall = size === "small";

  const stats = useMemo(() => {
    let done = 0, err = 0, up = 0, queued = 0, processed = 0;
    for (const it of queue) {
      if (it.status === "done") { done++; processed += 100; }
      else if (it.status === "error") { err++; processed += 100; }
      else if (it.status === "uploading") { up++; processed += it.progress; }
      else { queued++; }
    }
    const total = queue.length;
    const active = queued + up > 0;
    const allDone = total > 0 && !active;
    const pct = total ? processed / (total * 100) : 0;
    return { done, err, up, queued, total, active, allDone, pct };
  }, [queue]);

  const { done, err, total, active, allDone, pct } = stats;
  const pctRounded = Math.round(pct * 100);
  const remaining = total - done - err;
  const etaSec = Math.max(1, Math.ceil(remaining / 4.2));
  const etaLabel = etaSec >= 60 ? Math.ceil(etaSec / 60) + " min" : etaSec + "s";
  const speed = (12.6 + (done % 6) * 0.35).toFixed(1);
  const fmt = (n: number) => n.toLocaleString();

  const title = active
    ? `Uploading ${fmt(done)} of ${fmt(total)} photos`
    : err > 0
      ? `${fmt(done)} uploaded · ${err} failed`
      : `All ${fmt(total)} photos uploaded`;

  const subtitle = active
    ? `${speed} MB/s · about ${etaLabel} left`
    : err > 0
      ? "A few photos need another try."
      : "Added to the gallery just now.";

  const ringColor = active ? "#2563eb" : "#16a34a";
  const CIRC = 100.53;
  const offset = (CIRC * (1 - pct)).toFixed(2);

  const order: Record<string, number> = { error: 0, uploading: 1, queued: 2, done: 3 };
  const CAP = isSmall ? 60 : 60;
  const sorted = useMemo(
    () => queue.slice().sort((a, b) => order[a.status] - order[b.status]),
    [queue]
  );
  const rows = sorted.slice(0, CAP);
  const overflow = total - rows.length;

  const svgSize = isSmall ? 34 : 40;
  const strokeW = isSmall ? 4.5 : 4;
  const ringFont = isSmall ? 10 : 11;
  const checkSize = isSmall ? 16 : 18;
  const padX = isSmall ? "12px" : "15px";
  const padY = isSmall ? "11px" : "14px";
  const titleSize = isSmall ? 12.5 : 13.5;
  const subSize = isSmall ? 11.5 : 12;
  const btnH = isSmall ? 27 : 30;
  const btnPad = isSmall ? "0 9px" : "0 11px";
  const btnFont = isSmall ? 11.5 : 12.5;
  const barH = isSmall ? 4 : 4;
  const errPad = isSmall ? "9px 12px" : "10px 15px";
  const errFont = isSmall ? 11.5 : 12.5;
  const rowPad = isSmall ? "7px 12px" : "8px 15px";
  const rowFont = isSmall ? 11.5 : 12.5;
  const thumbSize = isSmall ? 24 : 28;
  const thumbRadius = isSmall ? 5 : 6;
  const statusFont = isSmall ? 11 : 11.5;
  const ovFont = isSmall ? 11 : 12;
  const gap = isSmall ? 11 : 13;
  const maxH = isSmall ? 150 : 228;

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e4e4e7",
        borderRadius: 12,
        overflow: "hidden",
        marginBottom: 22,
        boxShadow: "0 1px 3px rgba(0,0,0,.04)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap, padding: `${padY} ${padX}` }}>
        {/* Ring */}
        <div style={{ position: "relative", width: svgSize, height: svgSize, flexShrink: 0 }}>
          <svg width={svgSize} height={svgSize} viewBox="0 0 40 40" style={{ transform: "rotate(-90deg)" }}>
            <circle cx="20" cy="20" r="16" fill="none" stroke="#f1f1f3" strokeWidth={strokeW} />
            <circle
              cx="20" cy="20" r="16" fill="none" stroke={ringColor}
              strokeWidth={strokeW} strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={offset}
              style={{ transition: "stroke-dashoffset .3s ease, stroke .3s ease" }}
            />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {active ? (
              <span style={{ fontSize: ringFont, fontWeight: 600, color: "#3f3f46", fontVariantNumeric: "tabular-nums" }}>
                {pctRounded}%
              </span>
            ) : (
              <svg width={checkSize} height={checkSize} viewBox="0 0 24 24" fill="none" stroke={ringColor} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            )}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: titleSize, fontWeight: 600, letterSpacing: "-.01em" }}>{title}</div>
          <div style={{ fontSize: subSize, color: "#71717a", marginTop: 2 }}>{subtitle}</div>
        </div>

        <button
          onClick={onToggleDetails}
          style={{
            height: btnH,
            padding: btnPad,
            borderRadius: 7,
            border: "1px solid #e4e4e7",
            background: "#fff",
            color: "#3f3f46",
            fontSize: btnFont,
            fontWeight: 500,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            transition: "background .15s",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "#f4f4f5"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
        >
          {showDetails ? "Hide" : "Details"}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ transform: showDetails ? "rotate(180deg)" : "none", transition: "transform .2s" }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        <button
          onClick={active ? onCancel : onClear}
          style={{
            height: btnH,
            padding: "0 12px",
            borderRadius: 7,
            border: "none",
            background: active ? "#fef2f2" : "#f4f4f5",
            color: active ? "#dc2626" : "#3f3f46",
            fontSize: btnFont,
            fontWeight: 500,
            transition: "background .15s",
            cursor: "pointer",
          }}
        >
          {active ? "Cancel" : "Clear"}
        </button>
      </div>

      {/* Progress bar */}
      <div style={{ height: barH, background: "#f1f1f3" }}>
        <div
          style={{
            height: "100%",
            width: `${pctRounded}%`,
            background: ringColor,
            transition: "width .3s ease, background .3s ease",
          }}
        />
      </div>

      {/* Error banner */}
      {err > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: errPad, background: "#fef2f2", borderTop: "1px solid #fee2e2" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span style={{ flex: 1, fontSize: errFont, color: "#b91c1c", fontWeight: 500 }}>
            {err} {err === 1 ? "photo failed to upload" : "photos failed to upload"}
          </span>
          <button
            onClick={onRetry}
            style={{
              height: isSmall ? 25 : 27,
              padding: isSmall ? "0 9px" : "0 11px",
              borderRadius: 6,
              border: "1px solid #fecaca",
              background: "#fff",
              color: "#dc2626",
              fontSize: isSmall ? 11 : 12,
              fontWeight: 600,
              transition: "background .15s",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#fff5f5"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Details rows */}
      {showDetails && (
        <div className="pxscroll" style={{ maxHeight: maxH, overflowY: "auto", borderTop: "1px solid #f1f1f3" }}>
          {rows.map((u) => (
            <div
              key={u.id}
              style={{ display: "flex", alignItems: "center", gap: isSmall ? 9 : 11, padding: rowPad, borderBottom: "1px solid #fafafa" }}
            >
              <div style={{ width: thumbSize, height: thumbSize, borderRadius: thumbRadius, background: u.tint, flexShrink: 0, position: "relative", overflow: "hidden" }}>
                {u.status === "uploading" && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "linear-gradient(100deg,transparent 30%,rgba(255,255,255,.55) 50%,transparent 70%)",
                      backgroundSize: "200% 100%",
                      animation: "pxShimmer 1.1s linear infinite",
                    }}
                  />
                )}
              </div>
              <span style={{ flex: 1, minWidth: 0, fontSize: rowFont, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {u.name}
              </span>
              <span style={{ fontSize: statusFont, fontWeight: 500, color: u.status === "done" ? "#16a34a" : u.status === "error" ? "#dc2626" : u.status === "uploading" ? "#2563eb" : "#a1a1aa", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                {u.status === "done" ? "Done" : u.status === "error" ? "Failed" : u.status === "uploading" ? `${Math.round(u.progress)}%` : "Queued"}
              </span>
            </div>
          ))}
          {overflow > 0 && (
            <div style={{ padding: rowPad, fontSize: ovFont, color: "#a1a1aa", textAlign: "center" }}>
              + {fmt(overflow)} more in this upload
            </div>
          )}
        </div>
      )}
    </div>
  );
}
